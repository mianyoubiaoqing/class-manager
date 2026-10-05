import { z } from 'zod';
import { DomainError } from '../errors';
import { awaitModelResponse, readBoundedResponse } from './bounded-response';
import type { ConversationToolCall, ConversationStreamUpdate } from './types';

const usage = z.object({
  prompt_tokens: z.number().int().nonnegative().nullable().optional(),
  completion_tokens: z.number().int().nonnegative().nullable().optional(),
  total_tokens: z.number().int().nonnegative().nullable().optional(),
});
const tool = z.object({
  id: z.string().min(1).max(200),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(1024 * 1024) }),
});
const completion = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().optional().nullable(),
          tool_calls: z.array(tool).max(8).optional(),
        }),
      }),
    )
    .min(1),
  usage: usage.nullable().optional(),
});
export interface ConversationCompletion {
  id: string;
  model: string;
  content: string;
  reasoningContent: string;
  toolCalls: ConversationToolCall[];
  finishReason: string;
  usage?: z.infer<typeof usage> | null;
}
const maximum = 2 * 1024 * 1024;
const invalid = () =>
  new DomainError('INVALID_RESPONSE', '模型传输格式无效，未执行工具；可继续对话。');

/** SSE is decoded incrementally. No call is adopted until a complete finish and DONE frame. */
export async function readConversationCompletion(
  response: Response,
  signal: AbortSignal,
  update: (value: ConversationStreamUpdate) => void,
): Promise<ConversationCompletion> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    let parsed: z.infer<typeof completion>;
    try {
      parsed = completion.parse(JSON.parse(await readBoundedResponse(response, maximum, signal)));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw invalid();
    }
    const first = parsed.choices[0]!;
    return {
      id: parsed.id,
      model: parsed.model,
      content: first.message.content ?? '',
      reasoningContent: first.message.reasoning_content ?? '',
      toolCalls: first.message.tool_calls ?? [],
      finishReason: first.finish_reason,
      usage: parsed.usage,
    };
  }
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const result: ConversationCompletion = {
    id: '',
    model: '',
    content: '',
    reasoningContent: '',
    toolCalls: [],
    finishReason: '',
  };
  const calls = new Map<number, ConversationToolCall>();
  let buffer = '',
    bytes = 0,
    doneFrame = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunkSchema = z.object({
    id: z.string().optional(),
    model: z.string().optional(),
    usage: usage.nullable().optional(),
    choices: z.array(
      z.object({
        index: z.number().int().optional(),
        finish_reason: z.string().nullable().optional(),
        delta: z
          .object({
            content: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0).max(7),
                  id: z.string().optional(),
                  type: z.literal('function').optional(),
                  function: z
                    .object({ name: z.string().optional(), arguments: z.string().optional() })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    ),
  });
  const consume = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      doneFrame = true;
      return;
    }
    if (doneFrame) throw invalid();
    const parsed = chunkSchema.parse(JSON.parse(data));
    if (parsed.id) result.id = parsed.id;
    if (parsed.model) result.model = parsed.model;
    if (parsed.usage) result.usage = parsed.usage;
    for (const choice of parsed.choices) {
      if ((choice.index ?? 0) !== 0) continue;
      if (choice.finish_reason) result.finishReason = choice.finish_reason;
      result.content += choice.delta?.content ?? '';
      result.reasoningContent += choice.delta?.reasoning_content ?? '';
      for (const delta of choice.delta?.tool_calls ?? []) {
        const current = calls.get(delta.index) ?? {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (delta.id) current.id = delta.id;
        current.function.name += delta.function?.name ?? '';
        current.function.arguments += delta.function?.arguments ?? '';
        calls.set(delta.index, current);
      }
    }
    update({
      content: result.content,
      reasoningCharacters: result.reasoningContent.length,
      toolNames: [...calls.values()].map((call) => call.function.name),
    });
  };
  try {
    while (true) {
      const next = await awaitModelResponse(reader.read(), signal);
      if (signal.aborted) throw new DomainError('ABORTED', '对话已停止。');
      if (next.done) {
        buffer += decoder.decode();
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new DomainError('RESPONSE_LIMIT', '对话响应超过大小上限。');
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpMatchArray | null;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        consume(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index! + boundary[0].length);
      }
      if (doneFrame) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!doneFrame || !result.id || !result.model || !result.finishReason) throw invalid();
    result.toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => tool.parse(call));
    if (new Set(result.toolCalls.map((call) => call.id)).size !== result.toolCalls.length)
      throw invalid();
    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
      throw invalid();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
