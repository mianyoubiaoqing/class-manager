/** Inclusive calendar days in the teacher's local timezone, including today. */
export function withinLocalDays(date: string, days: number, now = new Date()): boolean {
  const end = new Date(now),
    start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  end.setHours(23, 59, 59, 999);
  const timestamp = new Date(`${date}T00:00:00`).getTime();
  return timestamp >= start.getTime() && timestamp <= end.getTime();
}
