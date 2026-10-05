import type { SeatingVersionView } from '../../src/shared/seating-records';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Synthetic complete snapshot; independent of persistence and randomization producers. */
export function printView(rows = 2, columns = 3, count = rows * columns): SeatingVersionView {
  return {
    record: {
      id: id(1001),
      classId: id(1002),
      revision: 1,
      requestId: id(1003),
      requestHash: 'a'.repeat(64),
      createdAt: '2026-09-30T06:00:00.000Z',
      reason: '合成打印',
    },
    payload: {
      formatVersion: 1,
      classId: id(1002),
      className: '合成打印班',
      layoutVersionId: id(1004),
      arrangement: {
        layout: { rows, columns, unavailable: [] },
        members: Array.from({ length: count }, (_, n) => ({
          studentId: id(n + 1),
          studentNumber: `S${n + 1}`,
          displayName: `合成学生${n + 1}`,
        })),
        assignments: Array.from({ length: count }, (_, n) => ({
          studentId: id(n + 1),
          row: Math.floor(n / columns) + 1,
          column: (n % columns) + 1,
        })),
        lockedStudentIds: [id(1)],
      },
    },
    latestVersionId: id(1001),
    stale: false,
    rosterChanged: false,
  };
}
