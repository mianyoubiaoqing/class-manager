import { randomInt } from 'node:crypto';
import {
  seatKey,
  seatPositionSchema,
  seatingDraftSchema,
  seatingLayoutSchema,
  type SeatAssignment,
  type SeatPosition,
  type SeatingDraft,
  type SeatingDraftState,
  type SeatingLayout,
} from '../shared/seating';
import { DomainError } from './errors';

function invalid(message: string): never {
  throw new DomainError('VALIDATION', message);
}
function inLayout(position: SeatPosition, layout: SeatingLayout): void {
  if (position.row > layout.rows || position.column > layout.columns)
    invalid(`第 ${position.row} 行第 ${position.column} 列超出布局范围。`);
}
const byPosition = (a: SeatPosition, b: SeatPosition) => a.row - b.row || a.column - b.column;

/**
 * Return a detached draft with coverage information; incomplete/empty drafts are allowed.
 * ZodError rejects malformed fields; DomainError(VALIDATION) rejects rule conflicts.
 * No input mutation, I/O or stored state; callers may safely inspect the same input again.
 */
export function inspectSeatingDraft(input: unknown): SeatingDraftState {
  const draft = seatingDraftSchema.parse(input);
  const { layout, members, assignments, lockedStudentIds } = draft;
  const unavailable = new Set<string>();
  for (const position of layout.unavailable) {
    inLayout(position, layout);
    const key = seatKey(position);
    if (unavailable.has(key)) invalid(`不可用位置 ${key} 重复。`);
    unavailable.add(key);
  }
  const memberIds = new Set<string>();
  const numbers = new Set<string>();
  for (const member of members) {
    if (memberIds.has(member.studentId)) invalid('参与成员重复，不能重复安排同一学生。');
    const number = member.studentNumber.toUpperCase();
    if (numbers.has(number)) invalid('参与成员的学生编号重复，请核对名册。');
    memberIds.add(member.studentId);
    numbers.add(number);
  }
  const availableSeatCount = layout.rows * layout.columns - unavailable.size;
  if (members.length > availableSeatCount)
    invalid(`可用座位不足：${members.length} 名成员，只有 ${availableSeatCount} 个可用座位。`);
  const assigned = new Set<string>();
  const occupied = new Set<string>();
  for (const assignment of assignments) {
    if (!memberIds.has(assignment.studentId)) invalid('座位包含不属于本次名册的成员。');
    inLayout(assignment, layout);
    const key = seatKey(assignment);
    if (unavailable.has(key)) invalid(`位置 ${key} 不可用，不能安排学生。`);
    if (assigned.has(assignment.studentId)) invalid('同一成员被重复安排。');
    if (occupied.has(key)) invalid(`位置 ${key} 被多名学生占用。`);
    assigned.add(assignment.studentId);
    occupied.add(key);
  }
  const locked = new Set<string>();
  for (const studentId of lockedStudentIds) {
    if (!memberIds.has(studentId)) invalid('锁定对象不属于本次名册成员。');
    if (locked.has(studentId)) invalid('同一成员被重复锁定。');
    if (!assigned.has(studentId)) invalid('未安排位置的成员不能锁定。');
    locked.add(studentId);
  }
  const unassignedStudentIds = members
    .filter((member) => !assigned.has(member.studentId))
    .map((member) => member.studentId);
  return {
    draft,
    unassignedStudentIds,
    availableSeatCount,
    complete: members.length > 0 && unassignedStudentIds.length === 0,
  };
}

/**
 * Return a detached, nonempty, fully assigned draft, or throw the same validation errors
 * as inspectSeatingDraft. No mutation/I/O. Guard confirmation, history and print with this check.
 */
export function requireCompleteSeating(input: unknown): SeatingDraft {
  const state = inspectSeatingDraft(input);
  if (!state.draft.members.length) invalid('没有可编排成员，请先维护本班名册。');
  if (state.unassignedStudentIds.length)
    invalid(`尚有 ${state.unassignedStudentIds.length} 名成员未安排，不能确认或打印。`);
  return state.draft;
}

/**
 * Return a complete detached arrangement preserving locks; empty rosters are rejected.
 * drawIndex must return an integer in [0, exclusiveMaximum). Invalid draws raise VALIDATION;
 * callback failures propagate without changing input. Uses OS randomness by default:
 * regeneration is not idempotent and must be deliberate, never an automatic retry.
 */
export function randomizeSeating(
  input: unknown,
  drawIndex: (exclusiveMaximum: number) => number = randomInt,
): SeatingDraft {
  const { draft } = inspectSeatingDraft(input);
  if (!draft.members.length) invalid('没有可编排成员，请先维护本班名册。');
  const locked = new Set(draft.lockedStudentIds);
  const kept = draft.assignments.filter((assignment) => locked.has(assignment.studentId));
  const unavailable = new Set([...draft.layout.unavailable.map(seatKey), ...kept.map(seatKey)]);
  const remainingMembers = draft.members.filter((member) => !locked.has(member.studentId));
  const positions: SeatPosition[] = [];
  for (let row = 1; row <= draft.layout.rows; row++) {
    for (let column = 1; column <= draft.layout.columns; column++) {
      if (!unavailable.has(seatKey({ row, column }))) positions.push({ row, column });
    }
  }
  // Shuffle free positions, including spare seats, so unused seats are not always at the back.
  if (remainingMembers.length) {
    for (let index = positions.length - 1; index > 0; index--) {
      const chosen = drawIndex(index + 1);
      if (!Number.isInteger(chosen) || chosen < 0 || chosen > index)
        invalid('随机源返回无效位置，草案未改变。');
      [positions[index], positions[chosen]] = [positions[chosen]!, positions[index]!];
    }
  }
  const assignments: SeatAssignment[] = [
    ...kept,
    ...remainingMembers.map((member, index) => ({
      studentId: member.studentId,
      ...positions[index]!,
    })),
  ];
  return requireCompleteSeating({ ...draft, assignments: assignments.sort(byPosition) });
}

/**
 * Return a detached draft after a move/swap, allowing remaining unassigned members.
 * Locked endpoints or displacing an occupant with an unassigned member raise VALIDATION.
 * Malformed draft/target fields raise ZodError; failures never mutate input. No I/O.
 */
export function moveSeatingStudent(
  input: unknown,
  studentId: string,
  target: SeatPosition,
): SeatingDraft {
  const { draft } = inspectSeatingDraft(input);
  if (!draft.members.some((member) => member.studentId === studentId))
    invalid('调整对象不属于本次名册成员。');
  const locked = new Set(draft.lockedStudentIds);
  if (locked.has(studentId)) invalid('请先显式解锁该学生，再调整位置。');
  const position = seatPositionSchema.parse(target);
  inLayout(position, draft.layout);
  const key = seatKey(position);
  if (draft.layout.unavailable.some((item) => seatKey(item) === key))
    invalid(`位置 ${key} 不可用，不能安排学生。`);
  const source = draft.assignments.find((item) => item.studentId === studentId);
  const occupant = draft.assignments.find((item) => seatKey(item) === key);
  if (occupant && locked.has(occupant.studentId)) invalid('目标位置已锁定，请先显式解锁再交换。');
  if (occupant?.studentId === studentId) return draft;
  if (occupant && !source) invalid('尚未安排的学生请先移入空位，不能挤出已有成员。');
  const assignments = draft.assignments.filter(
    (item) => item.studentId !== studentId && item.studentId !== occupant?.studentId,
  );
  assignments.push({ studentId, ...position });
  if (occupant && source)
    assignments.push({ studentId: occupant.studentId, row: source.row, column: source.column });
  return inspectSeatingDraft({ ...draft, assignments: assignments.sort(byPosition) }).draft;
}

/**
 * Return a detached draft with the explicit lock state; repeating a state is idempotent.
 * Missing/unassigned lock targets raise VALIDATION; malformed drafts raise ZodError.
 * Incomplete drafts are allowed, input is preserved and no I/O occurs.
 */
export function setSeatingLock(input: unknown, studentId: string, locked: boolean): SeatingDraft {
  const { draft } = inspectSeatingDraft(input);
  if (!draft.members.some((member) => member.studentId === studentId))
    invalid('锁定对象不属于本次名册成员。');
  if (locked && !draft.assignments.some((item) => item.studentId === studentId))
    invalid('未安排位置的成员不能锁定。');
  const locks = new Set(draft.lockedStudentIds);
  if (locked) locks.add(studentId);
  else locks.delete(studentId);
  return inspectSeatingDraft({ ...draft, lockedStudentIds: [...locks] }).draft;
}

/**
 * Return a detached draft with the requested layout, preserving assignments and locks.
 * Incomplete drafts are allowed. ZodError rejects malformed fields; VALIDATION rejects
 * conflicts, without input mutation or I/O. Reapplying the same layout is idempotent.
 */
export function changeSeatingLayout(input: unknown, layout: SeatingLayout): SeatingDraft {
  const { draft } = inspectSeatingDraft(input);
  return inspectSeatingDraft({ ...draft, layout: seatingLayoutSchema.parse(layout) }).draft;
}
