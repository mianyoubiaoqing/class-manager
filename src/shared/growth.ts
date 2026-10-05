import { z } from 'zod';
import { epochInput } from './contracts';
import { generationProviderSchema } from './model-provenance';

export const GROWTH_PROMPT_VERSION = 'growth-summary-v1';
const text = (max: number) => z.string().trim().min(1).max(max);
const revision = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unsupported = /人格障碍|抑郁症|焦虑症|多动症|道德败坏|智力低下|性格缺陷|懒惰/u;
export const growthContentSchema = text(12000).refine(
  (value) => !unsupported.test(value),
  '不接受心理诊断或人格定性，请只写可核对事实和行动建议。',
);
export const growthEventContentSchema = z
  .object({
    date: z.iso.date(),
    kind: z.enum(['event', 'conversation']),
    description: text(4000),
    source: text(300),
    action: z.string().trim().max(2000),
    result: z.string().trim().max(2000),
    followUp: z.enum(['none', 'planned', 'completed']),
    summaryFact: z.string().trim().max(1000),
  })
  .strict();
export const growthEventSchema = z
  .object({
    id: z.uuid(),
    studentId: z.uuid(),
    revision,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    content: growthEventContentSchema,
  })
  .strict();
export type GrowthEvent = z.infer<typeof growthEventSchema>;
export const growthEventSaveInput = epochInput
  .extend({
    requestId: z.uuid(),
    studentId: z.uuid(),
    id: z.uuid().optional(),
    expectedRevision: revision.optional(),
    content: growthEventContentSchema,
    reason: text(300),
  })
  .refine((value) => Boolean(value.id) === Boolean(value.expectedRevision), '更正需要记录与版本号');
export const growthStudentInput = epochInput.extend({ studentId: z.uuid() });
export const growthReadInput = epochInput.extend({ id: z.uuid() });
export interface GrowthReceipt {
  id: string;
  revision: number;
  replayed: boolean;
}
export interface GrowthEventRevision {
  record: GrowthEvent;
  requestId: string;
  reason: string;
  createdAt: string;
}

export const growthSelectionSchema = z
  .object({
    studentId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
    events: z.array(z.object({ id: z.uuid(), revision }).strict()).max(20),
    scores: z.array(z.object({ versionId: z.uuid(), subjectId: z.uuid() }).strict()).max(20),
  })
  .strict()
  .refine((value) => value.from <= value.to, '阶段起止日期顺序不正确');
export type GrowthSelection = z.infer<typeof growthSelectionSchema>;
export const growthSourceSchema = z
  .object({
    selection: growthSelectionSchema,
    studentRevision: revision,
    classId: z.uuid(),
  })
  .strict();
export const growthWireSchema = z
  .object({
    formatVersion: z.literal(1),
    facts: z
      .array(
        z
          .object({
            id: z.string().regex(/^F\d{3}$/),
            kind: z.enum(['event', 'conversation', 'score']),
            text: growthContentSchema,
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
export type GrowthSource = z.infer<typeof growthSourceSchema>;
export interface GrowthPacket {
  source: GrowthSource;
  wire: z.infer<typeof growthWireSchema>;
  inputHash: string;
  promptVersion: typeof GROWTH_PROMPT_VERSION;
}
export const growthOutputSchema = z
  .object({
    formatVersion: z.literal(1),
    factIds: z
      .array(z.string().regex(/^F\d{3}$/))
      .min(1)
      .max(40),
    suggestions: z
      .array(
        z
          .object({
            text: growthContentSchema,
            evidenceIds: z
              .array(z.string().regex(/^F\d{3}$/))
              .min(1)
              .max(40),
          })
          .strict(),
      )
      .max(8),
    limitations: z.array(growthContentSchema).min(1).max(8),
  })
  .strict();
export const growthSummarySchema = z
  .object({
    id: z.uuid(),
    studentId: z.uuid(),
    revision,
    status: z.enum(['draft', 'discarded', 'confirmed']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    source: growthSourceSchema,
    inputHash: hash,
    provider: generationProviderSchema.nullable(),
    original: growthOutputSchema.nullable(),
    content: growthContentSchema,
    reviewed: z.boolean(),
    supersedesEntryId: z.uuid().nullable(),
  })
  .strict();
export type GrowthSummary = z.infer<typeof growthSummarySchema>;
export interface GrowthSummaryView {
  record: GrowthSummary;
  packet: GrowthPacket;
  stale: boolean;
  entryId: string | null;
}
export const growthEntrySchema = z
  .object({
    id: z.uuid(),
    draftId: z.uuid(),
    draftRevision: revision,
    studentId: z.uuid(),
    createdAt: z.iso.datetime(),
    reason: text(300),
    source: growthSourceSchema,
    inputHash: hash,
    content: growthContentSchema,
    supersedesEntryId: z.uuid().nullable(),
  })
  .strict();
export type GrowthEntry = z.infer<typeof growthEntrySchema>;
export interface GrowthTimeline {
  events: GrowthEvent[];
  summaries: GrowthSummaryView[];
  entries: Array<{ record: GrowthEntry; stale: boolean; supersededBy: string | null }>;
}
export const growthPrepareInput = epochInput.extend({
  selection: growthSelectionSchema,
  acknowledgeSyntheticOnly: z.literal(true),
  acknowledgeRedacted: z.literal(true),
});
export const growthTokenInput = epochInput.extend({ token: z.uuid() });
export const growthClaimInput = growthTokenInput.extend({ requestId: z.uuid() });
// 私有 Worker 命令；Renderer 不得提交模型原稿或提供方元数据。
export const growthCompleteInput = growthClaimInput.extend({
  provider: generationProviderSchema,
  output: z.string().max(64 * 1024),
});
export const growthManualInput = growthPrepareInput.extend({
  requestId: z.uuid(),
  content: growthContentSchema,
  supersedesEntryId: z.uuid().optional(),
});
export const growthSummaryEditInput = growthReadInput.extend({
  expectedRevision: revision,
  content: growthContentSchema,
});
export const growthSummaryDiscardInput = growthReadInput.extend({ expectedRevision: revision });
export const growthConfirmInput = growthSummaryDiscardInput.extend({
  reason: text(300),
  acknowledgeReviewed: z.literal(true),
  acknowledgeSources: z.literal(true),
});
export interface GrowthPreparation {
  token: string;
  expiresAt: string;
  packet: GrowthPacket;
}
export interface GrowthConfirmReceipt {
  entryId: string;
  draftId: string;
  replayed: boolean;
}
