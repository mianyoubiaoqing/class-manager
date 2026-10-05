import { expect, test } from 'vitest';
import { calculateScoreStatistics, parseScoreCell } from '../src/core/scores';
import type { ScoreAnalysisInput } from '../src/shared/scores';

const subject = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '数学',
  maxScore: '150',
  precision: 2 as const,
};

test('score cells preserve zero and all three non-numeric states without rounding input', () => {
  expect(parseScoreCell('0', subject)).toEqual({ status: 'valid', hundredths: 0 });
  expect(parseScoreCell('0.10', subject)).toEqual({ status: 'valid', hundredths: 10 });
  expect(parseScoreCell('缺考', subject)).toEqual({ status: 'absent' });
  expect(parseScoreCell('未选考', subject)).toEqual({ status: 'not_selected' });
  expect(parseScoreCell('', subject)).toEqual({ status: 'missing' });
  expect(parseScoreCell(null, subject)).toEqual({ status: 'missing' });
  for (const value of ['-1', '150.01', '1.001', '1e2', '=1+2', 'NaN', Infinity]) {
    expect(() => parseScoreCell(value, subject)).toThrow();
  }
  expect(() => parseScoreCell('1.5', { ...subject, precision: 0 })).toThrow();
});

const studentIds = [1, 2, 3, 4].map(
  (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
);
const groupId = '20000000-0000-4000-8000-000000000001';

test('statistics use the expected roster, exclude non-scores, and leave incomplete totals null', () => {
  const result = calculateScoreStatistics({
    subjects: [{ ...subject, targetScore: '90' }],
    groups: [{ id: groupId, name: '数学单科', subjectIds: [subject.id] }],
    roster: studentIds.map((studentId) => ({ studentId, groupId })),
    entries: [
      { studentId: studentIds[0], subjectId: subject.id, score: parseScoreCell('0', subject) },
      { studentId: studentIds[1], subjectId: subject.id, score: parseScoreCell('100', subject) },
      { studentId: studentIds[2], subjectId: subject.id, score: { status: 'absent' } },
    ],
  });
  expect(result.subjects[0]).toMatchObject({
    expectedCount: 4,
    validCount: 2,
    absentCount: 1,
    missingCount: 1,
    notSelectedCount: 0,
    mean: '50.00',
    median: '50.00',
    minimum: '0.00',
    maximum: '100.00',
    target: { score: '90.00', metCount: 1, denominator: 2, ratePercent: '50.00' },
    ranks: null,
  });
  expect(result.totals.map((row) => row.score)).toEqual(['0.00', '100.00', null, null]);
  expect(result.totals.every((row) => row.rank === null)).toBe(true);
  expect(result.groups[0]).toMatchObject({ completeCount: 2, incompleteCount: 2 });
  expect(result.subjects[0]?.distribution.map((band) => band.count)).toEqual([1, 0, 0, 1, 0]);
});

test('opt-in ranks use competition ties and never combine different scoring groups', () => {
  const other = { ...subject, id: '00000000-0000-4000-8000-000000000002', name: '语文' };
  const otherGroup = '20000000-0000-4000-8000-000000000002';
  const result = calculateScoreStatistics({
    subjects: [subject, other],
    groups: [
      { id: groupId, name: '数学', subjectIds: [subject.id] },
      { id: otherGroup, name: '语数', subjectIds: [subject.id, other.id] },
    ],
    roster: studentIds.map((studentId, index) => ({
      studentId,
      groupId: index === 3 ? otherGroup : groupId,
    })),
    entries: [
      ...studentIds.map((studentId, index) => ({
        studentId,
        subjectId: subject.id,
        score: parseScoreCell(index === 2 ? '80' : '90', subject),
      })),
      { studentId: studentIds[3], subjectId: other.id, score: parseScoreCell('100', other) },
    ],
    includeRanks: true,
  });
  expect(result.totals.map((row) => [row.score, row.rank])).toEqual([
    ['90.00', 1],
    ['90.00', 1],
    ['80.00', 3],
    ['190.00', 1],
  ]);
  expect(result.subjects[0]?.ranks?.map((row) => row.rank)).toEqual([1, 1, 4, 1]);
});

function singleSubjectInput(): ScoreAnalysisInput {
  return {
    subjects: [{ ...subject, targetScore: '90' }],
    groups: [{ id: groupId, name: '数学', subjectIds: [subject.id] }],
    roster: studentIds.map((studentId) => ({ studentId, groupId })),
    entries: [],
  };
}

test('empty data has no fabricated zero averages or target rates; explicit non-selection stays separate', () => {
  const input = singleSubjectInput();
  input.entries.push({
    studentId: studentIds[0]!,
    subjectId: subject.id,
    score: { status: 'not_selected' },
  });
  const result = calculateScoreStatistics(input);
  expect(result.subjects[0]).toMatchObject({
    validCount: 0,
    notSelectedCount: 1,
    missingCount: 3,
    mean: null,
    median: null,
    minimum: null,
    maximum: null,
    target: { denominator: 0, ratePercent: null },
  });
  expect(result.groups[0]).toMatchObject({
    completeCount: 0,
    incompleteCount: 4,
    mean: null,
  });
});

test('integer decimal arithmetic uses half-up presentation and exact totals', () => {
  const input = singleSubjectInput();
  input.entries = ['1.00', '1.01'].map((value, index) => ({
    studentId: studentIds[index]!,
    subjectId: subject.id,
    score: parseScoreCell(value, subject),
  }));
  expect(calculateScoreStatistics(input).subjects[0]).toMatchObject({
    mean: '1.01',
    median: '1.01',
  });
  const other = { ...subject, id: '00000000-0000-4000-8000-000000000002', name: '语文' };
  input.subjects.push(other);
  input.groups[0]!.subjectIds.push(other.id);
  input.entries = [
    { studentId: studentIds[0]!, subjectId: subject.id, score: parseScoreCell('0.1', subject) },
    { studentId: studentIds[0]!, subjectId: other.id, score: parseScoreCell('0.2', other) },
  ];
  expect(calculateScoreStatistics(input).totals[0]?.score).toBe('0.30');
});

test('the six-subject specification example totals 561 and an absence cannot become zero', () => {
  const ids = ['语文', '数学', '英语', '物理', '化学', '生物学'].map((name, index) => ({
    ...subject,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name,
    maxScore: index < 3 ? '150' : '100',
  }));
  const first = ['112', '95', '118', '76', '81', '79'];
  const second = ['105', '缺考', '109', '70', '75', '83'];
  const result = calculateScoreStatistics({
    subjects: ids,
    groups: [{ id: groupId, name: '六科', subjectIds: ids.map((item) => item.id) }],
    roster: studentIds.slice(0, 2).map((studentId) => ({ studentId, groupId })),
    entries: [first, second].flatMap((row, index) =>
      ids.map((item, column) => ({
        studentId: studentIds[index]!,
        subjectId: item.id,
        score: parseScoreCell(row[column], item),
      })),
    ),
  });
  expect(result.totals.map((row) => row.score)).toEqual(['561.00', null]);
  expect(result.subjects[1]).toMatchObject({ validCount: 1, mean: '95.00', absentCount: 1 });
});

test('distribution intervals are lower-inclusive and only the last includes its upper boundary', () => {
  const input = singleSubjectInput();
  input.subjects[0]!.maxScore = '100';
  input.entries = [0, 20, 80, 100].map((value, index) => ({
    studentId: studentIds[index]!,
    subjectId: subject.id,
    score: { status: 'valid', hundredths: value * 100 },
  }));
  const stats = calculateScoreStatistics(input).subjects[0]!;
  expect(stats.distribution.map((band) => band.count)).toEqual([1, 1, 0, 0, 2]);
  expect(stats.distribution.map((band) => band.upperInclusive)).toEqual([
    false,
    false,
    false,
    false,
    true,
  ]);
});

test.each([
  'duplicate-roster',
  'duplicate-score',
  'unknown-student',
  'unknown-subject',
  'unknown-group',
  'duplicate-group-subject',
  'bad-precision',
  'too-high',
  'zero-maximum',
  'bad-target',
] as const)('invalid statistics input is rejected: %s', (failure) => {
  const input = singleSubjectInput();
  const entry = {
    studentId: studentIds[0]!,
    subjectId: subject.id,
    score: { status: 'valid' as const, hundredths: 100 },
  };
  input.entries.push(entry);
  switch (failure) {
    case 'duplicate-roster':
      input.roster.push(input.roster[0]!);
      break;
    case 'duplicate-score':
      input.entries.push(entry);
      break;
    case 'unknown-student':
      entry.studentId = '10000000-0000-4000-8000-000000000099';
      break;
    case 'unknown-subject':
      entry.subjectId = '00000000-0000-4000-8000-000000000099';
      break;
    case 'unknown-group':
      input.roster[0]!.groupId = '20000000-0000-4000-8000-000000000099';
      break;
    case 'duplicate-group-subject':
      input.groups[0]!.subjectIds.push(subject.id);
      break;
    case 'bad-precision':
      input.subjects[0]!.precision = 0;
      entry.score.hundredths = 101;
      break;
    case 'too-high':
      entry.score.hundredths = 15001;
      break;
    case 'zero-maximum':
      input.subjects[0]!.maxScore = '0';
      break;
    case 'bad-target':
      input.subjects[0]!.targetScore = '151';
      break;
  }
  expect(() => calculateScoreStatistics(input)).toThrow();
});
