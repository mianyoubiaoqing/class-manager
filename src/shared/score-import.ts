import { z } from 'zod';
import { scoreAnalysisInput, type ScoreValue } from './scores';

export const SCORE_FILE_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  rows: 10000,
  columns: 23,
  cellCharacters: 512,
  zipEntries: 128,
  entryBytes: 16 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  xmlNodes: 1_000_000,
});

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- Imported labels must not contain control characters.
    .refine((text) => !/[\u0000-\u001f\u007f]/u.test(text));

export const scoreImportContextSchema = scoreAnalysisInput
  .omit({ entries: true, includeRanks: true })
  .extend({
    className: label(80),
    scoreBasis: z.enum(['raw', 'converted', 'unknown']),
    roster: z
      .array(
        z
          .object({
            studentId: z.uuid(),
            groupId: z.uuid(),
            studentNumber: z.string().regex(/^[A-Z0-9_-]{1,32}$/),
            displayName: label(60),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    columnMappings: z
      .array(z.object({ header: label(60), subjectId: z.uuid() }).strict())
      .max(20)
      .default([]),
    exclusions: z
      .array(z.object({ row: z.number().int().min(2).max(10001), reason: label(300) }).strict())
      .max(10000)
      .default([]),
  });

export type ScoreImportContext = z.input<typeof scoreImportContextSchema>;

export interface ImportIssue {
  row: number;
  column: number | null;
  code: string;
  message: string;
}

export interface ScoreImportRow {
  row: number;
  studentId: string | null;
  studentNumber: string;
  displayName: string;
  excluded: boolean;
  exclusionReason: string | null;
  issues: ImportIssue[];
  scores: Array<{ subjectId: string; score: ScoreValue }>;
}

export interface ScoreImportPreview {
  fileHash: string;
  format: 'csv' | 'xlsx';
  headers: string[];
  issues: ImportIssue[];
  rows: ScoreImportRow[];
  missingStudentIds: string[];
  canConfirm: boolean;
  entries: Array<{ studentId: string; subjectId: string; score: ScoreValue }>;
}
