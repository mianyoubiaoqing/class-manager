import { z } from 'zod';

const decimal = z.string().regex(/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/);
export const scoreSubjectSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(60),
    maxScore: decimal,
    precision: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    targetScore: decimal.optional(),
  })
  .strict();

export const scoreValueSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('valid'), hundredths: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('missing') }).strict(),
  z.object({ status: z.literal('not_selected') }).strict(),
]);

export type ScoreSubject = z.infer<typeof scoreSubjectSchema>;
export type ScoreValue = z.infer<typeof scoreValueSchema>;

export const scoreAnalysisInput = z
  .object({
    subjects: z.array(scoreSubjectSchema).min(1).max(20),
    groups: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().trim().min(1).max(60),
            subjectIds: z.array(z.uuid()).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    roster: z
      .array(z.object({ studentId: z.uuid(), groupId: z.uuid() }).strict())
      .min(1)
      .max(10000),
    entries: z
      .array(
        z
          .object({
            studentId: z.uuid(),
            subjectId: z.uuid(),
            score: scoreValueSchema,
          })
          .strict(),
      )
      .max(200000),
    includeRanks: z.boolean().default(false),
  })
  .strict();

export type ScoreAnalysisInput = z.input<typeof scoreAnalysisInput>;

export interface NumericScoreSummary {
  mean: string | null;
  median: string | null;
  minimum: string | null;
  maximum: string | null;
}

export interface SubjectStatistics extends NumericScoreSummary {
  subjectId: string;
  expectedCount: number;
  validCount: number;
  absentCount: number;
  missingCount: number;
  notSelectedCount: number;
  distribution: Array<{
    lowerPercent: number;
    upperPercent: number;
    upperInclusive: boolean;
    count: number;
  }>;
  target: {
    score: string;
    metCount: number;
    denominator: number;
    ratePercent: string | null;
  } | null;
  ranks: Array<{ studentId: string; rank: number }> | null;
}

export interface ScoreStatistics {
  subjects: SubjectStatistics[];
  groups: Array<
    NumericScoreSummary & {
      groupId: string;
      fullScore: string;
      completeCount: number;
      incompleteCount: number;
    }
  >;
  totals: Array<{
    studentId: string;
    groupId: string;
    score: string | null;
    incompleteSubjectIds: string[];
    rank: number | null;
  }>;
}
