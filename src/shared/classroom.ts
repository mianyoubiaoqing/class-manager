import { z } from 'zod';

export const CLASSROOM_LIMITS = {
  sessions: 1000,
  payloadBytes: 16 * 1024,
  elapsedMs: 24 * 60 * 60 * 1000,
  projectionImageBytes: 64 * 1024 * 1024,
} as const;
const id = z.uuid();
const slideId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
export function validCalendarDate(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export const countdownSettingSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    targetDate: z.string().refine(validCalendarDate, '目标日期无效'),
    timeZone: z.string().min(1).max(80).refine(validTimeZone, '时区无效'),
  })
  .strict();
export const countdownRecordSchema = z
  .object({ revision: z.number().int().positive(), setting: countdownSettingSchema })
  .strict();
export type CountdownRecord = z.infer<typeof countdownRecordSchema>;
export type CountdownView = CountdownRecord & {
  today: string;
  remainingDays: number;
  status: 'future' | 'today' | 'expired';
};
export const countdownInput = z
  .object({
    epoch: id,
    expectedRevision: z.number().int().nonnegative(),
    setting: countdownSettingSchema,
  })
  .strict();
export const classroomReadInput = z.object({ epoch: id, id }).strict();
export const classroomListInput = z
  .object({
    epoch: id,
    offset: z.number().int().min(0).max(CLASSROOM_LIMITS.sessions).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const classroomCreateInput = z
  .object({
    epoch: id,
    requestId: id,
    versionId: id,
    classId: id,
    slideIds: z
      .array(slideId)
      .min(1)
      .max(60)
      .refine((values) => new Set(values).size === values.length),
    acknowledgeScope: z.literal(true),
  })
  .strict();
export const classroomControlInput = classroomReadInput
  .extend({
    expectedRevision: z.number().int().positive(),
    action: z.enum([
      'previous',
      'next',
      'slide',
      'pause',
      'resume',
      'reset',
      'finish',
      'answers',
      'questions',
    ]),
    slideId: slideId.optional(),
    visible: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.action === 'slide') !== (value.slideId !== undefined) ||
      (value.action === 'answers' || value.action === 'questions') !== (value.visible !== undefined)
    )
      context.addIssue({ code: 'custom', message: '课堂操作参数不匹配' });
  });
export const classroomPayloadSchema = z
  .object({
    slideIds: z
      .array(slideId)
      .min(1)
      .max(60)
      .refine((values) => new Set(values).size === values.length),
    index: z.number().int().nonnegative(),
    answersVisible: z.boolean(),
    questionsVisible: z.boolean(),
  })
  .strict()
  .refine((value) => value.index < value.slideIds.length);
export const classroomRecordSchema = z
  .object({
    id,
    versionId: id,
    classId: id,
    revision: z.number().int().positive(),
    requestId: id,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    status: z.enum(['paused', 'running', 'ended']),
    elapsedMs: z.number().int().min(0).max(CLASSROOM_LIMITS.elapsedMs),
    interrupted: z.boolean(),
    payload: classroomPayloadSchema,
  })
  .strict();
export type ClassroomRecord = z.infer<typeof classroomRecordSchema>;
export type ClassroomTeacherView = {
  record: ClassroomRecord;
  title: string;
  versionRevision: number;
  className: string;
  slides: Array<{
    id: string;
    title: string;
    sectionId: string;
    sectionTitle: string;
    durationMinutes: number;
  }>;
};
export type ClassroomCatalog = { items: ClassroomTeacherView[]; total: number };
export type ClassroomBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'image'; dataUrl: string; caption: string };
/** Student projection deliberately has no source quotes, notes, roster or generic lesson payload. */
export type ClassroomProjection = {
  title: string;
  versionRevision: number;
  sectionTitle: string;
  slideTitle: string;
  position: number;
  total: number;
  content: ClassroomBlock[];
  questions: ClassroomBlock[];
  answers: ClassroomBlock[];
  elapsedMs: number;
  status: ClassroomRecord['status'];
  durationMinutes: number;
  countdown: CountdownView | null;
};
export const classroomProjectionInput = classroomReadInput.extend({
  knownRevision: z.number().int().positive().optional(),
});
export type ClassroomProjectionReply = { revision: number; view: ClassroomProjection | null };
export type ClassroomClock = {
  checkpointFailed: boolean;
  elapsedMs: number;
  status: ClassroomRecord['status'];
  countdown: CountdownView | null;
};
