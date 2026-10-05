import { z } from 'zod';
import { epochInput } from './contracts';
import { scoreImportContextSchema, type ScoreImportPreview } from './score-import';
import { scoreAnalysisInput, type ScoreStatistics, type ScoreValue } from './scores';
import {
  examDefinitionSchema,
  type ScoreVersionPayload,
  type StoredScoreVersion,
} from './score-records';

const reason = z.string().trim().min(1).max(300);
const scoreConfigurationInput = epochInput.extend({
  classId: z.uuid(),
  examId: z.uuid().optional(),
  expectedRevision: z.number().int().nonnegative(),
  definition: examDefinitionSchema.omit({ className: true }),
  subjects: scoreImportContextSchema.shape.subjects,
  groups: scoreImportContextSchema.shape.groups,
  assignments: scoreAnalysisInput.shape.roster,
  scoreBasis: scoreImportContextSchema.shape.scoreBasis,
  columnMappings: scoreImportContextSchema.shape.columnMappings,
  exclusions: scoreImportContextSchema.shape.exclusions,
  includeRanks: z.boolean().default(false),
});
const validRevision = (input: { examId?: string; expectedRevision: number }) =>
  Boolean(input.examId) === input.expectedRevision > 0;
export const scorePreviewInput = scoreConfigurationInput
  .extend({
    format: z.enum(['csv', 'xlsx']),
    fileName: z.string().trim().min(1).max(255),
  })
  .refine(validRevision, '更正考试需要原版本号');
export const scoreFileInput = scoreConfigurationInput
  .extend({
    fileToken: z.uuid().optional(),
  })
  .refine(validRevision, '更正考试需要原版本号');
export const scoreTemplateInput = scoreConfigurationInput
  .extend({
    format: z.enum(['csv', 'xlsx']),
  })
  .refine(validRevision, '更正考试需要原版本号');
// 包括最多 10000 个计分组分配和显式排除原因，不能放宽其他 IPC 的限制。
export const MAX_SCORE_COMMAND_BYTES = 12 * 1024 * 1024;
export interface SelectedScorePreview extends PendingScoreView {
  fileToken: string;
  fileName: string;
}

export const scoreConfirmInput = epochInput.extend({
  token: z.uuid(),
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  reason,
});
export const scoreCancelInput = epochInput.extend({
  keepSelectedFile: z.boolean().default(false),
});
export const scoreListInput = epochInput.extend({ classId: z.uuid().optional() });
export const scoreReadInput = epochInput.extend({ versionId: z.uuid() });
export const scoreHistoryInput = epochInput.extend({ examId: z.uuid() });
export const studentScoreHistoryInput = epochInput.extend({
  studentId: z.uuid(),
  subjectId: z.uuid(),
});

export interface StudentScoreHistory {
  entries: Array<{
    examId: string;
    versionId: string;
    revision: number;
    examName: string;
    date: string;
    className: string;
    subjectName: string;
    maxScore: string;
    score: ScoreValue;
    displayScore: string | null;
    ratePercent: string | null;
  }>;
  hasMultipleValidExams: boolean;
  notes: string[];
}

export interface ScoreConfirmation {
  examId: string;
  versionId: string;
  revision: number;
  createdAt: string;
  replayed: boolean;
}
export interface ScoreVersionView {
  record: StoredScoreVersion;
  payload: ScoreVersionPayload;
  statistics: ScoreStatistics;
  latestVersionId: string;
  stale: boolean;
}
export interface ExamSummary {
  examId: string;
  classId: string;
  versionId: string;
  revision: number;
  definition: ScoreVersionPayload['definition'];
  updatedAt: string;
  studentCount: number;
}
export interface PendingScoreView extends ScoreImportPreview {
  token: string | null;
  examId: string;
  expectedRevision: number;
  expiresAt: string | null;
  statistics: ScoreStatistics | null;
  differences: ScoreDifferences | null;
  unchanged: boolean;
}

export interface ScoreDifferences {
  scores: Array<{
    studentId: string;
    subjectId: string;
    before: ScoreValue | null;
    after: ScoreValue | null;
  }>;
  configuration: Array<{ key: string; label: string; before: string | null; after: string | null }>;
}
