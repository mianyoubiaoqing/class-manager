import { defaultModelSelection, messageModelKind } from '../core/model-runtime';
import type { ModelKind, ModelSelection } from '../shared/model-providers';
import { randomUUID } from 'node:crypto';
import { epochInput, type Result } from '../shared/contracts';
import {
  LESSON_PROMPT_VERSION,
  lessonTokenInput,
  type LessonReceipt,
  type LessonPreparationView,
} from '../shared/lesson-records';
import { DomainError } from '../core/errors';
import {
  type DeepSeekClient,
  type DeepSeekCredentialStore,
  type DeepSeekLedger,
} from '../core/deepseek';
import { DeepSeekGenerationError } from '../core/deepseek/client';
import type { DeepSeekGenerationResult, DeepSeekLessonMessage } from '../core/deepseek/types';
import type { LessonPreparation } from '../core/lesson-drafting';
import { lessonMessages } from '../core/lesson-model';
import type { WorkerClient } from './worker-client';
import type { MaterialTaskRunner } from './material-task';

/** Main owns the approved minimal wire packet and one network lifetime; the data worker owns
 * source snapshots and commit admission. No file originals, private notes or unselected material
 * enter the network packet. Nothing resumes or retries automatically after cancel/restart. */
export class LessonRunner {
  private preparing = false;
  private preparingEpoch?: string;
  private preparationController?: AbortController;
  private generation = 0;
  private prepared?: {
    epoch: string;
    token: string;
    fingerprint: string;
    expiresAt: number;
    messages: DeepSeekLessonMessage[];
  };
  private active?: { epoch: string; controller: AbortController; cancellation: Int32Array };
  constructor(
    private readonly worker: Pick<WorkerClient, 'call'>,
    private readonly client: Pick<DeepSeekClient, 'generateLesson'>,
    private readonly credentials: Pick<DeepSeekCredentialStore, 'loadKey'>,
    private readonly ledger: Pick<DeepSeekLedger, 'startCall' | 'completeCall'>,
    private readonly images: Pick<MaterialTaskRunner, 'modelImage'>,
    private readonly selectModel: (kind: ModelKind) => ModelSelection = defaultModelSelection,
  ) {}
  get busy() {
    return this.active !== undefined || this.preparing;
  }
  invalidate() {
    this.generation++;
    this.prepared = undefined;
    this.preparationController?.abort();
    if (this.active) Atomics.compareExchange(this.active.cancellation, 0, 0, 1);
    this.active?.controller.abort();
  }
  async prepare(raw: unknown): Promise<Result<LessonPreparationView>> {
    const { epoch } = epochInput.strip().parse(raw);
    if (this.busy) throw new DomainError('BUSY', '备课准备或生成尚未结束。');
    this.prepared = undefined;
    this.preparing = true;
    this.preparingEpoch = epoch;
    const controller = new AbortController();
    this.preparationController = controller;
    const generation = ++this.generation;
    const current = () => {
      if (controller.signal.aborted || generation !== this.generation)
        throw new DomainError('ABORTED', '备课准备已取消或配置已变化。');
    };
    try {
      const result = await this.worker.call<{
        token: string;
        expiresAt: string;
        preparation: LessonPreparation;
      }>('prepareLesson', raw);
      if (!result.ok) return result;
      current();
      const { token, expiresAt, preparation } = result.value;
      const messages = await lessonMessages(preparation, async (id, assetId) => {
        current();
        const asset = await this.worker.call<{ bytes: Uint8Array; mime: string }>(
          'readMaterialAsset',
          { epoch, id, assetId },
        );
        if (!asset.ok) throw new DomainError(asset.error.code, asset.error.message);
        if (asset.value.mime !== 'image/png')
          throw new DomainError('LESSON_INVALID', '所选模型图像不是标准化 PNG。');
        current();
        const image = await this.images.modelImage(
          Buffer.from(asset.value.bytes),
          controller.signal,
        );
        current();
        return image.bytes;
      });
      if (generation !== this.generation)
        throw new DomainError('ABORTED', '备课准备已取消或配置已变化。');
      this.prepared = {
        epoch,
        token,
        expiresAt: Date.parse(expiresAt),
        fingerprint: preparation.fingerprint,
        messages,
      };
      return {
        ok: true,
        value: {
          token,
          expiresAt,
          inputHash: preparation.fingerprint,
          textCharacters: preparation.sources.reduce(
            (sum, source) =>
              sum +
              source.fragments.reduce((n, f) => n + (f.kind === 'text' ? f.text.length : 0), 0),
            0,
          ),
          images: preparation.sources.reduce(
            (sum, source) =>
              sum + source.fragments.filter((fragment) => fragment.kind === 'image').length,
            0,
          ),
          sources: preparation.sources.map((source) => ({
            sourceVersionId: source.sourceVersionId,
            fragmentIds: source.fragments.map((fragment) => fragment.id),
          })),
        },
      };
    } finally {
      this.preparing = false;
      this.preparingEpoch = undefined;
      if (this.preparationController === controller) this.preparationController = undefined;
    }
  }
  cancel(raw: unknown) {
    const input = epochInput.parse(raw);
    if (
      this.active?.epoch === input.epoch ||
      this.prepared?.epoch === input.epoch ||
      this.preparingEpoch === input.epoch
    )
      this.invalidate();
    return this.worker.call<void>('cancelLesson', input);
  }
  async generate(raw: unknown): Promise<Result<LessonReceipt>> {
    const input = lessonTokenInput.parse(raw);
    if (this.busy) throw new DomainError('BUSY', '备课准备或生成尚未结束，请勿重复提交。');
    const prepared = this.prepared;
    if (
      !prepared ||
      prepared.epoch !== input.epoch ||
      prepared.token !== input.token ||
      Date.now() >= prepared.expiresAt
    )
      throw new DomainError('LESSON_EXPIRED', '范围确认已失效，请重新准备。');
    const task = {
      epoch: input.epoch,
      controller: new AbortController(),
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
    };
    this.active = task;
    this.prepared = undefined;
    const requestId = randomUUID();
    const startedAt = Date.now();
    let started = false;
    let response: DeepSeekGenerationResult | undefined;
    const current = () => {
      if (task.controller.signal.aborted)
        throw new DomainError('ABORTED', '备课生成已取消或工作区/凭据已变化，返回内容未保存。');
    };
    try {
      const claimed = await this.worker.call<LessonPreparation>('claimLesson', {
        ...input,
        requestId,
      });
      if (!claimed.ok) return claimed;
      current();
      if (claimed.value.fingerprint !== prepared.fingerprint)
        throw new DomainError('LESSON_INVALID', '生成来源与已确认范围不一致。');
      const selection = this.selectModel(messageModelKind(prepared.messages));
      const apiKey = this.credentials.loadKey();
      this.ledger.startCall({
        id: requestId,
        timestamp: new Date().toISOString(),
        type: 'lesson_drafting',
        ...selection,
        status: 'in_progress',
        durationMs: 0,
        promptVersion: LESSON_PROMPT_VERSION,
      });
      started = true;
      response = await this.client.generateLesson(apiKey, prepared.messages, {
        signal: task.controller.signal,
        model: selection.requestModel,
        provider: selection.provider,
        configurationRevision: selection.configurationRevision,
      });
      current();
      const saved = await this.worker.call<LessonReceipt>('completeLesson', {
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
      if (started)
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
      throw error;
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }
}
