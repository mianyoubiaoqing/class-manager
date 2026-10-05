import { z } from 'zod';
import { scoreAnalysisInput } from './scores';
import { scoreImportContextSchema } from './score-import';

const label = (maximum: number) => z.string().trim().min(1).max(maximum);
export const examDefinitionSchema = z
  .object({
    name: label(100),
    date: z.iso.date(),
    academicYear: label(30),
    term: label(30),
    grade: label(30),
    className: label(80),
  })
  .strict();

/** 每个版本保留当时的名册与配置，后续调班、改名不会重写历史。 */
export const scoreVersionPayloadSchema = z
  .object({
    formatVersion: z.literal(1),
    scoreBasis: z.literal('raw'),
    definition: examDefinitionSchema,
    analysis: scoreAnalysisInput.extend({
      roster: scoreImportContextSchema.shape.roster,
    }),
    source: z
      .object({
        kind: z.enum(['csv', 'xlsx']),
        fileHash: z.string().regex(/^[a-f0-9]{64}$/),
        fileName: label(255),
        columnMappings: scoreImportContextSchema.shape.columnMappings,
        exclusions: scoreImportContextSchema.shape.exclusions,
      })
      .strict(),
    publication: z.object({ reviewId: z.uuid(), previousVersionId: z.uuid() }).strict().optional(),
  })
  .strict();

export type ScoreVersionPayload = z.infer<typeof scoreVersionPayloadSchema>;
export const storedExamSchema = z
  .object({ id: z.uuid(), classId: z.uuid(), createdAt: z.iso.datetime() })
  .strict();
export const storedScoreVersionSchema = z
  .object({
    id: z.uuid(),
    examId: z.uuid(),
    revision: z.number().int().positive(),
    requestId: z.uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    reason: label(300),
  })
  .strict();

export type StoredExam = z.infer<typeof storedExamSchema>;
export type StoredScoreVersion = z.infer<typeof storedScoreVersionSchema>;
