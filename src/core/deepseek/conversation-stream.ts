import { z } from 'zod';
import { DomainError } from '../errors';
import { awaitModelResponse, readBoundedResponse } from './bounded-response';
import type { ConversationToolCall, ConversationStreamUpdate } from './types';
import {
  ConversationResponseError,
  diagnosticIssues,
  type ConversationDiagnostic,
} from './conversation-diagnostics';

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
          tool_calls: z.array(tool).max(8).nullish(),
        }),
      }),
    )
    .min(1),
  usage: usage.nullable().optional(),
});
export interface ConversationCompletion {
  diagnostic: ConversationDiagnostic;
  id: string;
  model: string;
  content: string;
  reasoningContent: string;
  toolCalls: ConversationToolCall[];
  finishReason: string;
  usage?: z.infer<typeof usage> | null;
}
const maximum = 2 * 1024 * 1024;

/** SSE is decoded incrementally. No call is adopted until a complete finish and DONE frame. */
export async function readConversationCompletion(
  response: Response,
  signal: AbortSignal,
  update: (value: ConversationStreamUpdate) => void,
): Promise<ConversationCompletion> {
  const diagnostic: ConversationDiagnostic = {
    version: 1,
    transport: 'json',
    stage: 'body',
    reason: 'accepted',
    bytes: 0,
    frames: 0,
    done: false,
    hasId: false,
    hasModel: false,
    hasFinish: false,
    toolCalls: 0,
    issues: [],
  };
  const invalid = (
    reason: ConversationDiagnostic['reason'],
    issues: ConversationDiagnostic['issues'] = [],
  ) =>
    new ConversationResponseError(
      { ...diagnostic, reason, issues },
      reason === 'response-limit' ? 'RESPONSE_LIMIT' : 'INVALID_RESPONSE',
    );
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    let parsed: z.infer<typeof completion>;
    let raw: unknown;
    try {
      const text = await readBoundedResponse(response, maximum, signal);
      diagnostic.bytes = Buffer.byteLength(text);
      raw = JSON.parse(text);
      diagnostic.stage = 'completion';
      parsed = completion.parse(raw);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'RESPONSE_LIMIT')
        throw invalid('response-limit');
      if (error instanceof DomainError) throw error;
      throw invalid(
        error instanceof z.ZodError ? 'field-validation' : 'invalid-json',
        error instanceof z.ZodError ? diagnosticIssues(error, raw) : [],
      );
    }
    const first = parsed.choices[0]!;
    Object.assign(diagnostic, {
      stage: 'finish',
      hasId: !!parsed.id,
      hasModel: !!parsed.model,
      hasFinish: !!first.finish_reason,
      toolCalls: first.message.tool_calls?.length ?? 0,
    });
    return {
      diagnostic,
      id: parsed.id,
      model: parsed.model,
      content: first.message.content ?? '',
      reasoningContent: first.message.reasoning_content ?? '',
      toolCalls: first.message.tool_calls ?? [],
      finishReason: first.finish_reason,
      usage: parsed.usage,
    };
  }
  diagnostic.transport = 'sse';
  if (!response.body) throw invalid('missing-body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const result: ConversationCompletion = {
    diagnostic,
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
  const snapshot = () =>
    Object.assign(diagnostic, {
      bytes,
      done: doneFrame,
      hasId: !!result.id,
      hasModel: !!result.model,
      hasFinish: !!result.finishReason,
      toolCalls: calls.size,
    });
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
                  id: z.string().nullish(),
                  type: z.literal('function').nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
      }),
    ),
  });
  const consume = (frame: string) => {
    diagnostic.stage = 'frame';
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      doneFrame = true;
      snapshot();
      return;
    }
    snapshot();
    if (doneFrame) throw invalid('unexpected-frame');
    diagnostic.frames++;
    let raw: unknown;
    let parsed: z.infer<typeof chunkSchema>;
    try {
      raw = JSON.parse(data);
      parsed = chunkSchema.parse(raw);
    } catch (error) {
      throw invalid(
        error instanceof z.ZodError ? 'field-validation' : 'invalid-json',
        error instanceof z.ZodError ? diagnosticIssues(error, raw) : [],
      );
    }
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
    snapshot();
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
        diagnostic.stage = 'decode';
        buffer += decoder.decode();
        break;
      }
      bytes += next.value.byteLength;
      snapshot();
      if (bytes > maximum) throw invalid('response-limit');
      diagnostic.stage = 'decode';
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpMatchArray | null;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        consume(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index! + boundary[0].length);
      }
      if (doneFrame) break;
    }
    if (buffer.trim()) consume(buffer);
    diagnostic.stage = 'completion';
    snapshot();
    if (!doneFrame || !result.id || !result.model || !result.finishReason)
      throw invalid('missing-completion');
    result.toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => {
        const checked = tool.safeParse(call);
        if (!checked.success)
          throw invalid(
            'field-validation',
            diagnosticIssues(checked.error, call).map((issue) => ({
              ...issue,
              path: ['tool_calls', index, ...issue.path],
            })),
          );
        return checked.data;
      });
    if (new Set(result.toolCalls.map((call) => call.id)).size !== result.toolCalls.length)
      throw invalid('duplicate-tool-id');
    diagnostic.stage = 'finish';
    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
      throw invalid(error instanceof TypeError ? 'invalid-utf8' : 'invalid-json');
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
