import { z } from 'zod';
import { DomainError } from '../errors';
import type { DeepSeekCallRecord } from './types';

const field = z.enum([
  'id',
  'model',
  'choices',
  'index',
  'finish_reason',
  'message',
  'delta',
  'content',
  'reasoning_content',
  'tool_calls',
  'type',
  'function',
  'name',
  'arguments',
  'usage',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
]);
const valueType = z.enum([
  'missing',
  'null',
  'array',
  'object',
  'string',
  'number',
  'boolean',
  'other',
]);
/** Only protocol structure is persisted. No values, validator messages, headers or response text. */
export const conversationDiagnosticSchema = z
  .object({
    version: z.literal(1),
    transport: z.enum(['sse', 'json']),
    stage: z.enum(['body', 'decode', 'frame', 'completion', 'finish', 'business']),
    reason: z.enum([
      'accepted',
      'missing-body',
      'invalid-json',
      'invalid-utf8',
      'field-validation',
      'missing-completion',
      'duplicate-tool-id',
      'unexpected-frame',
      'response-limit',
      'unsupported-finish',
      'business-format',
    ]),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    frames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    done: z.boolean(),
    hasId: z.boolean(),
    hasModel: z.boolean(),
    hasFinish: z.boolean(),
    toolCalls: z.number().int().min(0).max(8),
    issues: z
      .array(
        z
          .object({
            path: z.array(z.union([field, z.number().int().min(0).max(1_000_000)])).max(16),
            actualType: valueType,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type ConversationDiagnostic = z.infer<typeof conversationDiagnosticSchema>;
export const conversationAttemptSchema = z
  .object({
    taskId: z.uuid(),
    transportAttempt: z.number().int().min(1).max(6),
  })
  .strict();
export type ConversationAttempt = z.infer<typeof conversationAttemptSchema>;

/** Export a whitelist projection, never the ledger's arbitrary strings or future extra properties. */
export function conversationDiagnosticEntries(entries: DeepSeekCallRecord[]) {
  return entries
    .flatMap((entry) => {
      const diagnostic = conversationDiagnosticSchema.safeParse(entry.responseDiagnostic);
      const attempt = conversationAttemptSchema.safeParse(entry.conversationAttempt);
      if (!diagnostic.success && !attempt.success) return [];
      if (
        entry.type !== 'conversation_intent' ||
        !z.uuid().safeParse(entry.id).success ||
        !z.iso.datetime().safeParse(entry.timestamp).success
      )
        return [];
      const status = z
        .enum(['success', 'failed', 'interrupted', 'in_progress'])
        .safeParse(entry.status);
      if (!status.success) return [];
      return [
        {
          callId: entry.id,
          at: entry.timestamp,
          status: status.data,
          ...(diagnostic.success ? { response: diagnostic.data } : {}),
          ...(attempt.success ? { attempt: attempt.data } : {}),
        },
      ];
    })
    .slice(0, 30);
}

export class ConversationResponseError extends DomainError {
  readonly diagnostic: ConversationDiagnostic;
  constructor(diagnostic: ConversationDiagnostic, code = 'INVALID_RESPONSE') {
    super(
      code,
      code === 'RESPONSE_LIMIT'
        ? '对话响应超过大小上限。'
        : '模型传输格式无效，未执行工具；可继续对话。',
    );
    this.diagnostic = conversationDiagnosticSchema.parse(diagnostic);
  }
}

export function diagnosticIssues(
  error: z.ZodError,
  input: unknown,
): ConversationDiagnostic['issues'] {
  return error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.filter((part): part is string | number => typeof part !== 'symbol');
    let value = input;
    for (const part of path)
      value =
        value !== null && typeof value === 'object'
          ? (value as Record<string | number, unknown>)[part]
          : undefined;
    const actualType =
      value === undefined
        ? 'missing'
        : value === null
          ? 'null'
          : Array.isArray(value)
            ? 'array'
            : typeof value;
    return {
      path: path
        .slice(0, 16)
        .flatMap<z.infer<typeof field> | number>((part) =>
          typeof part === 'number'
            ? [Math.min(1_000_000, Math.max(0, part))]
            : field.safeParse(part).success
              ? [part as z.infer<typeof field>]
              : [],
        ),
      actualType: valueType.safeParse(actualType).success
        ? (actualType as z.infer<typeof valueType>)
        : 'other',
    };
  });
}
