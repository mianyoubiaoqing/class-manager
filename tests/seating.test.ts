import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { SeatingDraft } from '../src/shared/seating';
import {
  inspectSeatingDraft,
  requireCompleteSeating,
  randomizeSeating,
  moveSeatingStudent,
  setSeatingLock,
  changeSeatingLayout,
} from '../src/core/seating';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function draft(count = 4, rows = 2, columns = 3): SeatingDraft {
  return {
    layout: { rows, columns, unavailable: [] },
    members: Array.from({ length: count }, (_, index) => ({
      studentId: id(index + 1),
      studentNumber: `S${index + 1}`,
      displayName: `合成学生 ${index + 1}`,
    })),
    assignments: [],
    lockedStudentIds: [],
  };
}
function seededDraw(seed: string) {
  let cursor = 0;
  return (maximum: number) =>
    createHash('sha256').update(`${seed}:${cursor++}`).digest().readUInt32BE(0) % maximum;
}
const seated = () => randomizeSeating(draft(), seededDraw('fixture'));
const checkComplete = (value: SeatingDraft) => {
  const state = inspectSeatingDraft(value);
  expect(state.complete).toBe(true);
  expect(state.unassignedStudentIds).toEqual([]);
  expect(new Set(value.assignments.map((item) => item.studentId)).size).toBe(value.members.length);
  expect(new Set(value.assignments.map((item) => `${item.row}:${item.column}`)).size).toBe(
    value.members.length,
  );
};

test('incomplete draft reports every missing member without calling it complete', () => {
  const state = inspectSeatingDraft(draft());
  expect(state.complete).toBe(false);
  expect(state.availableSeatCount).toBe(6);
  expect(state.unassignedStudentIds).toEqual([id(1), id(2), id(3), id(4)]);
  expect(() => requireCompleteSeating(state.draft)).toThrow(/尚有 4/);
});

test('empty roster is visible but cannot generate or confirm a plan', () => {
  expect(inspectSeatingDraft(draft(0)).complete).toBe(false);
  expect(() => randomizeSeating(draft(0))).toThrow(/没有/);
  expect(() => requireCompleteSeating(draft(0))).toThrow(/没有/);
});

test('seeded test random source reproduces exactly and production default returns a complete plan', () => {
  expect(randomizeSeating(draft(), seededDraw('same'))).toEqual(
    randomizeSeating(draft(), seededDraw('same')),
  );
  checkComplete(randomizeSeating(draft()));
});

test('randomization covers every member and skips unavailable seats across seeds and shapes', () => {
  const shapes = [
    [1, 8],
    [8, 1],
    [4, 4],
    [20, 20],
  ] as const;
  for (const [rows, columns] of shapes) {
    const initial = draft(rows * columns - 2, rows, columns);
    initial.layout.unavailable = [{ row: 1, column: 1 }];
    for (let seed = 0; seed < 12; seed++) {
      const result = randomizeSeating(initial, seededDraw(String(seed)));
      checkComplete(result);
      expect(result.assignments.some((item) => item.row === 1 && item.column === 1)).toBe(false);
    }
  }
});

test('exact capacity and all-locked regeneration keep full coverage', () => {
  let result = randomizeSeating(draft(6), seededDraw('all'));
  for (const member of result.members) result = setSeatingLock(result, member.studentId, true);
  expect(
    randomizeSeating(result, () => {
      throw new Error('No draw should be needed');
    }),
  ).toEqual(result);
  checkComplete(result);
});

test('regeneration preserves locks exactly and does not mutate the original draft', () => {
  const initial = setSeatingLock(seated(), id(1), true);
  const before = structuredClone(initial);
  const next = randomizeSeating(initial, seededDraw('different'));
  expect(next.assignments.find((item) => item.studentId === id(1))).toEqual(
    initial.assignments.find((item) => item.studentId === id(1)),
  );
  expect(initial).toEqual(before);
  checkComplete(next);
});

test('locking an unassigned member is rejected; explicit unlock permits movement', () => {
  expect(() => setSeatingLock(draft(), id(1), true)).toThrow(/未安排/);
  const initial = setSeatingLock(seated(), id(1), true);
  expect(() => moveSeatingStudent(initial, id(1), { row: 1, column: 1 })).toThrow(/解锁/);
  const unlocked = setSeatingLock(initial, id(1), false);
  checkComplete(moveSeatingStudent(unlocked, id(1), { row: 1, column: 1 }));
});

test('moving to a free position keeps coverage and swapping preserves both identities', () => {
  const initial = seated();
  const first = initial.assignments[0]!;
  const second = initial.assignments[1]!;
  const swapped = moveSeatingStudent(initial, first.studentId, {
    row: second.row,
    column: second.column,
  });
  expect(swapped.assignments.find((item) => item.studentId === second.studentId)).toMatchObject({
    row: first.row,
    column: first.column,
  });
  expect(swapped.assignments.find((item) => item.studentId === first.studentId)).toMatchObject({
    row: second.row,
    column: second.column,
  });
  const available = Array.from({ length: 6 }, (_, n) => ({
    row: Math.floor(n / 3) + 1,
    column: (n % 3) + 1,
  })).find(
    (seat) =>
      !initial.assignments.some((item) => item.row === seat.row && item.column === seat.column),
  )!;
  checkComplete(moveSeatingStudent(initial, first.studentId, available));
  checkComplete(swapped);
});

test('cannot move onto another locked student, and a rejected move leaves the draft unchanged', () => {
  const initial = setSeatingLock(seated(), id(2), true);
  const before = structuredClone(initial);
  const target = initial.assignments.find((item) => item.studentId === id(2))!;
  expect(() =>
    moveSeatingStudent(initial, id(1), { row: target.row, column: target.column }),
  ).toThrow(/解锁/);
  expect(initial).toEqual(before);
});

test('an unassigned member may take an empty seat but may not silently displace an occupant', () => {
  const initial = moveSeatingStudent(draft(), id(1), { row: 1, column: 1 });
  expect(() => moveSeatingStudent(initial, id(2), { row: 1, column: 1 })).toThrow(/空位/);
  const next = moveSeatingStudent(initial, id(2), { row: 1, column: 2 });
  expect(inspectSeatingDraft(next).unassignedStudentIds).toEqual([id(3), id(4)]);
});

test('layout edits reject occupied or locked positions becoming unavailable without silently removing students', () => {
  const initial = setSeatingLock(seated(), id(1), true);
  const first = initial.assignments[0]!;
  expect(() =>
    changeSeatingLayout(initial, {
      ...initial.layout,
      unavailable: [{ row: first.row, column: first.column }],
    }),
  ).toThrow(/不可用/);
  const expanded = changeSeatingLayout(initial, { rows: 3, columns: 3, unavailable: [] });
  expect(expanded.assignments).toEqual(initial.assignments);
  expect(expanded.lockedStudentIds).toEqual(initial.lockedStudentIds);
});

describe('invalid drafts cannot reach any mutation or confirmation operation', () => {
  test.each([
    [
      'insufficient capacity',
      (value: SeatingDraft) => {
        value.layout = { rows: 1, columns: 3, unavailable: [] };
      },
      /不足/,
    ],
    [
      'duplicate member',
      (value: SeatingDraft) => {
        value.members[1] = value.members[0]!;
      },
      /重复/,
    ],
    [
      'duplicate number',
      (value: SeatingDraft) => {
        value.members[1]!.studentNumber = value.members[0]!.studentNumber.toLowerCase();
      },
      /编号/,
    ],
    [
      'out of range blocked seat',
      (value: SeatingDraft) => {
        value.layout.unavailable = [{ row: 3, column: 1 }];
      },
      /范围/,
    ],
    [
      'duplicate blocked seat',
      (value: SeatingDraft) => {
        value.layout.unavailable = [
          { row: 1, column: 1 },
          { row: 1, column: 1 },
        ];
      },
      /重复/,
    ],
    [
      'unknown assignee',
      (value: SeatingDraft) => {
        value.assignments = [{ studentId: id(8), row: 1, column: 1 }];
      },
      /成员/,
    ],
    [
      'duplicate assignee',
      (value: SeatingDraft) => {
        value.assignments = [
          { studentId: id(1), row: 1, column: 1 },
          { studentId: id(1), row: 1, column: 2 },
        ];
      },
      /重复/,
    ],
    [
      'duplicate occupancy',
      (value: SeatingDraft) => {
        value.assignments = [
          { studentId: id(1), row: 1, column: 1 },
          { studentId: id(2), row: 1, column: 1 },
        ];
      },
      /占用/,
    ],
    [
      'unavailable assignment',
      (value: SeatingDraft) => {
        value.layout.unavailable = [{ row: 1, column: 1 }];
        value.assignments = [{ studentId: id(1), row: 1, column: 1 }];
      },
      /不可用/,
    ],
    [
      'out of range assignment',
      (value: SeatingDraft) => {
        value.assignments = [{ studentId: id(1), row: 3, column: 1 }];
      },
      /范围/,
    ],
    [
      'unknown locked member',
      (value: SeatingDraft) => {
        value.lockedStudentIds = [id(8)];
      },
      /成员/,
    ],
    [
      'unassigned locked member',
      (value: SeatingDraft) => {
        value.lockedStudentIds = [id(1)];
      },
      /未安排/,
    ],
    [
      'duplicate lock',
      (value: SeatingDraft) => {
        value.assignments = [{ studentId: id(1), row: 1, column: 1 }];
        value.lockedStudentIds = [id(1), id(1)];
      },
      /重复/,
    ],
  ] as const)('%s', (_name, mutate, message) => {
    const initial = draft();
    mutate(initial);
    expect(() => inspectSeatingDraft(initial)).toThrow(message);
    expect(() => randomizeSeating(initial)).toThrow(message);
    expect(() => moveSeatingStudent(initial, id(1), { row: 1, column: 1 })).toThrow(message);
    expect(() => requireCompleteSeating(initial)).toThrow(message);
  });
});

test('invalid random-source values are refused rather than creating corrupted assignments', () => {
  for (const value of [-1, 1.5, Number.NaN, 999, Infinity]) {
    expect(() => randomizeSeating(draft(), () => value)).toThrow(/随机/);
  }
});

test('runtime parsing rejects unknown fields, oversized layouts and nonprintable labels', () => {
  expect(() => inspectSeatingDraft({ ...draft(), arbitrary: true })).toThrow();
  expect(() =>
    inspectSeatingDraft({ ...draft(), layout: { rows: 21, columns: 2, unavailable: [] } }),
  ).toThrow();
  const initial = draft();
  initial.members[0]!.displayName = 'name\ninjection';
  expect(() => inspectSeatingDraft(initial)).toThrow();
});

test('parsed draft snapshots are detached from callers and position targets must be valid', () => {
  const initial = draft();
  const parsed = inspectSeatingDraft(initial);
  initial.members[0]!.displayName = 'later rename';
  expect(parsed.draft.members[0]!.displayName).not.toBe('later rename');
  expect(() => moveSeatingStudent(draft(), id(10), { row: 1, column: 1 })).toThrow(/成员/);
  expect(() => moveSeatingStudent(draft(), id(1), { row: 3, column: 1 })).toThrow(/范围/);
});

test.each([
  ['randomize', (input: SeatingDraft) => randomizeSeating(input, seededDraw('detached'))],
  ['move', (input: SeatingDraft) => moveSeatingStudent(input, id(1), { row: 1, column: 1 })],
  ['lock', (input: SeatingDraft) => setSeatingLock(input, id(1), true)],
  ['unlock', (input: SeatingDraft) => setSeatingLock(input, id(1), false)],
  [
    'layout',
    (input: SeatingDraft) => changeSeatingLayout(input, { rows: 3, columns: 3, unavailable: [] }),
  ],
] as const)('%s returns fully detached state without changing input', (_name, operation) => {
  const input = seated();
  const before = structuredClone(input);
  const result = operation(input);
  result.members[0]!.displayName = 'changed returned snapshot';
  result.assignments[0]!.row = 20;
  result.layout.unavailable.push({ row: 1, column: 1 });
  result.lockedStudentIds.push(id(4));
  expect(input).toEqual(before);
});

test('a random-source exception after partial shuffling propagates without changing input', () => {
  const input = seated();
  const before = structuredClone(input);
  const failure = new Error('Synthetic entropy unavailable');
  let calls = 0;
  expect(() =>
    randomizeSeating(input, () => {
      if (++calls === 2) throw failure;
      return 0;
    }),
  ).toThrow(failure);
  expect(calls).toBe(2);
  expect(input).toEqual(before);
});

test('rejected layout edits preserve positions, locks and labels in the old draft', () => {
  const input = setSeatingLock(seated(), id(1), true);
  const before = structuredClone(input);
  expect(() => changeSeatingLayout(input, { rows: 1, columns: 1, unavailable: [] })).toThrow(
    /不足/,
  );
  expect(input).toEqual(before);
});
