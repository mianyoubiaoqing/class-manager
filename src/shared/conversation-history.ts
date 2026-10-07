import { z } from 'zod';
import { conversationFileSchema, CONVERSATION_FILE_LIMITS } from './conversation-files';
import { conversationDocumentSchema } from './conversation';
import { lessonContentSchema } from './lessons';

export const conversationMessageSchema = z
  .object({
    speaker: z.enum(['user', 'assistant']),
    text: z.string().max(100_000),
    attachments: z.array(conversationFileSchema).max(CONVERSATION_FILE_LIMITS.files).optional(),
    document: conversationDocumentSchema.optional(),
    documents: z.array(conversationDocumentSchema).max(8).optional(),
    lesson: lessonContentSchema.optional(),
  })
  .strict();
export const conversationHistoryStateSchema = z
  .object({
    messages: z.array(conversationMessageSchema).max(60),
    draft: z.string().max(2000),
    attachments: z.array(conversationFileSchema).max(CONVERSATION_FILE_LIMITS.files).optional(),
    classId: z.uuid().nullable(),
    studentId: z.uuid().nullable(),
  })
  .strict();
export const conversationHistorySchema = z
  .object({
    id: z.uuid(),
    epoch: z.uuid(),
    title: z.string().trim().min(1).max(80),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    state: conversationHistoryStateSchema,
  })
  .strict();
export const historyEpochInput = z.object({ epoch: z.uuid() }).strict();
export const historyReadInput = historyEpochInput.extend({ id: z.uuid() });
export const historyWriteInput = historyReadInput.extend({
  expectedRevision: z.number().int().positive(),
});
export const historySaveInput = historyWriteInput.extend({ state: conversationHistoryStateSchema });
export const historyRenameInput = historyWriteInput.extend({
  title: z.string().trim().min(1).max(80),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationHistoryState = z.infer<typeof conversationHistoryStateSchema>;
export type ConversationHistory = z.infer<typeof conversationHistorySchema>;
export type ConversationHistorySummary = Omit<ConversationHistory, 'state'> & {
  messageCount: number;
  preview: string;
  archived: boolean;
};
export interface ConversationHistoryCatalog {
  items: ConversationHistorySummary[];
  unreadableCount: number;
}
