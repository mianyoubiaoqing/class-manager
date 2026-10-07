import { z } from 'zod';

export const CONVERSATION_FILE_LIMITS = {
  files: 6,
  bytes: 5 * 1024 * 1024,
  characters: 96_000,
} as const;
export const conversationFileSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(120),
    format: z.enum(['xlsx', 'csv', 'txt', 'md', 'pdf', 'docx']),
    bytes: z.number().int().positive().max(CONVERSATION_FILE_LIMITS.bytes),
    characters: z.number().int().positive().max(CONVERSATION_FILE_LIMITS.characters),
    warnings: z.array(z.string().max(1000)).max(20),
  })
  .strict();
export const conversationFilesInput = z.object({ epoch: z.uuid(), sessionId: z.uuid() }).strict();
export const conversationFileIds = z
  .array(z.uuid())
  .max(CONVERSATION_FILE_LIMITS.files)
  .refine((ids) => new Set(ids).size === ids.length, '附件不可重复');
export const conversationFileRemoveInput = conversationFilesInput.extend({
  ids: conversationFileIds,
});
export type ConversationFile = z.infer<typeof conversationFileSchema>;
