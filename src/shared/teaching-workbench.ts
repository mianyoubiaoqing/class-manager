import { z } from 'zod';
import { studentIdentityText } from './pupils';

const text = (max = 2000) => z.string().trim().max(max);
const required = (max = 120) => text(max).min(1);
const day = z.iso.date();
const pupil = z.uuid();
export const teachingKinds = [
  'discipline',
  'homework',
  'leave',
  'trace',
  'talk',
  'visit',
  'parentMeeting',
  'notice',
  'meeting',
  'activity',
  'award',
  'todo',
  'reminder',
  'notes',
  'studentExtra',
  'examArchive',
] as const;
export type TeachingKind = (typeof teachingKinds)[number];
export const teachingKindSchema = z.enum(teachingKinds);
export const teachingContentSchemas = {
  discipline: z
    .object({
      studentId: pupil,
      category: required(),
      date: day,
      detail: required(4000),
      handler: required(),
    })
    .strict(),
  homework: z
    .object({
      subject: required(60),
      title: required(1000),
      due: day,
      submissions: z.array(z.object({ studentId: pupil, done: z.boolean() }).strict()).max(500),
    })
    .strict(),
  leave: z
    .object({
      studentId: pupil,
      category: required(),
      reason: required(2000),
      start: day,
      end: day,
      status: z.enum(['pending', 'approved', 'rejected', 'closed']),
      note: text(),
    })
    .strict()
    .refine((v) => v.start <= v.end, '结束日期不能早于开始日期'),
  trace: z
    .object({
      category: required(),
      title: required(),
      date: day,
      content: required(6000),
      by: required(),
    })
    .strict(),
  talk: z
    .object({
      studentId: pupil,
      category: required(),
      date: day,
      content: required(6000),
      followUp: text(),
    })
    .strict(),
  visit: z.object({ studentId: pupil, date: day, result: required(4000), note: text() }).strict(),
  parentMeeting: z
    .object({
      title: required(),
      date: day,
      attendees: z.number().int().min(0).max(1000),
      summary: required(4000),
    })
    .strict(),
  notice: z.object({ title: required(), date: day, content: required(6000) }).strict(),
  meeting: z
    .object({ theme: required(), date: day, planned: z.boolean(), record: required(4000) })
    .strict(),
  activity: z
    .object({
      name: required(),
      date: day,
      description: required(4000),
      photoIds: z.array(z.uuid()).max(30),
    })
    .strict(),
  award: z.object({ studentId: pupil, name: required(), category: required(), date: day }).strict(),
  todo: z
    .object({
      text: required(1000),
      dueAt: z.iso.datetime(),
      priority: z.enum(['high', 'medium', 'low']),
      done: z.boolean(),
    })
    .strict(),
  reminder: z
    .object({
      text: required(1000),
      dueAt: z.iso.datetime(),
      priority: z.enum(['high', 'medium', 'low']),
      done: z.boolean(),
    })
    .strict(),
  notes: z.object({ title: required(), content: text(10000) }).strict(),
  studentExtra: z
    .object({
      studentId: pupil,
      idCard: studentIdentityText,
      height: z.number().min(0).max(250),
      group: z.number().int().min(1).max(100),
      note: text(),
    })
    .strict(),
  examArchive: z.object({ examId: z.uuid(), archived: z.boolean() }).strict(),
} satisfies Record<TeachingKind, z.ZodType>;
export type TeachingContent<K extends TeachingKind = TeachingKind> = z.infer<
  (typeof teachingContentSchemas)[K]
>;
export interface TeachingRecord<K extends TeachingKind = TeachingKind> {
  id: string;
  classId: string;
  kind: K;
  revision: number;
  content: TeachingContent<K>;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export const teachingListInput = z
  .object({
    epoch: z.uuid(),
    classId: z.uuid().optional(),
    kind: teachingKindSchema.optional(),
    includeDeleted: z.boolean().default(false),
  })
  .strict();
export const teachingSaveInput = z
  .object({
    epoch: z.uuid(),
    classId: z.uuid(),
    kind: teachingKindSchema,
    id: z.uuid().optional(),
    expectedRevision: z.number().int().nonnegative(),
    requestId: z.uuid(),
    content: z.unknown(),
  })
  .strict()
  .refine((v) => Boolean(v.id) === v.expectedRevision > 0, '编辑须提供原版本号');
export const teachingDeleteInput = z
  .object({
    epoch: z.uuid(),
    id: z.uuid(),
    expectedRevision: z.number().int().positive(),
    requestId: z.uuid(),
    deleted: z.boolean(),
  })
  .strict();
export interface TeachingSettings {
  notifications: boolean;
  sound: boolean;
}
export const teachingSettingsInput = z
  .object({ epoch: z.uuid(), notifications: z.boolean(), sound: z.boolean() })
  .strict();
export const teachingExportInput = z
  .object({
    epoch: z.uuid(),
    classId: z.uuid(),
    kind: z.enum(['roster', 'scores', 'profile', 'leave', 'trace', 'talk']),
    format: z.enum(['docx', 'xlsx']),
    studentId: z.uuid().optional(),
    recordId: z.uuid().optional(),
  })
  .strict();
export interface BridgeProposal {
  id: string;
  tool: string;
  input: unknown;
  createdAt: string;
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'rejected' | 'expired';
  result?: unknown;
  preview?: { className?: string; studentName?: string; before: unknown; after: unknown };
}
export interface WorkBuddyRegistration {
  installed: boolean;
  registered: boolean;
  changed: boolean;
  firstRegistration: boolean;
  launched: boolean;
  active: boolean;
  configurationPath?: string;
  backupPath?: string;
  launchError?: string;
}
export interface TeachingApi {
  exportTeachingSeatingImage(input: {
    epoch: string;
    versionId: string;
  }): Promise<import('./contracts').Result<import('./contracts').Receipt | null>>;
  listTeachingRecords(
    input: z.input<typeof teachingListInput>,
  ): Promise<import('./contracts').Result<TeachingRecord[]>>;
  saveTeachingRecord(
    input: z.input<typeof teachingSaveInput>,
  ): Promise<import('./contracts').Result<TeachingRecord>>;
  deleteTeachingRecord(
    input: z.input<typeof teachingDeleteInput>,
  ): Promise<import('./contracts').Result<TeachingRecord>>;
  readTeachingSettings(input: {
    epoch: string;
  }): Promise<import('./contracts').Result<TeachingSettings>>;
  saveTeachingSettings(
    input: z.input<typeof teachingSettingsInput>,
  ): Promise<import('./contracts').Result<TeachingSettings>>;
  exportTeachingReport(
    input: z.input<typeof teachingExportInput>,
  ): Promise<import('./contracts').Result<import('./contracts').Receipt | null>>;
  selectTeachingPhotos(input: {
    epoch: string;
    classId: string;
  }): Promise<import('./contracts').Result<Array<{ id: string; name: string; dataUrl: string }>>>;
  readTeachingPhoto(input: {
    epoch: string;
    id: string;
  }): Promise<import('./contracts').Result<string>>;
  saveTeachingExam(input: unknown): Promise<import('./contracts').Result<unknown>>;
  listBridgeProposals(): Promise<import('./contracts').Result<BridgeProposal[]>>;
  resolveBridgeProposal(input: {
    id: string;
    approve: boolean;
  }): Promise<import('./contracts').Result<BridgeProposal>>;
  workBuddyConnection(): Promise<
    import('./contracts').Result<{ configuration: string; active: boolean }>
  >;
  startWorkBuddyConnection(): Promise<import('./contracts').Result<WorkBuddyRegistration>>;
  openWorkBuddy(): Promise<import('./contracts').Result<null>>;
}
