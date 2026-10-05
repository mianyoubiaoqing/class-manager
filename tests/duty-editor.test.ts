import { describe, expect, test } from 'vitest';
import { dutyDateRange, dutyMinutes, dutyTime } from '../src/renderer/duty-editor';

describe('duty configuration calendar and time entry', () => {
  test('explicit weekdays, leap days, year boundaries, and 366-day bound', () => {
    expect(dutyDateRange('2028-02-28', '2028-03-01', [0, 1, 2, 3, 4, 5, 6])).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
    expect(dutyDateRange('2026-12-31', '2027-01-02', [0, 1, 2, 3, 4, 5, 6])).toEqual([
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(dutyDateRange('2026-09-28', '2026-10-04', [1, 3, 5])).toEqual([
      '2026-09-28',
      '2026-09-30',
      '2026-10-02',
    ]);
    expect(dutyDateRange('2028-01-01', '2028-12-31', [0, 1, 2, 3, 4, 5, 6])).toHaveLength(366);
  });
  test.each([
    ['2027-02-29', '2027-03-01', [1]],
    ['2026-10-02', '2026-10-01', [1]],
    ['2028-01-01', '2029-01-01', [1]],
    ['2026-09-30', '2026-09-30', []],
    ['2026-09-30', '2026-09-30', [1]],
    ['', '', [1]],
  ] as const)('rejects invalid or empty range %s..%s', (first, last, days) => {
    expect(() => dutyDateRange(first, last, [...days])).toThrow();
  });
  test('time entry roundtrips all valid minute values including end-of-day 24:00', () => {
    for (let minute = 0; minute <= 1440; minute++)
      expect(dutyMinutes(dutyTime(minute))).toBe(minute);
    for (const invalid of ['9:00', '24:01', '25:00', '12:60', '12', ' 12:00', '12:00x'])
      expect(dutyMinutes(invalid)).toBeNaN();
  });
});
