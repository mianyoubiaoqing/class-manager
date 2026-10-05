import { z } from 'zod';
import { classroomSchema, epochInput } from './contracts';
import {
  dutyDateSchema,
  dutyDraftSchema,
  dutyGenerateSchema,
  dutyGroupSchema,
  DUTY_LIMITS,
  type DutyDraftState,
} from './duty';

// A legal 366-date, 400-member unavailable list can exceed the generic 16 KiB IPC ceiling.
export const MAX_DUTY_COMMAND_BYTES = 8 * 1024 * 1024;
export const dutyPayloadSchema = z
  .object({
    formatVersion: z.literal(1),
    classId: z.uuid(),
    className: classroomSchema.shape.name,
    title: classroomSchema.shape.name,
    arrangement: dutyDraftSchema,
  })
  .strict();
export const dutyVersionSchema = z
  .object({
    id: z.uuid(),
    planId: z.uuid(),
    classId: z.uuid(),
    revision: z.number().int().positive(),
    requestId: z.uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    protectedDate: dutyDateSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const participants = dutyDraftSchema.shape.participantIds;
export const dutyPrepareInput = epochInput.extend({
  classId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  source: z.discriminatedUnion('kind', [
    dutyGenerateSchema.omit({ members: true }).extend({
      kind: z.literal('new'),
      title: classroomSchema.shape.name,
      participantIds: participants,
    }),
    z.object({ kind: z.literal('latest'), planId: z.uuid() }).strict(),
  ]),
});
export const dutyTokenInput = epochInput.extend({ token: z.uuid() });
export const dutyAdjustInput = dutyTokenInput.extend({
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('rotate') }).strict(),
    z
      .object({
        kind: z.literal('groups'),
        groups: z.array(dutyGroupSchema).min(1).max(DUTY_LIMITS.groups),
      })
      .strict(),
    z
      .object({
        kind: z.literal('participants'),
        participantIds: participants,
        groups: z.array(dutyGroupSchema).min(1).max(DUTY_LIMITS.groups),
      })
      .strict(),
    z
      .object({
        kind: z.literal('replace'),
        date: dutyDateSchema,
        postId: z.uuid(),
        slotIndex: z
          .number()
          .int()
          .min(0)
          .max(DUTY_LIMITS.dailySlots - 1),
        studentId: z.uuid().nullable(),
      })
      .strict(),
    z.object({ kind: z.literal('day-group'), date: dutyDateSchema, groupId: z.uuid() }).strict(),
    z
      .object({
        kind: z.literal('unavailable'),
        date: dutyDateSchema,
        studentIds: z.array(z.uuid()).max(DUTY_LIMITS.members),
      })
      .strict(),
    z.object({ kind: z.literal('complete'), date: dutyDateSchema }).strict(),
  ]),
});
export const dutyConfirmInput = dutyTokenInput.extend({
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  reason: dutyVersionSchema.shape.reason,
});
export const dutyHistoryInput = epochInput.extend({
  classId: z.uuid(),
  planId: z.uuid().optional(),
});
export const dutyReadInput = epochInput.extend({ versionId: z.uuid() });
/** Internal worker command; page offsets are validated again by the bounded paginator. */
export const dutyPrintBatchInput = dutyReadInput.extend({
  pageOffset: z.number().int().nonnegative(),
});
export const dutyListInput = epochInput.extend({ classId: z.uuid() });
export const dutyPlanSummarySchema = z
  .object({
    planId: z.uuid(),
    classId: z.uuid(),
    title: classroomSchema.shape.name,
    latestVersionId: z.uuid(),
    revision: z.number().int().positive(),
    firstDate: dutyDateSchema,
    lastDate: dutyDateSchema,
    participantCount: z.number().int().min(1).max(DUTY_LIMITS.members),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type DutyPlanSummary = z.infer<typeof dutyPlanSummarySchema>;
export type DutyPayload = z.infer<typeof dutyPayloadSchema>;
export type DutyVersion = z.infer<typeof dutyVersionSchema>;
export interface DutyPreparation extends DutyDraftState {
  token: string;
  expiresAt: string;
  planId: string;
  classId: string;
  className: string;
  title: string;
  expectedRevision: number;
  protectedDate: string;
}
export interface DutyConfirmation {
  versionId: string;
  planId: string;
  classId: string;
  revision: number;
  createdAt: string;
  replayed: boolean;
}
export interface DutyVersionView {
  record: DutyVersion;
  payload: DutyPayload;
  latestVersionId: string;
  stale: boolean;
}
