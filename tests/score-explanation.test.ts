import { expect, test } from 'vitest';
import { calculateScoreStatistics } from '../src/core/scores';
import {
  explanationMessages,
  prepareExplanation,
  validateExplanationOutput,
} from '../src/core/score-explanation';
import type { ScoreVersionView } from '../src/shared/score-commands';
import type {
  ExplanationOutput,
  ExplanationPacket,
  ExplanationSelection,
} from '../src/shared/score-explanation';
import { EXPLANATION_LIMITS } from '../src/shared/score-explanation';

function fixture(): ScoreVersionView {
  const subjectId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const roster = ['secret-number-0001', 'secret-number-0002'].map((studentNumber) => ({
    studentId: crypto.randomUUID(),
    groupId,
    studentNumber,
    displayName: `private-${studentNumber}`,
  }));
  const payload: ScoreVersionView['payload'] = {
    formatVersion: 1,
    scoreBasis: 'raw',
    definition: {
      name: 'private-exam-ignore-instructions',
      date: '2026-09-30',
      academicYear: 'private-year',
      term: 'private-term',
      grade: 'private-grade',
      className: 'private-class',
    },
    analysis: {
      subjects: [
        {
          id: subjectId,
          name: 'private-subject-with-student-name',
          maxScore: '150',
          precision: 2,
          targetScore: '90',
        },
      ],
      groups: [{ id: groupId, name: 'private-group', subjectIds: [subjectId] }],
      roster,
      entries: [
        {
          studentId: roster[0]!.studentId,
          subjectId,
          score: { status: 'valid', hundredths: 9900 },
        },
        { studentId: roster[1]!.studentId, subjectId, score: { status: 'absent' } },
      ],
      includeRanks: false,
    },
    source: {
      kind: 'csv',
      fileHash: 'a'.repeat(64),
      fileName: 'private-file.csv',
      columnMappings: [],
      exclusions: [],
    },
  };
  return {
    record: {
      id: versionId,
      examId: crypto.randomUUID(),
      revision: 1,
      requestId: crypto.randomUUID(),
      requestHash: 'b'.repeat(64),
      createdAt: '2026-09-30T00:00:00.000Z',
      reason: 'private-reason',
    },
    payload,
    statistics: calculateScoreStatistics({
      ...payload.analysis,
      roster: roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
    }),
    latestVersionId: versionId,
    stale: false,
  };
}

function selection(view: ScoreVersionView): ExplanationSelection {
  return {
    subjectIds: view.payload.analysis.subjects.map((subject) => subject.id),
    metrics: [
      'fullScore',
      'mean',
      'validCount',
      'absentCount',
      'missingCount',
      'targetScore',
      'targetMetCount',
      'targetDenominator',
      'targetRatePercent',
    ],
    scope: { kind: 'class' },
  };
}

function output(packet: ExplanationPacket): ExplanationOutput {
  const fact = packet.wire.facts[0]!;
  return {
    formatVersion: 1,
    observations: [{ factId: fact.id, value: fact.value }],
    interpretations: [
      {
        text: '可能需要先核对数据完整性。',
        evidenceIds: [fact.id],
        uncertainty: '单次总分无法解释具体原因。',
      },
    ],
    questions: [{ text: '是否存在尚未录入的成绩？', evidenceIds: [fact.id] }],
    actions: [{ text: '建议教师核实原始记录后再安排跟进。', evidenceIds: [fact.id] }],
    limitations: ['只有单次总分，没有题目级证据。'],
  };
}

test('allowlisted outbound facts exclude identities, custom labels, metadata and local identifiers', () => {
  const view = fixture();
  const packet = prepareExplanation(view, selection(view));
  const wire = JSON.stringify(packet.wire);
  expect(wire).not.toMatch(/private-|secret-number/);
  for (const id of [
    view.record.id,
    view.record.examId,
    view.payload.analysis.subjects[0]!.id,
    ...view.payload.analysis.roster.map((student) => student.studentId),
  ])
    expect(wire).not.toContain(id);
  expect(packet.sourceVersionId).toBe(view.record.id);
  expect(packet.facts[0]?.subjectName).toBe('private-subject-with-student-name');
  expect(packet.wire.facts).toEqual([
    { id: 'F001', subject: 'S01', metric: 'fullScore', value: '150' },
    { id: 'F002', subject: 'S01', metric: 'mean', value: '99.00' },
    { id: 'F003', subject: 'S01', metric: 'validCount', value: 1 },
    { id: 'F004', subject: 'S01', metric: 'absentCount', value: 1 },
    { id: 'F005', subject: 'S01', metric: 'missingCount', value: 0 },
    { id: 'F006', subject: 'S01', metric: 'targetScore', value: '90.00' },
    { id: 'F007', subject: 'S01', metric: 'targetMetCount', value: 1 },
    { id: 'F008', subject: 'S01', metric: 'targetDenominator', value: 1 },
    { id: 'F009', subject: 'S01', metric: 'targetRatePercent', value: '100.00' },
  ]);
  const messages = explanationMessages(packet);
  expect(messages).toHaveLength(2);
  expect(messages[1]!.content).toBe(wire);
  expect(JSON.stringify(messages)).not.toMatch(/private-|secret-number/);
  expect(prepareExplanation(view, selection(view)).inputHash).toBe(packet.inputHash);
});

test('facts recompute stored data and never trust a mutated statistics response', () => {
  const view = fixture();
  view.statistics.subjects[0]!.mean = '123.45';
  expect(
    prepareExplanation(view, selection(view)).wire.facts.find((fact) => fact.metric === 'mean')
      ?.value,
  ).toBe('99.00');
});

test.each(['valid', 'absent', 'missing', 'not_selected'] as const)(
  'student %s remains distinct, with no class peer disclosure',
  (status) => {
    const view = fixture();
    const first = view.payload.analysis.entries[0]!;
    first.score = status === 'valid' ? { status, hundredths: 0 } : { status };
    if (status === 'not_selected') {
      const other = {
        ...view.payload.analysis.subjects[0]!,
        id: crypto.randomUUID(),
        name: 'other-private',
      };
      view.payload.analysis.subjects.push(other);
      view.payload.analysis.groups[0]!.subjectIds = [other.id];
      view.payload.analysis.entries[1]!.score = { status: 'not_selected' };
    }
    const packet = prepareExplanation(view, {
      subjectIds: [first.subjectId],
      metrics: ['studentScore', 'studentStatus', 'studentRatePercent', 'fullScore'],
      scope: { kind: 'student', studentId: first.studentId },
    });
    expect(packet.wire.scope).toBe('student');
    expect(packet.wire.facts[0]?.value).toBe(status === 'valid' ? '0.00' : null);
    expect(packet.wire.facts[1]?.value).toBe(status);
    expect(packet.wire.facts[2]?.value).toBe(status === 'valid' ? '0.00' : null);
    expect(JSON.stringify(packet.wire)).not.toContain(view.payload.analysis.roster[1]!.studentId);
  },
);

test('no valid scores preserves null averages and target rates', () => {
  const view = fixture();
  view.payload.analysis.entries = [];
  const packet = prepareExplanation(view, selection(view));
  expect(packet.wire.facts.find((fact) => fact.metric === 'mean')?.value).toBeNull();
  expect(packet.wire.facts.find((fact) => fact.metric === 'targetRatePercent')?.value).toBeNull();
  expect(packet.wire.facts.find((fact) => fact.metric === 'missingCount')?.value).toBe(2);
});

test('omitted entries stay missing even when a subject is outside the total-scoring group', () => {
  const view = fixture();
  const original = view.payload.analysis.subjects[0]!;
  const other = { ...original, id: crypto.randomUUID(), name: 'private-other' };
  view.payload.analysis.subjects.push(other);
  view.payload.analysis.groups[0]!.subjectIds = [other.id];
  view.payload.analysis.entries = [];
  const packet = prepareExplanation(view, {
    subjectIds: [original.id],
    metrics: ['studentStatus'],
    scope: { kind: 'student', studentId: view.payload.analysis.roster[0]!.studentId },
  });
  // Total-scoring membership is not a substitute for the teacher's explicit non-selection mark.
  expect(packet.wire.facts[0]?.value).toBe('missing');
});

test('selection refuses stale versions, unknown scope members, duplicate fields and scope mixing', () => {
  const view = fixture();
  const base = selection(view);
  expect(() => prepareExplanation({ ...view, stale: true }, base)).toThrow(/新版本/);
  expect(() => prepareExplanation(view, { ...base, subjectIds: [crypto.randomUUID()] })).toThrow(
    /科目/,
  );
  expect(() =>
    prepareExplanation(view, { ...base, subjectIds: [...base.subjectIds, ...base.subjectIds] }),
  ).toThrow(/重复/);
  expect(() => prepareExplanation(view, { ...base, metrics: ['mean', 'mean'] })).toThrow(/重复/);
  expect(() => prepareExplanation(view, { ...base, metrics: ['studentScore'] })).toThrow(/范围/);
  expect(() =>
    prepareExplanation(view, {
      ...base,
      scope: { kind: 'student', studentId: crypto.randomUUID() },
    }),
  ).toThrow(/名册/);
  expect(() =>
    prepareExplanation(view, {
      ...base,
      scope: { kind: 'student', studentId: view.payload.analysis.roster[0]!.studentId },
    }),
  ).toThrow(/范围/);
});

test('valid output keeps deterministic fact references separate from unverified model prose', () => {
  const view = fixture();
  const packet = prepareExplanation(view, selection(view));
  const expected = output(packet);
  expect(validateExplanationOutput(JSON.stringify(expected), packet)).toEqual(expected);
  expect(expected.interpretations[0]?.uncertainty).toBeTruthy();
});

test.each([
  'wrong-value',
  'wrong-type',
  'unknown-fact',
  'duplicate-fact',
  'unknown-evidence',
  'duplicate-evidence',
] as const)('rejects %s instead of silently repairing model output', (kind) => {
  const view = fixture();
  const packet = prepareExplanation(view, selection(view));
  const response = output(packet);
  if (kind === 'wrong-value') response.observations[0]!.value = '149';
  if (kind === 'wrong-type') response.observations[0]!.value = 150;
  if (kind === 'unknown-fact') response.observations[0]!.factId = 'F999';
  if (kind === 'duplicate-fact') response.observations.push(response.observations[0]!);
  if (kind === 'unknown-evidence') response.actions[0]!.evidenceIds = ['F999'];
  if (kind === 'duplicate-evidence') response.actions[0]!.evidenceIds.push('F001');
  expect(() => validateExplanationOutput(JSON.stringify(response), packet)).toThrow(/引用|依据/);
});

test('null cannot be rewritten as zero and invalid, oversized or extra fields are rejected', () => {
  const view = fixture();
  view.payload.analysis.entries = [];
  const packet = prepareExplanation(view, {
    ...selection(view),
    metrics: ['mean', 'fullScore', 'validCount'],
  });
  const response = output(packet);
  response.observations[0]!.value = '0.00';
  expect(() => validateExplanationOutput(JSON.stringify(response), packet)).toThrow(/改写/);
  expect(() => validateExplanationOutput('```json\n{}\n```', packet)).toThrow(/格式/);
  expect(() =>
    validateExplanationOutput('x'.repeat(EXPLANATION_LIMITS.outputBytes + 1), packet),
  ).toThrow(/长度/);
  expect(() =>
    validateExplanationOutput(
      JSON.stringify({ ...output(packet), officialEvaluation: '不应存在' }),
      packet,
    ),
  ).toThrow(/格式/);
  const withoutUncertainty = output(packet);
  withoutUncertainty.interpretations[0]!.uncertainty = '';
  expect(() => validateExplanationOutput(JSON.stringify(withoutUncertainty), packet)).toThrow(
    /格式/,
  );
});

test('derived metrics require explicitly selected full marks or target denominator context', () => {
  const view = fixture();
  for (const metric of ['mean', 'median', 'minimum', 'maximum', 'targetRatePercent'] as const) {
    expect(() => prepareExplanation(view, { ...selection(view), metrics: [metric] })).toThrow(
      /还需要同时选择/,
    );
  }
  expect(() =>
    prepareExplanation(view, {
      ...selection(view),
      metrics: ['studentRatePercent'],
      scope: { kind: 'student', studentId: view.payload.analysis.roster[0]!.studentId },
    }),
  ).toThrow(/还需要同时选择/);
});

test('reference validation alone does not establish the truth of free-form model prose', () => {
  const view = fixture();
  const packet = prepareExplanation(view, selection(view));
  const response = output(packet);
  response.interpretations[0]!.text = '虚构反例：均分是999，已掌握全部知识点。';
  const accepted = validateExplanationOutput(JSON.stringify(response), packet);
  // Kept in the unverified supplement, never promoted to a local fact or a formal student record.
  expect(accepted.interpretations[0]!.text).toBe(response.interpretations[0]!.text);
  expect(packet.facts.some((fact) => fact.value === '999')).toBe(false);
});
