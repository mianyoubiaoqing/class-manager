import { z } from 'zod';

export const SEATING_LIMITS = { rows: 20, columns: 20, members: 400 } as const;
const seatLabel = (length: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(length)
    // eslint-disable-next-line no-control-regex -- Snapshot labels must be printable plain text.
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), '不能包含控制字符');
export const seatPositionSchema = z
  .object({
    row: z.number().int().min(1).max(SEATING_LIMITS.rows),
    column: z.number().int().min(1).max(SEATING_LIMITS.columns),
  })
  .strict();
export const seatingLayoutSchema = z
  .object({
    rows: z.number().int().min(1).max(SEATING_LIMITS.rows),
    columns: z.number().int().min(1).max(SEATING_LIMITS.columns),
    unavailable: z.array(seatPositionSchema).max(SEATING_LIMITS.members),
  })
  .strict();
export const seatingMemberSchema = z
  .object({
    studentId: z.uuid(),
    studentNumber: seatLabel(32),
    displayName: seatLabel(60),
  })
  .strict();
export const seatAssignmentSchema = seatPositionSchema.extend({ studentId: z.uuid() });
export const seatingDraftSchema = z
  .object({
    layout: seatingLayoutSchema,
    members: z.array(seatingMemberSchema).max(SEATING_LIMITS.members),
    assignments: z.array(seatAssignmentSchema).max(SEATING_LIMITS.members),
    lockedStudentIds: z.array(z.uuid()).max(SEATING_LIMITS.members),
  })
  .strict();

export type SeatPosition = z.infer<typeof seatPositionSchema>;
export type SeatingLayout = z.infer<typeof seatingLayoutSchema>;
export type SeatingMember = z.infer<typeof seatingMemberSchema>;
export type SeatAssignment = z.infer<typeof seatAssignmentSchema>;
export type SeatingDraft = z.infer<typeof seatingDraftSchema>;
export interface SeatingDraftState {
  draft: SeatingDraft;
  unassignedStudentIds: string[];
  availableSeatCount: number;
  complete: boolean;
}

/** Position identity is local to a layout; row 1 faces the classroom front. */
export const seatKey = (position: SeatPosition): string => `${position.row}:${position.column}`;
