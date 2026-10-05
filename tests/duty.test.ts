import { describe, expect, test } from 'vitest';
import {
  changeDutyDayGroup,
  changeDutyGroups,
  changeDutyParticipants,
  completeDutyDay,
  generateDuty,
  inspectDutyDraft,
  replaceDutySlot,
  requireCompleteDuty,
  requireDutyRevision,
  requireNewDuty,
  rotateDuty,
  setDutyUnavailable,
} from '../src/core/duty';
import { dutyDateSchema, type DutyDraft, type DutyGenerateInput } from '../src/shared/duty';

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const today = '2026-09-30';
const dates = ['2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06', '2026-10-08'];
const postId = id(900);
function config(count = 7, groupCount = 3): DutyGenerateInput {
  return {
    members: Array.from({ length: count }, (_, index) => ({
      studentId: id(index + 1),
      studentNumber: `D${index + 1}`,
      displayName: `合成成员${index + 1}`,
    })),
    dates: [...dates],
    posts: [{ id: postId, name: '清扫', startMinute: 960, endMinute: 980, required: 2 }],
    unavailable: [],
    groupCount,
  };
}
function generate(input: DutyGenerateInput = config()) {
  let cursor = 100;
  return generateDuty(input, () => id(cursor++));
}
const plan = () => generate().draft;

test('temporary groups partition uneven rosters and follow only explicit dates', () => {
  const state = generate();
  expect(state.complete).toBe(true);
  expect(state.draft.groups.map((group) => group.studentIds.length)).toEqual([3, 2, 2]);
  expect(state.draft.groups.flatMap((group) => group.studentIds).sort()).toEqual(
    state.draft.members.map((member) => member.studentId).sort(),
  );
  expect(state.draft.days.map((day) => day.date)).toEqual(dates);
  expect(state.groupCounts.map((group) => group.days)).toEqual([2, 2, 1]);
  expect(state.memberCounts.reduce((total, member) => total + member.assignments, 0)).toBe(10);
});

test('same explicit order reproduces allocation and new periods have independent identities', () => {
  const initial = config();
  const before = structuredClone(initial);
  expect(generate(initial)).toEqual(generate(initial));
  const first = generateDuty(initial);
  const second = generateDuty(initial);
  expect(second.draft.groups.map((group) => group.id)).not.toEqual(
    first.draft.groups.map((group) => group.id),
  );
  expect(second.draft.groups.map((group) => group.studentIds)).toEqual(
    first.draft.groups.map((group) => group.studentIds),
  );
  expect(initial).toEqual(before);
});

test.each([1, 2, 3, 5, 7])('rotation fairness is checkable for %i dates', (count) => {
  const initial = config();
  initial.dates = Array.from(
    { length: count },
    (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`,
  );
  const state = generate(initial);
  const counts = state.groupCounts.map((group) => group.days);
  expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  expect(
    state.draft.days.every((day, index) => day.groupId === state.draft.groups[index % 3]!.id),
  ).toBe(true);
});

test('one group can serve every date without inventing another group', () => {
  const state = generate(config(2, 1));
  expect(state.groupCounts).toEqual([{ groupId: id(100), days: 5 }]);
  expect(requireCompleteDuty(state.draft)).toEqual(state.draft);
});

test('insufficient people remain explicit shortages; no automatic out-of-group assignment', () => {
  const input = config(4, 3);
  const state = generate(input);
  expect(state.complete).toBe(false);
  expect(state.shortages.map((item) => item.missing)).toEqual([1, 1, 1]);
  expect(() => requireCompleteDuty(state.draft)).toThrow(/缺口/);
  expect(state.draft.days[1]!.posts[0]!.slots).toEqual([
    { studentId: id(2), temporaryReplacement: false },
    null,
  ]);
});

test('unknown/duplicate group IDs returned by the injected factory reject', () => {
  expect(() => generateDuty(config(), () => 'bad')).toThrow();
  expect(() => generateDuty(config(), () => id(100))).toThrow(/标识重复/);
});

test('empty roster, too many groups and invalid group count reject without drafts', () => {
  expect(() => generate(config(0, 1))).toThrow();
  expect(() => generate(config(2, 3))).toThrow(/组数/);
  expect(() => generate(config(2, 0))).toThrow();
});

test.each(['2026-02-29', '2026-04-31', '2026-9-30', '2026-09-30T00:00:00Z', '0000-01-01'])(
  'reject invalid calendar date %s',
  (date) => expect(() => dutyDateSchema.parse(date)).toThrow(),
);
test('leap dates work and no calendar normalization hides duplicates/order mistakes', () => {
  expect(dutyDateSchema.parse('2028-02-29')).toBe('2028-02-29');
  const input = config();
  expect(() => generate({ ...input, dates: [dates[0]!, dates[0]!] })).toThrow(/重复/);
  expect(() => generate({ ...input, dates: [...dates].reverse() })).toThrow(/先后/);
});

test('runtime guards reject unknown keys, excess slots, bad intervals and duplicated member numbers', () => {
  const input = config();
  expect(() => generateDuty({ ...input, ignored: true })).toThrow();
  expect(() => generate({ ...input, posts: [{ ...input.posts[0]!, endMinute: 960 }] })).toThrow();
  expect(() =>
    generate({
      ...input,
      posts: [
        { ...input.posts[0]!, required: 400 },
        { ...input.posts[0]!, id: id(901), name: '另一岗位', required: 1 },
      ],
    }),
  ).toThrow(/总和/);
  input.members[1]!.studentNumber = input.members[0]!.studentNumber.toLowerCase();
  expect(() => generate(input)).toThrow(/编号重复/);
});

describe('post intervals', () => {
  test('same member may work adjacent slots but never overlapping posts', () => {
    const input = config(1, 1);
    input.posts = [
      { id: postId, name: '清扫', startMinute: 960, endMinute: 980, required: 1 },
      { id: id(901), name: '收尾', startMinute: 980, endMinute: 1000, required: 1 },
    ];
    expect(generate(input).complete).toBe(true);
    input.posts[1]!.startMinute = 979;
    const state = generate(input);
    expect(state.shortages).toHaveLength(5);
    const changed = structuredClone(state.draft);
    changed.days[0]!.posts[1]!.slots[0] = { studentId: id(1), temporaryReplacement: true };
    expect(() => inspectDutyDraft(changed)).toThrow(/重叠/);
  });

  test('allocation orders intervals by start while preserving display order', () => {
    const input = config(2, 1);
    input.posts = [
      { id: postId, name: '中段', startMinute: 20, endMinute: 40, required: 1 },
      { id: id(901), name: '前段', startMinute: 0, endMinute: 30, required: 1 },
      { id: id(902), name: '后段', startMinute: 30, endMinute: 60, required: 1 },
    ];
    const state = generate(input);
    expect(state.complete).toBe(true);
    expect(state.draft.days[0]!.posts.map((post) => post.postId)).toEqual(
      input.posts.map((post) => post.id),
    );
  });

  test('duplicating a member within the same multi-person post also conflicts', () => {
    const draft = plan();
    draft.days[0]!.posts[0]!.slots[1] = structuredClone(draft.days[0]!.posts[0]!.slots[0]!);
    expect(() => inspectDutyDraft(draft)).toThrow(/重复占岗/);
  });
});

test('whole-day absences remove only that date and show precise vacancies', () => {
  const original = plan();
  const unavailable = setDutyUnavailable(original, dates[0]!, [id(1)], today);
  expect(unavailable.shortages).toEqual([{ date: dates[0], postId, missing: 1 }]);
  expect(unavailable.draft.days.slice(1)).toEqual(original.days.slice(1));
  expect(unavailable.draft.days[0]!.posts[0]!.slots[0]).toBeNull();
  expect(setDutyUnavailable(unavailable.draft, dates[0]!, [], today).shortages).toHaveLength(1);
  expect(() => replaceDutySlot(unavailable.draft, dates[0]!, postId, 0, id(1), today)).toThrow(
    /不可用/,
  );
  expect(inspectDutyDraft(original).complete).toBe(true);
});

test('generation skips absent members but never substitutes other groups implicitly', () => {
  const input = config();
  input.unavailable = [{ date: dates[0]!, studentIds: [id(1), id(4)] }];
  const state = generate(input);
  expect(state.draft.days[0]!.posts[0]!.slots).toEqual([
    { studentId: id(7), temporaryReplacement: false },
    null,
  ]);
  expect(state.shortages).toEqual([{ date: dates[0], postId, missing: 1 }]);
});

test('temporary replacement touches only one slot, leaves groups and other dates unchanged', () => {
  const original = plan();
  const next = replaceDutySlot(original, dates[0]!, postId, 0, id(2), today);
  expect(next.complete).toBe(true);
  expect(next.draft.days[0]!.posts[0]!.slots[0]).toEqual({
    studentId: id(2),
    temporaryReplacement: true,
  });
  expect(next.draft.groups).toEqual(original.groups);
  expect(next.draft.days.slice(1)).toEqual(original.days.slice(1));
  expect(original.days[0]!.posts[0]!.slots[0]!.studentId).toBe(id(1));
  expect(() => replaceDutySlot(original, dates[0]!, postId, 0, id(4), today)).toThrow(/重叠/);
  expect(() => replaceDutySlot(original, dates[0]!, postId, 0, id(888), today)).toThrow(/非参与/);
  expect(() => replaceDutySlot(original, dates[0]!, postId, -1, id(2), today)).toThrow(/位置/);
  expect(() => replaceDutySlot(original, '2026-11-01', postId, 0, id(2), today)).toThrow(
    /日期不存在/,
  );
});

test('outside-group assignees cannot masquerade as normal group members', () => {
  const draft = plan();
  draft.days[0]!.posts[0]!.slots[0] = { studentId: id(2), temporaryReplacement: false };
  expect(() => inspectDutyDraft(draft)).toThrow(/临时替换/);
});

test('manual group assignment rebuilds only its date and updates rotation counts', () => {
  const original = plan();
  const next = changeDutyDayGroup(original, dates[0]!, id(102), today);
  expect(next.draft.days[0]!.groupMemberIds).toEqual([id(3), id(6)]);
  expect(next.draft.days.slice(1)).toEqual(original.days.slice(1));
  expect(next.groupCounts.map((group) => group.days)).toEqual([1, 2, 2]);
});

test('member swaps keep a partition and rebuild future posts without changing frozen days', () => {
  const original = completeDutyDay(plan(), dates[0]!, today).draft;
  const groups = structuredClone(original.groups);
  [groups[0]!.studentIds[0], groups[1]!.studentIds[0]] = [
    groups[1]!.studentIds[0]!,
    groups[0]!.studentIds[0]!,
  ];
  const next = changeDutyGroups(original, groups, today);
  expect(next.draft.days[0]).toEqual(original.days[0]);
  expect(next.draft.days[1]!.groupMemberIds).toEqual([id(1), id(5)]);
  expect(next.draft.days[3]!.groupMemberIds).toEqual([id(2), id(4), id(7)]);
  expect(requireDutyRevision(original, next.draft, today)).toEqual(next.draft);
  expect(original.groups[0]!.studentIds[0]).toBe(id(1));
});

test('invalid partitions, empty active groups and changed group identities reject atomically', () => {
  const original = plan();
  const groups = structuredClone(original.groups);
  groups[1]!.studentIds.push(id(1));
  expect(() => changeDutyGroups(original, groups, today)).toThrow(/重复/);
  groups[1]!.studentIds.pop();
  groups[0]!.studentIds.pop();
  expect(() => changeDutyGroups(original, groups, today)).toThrow(/每名/);
  const empty = structuredClone(original.groups);
  empty[1]!.studentIds.push(...empty[0]!.studentIds);
  empty[0]!.studentIds = [];
  expect(() => changeDutyGroups(original, empty, today)).toThrow(/空组/);
  empty[0]!.id = id(888);
  expect(() => changeDutyGroups(original, empty, today)).toThrow(/标识/);
});

test('inspection reports missing dates and empty groups but confirmation refuses', () => {
  const draft = plan();
  draft.days = [];
  draft.groups[1]!.studentIds.push(...draft.groups[0]!.studentIds);
  draft.groups[0]!.studentIds = [];
  const state = inspectDutyDraft(draft);
  expect(state.missingDates).toEqual(dates);
  expect(state.emptyGroupIds).toEqual([id(100)]);
  expect(() => requireCompleteDuty(draft)).toThrow(/空组/);
  expect(() => requireCompleteDuty({ ...plan(), days: [] })).toThrow(/日期/);
});

test('completed and past dates reject replacement, rotation and availability changes', () => {
  const original = completeDutyDay(plan(), dates[0]!, today).draft;
  for (const draft of [original, plan()]) {
    const dateNow = draft === original ? today : '2026-10-01';
    expect(() => replaceDutySlot(draft, dates[0]!, postId, 0, id(2), dateNow)).toThrow(/不可修改/);
    expect(() => changeDutyDayGroup(draft, dates[0]!, id(101), dateNow)).toThrow(/不可修改/);
    expect(() => setDutyUnavailable(draft, dates[0]!, [id(1)], dateNow)).toThrow(/不可修改/);
  }
  expect(() => completeDutyDay(plan(), dates[1]!, today)).toThrow(/未来/);
  const vacant = replaceDutySlot(plan(), dates[0]!, postId, 0, null, today).draft;
  expect(() => completeDutyDay(vacant, dates[0]!, today)).toThrow(/缺口/);
  expect(completeDutyDay(original, dates[0]!, today).draft).toEqual(original);
});

test('revision guard refuses frozen history rewrites, reopening and changed period configuration', () => {
  const original = completeDutyDay(plan(), dates[0]!, today).draft;
  const edited = structuredClone(original);
  edited.days[0]!.posts[0]!.slots[0] = { studentId: id(2), temporaryReplacement: true };
  expect(() => requireDutyRevision(original, edited, today)).toThrow(/不能改写/);
  const reopened = structuredClone(original);
  reopened.days[0]!.completed = false;
  expect(() => requireDutyRevision(original, reopened, today)).toThrow(/重新开启/);
  const renamed = structuredClone(original);
  renamed.members[0]!.displayName = '不同快照';
  expect(() => requireDutyRevision(original, renamed, today)).toThrow(/快照/);
  const futureDone = structuredClone(original);
  futureDone.days[1]!.completed = true;
  expect(() => requireDutyRevision(original, futureDone, today)).toThrow(/未来/);
  const incorrectSnapshot = structuredClone(original);
  incorrectSnapshot.days[1]!.groupMemberIds.push(id(7));
  expect(() => requireDutyRevision(original, incorrectSnapshot, today)).toThrow(/快照/);
});

test('past dates may be marked complete without editing assignments', () => {
  const previous = plan();
  const next = completeDutyDay(previous, dates[0]!, '2026-10-01').draft;
  expect(requireDutyRevision(previous, next, '2026-10-01')).toEqual(next);
});

test('adding and removing participants affects only editable dates, preserving historical snapshots', () => {
  const previous = completeDutyDay(plan(), today, today).draft;
  const added = { studentId: id(8), studentNumber: 'D8', displayName: '新增合成成员' };
  const selected = [...previous.members.filter((member) => member.studentId !== id(1)), added];
  const groups = structuredClone(previous.groups);
  groups[0]!.studentIds = [id(8), id(4), id(7)];
  const next = changeDutyParticipants(previous, selected, groups, today).draft;
  expect(next.participantIds).not.toContain(id(1));
  expect(next.members.find((member) => member.studentId === id(1))).toEqual(previous.members[0]);
  expect(next.members.find((member) => member.studentId === id(8))).toEqual(added);
  expect(next.days[0]).toEqual(previous.days[0]);
  expect(next.days[3]!.groupMemberIds).toEqual([id(8), id(4), id(7)]);
  expect(requireDutyRevision(previous, next, today)).toEqual(next);
  expect(() => replaceDutySlot(next, dates[3]!, postId, 0, id(1), today)).toThrow(/非参与/);
  expect(() => setDutyUnavailable(next, dates[3]!, [id(1)], today)).toThrow(/非参与/);
  expect(previous.participantIds).toContain(id(1));
});

test('removal retains past absence snapshots but clears future absence and unused member records', () => {
  const input = config();
  input.unavailable = [
    { date: dates[0]!, studentIds: [id(7)] },
    { date: dates[3]!, studentIds: [id(7)] },
  ];
  const previous = generate(input).draft;
  const selected = previous.members.filter((member) => member.studentId !== id(7));
  const groups = previous.groups.map((group) => ({
    ...group,
    studentIds: group.studentIds.filter((studentId) => studentId !== id(7)),
  }));
  const next = changeDutyParticipants(previous, selected, groups, '2026-10-01').draft;
  expect(next.days[0]).toEqual(previous.days[0]);
  expect(next.unavailable.find((item) => item.date === dates[0])!.studentIds).toEqual([id(7)]);
  expect(next.unavailable.find((item) => item.date === dates[3])!.studentIds).toEqual([]);
  expect(requireDutyRevision(previous, next, '2026-10-01')).toEqual(next);
  const noHistory = changeDutyParticipants(previous, selected, groups, today).draft;
  expect(noHistory.members.some((member) => member.studentId === id(7))).toBe(false);
  expect(requireDutyRevision(previous, noHistory, today)).toEqual(noHistory);
});

test('participant changes reject duplicate selection, rewritten names and incomplete partitions', () => {
  const previous = plan();
  expect(() =>
    changeDutyParticipants(
      previous,
      [...previous.members, previous.members[0]],
      previous.groups,
      today,
    ),
  ).toThrow(/重复/);
  const renamed = structuredClone(previous.members);
  renamed[0]!.displayName = '改写历史';
  expect(() => changeDutyParticipants(previous, renamed, previous.groups, today)).toThrow(/快照/);
  expect(() =>
    changeDutyParticipants(previous, previous.members.slice(1), previous.groups, today),
  ).toThrow(/非参与/);
});

test('revision rejects reintroducing retired participants into future temporary slots', () => {
  const previous = completeDutyDay(plan(), today, today).draft;
  const selected = previous.members.filter((member) => member.studentId !== id(1));
  const groups = previous.groups.map((group) => ({
    ...group,
    studentIds: group.studentIds.filter((studentId) => studentId !== id(1)),
  }));
  const next = changeDutyParticipants(previous, selected, groups, today).draft;
  next.days[1]!.posts[0]!.slots[0] = { studentId: id(1), temporaryReplacement: true };
  expect(() => requireDutyRevision(previous, next, today)).toThrow(/已移出/);
});

test('factory failures propagate without changing caller-owned configuration', () => {
  const input = config();
  const before = structuredClone(input);
  const failure = new Error('fixture failure');
  expect(() =>
    generateDuty(input, () => {
      throw failure;
    }),
  ).toThrow(failure);
  expect(input).toEqual(before);
});

test('participant replacement applies snapshot limit after retiring unreferenced members', () => {
  const previous = generate(config(400, 100)).draft;
  for (let index = 0; index < 600; index++) {
    const studentId = id(1000 + index);
    previous.members.push({
      studentId,
      studentNumber: `H${index}`,
      displayName: `历史成员${index}`,
    });
    previous.days[index < 300 ? 0 : 1]!.groupMemberIds.push(studentId);
  }
  previous.days[0]!.completed = true;
  previous.days[1]!.completed = true;
  expect(requireCompleteDuty(previous).members).toHaveLength(1000);
  const before = structuredClone(previous);
  const added = { studentId: id(9000), studentNumber: 'N9000', displayName: '新增成员' };
  const selected = [
    ...previous.members.filter(
      (member) =>
        previous.participantIds.includes(member.studentId) && member.studentId !== id(400),
    ),
    added,
  ];
  const groups = previous.groups.map((group) => ({
    ...group,
    studentIds: group.studentIds.map((studentId) =>
      studentId === id(400) ? added.studentId : studentId,
    ),
  }));
  const next = changeDutyParticipants(previous, selected, groups, '2026-10-05').draft;
  expect(next.members).toHaveLength(1000);
  expect(next.members.some((member) => member.studentId === id(400))).toBe(false);
  expect(requireDutyRevision(previous, next, '2026-10-05')).toEqual(next);
  const retained = [
    ...previous.members.filter(
      (member) => previous.participantIds.includes(member.studentId) && member.studentId !== id(1),
    ),
    added,
  ];
  const retainedGroups = previous.groups.map((group) => ({
    ...group,
    studentIds: group.studentIds.map((studentId) =>
      studentId === id(1) ? added.studentId : studentId,
    ),
  }));
  expect(() => changeDutyParticipants(previous, retained, retainedGroups, '2026-10-05')).toThrow();
  expect(previous).toEqual(before);
});

test('new confirmation checks date boundary, completion flags and exact daily group snapshots', () => {
  expect(requireNewDuty(plan(), today)).toEqual(plan());
  expect(() => requireNewDuty(plan(), '2026-10-01')).toThrow(/新一期/);
  expect(() => requireNewDuty(completeDutyDay(plan(), today, today).draft, today)).toThrow(
    /标记完成/,
  );
  const changed = plan();
  changed.days[0]!.groupName = '伪造名称';
  expect(() => requireNewDuty(changed, today)).toThrow(/快照/);
});

test('explicit rerotation follows edited group order without touching completed snapshots', () => {
  const previous = completeDutyDay(plan(), today, today).draft;
  const groups = [...previous.groups].reverse();
  groups[0] = { ...groups[0]!, name: '更名小组' };
  const changed = changeDutyGroups(previous, groups, today).draft;
  const next = rotateDuty(changed, today).draft;
  expect(next.days[0]).toEqual(previous.days[0]);
  expect(next.days[2]!.groupId).toBe(id(100));
  expect(next.days[3]!.groupName).toBe('更名小组');
  expect(requireDutyRevision(previous, next, today)).toEqual(next);
  expect(() => rotateDuty({ ...previous, days: [] }, '2026-10-01')).toThrow(/补造/);
});

test('unknown and duplicated dates/posts/absences are rejected', () => {
  const mutations: ((draft: DutyDraft) => void)[] = [
    (draft) => draft.days.push(structuredClone(draft.days[0]!)),
    (draft) => {
      draft.days[0]!.groupId = id(999);
    },
    (draft) => draft.days[0]!.groupMemberIds.push(id(999)),
    (draft) => {
      draft.days[0]!.posts = [];
    },
    (draft) => {
      draft.days[0]!.posts[0]!.postId = id(999);
    },
    (draft) => {
      draft.days[0]!.posts[0]!.slots = [];
    },
    (draft) => draft.unavailable.push({ date: '2026-11-01', studentIds: [] }),
    (draft) => draft.unavailable.push({ date: dates[0]!, studentIds: [id(999)] }),
  ];
  for (const mutate of mutations) {
    const draft = plan();
    mutate(draft);
    expect(() => inspectDutyDraft(draft)).toThrow();
  }
});

test('400-member 366-day limits preserve coverage without mutating caller input', () => {
  const input = config(400, 100);
  input.posts[0]!.required = 4;
  input.dates = Array.from({ length: 366 }, (_, index) => {
    const date = new Date(Date.UTC(2028, 0, 1 + index));
    return date.toISOString().slice(0, 10);
  });
  const before = structuredClone(input);
  const state = generate(input);
  expect(state.complete).toBe(true);
  expect(state.draft.days).toHaveLength(366);
  expect(state.draft.groups.every((group) => group.studentIds.length === 4)).toBe(true);
  expect(state.memberCounts.reduce((sum, item) => sum + item.assignments, 0)).toBe(1464);
  expect(input).toEqual(before);
});
