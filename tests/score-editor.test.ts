import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoreResults } from '../src/renderer/ScoreResults';
import { calculateScoreStatistics } from '../src/core/scores';
import { scoreSubjectSchema } from '../src/shared/scores';
import {
  configurationDifference,
  customSubject,
  newExam,
  scoreText,
  SUBJECT_CATALOG,
  type ExamDraft,
} from '../src/renderer/score-editor';
import type { Snapshot } from '../src/shared/contracts';

test('subject identities are stable, distinct, and valid across custom normalization', async () => {
  expect(new Set(SUBJECT_CATALOG.map((subject) => subject.id)).size).toBe(SUBJECT_CATALOG.length);
  for (const subject of SUBJECT_CATALOG)
    expect(scoreSubjectSchema.safeParse(subject).success).toBe(true);
  const first = await customSubject('  校本Ａ  ');
  expect(first).toEqual(await customSubject('校本A'));
  expect(first.id).not.toBe((await customSubject('校本B')).id);
  expect(scoreSubjectSchema.safeParse(first).success).toBe(true);
  expect(await customSubject('数学')).toEqual(SUBJECT_CATALOG[1]);
  await expect(customSubject(' ')).rejects.toThrow();
  await expect(customSubject('科'.repeat(61))).rejects.toThrow();
});

test('new exams contain only the complete active class roster and require score basis confirmation', () => {
  const snapshot: Snapshot = {
    epoch: crypto.randomUUID(),
    classes: [],
    enrollments: [],
    assets: [],
    schemaVersion: 2,
    dataDirectory: 'synthetic',
    recoveryCopies: 0,
    students: [true, false, true].map((active, index) => ({
      id: crypto.randomUUID(),
      studentNumber: `00${index}`,
      displayName: '合成学生',
      active,
      classId: index === 2 ? 'other' : 'class',
      className: '合成班',
      revision: 1,
      createdAt: '2026-09-30T00:00:00.000Z',
    })),
  };
  const draft = newExam(snapshot, 'class');
  expect(draft.roster.map((student) => student.studentNumber)).toEqual(['000']);
  expect(draft.configuration.assignments).toEqual([
    { studentId: snapshot.students[0]!.id, groupId: draft.configuration.groups[0]!.id },
  ]);
  expect(draft.configuration.scoreBasis).toBe('unknown');
  expect(draft.configuration.includeRanks).toBe(false);
  expect(newExam(snapshot, 'class').configuration.subjects).toEqual(draft.configuration.subjects);
});

test('display preserves zero and distinct nonnumeric states', () => {
  expect(scoreText({ status: 'valid', hundredths: 0 })).toBe('0');
  expect(scoreText({ status: 'valid', hundredths: 10000 })).toBe('100');
  expect(scoreText({ status: 'valid', hundredths: 1010 })).toBe('10.1');
  expect(scoreText({ status: 'valid', hundredths: 1 })).toBe('0.01');
  expect(scoreText({ status: 'absent' })).toBe('缺考');
  expect(scoreText({ status: 'missing' })).toBe('未录入');
  expect(scoreText({ status: 'not_selected' })).toBe('未选考');
  expect(scoreText(null)).toBe('不在范围');
});

test('saved statistics display the original full score, target threshold and valid denominator', () => {
  const subject = { ...SUBJECT_CATALOG[1]!, targetScore: '95' };
  const group = { id: crypto.randomUUID(), name: '合成组', subjectIds: [subject.id] };
  const roster = [0, 1].map((index) => ({
    studentId: crypto.randomUUID(),
    groupId: group.id,
    studentNumber: `00${index}`,
    displayName: '合成学生',
  }));
  const entries = [
    {
      studentId: roster[0]!.studentId,
      subjectId: subject.id,
      score: { status: 'valid' as const, hundredths: 9900 },
    },
  ];
  const statistics = calculateScoreStatistics({
    subjects: [subject],
    groups: [group],
    roster: roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
    entries,
  });
  const html = renderToStaticMarkup(
    createElement(ScoreResults, {
      statistics,
      subjects: [subject],
      groups: [group],
      roster,
      entries,
    }),
  );
  expect(html).toContain('目标 ≥ 95.00 分；1/1（100.00%）');
  expect(html).toContain('有效人数');
  expect(html).toContain('<td>150</td>');
  expect(html).toContain('未录入');
});

test('configuration differences name removed subjects and translate technical fields', () => {
  const subject = SUBJECT_CATALOG[1]!;
  const group = { id: crypto.randomUUID(), name: '数学组', subjectIds: [subject.id] };
  const definition = {
    name: '合成考试',
    date: '2026-09-30',
    academicYear: '2026',
    term: '上',
    grade: '高一',
  };
  const draft: ExamDraft = {
    roster: [],
    configuration: {
      epoch: crypto.randomUUID(),
      classId: crypto.randomUUID(),
      expectedRevision: 0,
      definition,
      subjects: [],
      groups: [],
      assignments: [],
      scoreBasis: 'raw',
    },
    baseline: {
      formatVersion: 1,
      scoreBasis: 'raw',
      definition: { ...definition, className: '合成班' },
      analysis: {
        subjects: [subject],
        groups: [group],
        roster: [],
        entries: [],
        includeRanks: false,
      },
      source: {
        kind: 'csv',
        fileName: 'synthetic.csv',
        fileHash: 'a'.repeat(64),
        columnMappings: [],
        exclusions: [],
      },
    },
  };
  const removed = configurationDifference(
    { key: `group.${group.id}`, label: group.name, before: JSON.stringify(group), after: null },
    draft,
  );
  expect(removed).toEqual({ label: '数学组', before: '数学组：数学', after: '无' });
  expect(JSON.stringify(removed)).not.toContain(subject.id);
  expect(
    configurationDifference({ key: 'exam.name', label: 'name', before: '甲', after: '乙' }, draft),
  ).toEqual({ label: '考试名称', before: '甲', after: '乙' });
});
