import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Workspace } from '../../src/core/workspace';
import { parseMaterial } from '../../src/core/material-parser';
import { gradingRequestSchema } from '../../src/shared/grading';

/** 合成名册、人工细则与自制图像；不读取应用凭据，不调用真实模型。 */
export async function gradingStorageFixture(
  workspace: Workspace,
  options: { initialScore?: string; additionalStudentScore?: string } = {},
) {
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成阅卷班' });
  const classId = workspace.snapshot().classes[0]!.id;
  workspace.saveStudent({ epoch, classId, studentNumber: 'SYNTHETIC_1', displayName: '合成甲' });
  const studentId = workspace.snapshot().students[0]!.id;
  if (options.additionalStudentScore !== undefined)
    workspace.saveStudent({ epoch, classId, studentNumber: 'SYNTHETIC_2', displayName: '合成乙' });
  const subjectId = randomUUID(),
    groupId = randomUUID();
  const scoreInput = {
    epoch,
    classId,
    expectedRevision: 0,
    definition: {
      name: '合成阅卷测验',
      date: '2026-10-01',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id: subjectId, name: '合成学科', maxScore: '10', precision: 0 as const }],
    groups: [{ id: groupId, name: '合成计分组', subjectIds: [subjectId] }],
    assignments: workspace
      .snapshot()
      .students.map((student) => ({ studentId: student.id, groupId })),
    scoreBasis: 'raw' as const,
    format: 'csv' as const,
    fileName: 'synthetic.csv',
  };
  const preview = await workspace.scores.preview(
    Buffer.from(
      `学生编号,合成学科\nSYNTHETIC_1,${options.initialScore ?? '未录入'}${options.additionalStudentScore === undefined ? '' : `\nSYNTHETIC_2,${options.additionalStudentScore}`}`,
    ),
    scoreInput,
  );
  const score = workspace.scores.confirm({
    epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '合成考试初版',
  });
  const definition = {
    title: '合成评分细则',
    precision: 0 as const,
    maxHundredths: 1000,
    questions: [
      {
        id: 'choice',
        label: '第 1 题',
        prompt: '合成选择题',
        maxHundredths: 500,
        stepHundredths: 100,
        kind: 'single_choice' as const,
        options: ['A', 'B'],
        correct: 'B',
      },
      {
        id: 'manual',
        label: '第 2 题',
        prompt: '合成人工补评',
        maxHundredths: 500,
        stepHundredths: 100,
        kind: 'manual' as const,
        explanation: '不支持的公式转人工',
      },
    ],
  };
  const rubricInput = {
    epoch,
    requestId: randomUUID(),
    scoreVersionId: score.versionId,
    subjectId,
    definition,
  };
  const rubric = workspace.grading.createRubric(rubricInput);
  const bytes = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const parsed = await parseMaterial(bytes, 'png');
  workspace.materials.store({
    epoch,
    requestId: randomUUID(),
    name: 'synthetic-answer.png',
    parsed,
  });
  const page = {
    id: randomUUID(),
    role: 'student_answer' as const,
    sourceVersionId: parsed.version.id,
    fragmentId: 1,
    rotation: 0 as const,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    redactions: [],
  };
  const request = gradingRequestSchema.parse({
    examId: score.examId,
    scoreVersionId: score.versionId,
    subjectId,
    studentId,
    rubricVersionId: rubric.id,
    pages: [page],
    expectedAnswerPages: 1,
    selectedPageIds: [page.id],
    selectedQuestionIds: ['choice', 'manual'],
    acknowledgeSyntheticOnly: true,
    acknowledgeBindingAndOrder: true,
    acknowledgePartial: false,
  });
  const createInput = { epoch, requestId: randomUUID(), request };
  const draft = workspace.grading.create(createInput);
  const evidence = [{ pageId: page.id, rectangle: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }];
  const edits = definition.questions.map((q) => ({
    questionId: q.id,
    answer: '教师复核合成作答',
    scoreHundredths: q.maxHundredths,
    reason: '合成人工评分依据',
    evidence,
    acknowledgeReviewed: true as const,
  }));
  const output = JSON.stringify({
    formatVersion: 1,
    assessments: [
      {
        questionId: 'choice',
        state: 'readable',
        answer: 'B',
        suggestedHundredths: 0,
        reason: '合成作答定位',
        evidence,
        confidence: null,
      },
    ],
  });
  const provider = {
    provider: 'deepseek' as const,
    requestModel: 'synthetic',
    responseModel: 'synthetic',
    responseId: 'synthetic-grading',
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    usage: null,
  };
  const generation = (
    id = draft.id,
    selection = ['choice'],
    acknowledgeReplaceReviewed = false,
  ) => {
    const current = workspace.grading.read({ epoch, id });
    const prepared = workspace.grading.prepare({
      epoch,
      id,
      expectedRevision: current.record.revision,
      selectedPageIds: [page.id],
      selectedQuestionIds: selection,
      acknowledgeReplaceReviewed,
    });
    const command = { epoch, token: prepared.token, requestId: randomUUID(), provider, output };
    workspace.grading.claim({ epoch, token: command.token, requestId: command.requestId });
    return command;
  };
  return {
    epoch,
    draft,
    request,
    page,
    score,
    scoreInput,
    definition,
    rubricInput,
    rubric,
    createInput,
    edits,
    output,
    provider,
    generation,
  };
}
