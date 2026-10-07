import { z } from 'zod';
import { conversationFileIds } from './conversation-files';
import { countdownSettingSchema } from './classroom';
import { growthEventContentSchema } from './growth';
import type { ModelSelection } from './model-providers';
import type { DeepSeekTokenUsage } from '../core/deepseek/types';
import { applicationToolNames } from './application-tools';
import type { LessonContent } from './lessons';

export const CONVERSATION_PROMPT_VERSION = 'business-intent-v1';
export const AGENT_CONVERSATION_PROMPT_VERSION = 'business-agent-v11';
export const businessView = z.enum([
  'roster',
  'attendance',
  'profiles',
  'scores',
  'seating',
  'duty',
  'lessons',
  'classroom',
  'grading',
  'growth',
  'devices',
  'maintenance',
  'providerSettings',
]);
export type BusinessView = z.infer<typeof businessView>;
export const conversationQuery = z.enum([
  'capabilities',
  'workspace',
  'materials',
  'providerSettings',
  'modelUsage',
  'classes',
  'roster',
  'exams',
  'seating',
  'duty',
  'lessons',
  'classroom',
  'grading',
  'growth',
  'devices',
  'countdown',
]);
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // eslint-disable-next-line no-control-regex -- 业务名称拒绝控制字符。
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
/** 模型仅可提出这些具名操作，不能给出IPC名、路径、SQL、命令或业务版本。 */
export const conversationAction = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tool'),
      tool: z.enum(applicationToolNames),
      args: z.record(z.string().max(100), z.unknown()).default({}),
      // 对大型详情按结构路径/数组页读取，不静默截断或限制在最初的一页。
      result: z
        .object({
          path: z.array(z.string().max(100)).max(12).default([]),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('reply'), text: z.string().trim().min(1).max(100_000) }).strict(),
  z.object({ kind: z.literal('navigate'), view: businessView }).strict(),
  z
    .object({
      kind: z.literal('query'),
      query: conversationQuery,
      tool: z.enum(applicationToolNames).optional(),
      classRef: z.string().max(80).optional(),
      studentRef: z.string().max(80).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('createClass'), name }).strict(),
  z
    .object({ kind: z.literal('renameClass'), name, classRef: z.string().max(80).optional() })
    .strict(),
  z
    .object({
      kind: z.literal('setStudentActive'),
      active: z.boolean(),
      studentRef: z.string().max(80).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('setCountdown'), setting: countdownSettingSchema }).strict(),
  z
    .object({
      kind: z.literal('saveGrowthEvent'),
      content: growthEventContentSchema,
      reason: z.string().trim().min(1).max(300),
      studentRef: z.string().max(80).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('unsupported'), reason: z.string().trim().min(1).max(500) }).strict(),
]);
export type ConversationAction = z.infer<typeof conversationAction>;
export const conversationOutput = z
  .object({
    formatVersion: z.literal(1),
    explanation: z.string().trim().min(1).max(1000),
    action: conversationAction,
  })
  .strict();
export const conversationPrepareInput = z
  .object({
    epoch: z.uuid(),
    configurationRevision: z.uuid(),
    text: z.string().trim().min(1).max(2000),
    classId: z.uuid().nullable(),
    studentId: z.uuid().nullable(),
    sessionId: z.uuid().optional(),
    attachmentIds: conversationFileIds.optional(),
  })
  .strict();
export const conversationTokenInput = z.object({ epoch: z.uuid(), token: z.uuid() }).strict();
export const conversationSessionInput = z.object({ epoch: z.uuid(), sessionId: z.uuid() }).strict();
export const conversationGenerateInput = conversationTokenInput
  .extend({
    wireHash: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledgeOutboundPreview: z.literal(true).optional(),
    acknowledgeConversationSend: z.literal(true).optional(),
  })
  .refine((value) => value.acknowledgeOutboundPreview || value.acknowledgeConversationSend);
export const conversationExecuteInput = conversationTokenInput.extend({
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgeActionPreview: z.literal(true),
});
export interface ConversationPreparation {
  token: string;
  epoch: string;
  selection: ModelSelection;
  endpoint: string;
  body: string;
  wireHash: string;
  expiresAt: string;
  promptVersion: typeof CONVERSATION_PROMPT_VERSION | typeof AGENT_CONVERSATION_PROMPT_VERSION;
  sessionId?: string;
  context: { className: string | null; studentNumber: string | null; studentName: string | null };
}
export interface ConversationProposal {
  explanation: string;
  action: ConversationAction;
  actionHash: string;
  label: string;
  changes: Array<{ field: string; before: string; after: string }>;
  requiresWriteConfirmation: boolean;
  provider: ModelSelection & {
    responseId: string;
    responseModel: string;
    usage: DeepSeekTokenUsage | null;
    generatedAt: string;
  };
}
export interface ConversationExecution {
  message: string;
  confirmedActionHash?: string;
  navigate?: BusinessView;
  data?: string;
}
export interface ConversationTask {
  preparation: ConversationPreparation;
  status:
    | 'prepared'
    | 'planning'
    | 'proposed'
    | 'executing'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  proposal?: ConversationProposal;
  execution?: ConversationExecution;
  toolCalls?: Array<{ label: string; result: string }>;
  reply?: string;
  stream?: { text: string; phase: 'thinking' | 'answering' | 'tool'; label: string };
  document?: ConversationDocument;
  documents?: ConversationDocument[];
  remainingOperations?: number;
  lessonPreview?: LessonContent;
  warning?: string;
  contextUsage?: {
    estimatedTokens: number;
    budgetTokens: number;
    compactAtTokens: number;
    compactions: number;
    method?: 'model' | 'local';
  };
  error?: { code: string; message: string; operationId: string };
}

export const conversationDocumentSchema = z
  .object({
    kind: z.enum(['teaching-plan', 'courseware', 'document']),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(100_000),
    nextPrompt: z.string().trim().min(1).max(1800).optional(),
  })
  .strict();
export type ConversationDocument = z.infer<typeof conversationDocumentSchema>;
