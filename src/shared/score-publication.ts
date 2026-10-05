import { z } from 'zod';
import type { ScoreValue, ScoreStatistics } from './scores';
import type { ScoreConfirmation } from './score-commands';

const epoch = z.object({ epoch: z.uuid() }).strict();
export const scorePublicationReadInput = epoch.extend({ reviewId: z.uuid() });
export const scorePublicationConfirmInput = scorePublicationReadInput.extend({
  token: z.uuid(),
  expectedVersionId: z.uuid(),
  reason: z.string().trim().min(1).max(300),
  acknowledgePublish: z.literal(true),
  acknowledgeReplacement: z.boolean(),
});
export const scorePublicationRecordSchema = z
  .object({
    reviewId: z.uuid(),
    examId: z.uuid(),
    previousVersionId: z.uuid(),
    scoreVersionId: z.uuid(),
    createdAt: z.iso.datetime(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export type ScorePublicationRecord = z.infer<typeof scorePublicationRecordSchema>;
export interface ScorePublicationReceipt extends ScoreConfirmation {
  reviewId: string;
  previousVersionId: string;
}
export interface ScorePublicationPreview {
  reviewId: string;
  draftId: string;
  draftRevision: number;
  rubricVersionId: string;
  examId: string;
  studentId: string;
  subjectId: string;
  expectedVersionId: string;
  before: ScoreValue;
  after: ScoreValue;
  replacesExisting: boolean;
  token: string | null;
  expiresAt: string | null;
  receipt: ScorePublicationReceipt | null;
  statistics: ScoreStatistics;
}
