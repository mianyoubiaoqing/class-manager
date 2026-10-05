import { z } from 'zod';
import { lessonContentSchema, lessonRequestSchema, localLessonRequestSchema } from './lessons';
import { generationProviderSchema } from './model-provenance';

export const LESSON_PROMPT_VERSION = 'lesson-material-v1';
export interface LessonReceipt {
  id: string;
  revision: number;
  status: LessonDraftRecord['status'];
  replayed: boolean;
}
export interface LessonFreezeReceipt {
  versionId: string;
  revision: number;
  replayed: boolean;
}
export interface LessonPreparationView {
  token: string;
  expiresAt: string;
  inputHash: string;
  textCharacters: number;
  images: number;
  sources: { sourceVersionId: string; fragmentIds: number[] }[];
}
export interface LessonDraftSummary {
  record: LessonDraftRecord;
  title: string;
}
export const MAX_LESSON_COMMAND_BYTES = 2 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.object({ epoch: z.uuid() }).strict();
export const lessonPayloadSchema = z
  .object({
    formatVersion: z.literal(1),
    promptVersion: z.literal(LESSON_PROMPT_VERSION),
    request: localLessonRequestSchema,
    inputHash: hash,
    provider: generationProviderSchema.nullable(),
    authoring: z.literal('local').optional(),
    original: lessonContentSchema,
    content: lessonContentSchema,
  })
  .strict()
  .refine(
    (value) => (value.provider === null) === (value.authoring === 'local'),
    '备课来源标记不一致',
  )
  .refine(
    (value) => value.authoring === 'local' || value.request.selection.length > 0,
    '模型备课必须选择资料',
  );
export const lessonDraftRecordSchema = z
  .object({
    id: z.uuid(),
    lessonId: z.uuid(),
    revision: z.number().int().positive(),
    status: z.enum(['draft', 'discarded', 'frozen']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    baseVersionId: z.uuid().nullable(),
    generationRequestId: z.uuid(),
    generationHash: hash,
  })
  .strict();
export const lessonVersionRecordSchema = z
  .object({
    id: z.uuid(),
    lessonId: z.uuid(),
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    requestId: z.uuid(),
    requestHash: hash,
    createdAt: z.iso.datetime(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const lessonPrepareInput = epoch.extend({ request: lessonRequestSchema });
export const lessonCreateInput = epoch.extend({
  requestId: z.uuid(),
  request: localLessonRequestSchema,
  content: lessonContentSchema,
});
export const lessonTokenInput = epoch.extend({ token: z.uuid() });
export const lessonClaimInput = lessonTokenInput.extend({ requestId: z.uuid() });
// Main/worker only; Renderer cannot supply a provider response or a prepared source snapshot.
export const lessonCompleteInput = lessonClaimInput.extend({
  provider: generationProviderSchema,
  output: z.string().max(1024 * 1024),
});
export const lessonDraftReadInput = epoch.extend({ id: z.uuid() });
export const lessonEditInput = lessonDraftReadInput.extend({
  expectedRevision: z.number().int().positive(),
  content: lessonContentSchema,
});
export const lessonDiscardInput = lessonDraftReadInput.extend({
  expectedRevision: z.number().int().positive(),
});
export const lessonFreezeInput = lessonDiscardInput.extend({
  requestId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});
export const lessonVersionReadInput = epoch.extend({ versionId: z.uuid() });
export const lessonReviseInput = lessonVersionReadInput.extend({ requestId: z.uuid() });
export const lessonListInput = epoch.extend({ includeClosed: z.boolean().default(false) });
export type LessonPayload = z.infer<typeof lessonPayloadSchema>;
export type LessonDraftRecord = z.infer<typeof lessonDraftRecordSchema>;
export type LessonVersionRecord = z.infer<typeof lessonVersionRecordSchema>;
export interface LessonDraftView {
  record: LessonDraftRecord;
  payload: LessonPayload;
}
export interface LessonVersionView {
  record: LessonVersionRecord;
  payload: LessonPayload;
}
