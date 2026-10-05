import { defaultModelSelection } from '../core/model-runtime';
import type { ModelKind, ModelSelection } from '../shared/model-providers';
import { randomUUID } from 'node:crypto';
import { epochInput, type Result } from '../shared/contracts';
import {
  explanationTokenInput,
  type ExplanationDraftReceipt,
  type ExplanationPreparation,
} from '../shared/explanation-drafts';
import type { ExplanationPacket } from '../shared/score-explanation';
import { explanationMessages } from '../core/score-explanation';
import { DomainError } from '../core/errors';
import {
  type DeepSeekClient,
  type DeepSeekCredentialStore,
  type DeepSeekLedger,
} from '../core/deepseek';
import type { DeepSeekGenerationResult } from '../core/deepseek/types';
import type { WorkerClient } from './worker-client';
import { DeepSeekGenerationError } from '../core/deepseek/client';

/** Main owns network lifetime; the serial data worker only prepares and commits local records. */
export class ExplanationRunner {
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

  prepare(raw: unknown): Promise<Result<ExplanationPreparation>> {
    epochInput.strip().parse(raw);
    if (this.active) throw new DomainError('BUSY', '解释生成尚未结束，请先取消或等待。');
    // The book invalidates the preceding token before validating the replacement selection.
    return this.worker.call('prepareExplanation', raw);
  }

  cancel(raw: unknown): Promise<Result<void>> {
    const input = epochInput.parse(raw);
    if (this.active?.epoch === input.epoch) this.invalidate();
    return this.worker.call('cancelExplanation', input);
  }

  async generate(raw: unknown): Promise<Result<ExplanationDraftReceipt>> {
    const input = explanationTokenInput.parse(raw);
    if (this.active) throw new DomainError('BUSY', '解释生成尚未结束，请勿重复提交。');
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
        throw new DomainError('ABORTED', '解释生成已取消或配置已变更，返回内容未保存。');
    };
    try {
      const claimed = await this.worker.call<ExplanationPacket>('claimExplanation', {
        ...input,
        requestId,
      });
      if (!claimed.ok) return claimed;
      assertCurrent();
      const selection = this.selectModel('text');
      const apiKey = this.credentials.loadKey();
      const messages = explanationMessages(claimed.value);
      this.ledger.startCall({
        id: requestId,
        timestamp: new Date().toISOString(),
        type: 'score_explanation',
        ...selection,
        status: 'in_progress',
        durationMs: 0,
        promptVersion: claimed.value.promptVersion,
      });
      started = true;
      response = await this.client.generateText(apiKey, messages, {
        signal: task.controller.signal,
        model: selection.requestModel,
        provider: selection.provider,
        configurationRevision: selection.configurationRevision,
      });
      assertCurrent();
      const saved = await this.worker.call<ExplanationDraftReceipt>('completeExplanation', {
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
      // Atomic commit admission wins over subsequent cancellation; it never undoes saved data.
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
