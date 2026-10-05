import type { DutyVersionView } from '../../src/shared/duty-records';
import { generateDuty } from '../../src/core/duty';

/** Literal synthetic identities, independent of a live roster, wall clock or model provider. */
export function dutyPrintView(count = 12, groupCount = 2, dateCount = 3): DutyVersionView {
  const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let next = 2000;
  const draft = generateDuty(
    {
      members: Array.from({ length: count }, (_, index) => ({
        studentId: id(index + 1),
        studentNumber: `D${String(index + 1).padStart(3, '0')}`,
        displayName: `合成值日成员${index + 1}`,
      })),
      dates: Array.from({ length: dateCount }, (_, index) =>
        new Date(Date.UTC(2026, 9, 1) + index * 86400000).toISOString().slice(0, 10),
      ),
      posts: [
        {
          id: id(1000),
          name: '合成清扫岗位',
          startMinute: 960,
          endMinute: 990,
          required: Math.floor(count / groupCount),
        },
      ],
      groupCount,
      unavailable: [],
    },
    () => id(next++),
  ).draft;
  return {
    record: {
      id: id(3000),
      planId: id(3001),
      classId: id(3002),
      revision: 1,
      requestId: id(3003),
      requestHash: 'a'.repeat(64),
      createdAt: '2026-09-30T10:00:00.000Z',
      protectedDate: '2026-09-30',
      reason: '合成打印验证',
    },
    payload: {
      formatVersion: 1,
      classId: id(3002),
      className: '合成值日打印班',
      title: '合成当期值日',
      arrangement: draft,
    },
    latestVersionId: id(3000),
    stale: false,
  };
}
