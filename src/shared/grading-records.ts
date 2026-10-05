import { z } from 'zod';
import {
  GRADING_LIMITS,
  rubricDefinitionSchema,
  gradingRequestSchema,
  gradingRowSchema,
  gradingEditSchema,
} from './grading';
import { generationProviderSchema } from './model-provenance';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.object({ epoch: z.uuid() }).strict();
const revision = z.number().int().positive();
const reason = z.string().trim().min(1).max(500);
export const rubricRecordSchema = z
  .object({
    id: z.uuid(),
    examId: z.uuid(),
    subjectId: z.uuid(),
    scoreVersionId: z.uuid(),
    revision,
    requestId: z.uuid(),
    requestHash: hash,
    createdAt: z.iso.datetime(),
  })
  .strict();
export const gradingPayloadSchema = z
  .object({
    formatVersion: z.literal(1),
    initialRequest: gradingRequestSchema,
    request: gradingRequestSchema,
    inputHash: hash,
    rows: z.array(gradingRowSchema).min(1).max(GRADING_LIMITS.questions),
  })
  .strict();
export const gradingDraftRecordSchema = z
  .object({
    id: z.uuid(),
    revision,
    status: z.enum(['draft', 'frozen']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    createRequestId: z.uuid(),
    createHash: hash,
    baseReviewId: z.uuid().nullable(),
  })
  .strict();
export const gradingReviewRecordSchema = z
  .object({
    id: z.uuid(),
    draftId: z.uuid(),
    draftRevision: revision,
    requestId: z.uuid(),
    requestHash: hash,
    createdAt: z.iso.datetime(),
    totalHundredths: z.number().int().nonnegative(),
    reason,
  })
  .strict();
export const gradingAttemptPayloadSchema = z
  .object({
    token: z.uuid(),
    request: gradingRequestSchema,
    inputHash: hash,
    output: z.string().max(GRADING_LIMITS.outputBytes).nullable(),
    provider: generationProviderSchema.nullable(),
  })
  .strict();
export const gradingAttemptRecordSchema = z
  .object({
    id: z.uuid(),
    draftId: z.uuid(),
    baseRevision: revision,
    status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    resultRevision: revision.nullable(),
    requestHash: hash,
    resultHash: hash.nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable(),
  })
  .strict();
export const gradingRevisionRecordSchema = z
  .object({
    draftId: z.uuid(),
    revision,
    operation: z.enum(['created', 'edited', 'rebound', 'generated', 'frozen']),
    createdAt: z.iso.datetime(),
    requestId: z.uuid().nullable(),
  })
  .strict();
export const rubricCreateInput = epoch.extend({
  requestId: z.uuid(),
  scoreVersionId: z.uuid(),
  subjectId: z.uuid(),
  definition: rubricDefinitionSchema,
});
export const rubricReadInput = epoch.extend({ id: z.uuid() });
export const rubricListInput = epoch.extend({
  examId: z.uuid(),
  subjectId: z.uuid(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(50),
});
export const gradingCreateInput = epoch.extend({
  requestId: z.uuid(),
  request: gradingRequestSchema,
  baseReviewId: z.uuid().nullable().default(null),
});
export const gradingReadInput = epoch.extend({ id: z.uuid() });
export const gradingPagePreviewInput = gradingReadInput.extend({
  pageId: z.uuid(),
  revision: revision.optional(),
});
export interface GradingPagePreview {
  pageId: string;
  dataUrl: string;
  width: number;
  height: number;
}
export const gradingHistoryInput = gradingReadInput.extend({
  revision: revision.optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(50),
});
export const gradingWriteInput = gradingReadInput.extend({ expectedRevision: revision });
export const gradingRebindInput = gradingWriteInput.extend({ request: gradingRequestSchema });
export const gradingEditInput = gradingWriteInput.extend({
  edits: z.array(gradingEditSchema).min(1).max(GRADING_LIMITS.questions),
});
export const gradingFreezeInput = gradingWriteInput.extend({
  requestId: z.uuid(),
  reason,
  acknowledgeComplete: z.literal(true),
});
export const gradingListInput = epoch.extend({
  examId: z.uuid(),
  includeFrozen: z.boolean().default(false),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(50),
});
export const gradingPrepareInput = gradingWriteInput.extend({
  selectedPageIds: z.array(z.uuid()).min(1).max(GRADING_LIMITS.selectedPages),
  selectedQuestionIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
    .min(1)
    .max(GRADING_LIMITS.questions),
  acknowledgeReplaceReviewed: z.boolean(),
});
export const gradingTokenInput = epoch.extend({ token: z.uuid() });
export const GRADING_PROMPT_VERSION = 'grading-images-v1';
export const MAX_GRADING_COMMAND_BYTES = 2 * 1024 * 1024;
/** 仅确认 Main 持有的实际外发预览；不接受 Renderer 提供的图像、模型或响应。 */
export const gradingGenerateInput = gradingTokenInput.extend({
  wireHash: hash,
  acknowledgeOutboundPreview: z.literal(true),
});
export interface GradingPreparationView {
  token: string;
  expiresAt: string;
  inputHash: string;
  wireHash: string;
  questionIds: string[];
  missingAnswerPages: boolean;
  images: {
    pageId: string;
    role: z.infer<typeof gradingRequestSchema>['pages'][number]['role'];
    order: number;
    width: number;
    height: number;
    dataUrl: string;
  }[];
}
export interface GradingReceipt {
  id: string;
  revision: number;
  status: 'draft' | 'frozen';
  replayed: boolean;
}
export interface GradingFreezeReceipt {
  reviewId: string;
  totalHundredths: number;
  replayed: boolean;
}
export interface GradingAttemptView {
  record: GradingAttemptRecord;
  payload: z.infer<typeof gradingAttemptPayloadSchema>;
}
export interface GradingRevisionView {
  record: z.infer<typeof gradingRevisionRecordSchema>;
  payload: GradingPayload;
}
export const gradingClaimInput = gradingTokenInput.extend({ requestId: z.uuid() });
// Main/worker only. Renderer cannot create provider results, set attempt status or submit stored rows.
export const gradingCompleteInput = gradingClaimInput.extend({
  output: z.string().max(GRADING_LIMITS.outputBytes),
  provider: generationProviderSchema,
});
export const gradingEndInput = epoch.extend({
  requestId: z.uuid(),
  status: z.enum(['failed', 'cancelled', 'interrupted']),
  errorCode: gradingAttemptRecordSchema.shape.errorCode.unwrap(),
});
export type RubricRecord = z.infer<typeof rubricRecordSchema>;
export type GradingPayload = z.infer<typeof gradingPayloadSchema>;
export type GradingDraftRecord = z.infer<typeof gradingDraftRecordSchema>;
export type GradingReviewRecord = z.infer<typeof gradingReviewRecordSchema>;
export type GradingAttemptPayload = z.infer<typeof gradingAttemptPayloadSchema>;
export type GradingAttemptRecord = z.infer<typeof gradingAttemptRecordSchema>;
export interface RubricView {
  record: RubricRecord;
  definition: z.infer<typeof rubricDefinitionSchema>;
}
export interface RubricReceipt {
  id: string;
  revision: number;
  replayed: boolean;
}
export interface GradingDraftView {
  record: GradingDraftRecord;
  payload: GradingPayload;
  stale: boolean;
  reviewId: string | null;
}
export interface GradingSummary {
  record: GradingDraftRecord;
  studentId: string;
  subjectId: string;
}
export interface GradingReviewView {
  record: GradingReviewRecord;
  payload: GradingPayload;
  stale: boolean;
}
