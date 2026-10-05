import { z } from 'zod';

export const DUTY_LIMITS = {
  members: 400,
  snapshots: 1000,
  groups: 100,
  dates: 366,
  posts: 20,
  dailySlots: 400,
} as const;
const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- Printed snapshots must contain plain labels.
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), '不能包含控制字符');

/** Calendar dates, never instants: no UTC/local timezone conversion or inferred school calendar. */
export const dutyDateSchema = z.iso
  .date()
  .refine((value) => value >= '1900-01-01' && value <= '9999-12-31');
export const dutyMemberSchema = z
  .object({ studentId: z.uuid(), studentNumber: label(32), displayName: label(60) })
  .strict();
export const dutyGroupSchema = z
  .object({
    id: z.uuid(),
    name: label(40),
    studentIds: z.array(z.uuid()).max(DUTY_LIMITS.members),
  })
  .strict();
export const dutyPostSchema = z
  .object({
    id: z.uuid(),
    name: label(60),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    required: z.number().int().min(1).max(DUTY_LIMITS.dailySlots),
  })
  .strict()
  .refine((value) => value.endMinute > value.startMinute, '岗位结束时间必须晚于开始时间');
const absenceSchema = z
  .object({
    date: dutyDateSchema,
    studentIds: z.array(z.uuid()).max(DUTY_LIMITS.members),
  })
  .strict();
export const dutySlotSchema = z
  .object({ studentId: z.uuid(), temporaryReplacement: z.boolean() })
  .strict();
export const dutyDaySchema = z
  .object({
    date: dutyDateSchema,
    groupId: z.uuid(),
    groupName: label(40),
    // Daily membership survives subsequent group adjustments without rewriting completed days.
    groupMemberIds: z.array(z.uuid()).min(1).max(DUTY_LIMITS.members),
    completed: z.boolean(),
    posts: z
      .array(
        z
          .object({
            postId: z.uuid(),
            slots: z.array(dutySlotSchema.nullable()).max(DUTY_LIMITS.dailySlots),
          })
          .strict(),
      )
      .min(1)
      .max(DUTY_LIMITS.posts),
  })
  .strict();
export const dutyDraftSchema = z
  .object({
    members: z.array(dutyMemberSchema).min(1).max(DUTY_LIMITS.snapshots),
    participantIds: z.array(z.uuid()).min(1).max(DUTY_LIMITS.members),
    groups: z.array(dutyGroupSchema).min(1).max(DUTY_LIMITS.groups),
    dates: z.array(dutyDateSchema).min(1).max(DUTY_LIMITS.dates),
    posts: z.array(dutyPostSchema).min(1).max(DUTY_LIMITS.posts),
    unavailable: z.array(absenceSchema).max(DUTY_LIMITS.dates),
    days: z.array(dutyDaySchema).max(DUTY_LIMITS.dates),
  })
  .strict();
export const dutyGenerateSchema = dutyDraftSchema
  .omit({ groups: true, days: true, participantIds: true })
  .extend({
    members: z.array(dutyMemberSchema).min(1).max(DUTY_LIMITS.members),
    groupCount: z.number().int().min(1).max(DUTY_LIMITS.groups),
  });

export type DutyMember = z.infer<typeof dutyMemberSchema>;
export type DutyGroup = z.infer<typeof dutyGroupSchema>;
export type DutyPost = z.infer<typeof dutyPostSchema>;
export type DutyDay = z.infer<typeof dutyDaySchema>;
export type DutyDraft = z.infer<typeof dutyDraftSchema>;
export type DutyGenerateInput = z.infer<typeof dutyGenerateSchema>;
export interface DutyDraftState {
  draft: DutyDraft;
  emptyGroupIds: string[];
  missingDates: string[];
  shortages: { date: string; postId: string; missing: number }[];
  groupCounts: { groupId: string; days: number }[];
  memberCounts: { studentId: string; assignments: number }[];
  complete: boolean;
}
