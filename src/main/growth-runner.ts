import { defaultModelSelection } from '../core/model-runtime';
import type { ModelKind, ModelSelection } from '../shared/model-providers';
import { randomUUID } from 'node:crypto';
import { epochInput, type Result } from '../shared/contracts';
import { growthTokenInput, type GrowthReceipt, type GrowthPreparation } from '../shared/growth';
import type { GrowthPacket } from '../shared/growth';
import { growthMessages } from '../core/growth-source';
import { DomainError } from '../core/errors';
import {
  type DeepSeekClient,
  type DeepSeekCredentialStore,
  type DeepSeekLedger,
} from '../core/deepseek';
import type { DeepSeekGenerationResult } from '../core/deepseek/types';
import type { WorkerClient } from './worker-client';
import { DeepSeekGenerationError } from '../core/deepseek/client';

/** Main 管理单次付费请求和取消；串行数据 Worker 只准备来源并事务保存本地草稿。 */
export class GrowthRunner {
  private active?: { epoch: string; controller: AbortController; cancellation: Int32Array };
  constructor(
    private readonly worker: Pick<WorkerClient, 'call'>,
    private readonly client: Pick<DeepSeekClient, 'generateText'>,
    private readonly credentials: Pick<DeepSeekCredentialStore, 'loadKey'>,
    private readonly ledger: Pick<DeepSeekLedger, 'startCall' | 'completeCall'>,
    private readonly selectModel: (kind: ModelKind) => ModelSelection = defaultModelSelection,
  ) {}

  invalidate(): void {
    if (this.active) Atomics.compareExchange(this.active.cancellation, 0, 0, 1);
    this.active?.controller.abort();
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  prepare(raw: unknown): Promise<Result<GrowthPreparation>> {
    epochInput.strip().parse(raw);
    if (this.active) throw new DomainError('BUSY', '成长总结生成尚未结束，请先取消或等待。');
    // 新选择即使校验失败也先作废旧令牌，避免教师误用先前的外发授权。
    return this.worker.call('prepareGrowthSummary', raw);
  }

  cancel(raw: unknown): Promise<Result<void>> {
    const input = epochInput.parse(raw);
    if (this.active?.epoch === input.epoch) this.invalidate();
    return this.worker.call('cancelGrowthSummary', input);
  }

  async generate(raw: unknown): Promise<Result<GrowthReceipt>> {
    const input = growthTokenInput.parse(raw);
    if (this.active) throw new DomainError('BUSY', '成长总结生成尚未结束，请勿重复提交。');
    const task = {
      epoch: input.epoch,
      controller: new AbortController(),
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
    };
    this.active = task;
    const requestId = randomUUID();
    const startedAt = Date.now();
    let started = false;
    let response: DeepSeekGenerationResult | undefined;
    const assertCurrent = () => {
      if (task.controller.signal.aborted)
        throw new DomainError('ABORTED', '成长总结生成已取消或配置已变更，返回内容未保存。');
    };
    try {
      const claimed = await this.worker.call<GrowthPacket>('claimGrowthSummary', {
        ...input,
        requestId,
      });
      if (!claimed.ok) return claimed;
      assertCurrent();
      const selection = this.selectModel('text');
      const apiKey = this.credentials.loadKey();
      const messages = growthMessages(claimed.value);
      this.ledger.startCall({
        id: requestId,
        timestamp: new Date().toISOString(),
        type: 'growth_summary',
        ...selection,
        status: 'in_progress',
        durationMs: 0,
        promptVersion: claimed.value.promptVersion,
        growthInput: {
          source: claimed.value.source,
          inputHash: claimed.value.inputHash,
        },
      });
      started = true;
      response = await this.client.generateText(apiKey, messages, {
        signal: task.controller.signal,
        model: selection.requestModel,
        provider: selection.provider,
        configurationRevision: selection.configurationRevision,
      });
      assertCurrent();
      const saved = await this.worker.call<GrowthReceipt>('completeGrowthSummary', {
        cancellation: task.cancellation.buffer,
        command: {
          ...input,
          requestId,
          output: response.content,
          provider: {
            ...selection,
            responseModel: response.model,
            responseId: response.responseId,
            generatedAt: new Date().toISOString(),
            durationMs: response.durationMs,
            usage: response.usage,
          },
        },
      });
      // Worker 的原子提交准入若先于取消获胜，草稿按事务保存；晚到取消不能撤销已保存数据。
      started = false;
      this.ledger.completeCall(requestId, {
        status: saved.ok ? 'success' : 'failed',
        ...(saved.ok ? {} : { errorCode: saved.error.code }),
        responseId: response.responseId,
        responseModel: response.model,
        durationMs: Date.now() - startedAt,
        usage: response.usage ?? undefined,
      });
      return saved;
    } catch (error) {
      const metadata =
        response ?? (error instanceof DeepSeekGenerationError ? error.response : undefined);
      if (started) {
        this.ledger.completeCall(requestId, {
          status: 'failed',
          errorCode: error instanceof DomainError ? error.code : 'UNKNOWN',
          durationMs: Date.now() - startedAt,
          ...(metadata
            ? {
                responseId: metadata.responseId,
                responseModel: metadata.model,
                usage: metadata.usage ?? undefined,
              }
            : {}),
        });
      }
      throw error;
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }
}
