import { defaultModelSelection } from '../core/model-runtime';
import type { ModelKind, ModelSelection } from '../shared/model-providers';
import { randomUUID } from 'node:crypto';
import { epochInput, type Result } from '../shared/contracts';
import {
  GRADING_PROMPT_VERSION,
  gradingGenerateInput,
  gradingPagePreviewInput,
  type GradingPagePreview,
  type GradingDraftView,
  type GradingRevisionView,
  type GradingPreparationView,
  type GradingReceipt,
} from '../shared/grading-records';
import { DomainError } from '../core/errors';
import { gradingDigest } from '../core/grading-records';
import { gradingMessages } from '../core/grading-model';
import type { GradingPreparation } from '../core/grading';
import {
  type DeepSeekClient,
  type DeepSeekCredentialStore,
  type DeepSeekLedger,
} from '../core/deepseek';
import { DeepSeekGenerationError } from '../core/deepseek/client';
import type { DeepSeekGenerationResult, DeepSeekLessonMessage } from '../core/deepseek/types';
import type { WorkerClient } from './worker-client';
import type { MaterialTaskRunner } from './material-task';
import type { StoredMaterial } from '../shared/material-records';

/** Main 持有实际外发字节和网络生命周期；worker 持有来源、认领、校验与提交。
 * 准备不付费；确认完整数据包后单次调用，不自动重试。取消/凭据/恢复变化拒绝迟到结果。
 * 内部认领/完成/结束不向 Renderer 暴露；失败保留草案并结束尝试，重开不恢复网络。 */
export class GradingRunner {
  private generation = 0;
  private preparing?: { epoch: string; controller: AbortController };
  private prepared?: {
    epoch: string;
    token: string;
    expiresAt: number;
    fingerprint: string;
    requestHash: string;
    wireHash: string;
    messages: DeepSeekLessonMessage[];
  };
  private active?: { epoch: string; controller: AbortController; cancellation: Int32Array };
  constructor(
    private readonly worker: Pick<WorkerClient, 'call'>,
    private readonly client: Pick<DeepSeekClient, 'generateGrading'>,
    private readonly credentials: Pick<DeepSeekCredentialStore, 'loadKey'>,
    private readonly ledger: Pick<DeepSeekLedger, 'startCall' | 'completeCall'>,
    private readonly images: Pick<MaterialTaskRunner, 'gradingImage'>,
    private readonly selectModel: (kind: ModelKind) => ModelSelection = defaultModelSelection,
  ) {}
  get busy() {
    return !!this.preparing || !!this.active;
  }
  invalidate() {
    this.generation++;
    this.prepared = undefined;
    this.preparing?.controller.abort();
    if (this.active) Atomics.compareExchange(this.active.cancellation, 0, 0, 1);
    this.active?.controller.abort();
  }
  /** 当前、冻结或指定历史修订的单页本地衍生图，用于人工证据定位；无需付费令牌或网络。
   * 仅采用后台不可变页面描述，复用可取消的有界子进程；不改草案，不自动重试。 */
  async previewPage(raw: unknown): Promise<Result<GradingPagePreview>> {
    const input = gradingPagePreviewInput.parse(raw);
    if (this.busy) throw new DomainError('BUSY', '阅卷图像或生成任务尚未结束。');
    const task = { epoch: input.epoch, controller: new AbortController() };
    this.preparing = task;
    const current = () => {
      if (task.controller.signal.aborted) throw new DomainError('ABORTED', '图像预览已取消。');
    };
    try {
      const draft = await this.worker.call<GradingDraftView>('readGrading', {
        epoch: input.epoch,
        id: input.id,
      });
      if (!draft.ok) return draft;
      let payload = draft.value.payload;
      if (input.revision !== undefined) {
        const history = await this.worker.call<GradingRevisionView[]>('gradingHistory', {
          epoch: input.epoch,
          id: input.id,
          revision: input.revision,
        });
        if (!history.ok) return history;
        const entry = history.value[0];
        if (!entry) throw new DomainError('NOT_FOUND', '答卷历史修订不存在。');
        payload = entry.payload;
      }
      const page = payload.request.pages.find((page) => page.id === input.pageId);
      if (!page) throw new DomainError('NOT_FOUND', '页面不属于此答卷。');
      const source = await this.worker.call<StoredMaterial>('readMaterial', {
        epoch: input.epoch,
        id: page.sourceVersionId,
      });
      if (!source.ok) return source;
      const fragment = source.value.version.fragments.find(
        (fragment) => fragment.id === page.fragmentId,
      );
      if (!fragment || fragment.kind !== 'image')
        throw new DomainError('GRADING_INVALID', '答卷原图不存在。');
      const asset = await this.worker.call<{ bytes: Uint8Array; mime: string }>(
        'readMaterialAsset',
        { epoch: input.epoch, id: page.sourceVersionId, assetId: fragment.assetId },
      );
      if (!asset.ok) return asset;
      current();
      if (asset.value.mime !== 'image/png')
        throw new DomainError('GRADING_INVALID', '答卷原图格式无效。');
      const image = await this.images.gradingImage(
        Buffer.from(asset.value.bytes),
        { page, width: fragment.width, height: fragment.height },
        task.controller.signal,
      );
      current();
      return {
        ok: true,
        value: {
          pageId: page.id,
          width: image.width,
          height: image.height,
          dataUrl: 'data:' + 'image/jpeg;base64,' + image.bytes.toString('base64'),
        },
      };
    } finally {
      if (this.preparing === task) this.preparing = undefined;
    }
  }
  async prepare(raw: unknown): Promise<Result<GradingPreparationView>> {
    const { epoch } = epochInput.strip().parse(raw);
    if (this.busy) throw new DomainError('BUSY', '阅卷准备或生成尚未结束。');
    this.prepared = undefined;
    const task = { epoch, controller: new AbortController() };
    this.preparing = task;
    const generation = ++this.generation;
    const current = () => {
      if (task.controller.signal.aborted || generation !== this.generation)
        throw new DomainError('ABORTED', '阅卷准备已取消或配置已变化。');
    };
    try {
      const result = await this.worker.call<{
        token: string;
        expiresAt: string;
        preparation: GradingPreparation;
      }>('prepareGrading', raw);
      if (!result.ok) return result;
      current();
      const { token, expiresAt, preparation } = result.value;
      const images = [];
      for (const page of preparation.pages) {
        if (!preparation.request.selectedPageIds.includes(page.id)) continue;
        const asset = await this.worker.call<{ bytes: Uint8Array; mime: string }>(
          'readMaterialAsset',
          { epoch, id: page.sourceVersionId, assetId: page.assetId },
        );
        if (!asset.ok) throw new DomainError(asset.error.code, asset.error.message);
        current();
        if (asset.value.mime !== 'image/png')
          throw new DomainError('GRADING_INVALID', '所选原图不是登记的标准化 PNG。');
        images.push({
          pageId: page.id,
          image: await this.images.gradingImage(
            Buffer.from(asset.value.bytes),
            {
              page: preparation.request.pages.find((entry) => entry.id === page.id),
              width: page.width,
              height: page.height,
            },
            task.controller.signal,
          ),
        });
        current();
      }
      const packet = gradingMessages(preparation, images);
      current();
      this.prepared = {
        epoch,
        token,
        expiresAt: Date.parse(expiresAt),
        fingerprint: preparation.fingerprint,
        requestHash: gradingDigest(preparation.request),
        wireHash: packet.wireHash,
        messages: packet.messages,
      };
      return {
        ok: true,
        value: {
          token,
          expiresAt,
          inputHash: preparation.fingerprint,
          wireHash: packet.wireHash,
          questionIds: preparation.request.selectedQuestionIds,
          missingAnswerPages: preparation.missingAnswerPages,
          images: packet.images,
        },
      };
    } finally {
      if (this.preparing === task) this.preparing = undefined;
    }
  }
  cancel(raw: unknown) {
    const input = epochInput.parse(raw);
    if ([this.active?.epoch, this.preparing?.epoch, this.prepared?.epoch].includes(input.epoch))
      this.invalidate();
    return this.worker.call<void>('cancelGrading', input);
  }
  async generate(raw: unknown): Promise<Result<GradingReceipt>> {
    const input = gradingGenerateInput.parse(raw);
    if (this.busy) throw new DomainError('BUSY', '阅卷准备或生成尚未结束，请勿重复提交。');
    const prepared = this.prepared;
    if (
      !prepared ||
      prepared.epoch !== input.epoch ||
      prepared.token !== input.token ||
      prepared.wireHash !== input.wireHash ||
      Date.now() >= prepared.expiresAt
    )
      throw new DomainError('GRADING_EXPIRED', '外发预览确认已失效，请重新准备。');
    const task = {
      epoch: input.epoch,
      controller: new AbortController(),
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
    };
    this.active = task;
    this.prepared = undefined;
    const command = { epoch: input.epoch, token: input.token, requestId: randomUUID() };
    const startedAt = Date.now();
    let claimed = false;
    let ledgerStarted = false;
    let ledgerEnded = false;
    let response: DeepSeekGenerationResult | undefined;
    const current = () => {
      if (task.controller.signal.aborted)
        throw new DomainError('ABORTED', '阅卷已取消或工作区/凭据已变化，返回内容未采用。');
    };
    const finishLedger = (success: boolean, code?: string) => {
      if (!ledgerStarted || ledgerEnded) return;
      ledgerEnded = true;
      this.ledger.completeCall(command.requestId, {
        status: success ? 'success' : 'failed',
        ...(code ? { errorCode: code } : {}),
        durationMs: Date.now() - startedAt,
        ...(response
          ? {
              responseId: response.responseId,
              responseModel: response.model,
              usage: response.usage ?? undefined,
            }
          : {}),
      });
    };
    try {
      const claim = await this.worker.call<GradingPreparation>('claimGrading', command);
      if (!claim.ok) return claim;
      claimed = true;
      current();
      if (
        claim.value.fingerprint !== prepared.fingerprint ||
        gradingDigest(claim.value.request) !== prepared.requestHash
      )
        throw new DomainError('GRADING_STALE', '认领来源与已确认外发范围不一致。');
      const selection = this.selectModel('vision');
      const apiKey = this.credentials.loadKey();
      this.ledger.startCall({
        id: command.requestId,
        timestamp: new Date().toISOString(),
        type: 'grading',
        ...selection,
        status: 'in_progress',
        durationMs: 0,
        promptVersion: GRADING_PROMPT_VERSION,
      });
      ledgerStarted = true;
      response = await this.client.generateGrading(apiKey, prepared.messages, {
        signal: task.controller.signal,
        model: selection.requestModel,
        provider: selection.provider,
        configurationRevision: selection.configurationRevision,
      });
      current();
      const saved = await this.worker.call<GradingReceipt>('completeGrading', {
        cancellation: task.cancellation.buffer,
        command: {
          ...command,
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
      finishLedger(saved.ok, saved.ok ? undefined : saved.error.code);
      if (!saved.ok) {
        const ended = await this.worker.call('endGrading', {
          epoch: input.epoch,
          requestId: command.requestId,
          status: task.controller.signal.aborted ? 'cancelled' : 'failed',
          errorCode: saved.error.code,
        });
        if (!ended.ok) return ended;
      }
      claimed = false;
      return saved;
    } catch (error) {
      if (!response && error instanceof DeepSeekGenerationError)
        response = { ...error.response, content: '' };
      const code = error instanceof DomainError ? error.code : 'UNKNOWN';
      let failure = error;
      try {
        finishLedger(false, code);
      } catch (ledgerError) {
        // 账本磁盘错误不能跳过数据库尝试收尾；请求不重发，教师重开核对两处记录。
        failure = ledgerError;
      }
      if (claimed) {
        const ended = await this.worker.call('endGrading', {
          epoch: input.epoch,
          requestId: command.requestId,
          status: task.controller.signal.aborted ? 'cancelled' : 'failed',
          errorCode: code,
        });
        if (!ended.ok) return ended;
      }
      throw failure;
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }
}
