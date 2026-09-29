import { DomainError } from '../errors';
import {
  TEXT_PROMPT_VERSION,
  VISION_PROMPT_VERSION,
  type DeepSeekCheckOptions,
  type DeepSeekCheckResult,
  type DeepSeekTokenUsage,
} from './types';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_TEXT_MODEL = 'deepseek-flash';
export const DEFAULT_VISION_MODEL = 'deepseek-flash';

// 1x1 像素微型透明合成 PNG，用于验证 Vision 多模态接口，消耗极少 token
export const SYNTHETIC_TEST_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
      role?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export type FetchFunction = typeof fetch;

export class DeepSeekClient {
  private readonly baseUrl: string;
  private readonly customFetch?: FetchFunction;

  constructor(options?: { baseUrl?: string; customFetch?: FetchFunction }) {
    this.baseUrl = (options?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.customFetch = options?.customFetch;
  }

  private sanitizeMessage(message: string, apiKey: string): string {
    if (!message) return '';
    const trimmedKey = apiKey.trim();
    if (trimmedKey && trimmedKey.length >= 5) {
      return message.replaceAll(trimmedKey, '***');
    }
    return message;
  }

  private parseUsage(usageRaw?: ChatCompletionResponse['usage']): DeepSeekTokenUsage | null {
    if (!usageRaw) return null;
    return {
      promptTokens: usageRaw.prompt_tokens ?? 0,
      completionTokens: usageRaw.completion_tokens ?? 0,
      totalTokens: usageRaw.total_tokens ?? 0,
    };
  }

  private async requestWithRetry(
    apiKey: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    maxRetries = 1,
  ): Promise<{ data: ChatCompletionResponse; durationMs: number }> {
    const fetchImpl = this.customFetch ?? globalThis.fetch;
    const url = `${this.baseUrl}/chat/completions`;

    let attempt = 0;
    const startTime = Date.now();

    while (attempt <= maxRetries) {
      try {
        if (signal?.aborted) {
          throw new DomainError('ABORTED', 'DeepSeek 任务已取消。');
        }

        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        const durationMs = Date.now() - startTime;

        if (res.status === 401) {
          throw new DomainError('AUTH_FAILED', 'DeepSeek 认证失败，请检查 API Key 是否有效。');
        }
        if (res.status === 402) {
          throw new DomainError('INSUFFICIENT_BALANCE', 'DeepSeek 账号余额不足，请充值后重试。');
        }
        if (res.status === 400 || res.status === 422) {
          let detail = '请求参数错误';
          try {
            const errJson = (await res.json()) as ChatCompletionResponse;
            if (errJson.error?.message) {
              detail = this.sanitizeMessage(errJson.error.message, apiKey);
            }
          } catch {
            // Ignore JSON parsing failure
          }
          throw new DomainError('PARAM_ERROR', `DeepSeek 参数错误: ${detail}`);
        }
        if (res.status === 429) {
          if (attempt < maxRetries) {
            attempt++;
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            continue;
          }
          throw new DomainError('RATE_LIMIT', 'DeepSeek API 调用频率超限，请稍后重试。');
        }
        if (res.status >= 500) {
          if (attempt < maxRetries) {
            attempt++;
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            continue;
          }
          throw new DomainError('SERVER_ERROR', `DeepSeek 服务端错误 (HTTP ${res.status})。`);
        }

        if (!res.ok) {
          throw new DomainError('HTTP_ERROR', `DeepSeek 请求失败 (HTTP ${res.status})。`);
        }

        const data = (await res.json()) as ChatCompletionResponse;
        return { data, durationMs };
      } catch (error) {
        if (error instanceof DomainError) {
          throw error;
        }
        if (signal?.aborted) {
          throw new DomainError('ABORTED', 'DeepSeek 任务已取消。');
        }

        const errMsg = error instanceof Error ? error.message : String(error);
        const sanitized = this.sanitizeMessage(errMsg, apiKey);

        if (attempt < maxRetries) {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }

        throw new DomainError('NETWORK_ERROR', `与 DeepSeek 服务器连接失败: ${sanitized}`);
      }
    }

    throw new DomainError('NETWORK_ERROR', 'DeepSeek 请求失败。');
  }

  private async executeCheck(
    apiKey: string,
    type: 'text' | 'vision',
    model: string,
    messages: unknown[],
    promptVersion: string,
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekCheckResult> {
    const body = {
      model,
      messages,
      max_tokens: 5,
      thinking: { type: 'disabled' },
    };

    const startIso = new Date().toISOString();
    const { data, durationMs } = await this.requestWithRetry(apiKey, body, options?.signal, 1);
    const returnedModel = data.model || model;
    const usage = this.parseUsage(data.usage);
    const label = type === 'text' ? '文本模型' : '视觉模型';

    return {
      type,
      success: true,
      responseId: data.id,
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
      [{ role: 'user', content: 'Ping' }],
      TEXT_PROMPT_VERSION,
      options,
    );
  }

  async checkVisionConnection(
    apiKey: string,
    options?: DeepSeekCheckOptions,
  ): Promise<DeepSeekCheckResult> {
    return this.executeCheck(
      apiKey,
      'vision',
      options?.model ?? DEFAULT_VISION_MODEL,
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            {
              type: 'image_url',
              image_url: {
                url: SYNTHETIC_TEST_IMAGE_DATA_URL,
              },
            },
          ],
        },
      ],
      VISION_PROMPT_VERSION,
      options,
    );
  }
}
