import { dutyDateSchema, DUTY_LIMITS, type DutyDraft } from '../shared/duty';

/** UI-only calendar entry; backend still owns protected dates and all assignment rules. */
export function dutyDateRange(first: string, last: string, weekdays: number[]): string[] {
  if (!dutyDateSchema.safeParse(first).success || !dutyDateSchema.safeParse(last).success)
    throw new Error('请选择有效的开始和结束日期。');
  const start = Date.parse(`${first}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);
  if (end < start || (end - start) / 86400000 >= DUTY_LIMITS.dates)
    throw new Error('日期范围须为 1–366 天，结束日期不能早于开始日期。');
  if (!weekdays.length) throw new Error('至少选择一个星期选项。');
  const dates: string[] = [];
  for (let time = start; time <= end; time += 86400000) {
    const date = new Date(time);
    if (weekdays.includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
  }
  if (!dates.length) throw new Error('所选范围内没有符合星期选项的日期。');
  return dates;
}

export function dutyTime(minutes: number): string {
  return `${Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`;
}

export function dutyMinutes(text: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u.test(text)) return NaN;
  const [hours, minutes] = text.split(':').map(Number);
  return hours! * 60 + minutes!;
}

export function dutyMemberLabel(draft: DutyDraft, id: string): string {
  const member = draft.members.find((item) => item.studentId === id);
  return member ? `${member.studentNumber} · ${member.displayName}` : '未知成员';
}

/** Presentation counts only: no fairness score, no scheduling decisions, no mutation. */
export function dutyCounts(draft: DutyDraft) {
  const groups = new Map(draft.groups.map((group) => [group.id, 0]));
  const members = new Map(draft.members.map((member) => [member.studentId, 0]));
  for (const day of draft.days) {
    groups.set(day.groupId, (groups.get(day.groupId) ?? 0) + 1);
    for (const post of day.posts)
      for (const slot of post.slots)
        if (slot) members.set(slot.studentId, (members.get(slot.studentId) ?? 0) + 1);
  }
  return { groups, members };
}
