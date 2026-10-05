import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  rubricDefinitionSchema,
  gradingRequestSchema,
  type QuestionRule,
} from '../src/shared/grading';
import {
  validateRubric,
  prepareGrading,
  validateGradingOutput,
  applyGradingEdits,
  validateGradingReview,
  gradingOriginalRectangle,
} from '../src/core/grading';

function fixture() {
  const examId = randomUUID(),
    subjectId = randomUUID(),
    studentId = randomUUID(),
    groupId = randomUUID();
  const rule = (id: string, maxHundredths: number) => ({
    id,
    label: '第 1 题',
    prompt: '合成题目',
    maxHundredths,
    stepHundredths: 100,
  });
  const definition = rubricDefinitionSchema.parse({
    title: '合成普通题型评分细则',
    precision: 0,
    maxHundredths: 2300,
    questions: [
      {
        ...rule('partA-1', 200),
        kind: 'single_choice',
        options: ['A', 'B', 'C', 'D'],
        correct: 'B',
      },
      {
        ...rule('partB-1', 400),
        kind: 'multiple_choice',
        options: ['A', 'B', 'C', 'D'],
        correct: ['B', 'D'],
        partial: { mode: 'fixed', hundredths: 200 },
      },
      {
        ...rule('judge', 100),
        kind: 'judgement',
        correct: ['正确', 'T'],
        incorrect: ['错误', 'F'],
      },
      {
        ...rule('blank', 300),
        kind: 'blank',
        accepted: ['3 m', '三米'],
        normalization: { ignoreCase: false, collapseWhitespace: true },
      },
      {
        ...rule('short', 500),
        kind: 'short_text',
        scoringPoints: '说出大小、方向与作用点，逐项依据教师细则给分。',
      },
      {
        ...rule('complex', 800),
        kind: 'manual',
        explanation: '手写公式不自动判分，教师对照原卷补评。',
      },
    ],
  });
  const rubric = { id: randomUUID(), examId, subjectId, revision: 1, definition };
  const source = {
    id: randomUUID(),
    format: 'png',
    sha256: '1'.repeat(64),
    originalAssetId: randomUUID(),
    bytes: 100,
    completeness: 'complete',
    warnings: [],
    fragments: [
      {
        id: 1,
        kind: 'image',
        locator: { kind: 'page', index: 1 },
        assetId: randomUUID(),
        sha256: '2'.repeat(64),
        width: 1000,
        height: 1000,
      },
    ],
  };
  const record = {
    id: randomUUID(),
    examId,
    revision: 1,
    requestId: randomUUID(),
    requestHash: '3'.repeat(64),
    createdAt: '2026-10-01T00:00:00Z',
    reason: '合成考试基线',
  };
  const payload = {
    formatVersion: 1,
    scoreBasis: 'raw',
    definition: {
      name: '合成考试',
      date: '2026-10-01',
      academicYear: '2026',
      term: '第一学期',
      grade: '高一',
      className: '合成班级',
    },
    analysis: {
      subjects: [{ id: subjectId, name: '合成综合测验', maxScore: '23', precision: 0 }],
      groups: [{ id: groupId, name: '合成计分组', subjectIds: [subjectId] }],
      roster: [{ studentId, groupId, studentNumber: 'SYNTHETIC_1', displayName: '本地私有学生名' }],
      entries: [],
    },
    source: {
      kind: 'csv',
      fileHash: '4'.repeat(64),
      fileName: '本地私有原表.csv',
      columnMappings: [],
      exclusions: [],
    },
  };
  const page = {
    id: randomUUID(),
    role: 'student_answer',
    sourceVersionId: source.id,
    fragmentId: 1,
    rotation: 0,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    redactions: [],
  };
  const request = gradingRequestSchema.parse({
    examId,
    scoreVersionId: record.id,
    subjectId,
    studentId,
    rubricVersionId: rubric.id,
    pages: [page],
    expectedAnswerPages: 1,
    selectedPageIds: [page.id],
    selectedQuestionIds: definition.questions.map((q) => q.id),
    acknowledgeSyntheticOnly: true,
    acknowledgeBindingAndOrder: true,
    acknowledgePartial: false,
  });
  const prepare = (
    nextRequest: unknown = request,
    nextRubric: unknown = rubric,
    nextSources: unknown[] = [source],
  ) => prepareGrading(nextRequest, nextRubric, { record, payload }, nextSources);
  const preparation = prepare();
  const assessment = (
    questionId: string,
    answer: string | null,
    suggestedHundredths: number | null = 0,
  ) => ({
    questionId,
    state: 'readable',
    answer,
    suggestedHundredths,
    reason: '合成图像上已定位作答，仍待教师核对。',
    evidence: [{ pageId: page.id, rectangle: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }],
    confidence: null,
  });
  const output = (assessments: unknown[]) => JSON.stringify({ formatVersion: 1, assessments });
  return { definition, rubric, source, request, preparation, prepare, assessment, output, page };
}

test('ordinary objective forms use teacher rules; short text and unsupported content remain reviewable', () => {
  const f = fixture();
  const rows = validateGradingOutput(
    f.output([
      f.assessment('partA-1', 'Ｂ', 0),
      f.assessment('partB-1', 'B', 400),
      f.assessment('judge', 'T'),
      f.assessment('blank', '3   m'),
      f.assessment('short', '大小、方向。', 300),
      f.assessment('complex', '手写公式', 800),
    ]),
    f.preparation,
  );
  expect(rows.map((row) => row.scoreHundredths)).toEqual([200, 200, 100, 300, 300, null]);
  expect(rows.map((row) => row.origin)).toEqual(['rule', 'rule', 'rule', 'rule', 'model', 'model']);
  expect(rows.every((row) => !row.reviewed)).toBe(true);
  expect(rows[5]?.status).toBe('pending');
  expect(() => validateGradingReview(rows, f.preparation, f.preparation.fingerprint)).toThrow(
    '未决',
  );
});

test.each([
  ['B,D', 400],
  ['D B', 400],
  ['B', 200],
  ['A B', 0],
  ['BB', null],
  ['E', null],
])('multiple-choice answer %s obeys its explicit rule', (answer, expected) => {
  const f = fixture();
  const rows = validateGradingOutput(f.output([f.assessment('partB-1', answer)]), f.preparation);
  expect(rows[1]?.scoreHundredths).toBe(expected);
});

test('per-correct and all-or-nothing multiple rules have separate semantics', () => {
  const f = fixture();
  for (const mode of ['none', 'per_correct'] as const) {
    const questions = f.definition.questions.map((q): QuestionRule =>
      q.kind === 'multiple_choice'
        ? { ...q, partial: mode === 'none' ? { mode } : { mode, hundredths: 100 } }
        : q,
    );
    const prepared = f.prepare(f.request, {
      ...f.rubric,
      definition: { ...f.definition, questions },
    });
    expect(
      validateGradingOutput(f.output([f.assessment('partB-1', 'B')]), prepared)[1]?.scoreHundredths,
    ).toBe(mode === 'none' ? 0 : 100);
  }
});

test('blurred, missing and omitted questions are null, whereas explicit visible blank may suggest zero', () => {
  const f = fixture();
  const rows = validateGradingOutput(
    f.output([
      { ...f.assessment('partA-1', null, null), state: 'unreadable' },
      { ...f.assessment('partB-1', null, null), state: 'missing', evidence: [] },
      { ...f.assessment('judge', null, null), state: 'blank' },
    ]),
    f.preparation,
  );
  expect(rows.map((row) => row.scoreHundredths)).toEqual([null, null, 0, null, null, null]);
  expect(rows).toHaveLength(f.definition.questions.length);
  expect(() =>
    validateGradingOutput(
      f.output([{ ...f.assessment('partA-1', null), state: 'unreadable' }]),
      f.preparation,
    ),
  ).toThrow('自动赋分');
});

test('omitted confidence stays unknown rather than inventing certainty', () => {
  const f = fixture();
  const rows = validateGradingOutput(
    f.output([{ ...f.assessment('partA-1', 'B'), confidence: undefined }]),
    f.preparation,
  );
  expect(rows[0]?.confidence).toBeNull();
});

test('invalid IDs, out-of-range scores, inconsistent states and unselected evidence fail before any review', () => {
  const f = fixture();
  for (const row of [
    f.assessment('unknown', 'B'),
    { ...f.assessment('partA-1', 'B'), suggestedHundredths: 201 },
    f.assessment('partA-1', null),
    { ...f.assessment('partA-1', 'B'), state: 'blank' },
    {
      ...f.assessment('partA-1', 'B'),
      evidence: [{ pageId: randomUUID(), rectangle: { x: 0, y: 0, width: 1, height: 1 } }],
    },
  ])
    expect(() => validateGradingOutput(f.output([row]), f.preparation)).toThrow();
  expect(() =>
    validateGradingOutput(
      f.output([f.assessment('partA-1', 'B'), f.assessment('partA-1', 'B')]),
      f.preparation,
    ),
  ).toThrow('重复');
  expect(() => validateGradingOutput('not JSON', f.preparation)).toThrow('JSON');
  expect(() => validateGradingOutput(' '.repeat(1024 * 1024 + 1), f.preparation)).toThrow('大小');
});

test('full rubric preserves unsupported questions and rejects unsafe options, precision or partial credit', () => {
  const f = fixture();
  const replace = (id: string, fields: object) => ({
    ...f.definition,
    questions: f.definition.questions.map((q) => (q.id === id ? { ...q, ...fields } : q)),
  });
  expect(validateRubric(f.definition)).toEqual(f.definition);
  for (const input of [
    { ...f.definition, questions: f.definition.questions.slice(0, -1) },
    { ...f.definition, questions: [...f.definition.questions, f.definition.questions[0]] },
    replace('partA-1', { options: ['B', 'B'] }),
    replace('partA-1', { correct: 'E' }),
    replace('partB-1', { partial: { mode: 'fixed', hundredths: 400 } }),
    replace('judge', { incorrect: ['t'] }),
    replace('blank', { stepHundredths: 50 }),
  ])
    expect(() => validateRubric(input)).toThrow();
});

test('binding, page role/order and immutable source preparation exclude local identity text', () => {
  const f = fixture();
  expect(JSON.stringify(f.preparation)).not.toMatch(/本地私有|fileName|displayName|studentNumber/);
  for (const input of [
    { ...f.request, studentId: randomUUID() },
    { ...f.request, examId: randomUUID() },
    { ...f.request, rubricVersionId: randomUUID() },
    { ...f.request, pages: [{ ...f.page, role: 'question_material' }] },
    { ...f.request, pages: [f.page, { ...f.page, id: randomUUID() }] },
    { ...f.request, selectedQuestionIds: ['unknown'] },
    { ...f.request, acknowledgeBindingAndOrder: false },
  ])
    expect(() => f.prepare(input)).toThrow();
  expect(() => f.prepare(f.request, f.rubric, [{ ...f.source, format: 'txt' }])).toThrow('JPG');
  expect(() =>
    f.prepare(f.request, f.rubric, [{ ...f.source, completeness: 'partial', warnings: ['缺页'] }]),
  ).toThrow('未完整');
  const revised = f.prepare({ ...f.request, pages: [{ ...f.page, rotation: 90 }] });
  expect(revised.fingerprint).not.toBe(f.preparation.fingerprint);
  f.source.fragments[0]!.width = 900;
  expect(f.preparation.pages[0]?.width).toBe(1000);
});

test('cropped and rotated evidence maps to the exact original page; masks cannot become model evidence', () => {
  const f = fixture();
  const page = {
    ...f.request.pages[0]!,
    rotation: 90 as const,
    crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.8 },
  };
  const mapped = gradingOriginalRectangle(page, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  expect(mapped.x).toBeCloseTo(0.3);
  expect(mapped.y).toBeCloseTo(0.58);
  expect(mapped.width).toBeCloseTo(0.2);
  expect(mapped.height).toBeCloseTo(0.24);
  const masked = f.prepare({
    ...f.request,
    pages: [{ ...f.page, redactions: [{ x: 0, y: 0, width: 0.3, height: 0.3 }] }],
  });
  expect(
    validateGradingOutput(f.output([f.assessment('partA-1', 'B')]), masked)[0]?.scoreHundredths,
  ).toBeNull();
  expect(() => gradingOriginalRectangle(page, { x: 0.9, y: 0, width: 0.2, height: 0.1 })).toThrow();
});

test('explicit teacher completion records basis and attribution; source changes and missing pages block freezing', () => {
  const f = fixture();
  const rows = validateGradingOutput(f.output([]), f.preparation);
  const edits = f.definition.questions.map((q) => ({
    questionId: q.id,
    answer: '教师对照原图纠正或人工补评',
    scoreHundredths: q.maxHundredths,
    reason: '逐题核对并依据当前细则给分，含不支持的公式题人工评分。',
    evidence: [{ pageId: f.page.id, rectangle: { x: 0, y: 0, width: 1, height: 1 } }],
    acknowledgeReviewed: true,
  }));
  const edited = applyGradingEdits(rows, edits, f.preparation);
  expect(edited.every((row) => row.origin === 'teacher' && row.reviewed)).toBe(true);
  expect(
    validateGradingReview(edited, f.preparation, f.preparation.fingerprint).totalHundredths,
  ).toBe(2300);
  expect(() => validateGradingReview(edited, f.preparation, 'stale')).toThrow('重新复核');
  const missing = f.prepare({ ...f.request, expectedAnswerPages: 2 });
  const missingRows = applyGradingEdits(
    validateGradingOutput(f.output([]), missing),
    edits,
    missing,
  );
  expect(() => validateGradingReview(missingRows, missing, missing.fingerprint)).toThrow('缺页');
  expect(() =>
    applyGradingEdits(rows, [{ ...edits[0], scoreHundredths: 1 }], f.preparation),
  ).toThrow('步长');
  expect(() =>
    applyGradingEdits(rows, [{ ...edits[0], acknowledgeReviewed: false }], f.preparation),
  ).toThrow();
  expect(() =>
    validateGradingReview(
      edited.map((row) => ({ ...row, origin: 'model' })),
      f.preparation,
      f.preparation.fingerprint,
    ),
  ).toThrow('自行');
  expect(rows.every((row) => row.status === 'pending')).toBe(true);
});

test('previously reviewed rows cannot be reused with a changed rubric or transformed image context', () => {
  const f = fixture();
  const edits = f.definition.questions.map((q) => ({
    questionId: q.id,
    answer: '教师已核对',
    scoreHundredths: q.maxHundredths,
    reason: '合成评分依据',
    evidence: [{ pageId: f.page.id, rectangle: { x: 0, y: 0, width: 1, height: 1 } }],
    acknowledgeReviewed: true,
  }));
  const reviewed = applyGradingEdits(
    validateGradingOutput(f.output([]), f.preparation),
    edits,
    f.preparation,
  );
  const changed = f.prepare(f.request, {
    ...f.rubric,
    definition: {
      ...f.definition,
      questions: f.definition.questions.map((q) =>
        q.kind === 'single_choice' ? { ...q, correct: 'A' } : q,
      ),
    },
  });
  expect(() => validateGradingReview(reviewed, changed, changed.fingerprint)).toThrow('来源已变化');
  const rotated = f.prepare({ ...f.request, pages: [{ ...f.page, rotation: 90 }] });
  expect(() => applyGradingEdits(reviewed, edits, rotated)).toThrow('来源已变化');
  expect(() =>
    applyGradingEdits(reviewed, [{ ...edits[0], evidence: [] }], f.preparation),
  ).toThrow();
  expect(() =>
    validateGradingReview(
      reviewed.map((row) => ({ ...row, evidence: [] })),
      f.preparation,
      f.preparation.fingerprint,
    ),
  ).toThrow('原图位置');
});

test('per-call question selection keeps the full source basis but raster-rounded masks still block evidence', () => {
  const f = fixture();
  const batch = f.prepare({ ...f.request, selectedQuestionIds: ['partA-1'] });
  expect(batch.fingerprint).toBe(f.preparation.fingerprint);
  const masked = f.prepare({
    ...f.request,
    pages: [{ ...f.page, redactions: [{ x: 0.5001, y: 0.2501, width: 0.0001, height: 0.0001 }] }],
  });
  const rows = validateGradingOutput(
    f.output([
      {
        ...f.assessment('partA-1', 'B'),
        evidence: [
          { pageId: f.page.id, rectangle: { x: 0.5, y: 0.25, width: 0.00005, height: 0.00005 } },
        ],
      },
    ]),
    masked,
  );
  expect(rows[0]?.status).toBe('pending');
  expect(rows[0]?.scoreHundredths).toBeNull();
});
