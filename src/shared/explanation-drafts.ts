import { z } from 'zod';
import { epochInput } from './contracts';
import { generationProviderSchema } from './model-provenance';
import {
  EXPLANATION_PROMPT_VERSION,
  explanationOutputSchema,
  explanationSelectionSchema,
  type ExplanationPacket,
} from './score-explanation';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const explanationProviderSchema = generationProviderSchema;
export const explanationContentSchema = z
  .object({
    interpretations: z.string().max(32000),
    questions: z.string().max(32000),
    actions: z.string().max(32000),
    teacherNotes: z.string().max(32000),
  })
  .strict();
export const explanationPayloadSchema = z
  .object({
    formatVersion: z.literal(1),
    promptVersion: z.literal(EXPLANATION_PROMPT_VERSION),
    selection: explanationSelectionSchema,
    inputHash: hash,
    provider: explanationProviderSchema,
    original: explanationOutputSchema,
    content: explanationContentSchema,
  })
  .strict();
export const explanationRecordSchema = z
  .object({
    id: z.uuid(),
    sourceVersionId: z.uuid(),
    revision: z.number().int().positive(),
    status: z.enum(['draft', 'discarded']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    discardedAt: z.iso.datetime().nullable(),
    generationRequestId: z.uuid(),
    generationHash: hash,
  })
  .strict();
export type ExplanationProvider = z.infer<typeof explanationProviderSchema>;
export type ExplanationContent = z.infer<typeof explanationContentSchema>;
export type ExplanationPayload = z.infer<typeof explanationPayloadSchema>;
export type ExplanationRecord = z.infer<typeof explanationRecordSchema>;
export interface ExplanationDraftView {
  scopeLabel: string;
  record: ExplanationRecord;
  payload: ExplanationPayload;
  packet: ExplanationPacket;
  stale: boolean;
  latestSourceVersionId: string;
}
export interface ExplanationDraftSummary {
  scopeLabel: string;
  record: ExplanationRecord;
  examId: string;
  examName: string;
  scope: ExplanationPayload['selection']['scope'];
  stale: boolean;
}
export interface ExplanationPreparation {
  token: string;
  expiresAt: string;
  packet: ExplanationPacket;
}
export interface ExplanationDraftReceipt {
  id: string;
  revision: number;
  status: ExplanationRecord['status'];
  replayed: boolean;
}

export const explanationPrepareInput = epochInput.extend({
  sourceVersionId: z.uuid(),
  selection: explanationSelectionSchema,
});
export const explanationTokenInput = epochInput.extend({ token: z.uuid() });
export const explanationClaimInput = explanationTokenInput.extend({ requestId: z.uuid() });
// Internal worker command only: the Renderer must never supply provider metadata or model output.
export const explanationCompleteInput = explanationTokenInput.extend({
  requestId: z.uuid(),
  provider: explanationProviderSchema,
  output: z.string().max(64 * 1024),
});
export const explanationReadInput = epochInput.extend({ id: z.uuid() });
export const explanationListInput = epochInput.extend({
  examId: z.uuid().optional(),
  includeDiscarded: z.boolean().default(false),
});
export const explanationEditInput = explanationReadInput.extend({
  expectedRevision: z.number().int().positive(),
  content: explanationContentSchema,
});
export const explanationDiscardInput = explanationReadInput.extend({
  expectedRevision: z.number().int().positive(),
});
