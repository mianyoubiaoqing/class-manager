import type { CountdownRecord, CountdownView } from '../shared/classroom';

/** Calendar days in the configured zone; 23/25-hour DST days never change the day count. */
export function countdownView(record: CountdownRecord, now = Date.now()): CountdownView {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: record.setting.timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  const today = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  const days = Math.round(
    (Date.parse(`${record.setting.targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86400000,
  );
  return {
    ...record,
    today,
    remainingDays: Math.max(0, days),
    status: days > 0 ? 'future' : days === 0 ? 'today' : 'expired',
  };
}
