import { z } from 'zod';
import type { Snapshot } from './contracts';
import type { ScoreSubject, ScoreValue } from './scores';
import type { StudentProfile } from './pupils';

export const classDataSelectInput = z.object({ epoch: z.uuid(), classId: z.uuid() }).strict();
export const classDataConfigureInput = classDataSelectInput
  .extend({
    token: z.uuid(),
    studentSheet: z.string().max(100).nullable(),
    scoreSheet: z.string().max(100).nullable(),
    examName: z.string().trim().max(100),
    examDate: z.iso.date(),
    subjects: z
      .array(
        z
          .object({
            header: z.string().min(1).max(60),
            name: z.string().min(1).max(60),
            maxScore: z.string().max(20),
            precision: z.number().int().min(0).max(2),
          })
          .strict(),
      )
      .max(20),
    resolutions: z
      .array(
        z
          .object({
            key: z.string().max(100),
            action: z.enum(['existing', 'new', 'skip']),
            studentId: z.uuid().optional(),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export const classDataConfirmInput = z.object({ epoch: z.uuid(), token: z.uuid() }).strict();
export type ClassDataConfiguration = z.infer<typeof classDataConfigureInput>;
export interface ClassDataRow {
  key: string;
  sheet: string;
  row: number;
  studentNumber: string;
  displayName: string;
  studentId: string | null;
  status: 'new' | 'existing' | 'unresolved' | 'skip' | 'error';
  message: string;
  scores: Array<{ subjectId: string; score: ScoreValue }>;
  profile?: Partial<StudentProfile['content']>;
}
export interface ClassDataPreview {
  token: string;
  classId: string;
  className: string;
  fileNames: string[];
  sheets: Array<{ key: string; label: string; headers: string[] }>;
  configuration: ClassDataConfiguration;
  subjects: ScoreSubject[];
  rows: ClassDataRow[];
  issues: string[];
  added: number;
  matched: number;
  unresolved: number;
  scoreRows: number;
  hasScores: boolean;
  profileRows: number;
  canConfirm: boolean;
  expiresAt: string;
}
export interface ClassDataReceipt {
  snapshot: Snapshot;
  classId: string;
  added: number;
  examId: string | null;
  replayed: boolean;
}
