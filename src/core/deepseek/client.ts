import { z } from 'zod';
import { DomainError } from '../errors';
import {
  TEXT_PROMPT_VERSION,
  VISION_PROMPT_VERSION,
  type DeepSeekCheckOptions,
  type DeepSeekCheckResult,
  type DeepSeekTokenUsage,
  type DeepSeekGenerationResult,
  type DeepSeekLessonMessage,
} from './types';
import { awaitModelResponse, readBoundedResponse } from './bounded-response';
import type { ModelKind, ModelProviderId } from '../../shared/model-providers';
import { readConversationCompletion } from './conversation-stream';
import type { ConversationDiagnostic } from './conversation-diagnostics';
import type {
  DeepSeekTextMessage,
  ConversationModelResponse,
  ConversationStreamUpdate,
} from './types';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_TEXT_MODEL = 'deepseek-flash';
export const DEFAULT_VISION_MODEL = 'deepseek-flash';
export const GENERATION_TIMEOUT_MS = 60_000;

/** Safe billing metadata only; invalid/truncated response content must not enter errors or logs. */
export class DeepSeekGenerationError extends DomainError {
  constructor(
    message: string,
    readonly response: Omit<DeepSeekGenerationResult, 'content'>,
    readonly diagnostic?: ConversationDiagnostic,
  ) {
    super('INVALID_RESPONSE', message);
  }
}

// 1x1 像素微型透明合成 PNG，用于验证 Vision 多模态接口，消耗极少 token
export const SYNTHETIC_TEST_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const chatCompletionSuccessSchema = z
  .object({
    id: z.string().trim().min(1, '返回数据缺少响应 ID'),
    model: z.string().trim().min(1, '返回数据缺少模型名称'),
    choices: z
      .array(
        z
          .object({
            message: z.object({
              content: z.string().trim().min(1, '模型返回正文不能为空'),
              role: z.string().optional().nullable(),
            }),
          })
          .passthrough(),
      )
      .min(1, 'choices 列表不能为空'),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional().nullable(),
        completion_tokens: z.number().int().nonnegative().optional().nullable(),
        total_tokens: z.number().int().nonnegative().optional().nullable(),
      })
      .optional()
      .nullable(),
  })
  .passthrough();

export type ChatCompletionVerifiedResponse = z.infer<typeof chatCompletionSuccessSchema>;

export type FetchFunction = typeof fetch;

export class DeepSeekClient {
  private readonly baseUrl: string;
  private readonly customFetch?: FetchFunction;
  private readonly protocol: ModelProviderId;
  private readonly label: string;

  constructor(options?: {
    baseUrl?: string;
    customFetch?: FetchFunction;
    protocol?: ModelProviderId;
  }) {
    this.baseUrl = (options?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.customFetch = options?.customFetch;
    this.protocol = options?.protocol ?? 'deepseek';
    this.label = { deepseek: 'DeepSeek', kimi: 'Kimi', doubao: '豆包' }[this.protocol];
  }

  private requestBody(body: {
    model: string;
    messages: unknown[];
    max_tokens: number;
    response_format?: { type: string };
  }): Record<string, unknown> {
    if (this.protocol === 'kimi') {
      if (body.model === 'kimi-k3') {
        const { max_tokens, ...rest } = body;
        return {
          ...rest,
          max_completion_tokens: Math.max(1024, max_tokens),
          reasoning_effort: 'low',
        };
      }
      if (body.model !== 'kimi-k2.6')
        throw new DomainError(
          'MODEL_UNSUPPORTED',
          '当前Kimi接口支持kimi-k2.6或kimi-k3，请重新配置。',
        );
    }
    return { ...body, thinking: { type: 'disabled' } };
  }

  /** 固定合成Ping或1x1图片的实际请求体；不发请求/不含Key，预览与发送共用同一构造。 */
  checkBody(type: ModelKind, model: string): Record<string, unknown> {
    return this.requestBody({
      model,
      max_tokens: 5,
      messages:
        type === 'text'
          ? [{ role: 'user', content: 'Ping' }]
          : [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Describe' },
                  { type: 'image_url', image_url: { url: SYNTHETIC_TEST_IMAGE_DATA_URL } },
                ],
              },
            ],
    });
  }

  private sanitizeMessage(message: string, apiKey: string): string {
    if (!message) return '';
    const trimmedKey = apiKey.trim();
    if (trimmedKey && trimmedKey.length >= 5) {
      return message.replaceAll(trimmedKey, '***');
    }
    return message;
  }

  private parseUsage(
    usageRaw?: ChatCompletionVerifiedResponse['usage'],
  ): DeepSeekTokenUsage | null {
    if (!usageRaw) return null;
    const promptTokens = typeof usageRaw.prompt_tokens === 'number' ? usageRaw.prompt_tokens : null;
    const completionTokens =
      typeof usageRaw.completion_tokens === 'number' ? usageRaw.completion_tokens : null;
    let totalTokens = typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : null;

    if (totalTokens === null && promptTokens !== null && completionTokens !== null) {
      totalTokens = promptTokens + completionTokens;
    }

    if (promptTokens === null && completionTokens === null && totalTokens === null) {
      return null;
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  private async requestOnce(
    apiKey: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    maximumResponseBytes?: number,
  ): Promise<{ data: ChatCompletionVerifiedResponse; durationMs: number }> {
    const fetchImpl = this.customFetch ?? globalThis.fetch;
    const url = `${this.baseUrl}/chat/completions`;

    const startTime = Date.now();

    try {
      if (signal?.aborted) {
        throw new DomainError('ABORTED', `${this.label} 任务已取消。`);
      }

      const transport = fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      // 迟到响应仍属于已取消的原调用，只释放正文资源，不进入结果或触发重试。
      void transport.then(
        (response) => {
          if (signal?.aborted) void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const res = await awaitModelResponse(transport, signal);

      const durationMs = Date.now() - startTime;
      if (maximumResponseBytes && !res.ok && res.status !== 400 && res.status !== 422)
        void res.body?.cancel().catch(() => {});

      if (res.status === 401) {
        throw new DomainError('AUTH_FAILED', `${this.label} 认证失败，请检查此供应商 API Key。`);
      }
      if (res.status === 402) {
        throw new DomainError('INSUFFICIENT_BALANCE', `${this.label} 账号余额不足，请核对账号。`);
      }
      if (res.status === 400 || res.status === 422) {
        if (maximumResponseBytes) {
          void res.body?.cancel().catch(() => {});
          throw new DomainError('PARAM_ERROR', `${this.label} 拒绝参数，请核对型号及账号能力。`);
        }
        let detail = '请求参数错误';
        try {
          const rawErrText =
            typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
          if (signal?.aborted) {
            throw new DomainError('ABORTED', `${this.label} 任务已取消。`);
          }
          const errJson = JSON.parse(rawErrText) as { error?: { message?: string } };
          if (errJson?.error?.message) {
            detail = this.sanitizeMessage(errJson.error.message, apiKey);
          }
        } catch (e) {
          if (e instanceof DomainError) throw e;
          // Ignore JSON parsing failure
        }
        throw new DomainError('PARAM_ERROR', `${this.label} 参数错误: ${detail}`);
      }
      if (res.status === 429) {
        throw new DomainError('RATE_LIMIT', `${this.label} 调用频率超限，没有自动重试。`);
      }
      if (res.status >= 500) {
        throw new DomainError('SERVER_ERROR', `${this.label} 服务端错误 (HTTP ${res.status})。`);
      }

      if (!res.ok) {
        throw new DomainError('HTTP_ERROR', `${this.label} 请求失败 (HTTP ${res.status})。`);
      }

      // 1. 读取响应内容并严格区分流传输错误与 JSON 语法错误
      let rawJson: unknown;
      if (typeof res.text === 'function' || maximumResponseBytes) {
        // 标准 Fetch 路径：先读取网络正文流
        const rawText = maximumResponseBytes
          ? await readBoundedResponse(res, maximumResponseBytes, signal)
          : await res.text();
        if (signal?.aborted) {
          throw new DomainError('ABORTED', `${this.label} 任务已取消。`);
        }
        // 仅对已接收完整的正文文本进行 JSON 语法解析，纯语法错误归为 INVALID_RESPONSE
        try {
          rawJson = JSON.parse(rawText);
        } catch (syntaxError) {
          if (maximumResponseBytes)
            throw new DomainError(
              'INVALID_RESPONSE',
              `${this.label} 返回的内容无法解析为有效 JSON。`,
            );
          const errMsg = syntaxError instanceof Error ? syntaxError.message : String(syntaxError);
          const sanitized = this.sanitizeMessage(errMsg, apiKey);
          throw new DomainError(
            'INVALID_RESPONSE',
            `${this.label} 返回的内容无法解析为有效 JSON (${sanitized})。`,
          );
        }
      } else {
        // 仅提供 res.json() 的模拟环境回退路径
        try {
          rawJson = await res.json();
        } catch (jsonError) {
          if (signal?.aborted || (jsonError instanceof Error && jsonError.name === 'AbortError')) {
            throw new DomainError('ABORTED', `${this.label} 任务已取消。`);
          }
          if (
            jsonError instanceof SyntaxError ||
            (jsonError instanceof Error && jsonError.name === 'SyntaxError')
          ) {
            const errMsg = jsonError.message;
            const sanitized = this.sanitizeMessage(errMsg, apiKey);
            throw new DomainError(
              'INVALID_RESPONSE',
              `${this.label} 返回的内容无法解析为有效 JSON (${sanitized})。`,
            );
          }
          throw jsonError;
        }
      }

      const parseResult = chatCompletionSuccessSchema.safeParse(rawJson);
      if (!parseResult.success) {
        throw new DomainError(
          'INVALID_RESPONSE',
          `${this.label} 响应结构无效: ${parseResult.error.issues[0]?.message ?? '数据结构不符合规范'}`,
        );
      }
      return { data: parseResult.data, durationMs };
    } catch (error) {
      // 先优先识别取消语义：无论发生在建立连接、正文流传输还是其他环节
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new DomainError('ABORTED', `${this.label} 任务已取消。`);
      }

      if (error instanceof DomainError) {
        throw error;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      const sanitized = this.sanitizeMessage(errMsg, apiKey);

      throw new DomainError('NETWORK_ERROR', `与 ${this.label} 服务器连接失败: ${sanitized}`);
    }
  }

  private async executeCheck(
    apiKey: string,
    type: 'text' | 'vision',
    model: string,
    promptVersion: string,
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekCheckResult> {
    const body = this.checkBody(type, model);

    const startIso = new Date().toISOString();
    const { data, durationMs } = await this.requestOnce(apiKey, body, options?.signal, 256 * 1024);
    const returnedModel = this.sanitizeMessage(data.model, apiKey);
    const usage = this.parseUsage(data.usage);
    const label = type === 'text' ? '文本模型' : '视觉模型';

    return {
      type,
      success: true,
      responseId: this.sanitizeMessage(data.id, apiKey),
      model: returnedModel,
      durationMs,
      usage,
      message: `${label}连接成功 (${returnedModel})，耗时 ${durationMs}ms`,
      timestamp: startIso,
      promptVersion,
    };
  }

  async checkTextConnection(
    apiKey: string,
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekCheckResult> {
    return this.executeCheck(
      apiKey,
      'text',
      options?.model ?? DEFAULT_TEXT_MODEL,
      TEXT_PROMPT_VERSION,
      options,
    );
  }

  private textMessages(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ) {
    const parsed = z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(81)
      .parse(messages);
    if (Buffer.byteLength(JSON.stringify(parsed)) > 160 * 1024)
      throw new DomainError('VALIDATION', '模型请求超过大小上限。');
    return parsed;
  }

  /** 有界文本生成的确切JSON请求体，不含Key/不联网；与generateText使用同一校验及协议构造。 */
  textBody(
    model: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Record<string, unknown> {
    return this.requestBody({ model, messages: this.textMessages(messages), max_tokens: 4096 });
  }

  /** Generation has no automatic retry: an uncertain response may already have incurred a charge. */
  async generateText(
    apiKey: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekGenerationResult> {
    return this.generate(apiKey, this.textMessages(messages), options, {
      tokens: 4096,
      responseBytes: 256 * 1024,
      json: false,
    });
  }

  conversationBody(
    model: string,
    messages: DeepSeekTextMessage[],
    tools: unknown[],
  ): Record<string, unknown> {
    // Token-budget preflight and compaction belong to the runner; retain a structural safety bound.
    if (messages.length > 8192)
      throw new DomainError(
        'CONVERSATION_CONTEXT_LIMIT',
        '本轮工具记录超过对话容量，已停止后续步骤。请新建对话继续；已完成的操作保留。',
      );
    const parsed = z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant', 'tool']),
            content: z.string(),
            tool_call_id: z.string().max(200).optional(),
            tool_calls: z
              .array(
                z
                  .object({
                    id: z.string().max(200),
                    type: z.literal('function'),
                    function: z
                      .object({ name: z.string().max(100), arguments: z.string() })
                      .strict(),
                  })
                  .strict(),
              )
              .max(8)
              .optional(),
            reasoning_content: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8192)
      .parse(messages);
    if (Buffer.byteLength(JSON.stringify(parsed)) > 8 * 1024 * 1024)
      throw new DomainError(
        'CONVERSATION_CONTEXT_LIMIT',
        '对话上下文超过大小上限，请新建对话或缩小内容；已完成的操作保留。',
      );
    let pending: string[] = [];
    const invalidPairing = () =>
      new DomainError(
        'CONVERSATION_PROTOCOL_ERROR',
        '工具步骤回执不完整，已停止后续请求。请新建对话继续；已完成操作保留。',
      );
    for (const message of parsed) {
      if (pending.length) {
        if (
          message.role !== 'tool' ||
          message.tool_call_id !== pending.shift() ||
          message.tool_calls?.length
        )
          throw invalidPairing();
      } else if (message.role === 'tool' || message.tool_call_id) throw invalidPairing();
      if (message.tool_calls?.length) {
        if (
          message.role !== 'assistant' ||
          new Set(message.tool_calls.map((call) => call.id)).size !== message.tool_calls.length
        )
          throw invalidPairing();
        pending = message.tool_calls.map((call) => call.id);
      }
    }
    if (pending.length) throw invalidPairing();
    const body = this.requestBody({ model, messages: parsed, max_tokens: 16384 });
    return {
      ...body,
      ...(this.protocol === 'kimi' && model === 'kimi-k3' ? {} : { thinking: { type: 'enabled' } }),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools, parallel_tool_calls: false } : {}),
    };
  }

  /** Native tools and streaming are isolated from strict JSON lesson/grading generation. */
  async generateConversation(
    apiKey: string,
    messages: DeepSeekTextMessage[],
    tools: unknown[],
    options: DeepSeekCheckOptions | undefined,
    update: (value: ConversationStreamUpdate) => void,
  ): Promise<ConversationModelResponse> {
    const deadline = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), 180_000);
    const started = Date.now();
    try {
      const transport = (this.customFetch ?? globalThis.fetch)(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify(
          this.conversationBody(options?.model ?? DEFAULT_TEXT_MODEL, messages, tools),
        ),
        signal,
      });
      void transport.then(
        (response) => {
          if (signal.aborted) void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const response = await awaitModelResponse(transport, signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code =
          response.status === 401
            ? 'AUTH_FAILED'
            : response.status === 402
              ? 'INSUFFICIENT_BALANCE'
              : response.status === 429
                ? 'RATE_LIMIT'
                : response.status === 400 || response.status === 422
                  ? 'PARAM_ERROR'
                  : 'HTTP_ERROR';
        throw new DomainError(
          code,
          response.status === 401
            ? `${this.label} 身份验证失败 (HTTP 401)，没有自动重试。请让交付人员在“系统设置 → 模型连接”检查 API Key 是否有效、是否属于当前供应商。`
            : `${this.label} 请求失败 (HTTP ${response.status})，没有自动重试。请核对型号和账号能力。`,
        );
      }
      const parsed = await readConversationCompletion(response, signal, (value) =>
        update({ ...value, content: this.sanitizeMessage(value.content, apiKey) }),
      );
      const metadata = {
        responseId: this.sanitizeMessage(parsed.id, apiKey),
        model: this.sanitizeMessage(parsed.model, apiKey),
        durationMs: Date.now() - started,
        usage: this.parseUsage(parsed.usage),
      };
      if (!['stop', 'tool_calls', 'length'].includes(parsed.finishReason))
        throw new DeepSeekGenerationError('模型输出未正常结束，未采用工具提议。', metadata, {
          ...parsed.diagnostic,
          reason: 'unsupported-finish',
        });
      return {
        ...metadata,
        diagnostic: parsed.diagnostic,
        content: this.sanitizeMessage(parsed.content, apiKey),
        reasoningContent: this.sanitizeMessage(parsed.reasoningContent, apiKey),
        toolCalls: parsed.toolCalls,
        truncated: parsed.finishReason === 'length',
      };
    } catch (error) {
      if (deadline.signal.aborted && !options?.signal?.aborted)
        throw new DomainError('TIMEOUT', '本轮生成超过3分钟，已停止；已收到正文保留，可继续对话。');
      if (error instanceof DomainError) throw error;
      if (signal.aborted) throw new DomainError('ABORTED', '对话已停止。');
      throw new DomainError('NETWORK_ERROR', `${this.label} 流式连接中断，未自动重试。`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Explicit lesson generation accepts only inline JPEGs prepared from approved local fragments.
   * No URLs or file IDs, no automatic retry; both request and response bodies have byte ceilings. */
  async generateLesson(
    apiKey: string,
    messages: DeepSeekLessonMessage[],
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekGenerationResult> {
    return this.generateImages(apiKey, messages, options, '备课', 384 * 1024);
  }

  /** 已确认外发 JPEG 和所选评分细则；有界 JSON 输出，不自动重试或调用工具。
   * 本方法只传输，业务题号/分值/证据校验及持久化由阅卷模块完成。 */
  async generateGrading(
    apiKey: string,
    messages: DeepSeekLessonMessage[],
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekGenerationResult> {
    return this.generateImages(apiKey, messages, options, '阅卷', 1024 * 1024);
  }

  private async generateImages(
    apiKey: string,
    messages: DeepSeekLessonMessage[],
    options: DeepSeekCheckOptions | undefined,
    label: string,
    textLimit: number,
  ): Promise<DeepSeekGenerationResult> {
    if (Buffer.byteLength(JSON.stringify(messages)) > 12 * 1024 * 1024)
      throw new DomainError('VALIDATION', `${label}模型请求超过 12 MiB。`);
    const part = z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('text'),
          text: z.string().min(1).max(textLimit),
        })
        .strict(),
      z
        .object({
          type: z.literal('image_url'),
          image_url: z
            .object({
              url: z
                .string()
                .max(1400000)
                .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/),
            })
            .strict(),
        })
        .strict(),
    ]);
    const parsed = z
      .tuple([
        z
          .object({
            role: z.literal('system'),
            content: z
              .string()
              .min(1)
              .max(64 * 1024),
          })
          .strict(),
        z.object({ role: z.literal('user'), content: z.array(part).min(1).max(17) }).strict(),
      ])
      .parse(messages);
    if (parsed[1].content.filter((value) => value.type === 'image_url').length > 8)
      throw new DomainError('VALIDATION', `${label}模型图像数量超过上限。`);
    return this.generate(apiKey, parsed, options, {
      tokens: 16384,
      responseBytes: 1536 * 1024,
      json: true,
    });
  }

  private async generate(
    apiKey: string,
    messages: unknown[],
    options: DeepSeekCheckOptions | undefined,
    limits: { tokens: number; responseBytes: number; json: boolean },
  ): Promise<DeepSeekGenerationResult> {
    const deadline = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), GENERATION_TIMEOUT_MS);
    try {
      const { data, durationMs } = await this.requestOnce(
        apiKey,
        this.requestBody({
          model: options?.model ?? DEFAULT_TEXT_MODEL,
          messages,
          max_tokens: limits.tokens,
          ...(limits.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal,
        limits.responseBytes,
      );
      const metadata = {
        responseId: this.sanitizeMessage(data.id, apiKey),
        model: this.sanitizeMessage(data.model, apiKey),
        durationMs,
        usage: this.parseUsage(data.usage),
      };
      if (data.choices[0]!.finish_reason !== 'stop')
        throw new DeepSeekGenerationError('模型输出未正常结束，未采用截断内容。', metadata);
      return {
        ...metadata,
        content: this.sanitizeMessage(data.choices[0]!.message.content, apiKey),
      };
    } catch (error) {
      if (deadline.signal.aborted && !options?.signal?.aborted)
        throw new DomainError('TIMEOUT', '模型生成超过 60 秒，已取消；可核对用量后显式重试。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkVisionConnection(
    apiKey: string,
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekCheckResult> {
    return this.executeCheck(
      apiKey,
      'vision',
      options?.model ?? DEFAULT_VISION_MODEL,
      VISION_PROMPT_VERSION,
      options,
    );
  }
}
