import {
  scoreAnalysisInput,
  scoreSubjectSchema,
  scoreValueSchema,
  type NumericScoreSummary,
  type ScoreStatistics,
  type ScoreSubject,
  type ScoreValue,
  type SubjectStatistics,
} from '../shared/scores';
import { DomainError } from './errors';

/** Parse decimal digits rather than multiplying a floating-point score by 100. */
function hundredths(text: string, precision: number): number {
  const match = /^(0|[1-9]\d{0,4})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match || (match[2]?.length ?? 0) > precision) {
    throw new DomainError('SCORE_INVALID', '成绩格式或小数位不符合科目配置。');
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

function validateSubject(input: ScoreSubject): { subject: ScoreSubject; maximum: number } {
  const subject = scoreSubjectSchema.parse(input);
  const maximum = hundredths(subject.maxScore, subject.precision);
  if (maximum <= 0 || maximum > 1_000_000) {
    throw new DomainError('SCORE_CONFIG', '科目满分必须大于 0 且不超过 10000。');
  }
  if (
    subject.targetScore !== undefined &&
    hundredths(subject.targetScore, subject.precision) > maximum
  ) {
    throw new DomainError('SCORE_CONFIG', '目标分数线不能超过满分。');
  }
  return { subject, maximum };
}

export function parseScoreCell(input: unknown, configuration: ScoreSubject): ScoreValue {
  const { subject, maximum } = validateSubject(configuration);
  if (input === null || input === undefined) return { status: 'missing' };
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new DomainError('SCORE_INVALID', '成绩必须为数字或明确的成绩状态。');
  }
  const text = String(input).trim();
  if (text === '' || text === '未录入') return { status: 'missing' };
  if (text === '缺考') return { status: 'absent' };
  if (text === '未选考') return { status: 'not_selected' };
  const value = hundredths(text, subject.precision);
  if (value > maximum) throw new DomainError('SCORE_INVALID', '成绩超过该科目满分。');
  return { status: 'valid', hundredths: value };
}

function formatScore(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

/** All operands are bounded integers; ties round half-up only at the display boundary. */
function roundRatio(numerator: number, denominator: number): number {
  return (
    Math.floor(numerator / denominator) + (2 * (numerator % denominator) >= denominator ? 1 : 0)
  );
}

/** 跨次历史只描述数值与得分率，不从不同试卷的分数推断能力变化。 */
export function presentSubjectScore(value: ScoreValue, configuration: ScoreSubject) {
  const score = scoreValueSchema.parse(value);
  const { maximum, subject } = validateSubject(configuration);
  if (score.status !== 'valid') return { displayScore: null, ratePercent: null };
  if (score.hundredths > maximum || score.hundredths % 10 ** (2 - subject.precision) !== 0) {
    throw new DomainError('SCORE_INVALID', '成绩不符合科目满分或精度。');
  }
  return {
    displayScore: formatScore(score.hundredths),
    ratePercent: formatScore(roundRatio(score.hundredths * 10000, maximum)),
  };
}

function summarize(values: number[]): NumericScoreSummary {
  if (!values.length) return { mean: null, median: null, minimum: null, maximum: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[middle]! : roundRatio(sorted[middle - 1]! + sorted[middle]!, 2);
  return {
    mean: formatScore(
      roundRatio(
        values.reduce((sum, value) => sum + value, 0),
        values.length,
      ),
    ),
    median: formatScore(median),
    minimum: formatScore(sorted[0]!),
    maximum: formatScore(sorted.at(-1)!),
  };
}

function rejectDuplicates(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new DomainError('SCORE_DUPLICATE', `${label}重复，不能继续统计。`);
  }
}

function competitionRanks(values: Array<[string, number]>): Map<string, number> {
  const result = new Map<string, number>();
  let previous: number | undefined;
  let rank = 0;
  [...values]
    .sort((a, b) => b[1] - a[1])
    .forEach(([studentId, value], index) => {
      if (value !== previous) rank = index + 1;
      result.set(studentId, rank);
      previous = value;
    });
  return result;
}

export function calculateScoreStatistics(raw: unknown): ScoreStatistics {
  const input = scoreAnalysisInput.parse(raw);
  rejectDuplicates(
    input.subjects.map((subject) => subject.id),
    '科目标识',
  );
  rejectDuplicates(
    input.subjects.map((subject) => subject.name.toLowerCase()),
    '科目名称',
  );
  rejectDuplicates(
    input.groups.map((group) => group.id),
    '计分组',
  );
  rejectDuplicates(
    input.roster.map((member) => member.studentId),
    '应考学生',
  );
  const subjects = new Map(input.subjects.map((subject) => [subject.id, validateSubject(subject)]));
  const groups = new Map(input.groups.map((group) => [group.id, group]));
  for (const group of input.groups) {
    rejectDuplicates(group.subjectIds, '计分组科目');
    if (group.subjectIds.some((id) => !subjects.has(id))) {
      throw new DomainError('SCORE_CONFIG', '计分组引用了本次考试未设置的科目。');
    }
  }
  const roster = new Set(input.roster.map((member) => member.studentId));
  if (input.roster.some((member) => !groups.has(member.groupId))) {
    throw new DomainError('SCORE_CONFIG', '每名应考学生都必须明确选择计分组。');
  }
  const entries = new Map<string, ScoreValue>();
  const cellKey = (studentId: string, subjectId: string) => `${studentId}:${subjectId}`;
  for (const entry of input.entries) {
    const configured = subjects.get(entry.subjectId);
    if (!roster.has(entry.studentId) || !configured) {
      throw new DomainError('SCORE_SCOPE', '成绩包含应考名册或考试科目范围外的数据。');
    }
    const key = cellKey(entry.studentId, entry.subjectId);
    if (entries.has(key)) throw new DomainError('SCORE_DUPLICATE', '同一学生的科目成绩重复。');
    if (
      entry.score.status === 'valid' &&
      (entry.score.hundredths > configured.maximum ||
        entry.score.hundredths % 10 ** (2 - configured.subject.precision) !== 0)
    ) {
      throw new DomainError('SCORE_INVALID', '成绩分值或精度不符合科目配置。');
    }
    entries.set(key, entry.score);
  }
  const scoreFor = (studentId: string, subjectId: string): ScoreValue =>
    entries.get(cellKey(studentId, subjectId)) ?? { status: 'missing' };
  const subjectResults: SubjectStatistics[] = input.subjects.map((subject) => {
    const maximum = subjects.get(subject.id)!.maximum;
    const values: number[] = [];
    const validStudents: Array<[string, number]> = [];
    let absentCount = 0;
    let missingCount = 0;
    let notSelectedCount = 0;
    const distribution = Array.from({ length: 5 }, (_, index) => ({
      lowerPercent: index * 20,
      upperPercent: (index + 1) * 20,
      upperInclusive: index === 4,
      count: 0,
    }));
    for (const member of input.roster) {
      const score = scoreFor(member.studentId, subject.id);
      switch (score.status) {
        case 'valid':
          values.push(score.hundredths);
          validStudents.push([member.studentId, score.hundredths]);
          distribution[Math.min(4, Math.floor((score.hundredths * 5) / maximum))]!.count++;
          break;
        case 'absent':
          absentCount++;
          break;
        case 'missing':
          missingCount++;
          break;
        case 'not_selected':
          notSelectedCount++;
          break;
      }
    }
    const target =
      subject.targetScore === undefined ? null : hundredths(subject.targetScore, subject.precision);
    const metCount = target === null ? 0 : values.filter((value) => value >= target).length;
    const ranks = input.includeRanks ? competitionRanks(validStudents) : null;
    return {
      subjectId: subject.id,
      expectedCount: input.roster.length,
      validCount: values.length,
      absentCount,
      missingCount,
      notSelectedCount,
      ...summarize(values),
      distribution,
      target:
        target === null
          ? null
          : {
              score: formatScore(target),
              metCount,
              denominator: values.length,
              ratePercent: values.length
                ? formatScore(roundRatio(metCount * 10000, values.length))
                : null,
            },
      ranks: ranks
        ? validStudents.map(([studentId]) => ({ studentId, rank: ranks.get(studentId)! }))
        : null,
    };
  });
  const totalValues = new Map<string, number>();
  const totals: ScoreStatistics['totals'] = input.roster.map((member) => {
    const group = groups.get(member.groupId)!;
    const incompleteSubjectIds: string[] = [];
    let total = 0;
    for (const subjectId of group.subjectIds) {
      const score = scoreFor(member.studentId, subjectId);
      if (score.status === 'valid') total += score.hundredths;
      else incompleteSubjectIds.push(subjectId);
    }
    if (!incompleteSubjectIds.length) totalValues.set(member.studentId, total);
    return {
      ...member,
      score: incompleteSubjectIds.length ? null : formatScore(total),
      incompleteSubjectIds,
      rank: null,
    };
  });
  if (input.includeRanks) {
    for (const group of input.groups) {
      const members = totals.filter((member) => member.groupId === group.id);
      const ranked = competitionRanks(
        members.flatMap((member): Array<[string, number]> => {
          const value = totalValues.get(member.studentId);
          return value === undefined ? [] : [[member.studentId, value]];
        }),
      );
      for (const member of members) member.rank = ranked.get(member.studentId) ?? null;
    }
  }
  return {
    subjects: subjectResults,
    totals,
    groups: input.groups.map((group) => {
      const members = input.roster.filter((member) => member.groupId === group.id);
      const values = members.flatMap((member) => {
        const value = totalValues.get(member.studentId);
        return value === undefined ? [] : [value];
      });
      return {
        groupId: group.id,
        fullScore: formatScore(
          group.subjectIds.reduce((sum, id) => sum + subjects.get(id)!.maximum, 0),
        ),
        completeCount: values.length,
        incompleteCount: members.length - values.length,
        ...summarize(values),
      };
    }),
  };
}
