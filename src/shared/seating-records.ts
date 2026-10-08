import { z } from 'zod';
import { classroomSchema, epochInput } from './contracts';
import {
  seatingDraftSchema,
  seatingLayoutSchema,
  seatPositionSchema,
  type SeatingDraftState,
} from './seating';

export const seatingPayloadSchema = z
  .object({
    formatVersion: z.literal(1),
    classId: z.uuid(),
    className: classroomSchema.shape.name,
    layoutVersionId: z.uuid(),
    arrangement: seatingDraftSchema,
  })
  .strict();
export const seatingVersionSchema = z
  .object({
    id: z.uuid(),
    classId: z.uuid(),
    revision: z.number().int().positive(),
    requestId: z.uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const seatingPrepareInput = epochInput.extend({
  classId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('empty'), layout: seatingLayoutSchema }).strict(),
    z.object({ kind: z.literal('latest') }).strict(),
  ]),
});
export const seatingTokenInput = epochInput.extend({ token: z.uuid() });
export const seatingAdjustInput = seatingTokenInput.extend({
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('randomize') }).strict(),
    z.object({ kind: z.literal('order'), studentIds: z.array(z.uuid()).max(400) }).strict(),
    z.object({ kind: z.literal('unassign'), studentId: z.uuid() }).strict(),
    z.object({ kind: z.literal('move'), studentId: z.uuid(), target: seatPositionSchema }).strict(),
    z.object({ kind: z.literal('lock'), studentId: z.uuid(), locked: z.boolean() }).strict(),
    z.object({ kind: z.literal('layout'), layout: seatingLayoutSchema }).strict(),
  ]),
});
export const seatingConfirmInput = seatingTokenInput.extend({
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  reason: seatingVersionSchema.shape.reason,
});
export const seatingHistoryInput = epochInput.extend({ classId: z.uuid() });
export const seatingReadInput = epochInput.extend({ versionId: z.uuid() });
export type SeatingPayload = z.infer<typeof seatingPayloadSchema>;
export type SeatingVersion = z.infer<typeof seatingVersionSchema>;
export interface SeatingPreparation extends SeatingDraftState {
  token: string;
  expiresAt: string;
  classId: string;
  className: string;
  expectedRevision: number;
}
export interface SeatingConfirmation {
  versionId: string;
  classId: string;
  revision: number;
  createdAt: string;
  replayed: boolean;
}
export interface SeatingVersionView {
  record: SeatingVersion;
  payload: SeatingPayload;
  latestVersionId: string;
  stale: boolean;
  rosterChanged: boolean;
}
export type { PrintReceipt as SeatingPrintReceipt } from './printing';
