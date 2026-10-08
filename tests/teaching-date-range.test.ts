import { expect, test } from 'vitest';
import { withinLocalDays } from '../src/renderer/features/teaching/date-range';

test('dashboard includes today before 08:00 and uses inclusive local calendar days', () => {
  const now = new Date(2026, 9, 8, 0, 1);
  expect(withinLocalDays('2026-10-08', 7, now)).toBe(true);
  expect(withinLocalDays('2026-10-02', 7, now)).toBe(true);
  expect(withinLocalDays('2026-10-01', 7, now)).toBe(false);
  expect(withinLocalDays('2026-10-09', 7, now)).toBe(false);
  expect(withinLocalDays('2026-09-09', 30, now)).toBe(true);
  expect(withinLocalDays('2026-09-08', 30, now)).toBe(false);
});
