import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  dutyDateSchema,
  dutyDraftSchema,
  dutyGenerateSchema,
  dutyGroupSchema,
  dutyMemberSchema,
  DUTY_LIMITS,
  type DutyDay,
  type DutyDraft,
  type DutyDraftState,
  type DutyGroup,
  type DutyPost,
} from '../shared/duty';
import { DomainError } from './errors';

/**
 * Shared contract for all exported operations: parse strict schemas, return detached values,
 * never mutate caller input, persist data, call AI or read the clock. ZodError reports malformed
 * fields; DomainError(VALIDATION) reports rule conflicts. No cancellation/background work.
 * Except generateDuty's fresh IDs, repeated calls with identical input/date are deterministic;
 * callers must not confuse this with persistence idempotency or automatically retry user edits.
 */
function invalid(message: string): never {
  throw new DomainError('VALIDATION', message);
}
function unique(values: string[], message: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) invalid(message);
  return result;
}
function membersOnly(values: string[], members: Set<string>, message: string): void {
  if (values.some((id) => !members.has(id))) invalid(message);
}
function overlap(left: DutyPost, right: DutyPost): boolean {
  return left.startMinute < right.endMinute && right.startMinute < left.endMinute;
}
function frozen(day: DutyDay, today: string): boolean {
  return day.completed || day.date < today;
}

/**
 * Validate and detach a plan; report empty groups, missing days and explicit vacant slots.
 * Malformed structures throw ZodError; invalid references, duplicate membership, unavailable
 * assignees or overlapping work throw DomainError(VALIDATION). No mutation, clock, I/O or AI.
 * Counts describe group appearances and assigned posts, not individual workload fairness.
 */
export function inspectDutyDraft(input: unknown): DutyDraftState {
  const draft = dutyDraftSchema.parse(input);
  const members = unique(
    draft.members.map((item) => item.studentId),
    '参与学生重复。',
  );
  unique(
    draft.members.map((item) => item.studentNumber.toUpperCase()),
    '学生编号重复。',
  );
  const participants = unique(draft.participantIds, '当前参与学生重复。');
  membersOnly(draft.participantIds, members, '参与名单缺少成员快照。');
  const groups = unique(
    draft.groups.map((item) => item.id),
    '小组标识重复。',
  );
  unique(
    draft.groups.map((item) => item.name),
    '小组名称重复。',
  );
  const grouped = draft.groups.flatMap((group) => group.studentIds);
  unique(grouped, '学生不能重复分入小组。');
  membersOnly(grouped, participants, '分组包含非参与学生。');
  if (grouped.length !== participants.size) invalid('每名参与学生都必须分入一个当期小组。');
  const dates = unique(draft.dates, '值日日期重复。');
  if (draft.dates.some((date, index) => index > 0 && date <= draft.dates[index - 1]!))
    invalid('值日日期必须按先后顺序排列。');
  const posts = new Map(draft.posts.map((post) => [post.id, post]));
  if (posts.size !== draft.posts.length) invalid('岗位标识重复。');
  unique(
    draft.posts.map((post) => post.name),
    '岗位名称重复。',
  );
  if (draft.posts.reduce((total, post) => total + post.required, 0) > DUTY_LIMITS.dailySlots)
    invalid(`每日岗位人数总和不能超过 ${DUTY_LIMITS.dailySlots}。`);
  const absences = new Map<string, Set<string>>();
  for (const absence of draft.unavailable) {
    if (!dates.has(absence.date) || absences.has(absence.date)) invalid('不可用日期无效或重复。');
    const ids = unique(absence.studentIds, '不可用学生重复。');
    membersOnly(absence.studentIds, members, '不可用名单包含非参与学生。');
    absences.set(absence.date, ids);
  }
  const seenDates = new Set<string>();
  const groupCounts = new Map(draft.groups.map((group) => [group.id, 0]));
  const memberCounts = new Map(draft.members.map((member) => [member.studentId, 0]));
  const shortages: DutyDraftState['shortages'] = [];
  for (const day of draft.days) {
    if (!dates.has(day.date) || seenDates.has(day.date)) invalid('安排日期无效或重复。');
    seenDates.add(day.date);
    if (!groups.has(day.groupId)) invalid('安排引用不存在的小组。');
    const dailyMembers = unique(day.groupMemberIds, '当日小组成员快照重复。');
    membersOnly(day.groupMemberIds, members, '当日快照包含非参与学生。');
    const occupied = new Map<string, DutyPost[]>();
    const seenPosts = new Set<string>();
    for (const assignment of day.posts) {
      const post = posts.get(assignment.postId);
      if (!post || seenPosts.has(post.id)) invalid('当日岗位无效或重复。');
      seenPosts.add(post.id);
      if (assignment.slots.length !== post.required) invalid('岗位必须显式保留全部人数位置。');
      let missing = 0;
      for (const slot of assignment.slots) {
        if (!slot) {
          missing++;
          continue;
        }
        if (!members.has(slot.studentId)) invalid('岗位包含非参与学生。');
        if (!slot.temporaryReplacement && !dailyMembers.has(slot.studentId))
          invalid('非当日轮值组成员必须明确标为临时替换。');
        if (absences.get(day.date)?.has(slot.studentId))
          invalid('该学生当日不可用，不能安排岗位。');
        const previous = occupied.get(slot.studentId) ?? [];
        if (previous.some((item) => overlap(item, post)))
          invalid('同一学生不能在重叠时间重复占岗。');
        occupied.set(slot.studentId, [...previous, post]);
        memberCounts.set(slot.studentId, memberCounts.get(slot.studentId)! + 1);
      }
      if (missing) shortages.push({ date: day.date, postId: post.id, missing });
    }
    if (seenPosts.size !== posts.size) invalid('当日安排必须覆盖所有岗位。');
    if (day.completed && day.posts.some((post) => post.slots.some((slot) => !slot)))
      invalid('有岗位缺口的日期不能标记完成。');
    groupCounts.set(day.groupId, groupCounts.get(day.groupId)! + 1);
  }
  const emptyGroupIds = draft.groups
    .filter((group) => !group.studentIds.length)
    .map((group) => group.id);
  const missingDates = draft.dates.filter((date) => !seenDates.has(date));
  return {
    draft,
    emptyGroupIds,
    missingDates,
    shortages,
    groupCounts: [...groupCounts].map(([groupId, days]) => ({ groupId, days })),
    memberCounts: [...memberCounts].map(([studentId, assignments]) => ({ studentId, assignments })),
    complete: !emptyGroupIds.length && !missingDates.length && !shortages.length,
  };
}

/** Confirmation/printing guard. Same errors as inspect; incomplete plans are rejected, never padded. */
export function requireCompleteDuty(input: unknown): DutyDraft {
  const state = inspectDutyDraft(input);
  if (state.emptyGroupIds.length) invalid('存在空组，请调整组员后确认。');
  if (state.missingDates.length) invalid('尚有日期未安排，不能确认。');
  if (state.shortages.length) invalid('仍有岗位人员缺口，请补齐后确认。');
  return state.draft;
}

function arrangeDay(draft: DutyDraft, date: string, group: DutyGroup): DutyDay {
  if (!group.studentIds.length) invalid('空组不能安排轮值，请先调整组员。');
  const unavailable = new Set(
    draft.unavailable.find((item) => item.date === date)?.studentIds ?? [],
  );
  const occupied = new Map<string, DutyPost[]>();
  // Stable time order makes interval allocation reproducible; saved UI order stays unchanged.
  const scheduled = new Map<string, DutyDay['posts'][number]>();
  for (const post of [...draft.posts].sort((a, b) => a.startMinute - b.startMinute)) {
    const slots: DutyDay['posts'][number]['slots'] = [];
    for (let index = 0; index < post.required; index++) {
      const id = group.studentIds.find(
        (member) =>
          !unavailable.has(member) &&
          !(occupied.get(member) ?? []).some((previous) => overlap(previous, post)),
      );
      slots.push(id ? { studentId: id, temporaryReplacement: false } : null);
      if (id) occupied.set(id, [...(occupied.get(id) ?? []), post]);
    }
    scheduled.set(post.id, { postId: post.id, slots });
  }
  return {
    date,
    groupId: group.id,
    groupName: group.name,
    groupMemberIds: [...group.studentIds],
    completed: false,
    posts: draft.posts.map((post) => scheduled.get(post.id)!),
  };
}

/**
 * Generate balanced temporary groups from the explicit member order, then round-robin dates.
 * No random reordering or holiday inference. Same input produces the same allocation; UUIDs
 * identify groups and may be injected for tests. Invalid IDs/configuration reject atomically.
 * Factory exceptions propagate unchanged. Fresh IDs make default generation non-idempotent
 * in identity even though allocation is deterministic; the shared contract applies.
 * Personnel shortages remain null slots and prevent confirmation; no out-of-group auto-fill.
 */
export function generateDuty(input: unknown, createId: () => string = randomUUID): DutyDraftState {
  const config = dutyGenerateSchema.parse(input);
  if (config.groupCount > config.members.length) invalid('组数不能超过参与人数，不能生成空组。');
  const groups: DutyGroup[] = Array.from({ length: config.groupCount }, (_, index) => ({
    id: z.uuid().parse(createId()),
    name: `第 ${index + 1} 组`,
    studentIds: [],
  }));
  config.members.forEach((member, index) =>
    groups[index % groups.length]!.studentIds.push(member.studentId),
  );
  const draft = inspectDutyDraft({
    members: config.members,
    participantIds: config.members.map((member) => member.studentId),
    dates: config.dates,
    posts: config.posts,
    unavailable: config.unavailable,
    groups,
    days: [],
  }).draft;
  draft.days = draft.dates.map((date, index) =>
    arrangeDay(draft, date, groups[index % groups.length]!),
  );
  return inspectDutyDraft(draft);
}

function editableDay(draft: DutyDraft, date: string, today: string): DutyDay {
  dutyDateSchema.parse(date);
  dutyDateSchema.parse(today);
  const day = draft.days.find((item) => item.date === date);
  if (!day) invalid('安排日期不存在。');
  if (frozen(day, today)) invalid('已完成或过去日期不可修改，请保留历史记录。');
  return day;
}

/**
 * Change one slot only, explicitly recording a temporary replacement (or null vacancy).
 * Reject frozen dates, unknown IDs/positions, unavailable members and time conflicts.
 * Detached result; no implicit swaps, other-day changes, writes or automatic retry.
 */
export function replaceDutySlot(
  input: unknown,
  date: string,
  postId: string,
  slotIndex: number,
  studentId: string | null,
  today: string,
): DutyDraftState {
  const draft = inspectDutyDraft(input).draft;
  const day = editableDay(draft, date, today);
  const post = day.posts.find((item) => item.postId === z.uuid().parse(postId));
  if (studentId !== null && !draft.participantIds.includes(studentId))
    invalid('替换对象是非参与学生，请先调整当期名单。');
  if (!post || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= post.slots.length)
    invalid('岗位位置不存在。');
  post.slots[slotIndex] =
    studentId === null
      ? null
      : { studentId: z.uuid().parse(studentId), temporaryReplacement: true };
  return inspectDutyDraft(draft);
}

/** Shared contract applies. Reassign only an editable date, rebuilding its posts and clearing substitutes. */
export function changeDutyDayGroup(
  input: unknown,
  date: string,
  groupId: string,
  today: string,
): DutyDraftState {
  const draft = inspectDutyDraft(input).draft;
  editableDay(draft, date, today);
  const group = draft.groups.find((item) => item.id === z.uuid().parse(groupId));
  if (!group) invalid('小组不存在。');
  draft.days = draft.days.map((day) => (day.date === date ? arrangeDay(draft, date, group) : day));
  return inspectDutyDraft(draft);
}

/**
 * Explicitly rerun the group order over the original date indices, retaining all frozen days.
 * Only editable dates lose manual changes/substitutes; call after teacher review, never on retry.
 */
export function rotateDuty(input: unknown, today: string): DutyDraftState {
  const draft = inspectDutyDraft(input).draft;
  dutyDateSchema.parse(today);
  const existing = new Map(draft.days.map((day) => [day.date, day]));
  draft.days = draft.dates.map((date, index) => {
    const day = existing.get(date);
    if (day && frozen(day, today)) return day;
    if (date < today) invalid('不能为过去日期补造安排。');
    return arrangeDay(draft, date, draft.groups[index % draft.groups.length]!);
  });
  return inspectDutyDraft(draft);
}

/**
 * Edit the period's group membership/order; each participant must still appear exactly once.
 * Preserve frozen daily snapshots, rebuild editable dates with the same assigned group identity.
 * Empty groups may be edited, but cannot be assigned or confirmed. Surviving group IDs are fixed.
 * Teachers must review rebuilt future slots: explicit temporary replacements there are cleared.
 */
export function changeDutyGroups(
  input: unknown,
  groupsInput: unknown,
  today: string,
): DutyDraftState {
  const draft = inspectDutyDraft(input).draft;
  return changeDutyParticipants(
    draft,
    draft.members.filter((member) => draft.participantIds.includes(member.studentId)),
    groupsInput,
    today,
  );
}

/**
 * Shared contract applies. Add/remove current participants and repartition existing groups.
 * Preserve frozen daily/absence snapshots and names; only editable dates are rebuilt.
 * Incoming names come from the authoritative roster; storage must check enrollment.
 * Removed members stay while referenced by history; unreferenced snapshots are dropped.
 */
export function changeDutyParticipants(
  input: unknown,
  membersInput: unknown,
  groupsInput: unknown,
  today: string,
): DutyDraftState {
  const draft = inspectDutyDraft(input).draft;
  dutyDateSchema.parse(today);
  const selected = z.array(dutyMemberSchema).min(1).max(DUTY_LIMITS.members).parse(membersInput);
  const groups = z.array(dutyGroupSchema).min(1).max(DUTY_LIMITS.groups).parse(groupsInput);
  unique(
    groups.map((group) => group.id),
    '小组标识重复。',
  );
  const originalIds = new Set(draft.groups.map((item) => item.id));
  if (groups.length !== originalIds.size || groups.some((group) => !originalIds.has(group.id)))
    invalid('当期调整保留原小组标识及数量；重新分期才能更换组数。');
  const members = new Map(draft.members.map((member) => [member.studentId, member]));
  for (const member of selected) {
    const saved = members.get(member.studentId);
    if (saved && JSON.stringify(saved) !== JSON.stringify(member))
      invalid('已有成员的历史姓名及编号快照不能改写。');
    members.set(member.studentId, member);
  }
  const participantIds = selected.map((member) => member.studentId);
  // Validate the final retained snapshot set, not the temporary union before retiring members.
  const next: DutyDraft = {
    ...draft,
    members: [...members.values()],
    participantIds,
    groups,
  };
  next.days = next.days.map((day) => {
    if (frozen(day, today)) return day;
    const group = next.groups.find((item) => item.id === day.groupId)!;
    return arrangeDay(next, day.date, group);
  });
  next.unavailable = next.unavailable.map((absence) => {
    const day = next.days.find((item) => item.date === absence.date);
    return day && frozen(day, today)
      ? absence
      : { ...absence, studentIds: absence.studentIds.filter((id) => participantIds.includes(id)) };
  });
  // 退组不删除过去安排中的成员快照；只回收此修订完全不再引用的成员。
  const referenced = new Set([
    ...participantIds,
    ...next.days.flatMap((day) => [
      ...day.groupMemberIds,
      ...day.posts.flatMap((post) => post.slots.flatMap((slot) => (slot ? [slot.studentId] : []))),
    ]),
    ...next.unavailable.flatMap((absence) => absence.studentIds),
  ]);
  next.members = next.members.filter((member) => referenced.has(member.studentId));
  return inspectDutyDraft(next);
}

/** Shared contract applies. Mark a staffed date complete on/after that date; repeated completion is a no-op. */
export function completeDutyDay(input: unknown, date: string, today: string): DutyDraftState {
  const draft = inspectDutyDraft(input).draft;
  dutyDateSchema.parse(today);
  dutyDateSchema.parse(date);
  if (date > today) invalid('未来日期不能提前标记完成。');
  const day = draft.days.find((item) => item.date === date);
  if (!day) invalid('安排日期不存在。');
  day.completed = true;
  return inspectDutyDraft(draft);
}

/** First-confirmation guard: complete future/today plan with matching group snapshots, no completion flags. */
export function requireNewDuty(input: unknown, today: string): DutyDraft {
  const draft = requireCompleteDuty(input);
  dutyDateSchema.parse(today);
  if (draft.members.length !== draft.participantIds.length)
    invalid('新一期不能包含仅供历史保留的成员。');
  for (const day of draft.days) {
    if (day.date < today || day.completed) invalid('新一期只能安排今天或未来，不能预先标记完成。');
    requireCurrentGroup(draft, day);
  }
  return draft;
}

function requireCurrentGroup(draft: DutyDraft, day: DutyDay): void {
  const group = draft.groups.find((item) => item.id === day.groupId)!;
  if (
    JSON.stringify(group.studentIds) !== JSON.stringify(day.groupMemberIds) ||
    group.name !== day.groupName
  )
    invalid('未完成日期的小组快照必须与当期分组一致。');
  if (
    day.posts.some((post) =>
      post.slots.some((slot) => slot && !draft.participantIds.includes(slot.studentId)),
    )
  )
    invalid('未完成日期不能安排已移出当期名单的学生。');
  const absent = draft.unavailable.find((item) => item.date === day.date)?.studentIds ?? [];
  membersOnly(absent, new Set(draft.participantIds), '未完成日期的不可用名单包含已移出学生。');
}

/**
 * Set the whole-day unavailable list for one editable date. Newly unavailable assignees become
 * explicit vacancies; restoring availability does not silently reassign or discard substitutes.
 */
export function setDutyUnavailable(
  input: unknown,
  date: string,
  studentIds: string[],
  today: string,
): DutyDraftState {
  const draft = inspectDutyDraft(input).draft;
  const day = editableDay(draft, date, today);
  const unavailable = unique(
    z.array(z.uuid()).max(DUTY_LIMITS.members).parse(studentIds),
    '不可用学生重复。',
  );
  membersOnly(studentIds, new Set(draft.participantIds), '不可用名单包含非参与学生。');
  draft.unavailable = draft.unavailable.filter((item) => item.date !== date);
  if (studentIds.length) draft.unavailable.push({ date, studentIds: [...studentIds] });
  for (const post of day.posts) {
    post.slots = post.slots.map((slot) => (slot && unavailable.has(slot.studentId) ? null : slot));
  }
  return inspectDutyDraft(draft);
}

/**
 * Persistence guard for a revision of the same period. Keep dates/posts/retained member snapshots and
 * group identities fixed; changes to future groups/slots and date-specific absences are allowed.
 * Past/completed daily records are immutable except a past incomplete flag may become complete.
 * The caller supplies the local calendar date and authoritative prior version, never Renderer.
 */
export function requireDutyRevision(
  previousInput: unknown,
  nextInput: unknown,
  today: string,
): DutyDraft {
  const previous = requireCompleteDuty(previousInput);
  const next = requireCompleteDuty(nextInput);
  dutyDateSchema.parse(today);
  for (const field of ['dates', 'posts'] as const) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field]))
      invalid('当期修订不能替换日期或岗位；请另建新一期。');
  }
  const originalMembers = new Map(previous.members.map((member) => [member.studentId, member]));
  for (const member of next.members) {
    const saved = originalMembers.get(member.studentId);
    if (saved && JSON.stringify(saved) !== JSON.stringify(member))
      invalid('已有成员的历史姓名及编号快照不能改写。');
  }
  const previousGroups = previous.groups.map((group) => group.id).sort();
  if (
    JSON.stringify(previousGroups) !== JSON.stringify(next.groups.map((group) => group.id).sort())
  )
    invalid('当期修订不能更换小组标识。');
  for (const day of previous.days) {
    const updated = next.days.find((item) => item.date === day.date)!;
    if (updated.completed && day.date > today) invalid('未来日期不能提前标记完成。');
    if (frozen(day, today)) {
      if (day.completed && !updated.completed) invalid('已完成日期不能重新开启。');
      if (JSON.stringify({ ...day, completed: updated.completed }) !== JSON.stringify(updated))
        invalid('已完成或过去日期的安排不能改写。');
      const absent = (plan: DutyDraft) =>
        plan.unavailable.find((item) => item.date === day.date)?.studentIds ?? [];
      if (JSON.stringify(absent(previous)) !== JSON.stringify(absent(next)))
        invalid('已完成或过去日期的不可用名单不能改写。');
    } else {
      requireCurrentGroup(next, updated);
    }
  }
  return next;
}
