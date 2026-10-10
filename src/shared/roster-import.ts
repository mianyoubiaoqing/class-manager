import { z } from 'zod';
import type { StudentProfile } from './pupils';

export const rosterImportInput = z.object({ epoch: z.uuid(), classId: z.uuid() }).strict();
export const rosterConfirmInput = z.object({ epoch: z.uuid(), token: z.uuid() }).strict();
export const rosterTemplateInput = z
  .object({ epoch: z.uuid(), format: z.enum(['xlsx', 'csv']) })
  .strict();
export interface RosterImportRow {
  row: number;
  studentNumber: string;
  displayName: string;
  status: 'new' | 'update' | 'skip' | 'error';
  studentId?: string;
  profile?: Partial<StudentProfile['content']>;
  message: string;
}
export interface RosterImportPreview {
  token: string;
  fileName: string;
  className: string;
  rows: RosterImportRow[];
  issues: string[];
  added: number;
  skipped: number;
  updated: number;
  canConfirm: boolean;
}
