import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from './errors';
import { atomicWrite } from './files';
import {
  DeepSeekClient,
  DEFAULT_BASE_URL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
} from './deepseek/client';
import { DeepSeekCredentialStore, type CryptoProvider } from './deepseek/credentials';
import { DeepSeekLedger } from './deepseek/ledger';
import type {
  DeepSeekCheckOptions,
  DeepSeekCallRecord,
  DeepSeekLessonMessage,
  DeepSeekGenerationResult,
} from './deepseek/types';
import {
  modelName,
  modelProviderId,
  modelConfigurationInput,
  modelKeyInput,
  modelProviderInput,
  selectModelProviderInput,
  modelCheckPreparationInput,
  modelCheckConfirmationInput,
  type ModelKind,
  type ModelProviderId,
  type ModelSelection,
  type ModelSettingsView,
  type ModelCheckPreparation,
  type ModelCheckReceipt,
  type ModelLedgerView,
} from '../shared/model-providers';

const presets = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: DEFAULT_BASE_URL,
    textModel: DEFAULT_TEXT_MODEL,
    visionModel: DEFAULT_VISION_MODEL,
  },
  kimi: {
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    textModel: 'kimi-k2.6',
    visionModel: 'kimi-k2.6',
  },
  doubao: {
    label: '豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    textModel: '',
    visionModel: '',
  },
} satisfies Record<
  ModelProviderId,
  { label: string; baseUrl: string; textModel: string; visionModel: string }
>;
const config = z
  .object({
    textModel: z.union([modelName, z.literal('')]),
    visionModel: z.union([modelName, z.literal('')]),
    contextWindowTokens: z.number().int().min(32768).max(1_000_000).optional(),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    revision: z.uuid(),
    selectedProvider: modelProviderId,
    providers: z.object({ deepseek: config, kimi: config, doubao: config }).strict(),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
const hash = (body: string) => createHash('sha256').update(body).digest('hex');

/** 旧DeepSeek调用方的默认来源；新Main注入实际所选供应商。无网络或凭据读取。 */
export const defaultModelSelection = (kind: ModelKind): ModelSelection => ({
  provider: 'deepseek',
  requestModel: kind === 'vision' ? DEFAULT_VISION_MODEL : DEFAULT_TEXT_MODEL,
});
export const messageModelKind = (messages: DeepSeekLessonMessage[]): ModelKind =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))
    ? 'vision'
    : 'text';

/** 多供应商深模块拥有配置/凭据/用量隔离、确切选择、固定传输预设和单次检查。
 * 不自动请求、不回退、不重试；Main负责先取消旧任务及准备再配置。文件位于业务库外，Key不进入备份。 */
export class ModelRuntime {
  private manifest: Manifest;
  private readonly path: string;
  private readonly stores: Record<ModelProviderId, DeepSeekCredentialStore>;
  private readonly ledgers: Record<ModelProviderId, DeepSeekLedger>;
  private readonly calls = new Map<string, ModelProviderId>();
  private readonly completedCalls = new Map<string, ModelProviderId>();
  private preparation?: ModelCheckPreparation;
  private checkController?: AbortController;
  constructor(
    root: string,
    crypto: CryptoProvider,
    private readonly customFetch?: typeof fetch,
  ) {
    this.path = join(root, 'model-providers.json');
    this.manifest = existsSync(this.path)
      ? manifestSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : {
          version: 1,
          revision: randomUUID(),
          selectedProvider: 'deepseek',
          providers: {
            deepseek: {
              textModel: presets.deepseek.textModel,
              visionModel: presets.deepseek.visionModel,
            },
            kimi: { textModel: presets.kimi.textModel, visionModel: presets.kimi.visionModel },
            doubao: { textModel: '', visionModel: '' },
          },
        };
    // 首次创建持久revision，避免不同窗口/重开把不同准备误当同一配置。
    if (!existsSync(this.path)) atomicWrite(this.path, JSON.stringify(this.manifest, null, 2));
    this.stores = {
      deepseek: new DeepSeekCredentialStore(root, crypto, 'deepseek'),
      kimi: new DeepSeekCredentialStore(root, crypto, 'kimi'),
      doubao: new DeepSeekCredentialStore(root, crypto, 'doubao'),
    };
    this.ledgers = {
      deepseek: new DeepSeekLedger(root, 'deepseek'),
      kimi: new DeepSeekLedger(root, 'kimi'),
      doubao: new DeepSeekLedger(root, 'doubao'),
    };
  }
  get busy() {
    return !!this.checkController;
  }
  private store(manifest: Manifest) {
    atomicWrite(this.path, JSON.stringify(manifest, null, 2));
    this.manifest = manifest;
  }
  private revision(raw: string) {
    if (raw !== this.manifest.revision)
      throw new DomainError('CONFLICT', '模型配置已变化，请刷新并重新核对。');
  }
  private client(provider: ModelProviderId) {
    return new DeepSeekClient({
      baseUrl: presets[provider].baseUrl,
      protocol: provider,
      customFetch: this.customFetch,
    });
  }
  /** 脱敏只读设置；文本/图像能力未配置或未验证，不把接口兼容当作账号权限。 */
  settings(): ModelSettingsView {
    return {
      revision: this.manifest.revision,
      selectedProvider: this.manifest.selectedProvider,
      providers: modelProviderId.options.map((provider) => ({
        provider,
        label: presets[provider].label,
        baseUrl: presets[provider].baseUrl,
        ...this.manifest.providers[provider],
        credentials: this.stores[provider].getStatus(),
        capabilities: {
          text: this.manifest.providers[provider].textModel ? 'unverified' : 'unconfigured',
          vision: this.manifest.providers[provider].visionModel ? 'unverified' : 'disabled',
        },
      })),
    };
  }
  /** CAS保存型号，无网络；图像留空表示禁止图像调用。调用前Main须已撤销所有旧准备/在途请求。 */
  configure(raw: unknown): ModelSettingsView {
    const input = modelConfigurationInput.parse(raw);
    this.revision(input.expectedRevision);
    if (
      input.provider === 'kimi' &&
      [input.textModel, input.visionModel]
        .filter(Boolean)
        .some((m) => !['kimi-k2.6', 'kimi-k3'].includes(m))
    )
      throw new DomainError('MODEL_UNSUPPORTED', '当前Kimi配置只支持kimi-k2.6或kimi-k3。');
    this.invalidate();
    this.store({
      ...this.manifest,
      revision: randomUUID(),
      providers: {
        ...this.manifest.providers,
        [input.provider]: {
          textModel: input.textModel,
          visionModel: input.visionModel,
          ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
        },
      },
    });
    return this.settings();
  }
  /** CAS选择已声明供应商；未配置仍允许选择，但调用拒绝，不会自动回退到其他账号。 */
  select(raw: unknown): ModelSettingsView {
    const input = selectModelProviderInput.parse(raw);
    this.revision(input.expectedRevision);
    this.invalidate();
    this.store({ ...this.manifest, revision: randomUUID(), selectedProvider: input.provider });
    return this.settings();
  }
  /** 指定供应商Key仅本地加密保存；不读旧Key/不联网，写入失败拒绝明文。 */
  saveKey(raw: unknown): ModelSettingsView {
    const input = modelKeyInput.parse(raw);
    this.invalidate();
    this.stores[input.provider].saveKey(input.apiKey);
    this.store({ ...this.manifest, revision: randomUUID() });
    return this.settings();
  }
  /** 删除指定Key并失效本模块检查，不删除用量或既有业务原稿。 */
  deleteKey(raw: unknown): ModelSettingsView {
    const input = modelProviderInput.parse(raw);
    this.invalidate();
    this.stores[input.provider].deleteKey();
    this.store({ ...this.manifest, revision: randomUUID() });
    return this.settings();
  }
  /** 当前供应商确切型号/revision；缺型号或图像未声明拒绝，无网络/Key读取。 */
  selection(kind: ModelKind): ModelSelection {
    const provider = this.manifest.selectedProvider,
      requestModel =
        this.manifest.providers[provider][kind === 'text' ? 'textModel' : 'visionModel'];
    if (!requestModel)
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        kind === 'vision'
          ? '所选供应商未配置图像型号，图像外发已拒绝。'
          : '所选供应商未配置文本型号，请填写Model/Endpoint ID。',
      );
    return {
      provider,
      requestModel,
      configurationRevision: this.manifest.revision,
      ...(this.manifest.providers[provider].contextWindowTokens
        ? { contextWindowTokens: this.manifest.providers[provider].contextWindowTokens }
        : {}),
    };
  }
  /** 仅Main内部取当前Key，返回值禁止进入Renderer/日志/备份；未配置/加密故障拒绝。 */
  loadKey(): string {
    return this.stores[this.manifest.selectedProvider].loadKey();
  }
  private selected(options: DeepSeekCheckOptions | undefined, kind: ModelKind) {
    const current = this.selection(kind);
    if (
      (options?.provider !== undefined && options.provider !== current.provider) ||
      (options?.configurationRevision !== undefined &&
        options.configurationRevision !== current.configurationRevision) ||
      (options?.model !== undefined && options.model !== current.requestModel)
    )
      throw new DomainError('ABORTED', '模型配置已变化，旧请求未外发。');
    return current;
  }
  /** 当前型号/版本的确切有界文本JSON及endpoint，无网络/Key读取；供外发前预览。 */
  previewText(messages: Parameters<DeepSeekClient['generateText']>[1]) {
    const selection = this.selection('text');
    return {
      selection,
      endpoint: presets[selection.provider].baseUrl + '/chat/completions',
      body: JSON.stringify(
        this.client(selection.provider).textBody(selection.requestModel, messages),
      ),
    };
  }

  previewConversation(
    messages: Parameters<DeepSeekClient['conversationBody']>[1],
    tools: unknown[],
  ) {
    const selection = this.selection('text');
    return {
      selection,
      endpoint: presets[selection.provider].baseUrl + '/chat/completions',
      body: JSON.stringify(
        this.client(selection.provider).conversationBody(selection.requestModel, messages, tools),
      ),
    };
  }
  generateConversation(
    key: string,
    messages: Parameters<DeepSeekClient['conversationBody']>[1],
    tools: unknown[],
    options: DeepSeekCheckOptions | undefined,
    update: Parameters<DeepSeekClient['generateConversation']>[4],
  ) {
    const selected = this.selected(options, 'text');
    return this.client(selected.provider).generateConversation(
      key,
      messages,
      tools,
      { ...options, model: selected.requestModel },
      update,
    );
  }

  /** 确切当前选择的有界文本传输；无回退/重试，不调用业务工具，业务输出另行校验。 */
  generateText(
    key: string,
    messages: Parameters<DeepSeekClient['generateText']>[1],
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekGenerationResult> {
    const selected = this.selected(options, 'text');
    return this.client(selected.provider).generateText(key, messages, {
      ...options,
      model: selected.requestModel,
    });
  }
  /** 使用本地已批准图片/文本对应型号；没有图像配置时拒绝，输出只供备课草稿。 */
  generateLesson(
    key: string,
    messages: DeepSeekLessonMessage[],
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekGenerationResult> {
    const selected = this.selected(options, messageModelKind(messages));
    return this.client(selected.provider).generateLesson(key, messages, {
      ...options,
      model: selected.requestModel,
    });
  }
  /** 仅指定图像型号的答卷传输；复用图像/输出上限，不自动入分或再次收费。 */
  generateGrading(
    key: string,
    messages: DeepSeekLessonMessage[],
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekGenerationResult> {
    const selected = this.selected(options, 'vision');
    return this.client(selected.provider).generateGrading(key, messages, {
      ...options,
      model: selected.requestModel,
    });
  }
  /** 副作用前把exact provider/revision/model记入其独立账本；开始失败不得请求模型。 */
  startCall(record: DeepSeekCallRecord): void {
    if (this.calls.has(record.id) || this.completedCalls.has(record.id))
      throw new DomainError('CONFLICT', '模型调用ID已使用，禁止重复外发。');
    if (this.calls.size >= 256)
      throw new DomainError('LEDGER_LIMIT', '待核对模型账本已达会话上限，请先核对已有结果。');
    const provider = record.provider ?? this.manifest.selectedProvider;
    this.ledgers[provider].startCall(record);
    this.calls.set(record.id, provider);
  }
  /** 按原调用ID完成原供应商账本，即使当前选择已变化；已知用量保留，未知不写0。 */
  completeCall(id: string, update: Parameters<DeepSeekLedger['completeCall']>[1]): void {
    const provider = this.calls.get(id) ?? this.completedCalls.get(id);
    if (!provider)
      throw new DomainError('LEDGER_CALL_MISSING', '未找到原模型调用的供应商账本，禁止重发。');
    this.ledgers[provider].completeCall(id, update);
    this.calls.delete(id);
    this.completedCalls.set(id, provider);
    if (this.completedCalls.size > 200)
      this.completedCalls.delete(this.completedCalls.keys().next().value!);
  }
  /** 只读指定供应商用量；不读取Key/不查询供应商余额，不把Token换算为假定费用。 */
  ledger(raw: unknown): ModelLedgerView {
    const { provider } = modelProviderInput.parse(raw);
    return { provider, summary: this.ledgers[provider].getSummary() };
  }
  /** 当前revision准备固定合成外发的exact JSON，不联网；新准备撤销旧token。 */
  prepareCheck(raw: unknown): ModelCheckPreparation {
    this.preparation = undefined;
    const input = modelCheckPreparationInput.parse(raw);
    this.revision(input.expectedRevision);
    if (this.busy) throw new DomainError('BUSY', '模型检查尚未结束，请先取消或等待。');
    const selected = this.selection(input.type),
      body = JSON.stringify(
        this.client(selected.provider).checkBody(input.type, selected.requestModel),
      );
    this.preparation = {
      token: randomUUID(),
      revision: this.manifest.revision,
      provider: selected.provider,
      model: selected.requestModel,
      endpoint: presets[selected.provider].baseUrl + '/chat/completions',
      type: input.type,
      body,
      wireHash: hash(body),
    };
    return { ...this.preparation };
  }
  /** 明确确认exact token/revision/hash才执行一次检查；消费token，即使回包不明也不自动重复。 */
  async check(raw: unknown): Promise<ModelCheckReceipt> {
    const input = modelCheckConfirmationInput.parse(raw);
    this.revision(input.revision);
    if (this.busy) throw new DomainError('BUSY', '模型检查尚未结束，请先取消或等待。');
    const prepared = this.preparation;
    if (
      !prepared ||
      prepared.token !== input.token ||
      prepared.wireHash !== input.wireHash ||
      prepared.revision !== input.revision
    )
      throw new DomainError('CONFLICT', '检查准备已失效，请重新预览。');
    this.preparation = undefined;
    const key = this.loadKey(),
      controller = new AbortController(),
      id = randomUUID(),
      started = Date.now();
    this.checkController = controller;
    let recorded = false;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      this.startCall({
        id,
        timestamp: new Date().toISOString(),
        type: prepared.type === 'text' ? 'text_check' : 'vision_check',
        provider: prepared.provider,
        configurationRevision: prepared.revision,
        requestModel: prepared.model,
        status: 'in_progress',
        durationMs: 0,
        promptVersion: prepared.type === 'text' ? 'ping-v1' : 'synthetic-1x1-v1',
      });
      recorded = true;
      const client = this.client(prepared.provider),
        options = { model: prepared.model, signal: controller.signal };
      const result = await (prepared.type === 'text'
        ? client.checkTextConnection(key, options)
        : client.checkVisionConnection(key, options));
      this.completeCall(id, {
        status: controller.signal.aborted ? 'failed' : 'success',
        ...(controller.signal.aborted ? { errorCode: 'ABORTED' } : {}),
        responseId: result.responseId,
        responseModel: result.model,
        durationMs: result.durationMs,
        usage: result.usage ?? undefined,
      });
      recorded = false;
      if (controller.signal.aborted || this.manifest.revision !== prepared.revision)
        throw new DomainError('ABORTED', '模型检查已取消或配置已改变，旧结果未采用。');
      return { provider: prepared.provider, revision: prepared.revision, result };
    } catch (error) {
      if (recorded)
        this.completeCall(id, {
          status: 'failed',
          errorCode: error instanceof DomainError ? error.code : 'UNKNOWN',
          durationMs: Date.now() - started,
        });
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.checkController === controller) this.checkController = undefined;
    }
  }
  /** 清除检查准备并取消在途检查；实际供应商可能已计费，保留原账本，不能冒充未发送。 */
  invalidate(): void {
    this.preparation = undefined;
    this.checkController?.abort();
  }
}
