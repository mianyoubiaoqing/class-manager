import { createHash } from 'node:crypto';
import {
  GRADING_LIMITS,
  rubricDefinitionSchema,
  rubricVersionSchema,
  gradingRequestSchema,
  gradingModelOutputSchema,
  gradingRowSchema,
  gradingEditSchema,
  gradingRectangleSchema,
  type RubricDefinition,
  type QuestionRule,
  type GradingRequest,
  type RubricVersion,
  type GradingPage,
  type GradingRectangle,
  type GradingEvidence,
  type GradingRow,
} from '../shared/grading';
import { materialVersionSchema } from '../shared/lessons';
import { storedScoreVersionSchema, scoreVersionPayloadSchema } from '../shared/score-records';
import { DomainError } from './errors';
import { gradingEffectiveCrop, gradingEffectiveRectangle } from './grading-geometry';

function invalid(message: string): never {
  throw new DomainError('GRADING_INVALID', message);
}
const normalized = (value: string) => value.normalize('NFKC').trim().toUpperCase();
const unique = (values: readonly string[]) => new Set(values).size === values.length;
function validatePoints(value: number, rule: QuestionRule) {
  if (value > rule.maxHundredths || value % rule.stepHundredths !== 0)
    invalid('分数超过题目满分或不符合给分步长。');
}

/**
 * 完整细则保留人工题，逐题满分总和及步长须符合考试计分口径。
 * Validate a teacher's complete rubric, including manual-only questions and exact full-score sum.
 * Pure and detached; no confirmation, persistence, provider call or automatic repair/retry.
 * ZodError rejects structure; GRADING_INVALID rejects conflicting rules and score scales.
 */
export function validateRubric(input: unknown): RubricDefinition {
  const definition = rubricDefinitionSchema.parse(input);
  if (!unique(definition.questions.map((rule) => rule.id))) invalid('题目标识重复。');
  const unit = 10 ** (2 - definition.precision);
  for (const rule of definition.questions) {
    if (rule.maxHundredths % rule.stepHundredths || rule.stepHundredths % unit)
      invalid('题目满分和给分步长必须符合科目小数位。');
    if (rule.kind === 'single_choice' || rule.kind === 'multiple_choice') {
      if (!unique(rule.options)) invalid('选项重复。');
      const answers = rule.kind === 'single_choice' ? [rule.correct] : rule.correct;
      if (!unique(answers) || answers.some((value) => !rule.options.includes(value)))
        invalid('正确选项重复或不存在。');
      if (rule.kind === 'multiple_choice' && rule.partial.mode !== 'none') {
        validatePoints(rule.partial.hundredths, rule);
        if (rule.partial.hundredths === 0 || rule.partial.hundredths >= rule.maxHundredths)
          invalid('部分给分必须大于零且小于满分。');
        if (
          rule.partial.mode === 'per_correct' &&
          rule.correct.length > 1 &&
          rule.partial.hundredths * (rule.correct.length - 1) >= rule.maxHundredths
        )
          invalid('不完整的选项集合不能获得满分。');
      }
    }
    if (rule.kind === 'judgement') {
      const correct = rule.correct.map(normalized),
        incorrect = rule.incorrect.map(normalized);
      if (
        !unique(correct) ||
        !unique(incorrect) ||
        correct.some((value) => incorrect.includes(value))
      )
        invalid('判断题答案形式重复或相互冲突。');
    }
    if (rule.kind === 'blank') {
      if (!unique(rule.accepted.map((value) => normalizeBlank(value, rule))))
        invalid('可接受填空答案按所选规范化规则重复。');
    }
  }
  if (
    definition.questions.reduce((sum, rule) => sum + rule.maxHundredths, 0) !==
    definition.maxHundredths
  )
    invalid('逐题满分总和必须与试卷满分一致，不能删掉未支持题目。');
  return definition;
}
function normalizeBlank(value: string, rule: Extract<QuestionRule, { kind: 'blank' }>) {
  let result = value.normalize('NFKC').trim();
  if (rule.normalization.collapseWhitespace) result = result.replace(/\s+/gu, ' ');
  return rule.normalization.ignoreCase ? result.toLocaleUpperCase('en-US') : result;
}

export interface GradingPreparation {
  request: GradingRequest;
  rubric: RubricVersion;
  pages: (GradingPage & {
    sourceHash: string;
    imageHash: string;
    assetId: string;
    width: number;
    height: number;
  })[];
  missingAnswerPages: boolean;
  fingerprint: string;
}

/**
 * 归属由后台快照确定，模型不能猜测学生或科目；页面顺序、角色和不完整材料须显式确认。
 * Backend-only preparation from immutable score/rubric/material snapshots, never Renderer records.
 * Checks exam/student/subject binding, explicit material roles/order and selected image scope.
 * Returns a detached private context/hash, without names, filenames or unselected source text.
 * Does not transform or send images; masks must later be baked into derivative pixels before I/O.
 * Partial/missing pages stay visible as blockers. Invalid bindings fail with GRADING_INVALID.
 */
export function prepareGrading(
  requestInput: unknown,
  rubricInput: unknown,
  scoreInput: { record: unknown; payload: unknown },
  sourceInputs: readonly unknown[],
): GradingPreparation {
  const request = gradingRequestSchema.parse(requestInput);
  const rubric = rubricVersionSchema.parse(rubricInput);
  rubric.definition = validateRubric(rubric.definition);
  const score = storedScoreVersionSchema.parse(scoreInput.record);
  const payload = scoreVersionPayloadSchema.parse(scoreInput.payload);
  if (
    score.id !== request.scoreVersionId ||
    score.examId !== request.examId ||
    rubric.id !== request.rubricVersionId ||
    rubric.examId !== request.examId ||
    rubric.subjectId !== request.subjectId
  )
    invalid('考试、科目、成绩版本或评分细则版本不一致。');
  const student = payload.analysis.roster.find((value) => value.studentId === request.studentId);
  const subject = payload.analysis.subjects.find((value) => value.id === request.subjectId);
  if (
    !student ||
    !subject ||
    !payload.analysis.groups.some(
      (group) => group.id === student.groupId && group.subjectIds.includes(request.subjectId),
    )
  )
    invalid('学生或科目不属于所选考试计分范围。');
  if (
    Math.round(Number(subject.maxScore) * 100) !== rubric.definition.maxHundredths ||
    subject.precision !== rubric.definition.precision
  )
    invalid('评分细则满分或小数位与考试科目不一致。');
  if (sourceInputs.length > GRADING_LIMITS.materials) invalid('一次最多关联 8 份材料。');
  const sources = sourceInputs.map((value) => materialVersionSchema.parse(value));
  if (!unique(sources.map((value) => value.id))) invalid('材料版本重复。');
  if (
    !unique(request.pages.map((value) => value.id)) ||
    !unique(request.pages.map((value) => `${value.sourceVersionId}:${value.fragmentId}`)) ||
    !unique(request.selectedPageIds) ||
    !unique(request.selectedQuestionIds)
  )
    invalid('页序、页面、选择范围或题目标识重复。');
  if (
    request.selectedPageIds.some((id) => !request.pages.some((page) => page.id === id)) ||
    request.selectedQuestionIds.some(
      (id) => !rubric.definition.questions.some((rule) => rule.id === id),
    )
  )
    invalid('选择范围包含不存在的页面或题目。');
  const answerPages = request.pages.filter((page) => page.role === 'student_answer');
  if (!answerPages.length || answerPages.length > request.expectedAnswerPages)
    invalid('须明确答卷页面及预计页数，题目材料不能代替学生答卷。');
  if (!answerPages.some((page) => request.selectedPageIds.includes(page.id)))
    invalid('本次图像范围必须包含已绑定的学生答卷。');
  const pages = request.pages.map((page) => {
    const source = sources.find((value) => value.id === page.sourceVersionId);
    if (!source) invalid('材料版本不存在。');
    if (source.completeness === 'partial' && !request.acknowledgePartial)
      invalid('材料未完整解析，请明确核对并确认可读范围。');
    if (!['jpg', 'png', 'pdf'].includes(source.format))
      invalid('答卷阅卷页面仅使用 JPG、PNG 或 PDF。');
    const fragment = source.fragments.find((value) => value.id === page.fragmentId);
    if (!fragment || fragment.kind !== 'image') invalid('所选页面没有可对照的原图。');
    return {
      ...page,
      sourceHash: source.sha256,
      imageHash: fragment.sha256,
      assetId: fragment.assetId,
      width: fragment.width,
      height: fragment.height,
    };
  });
  const context = {
    request,
    rubric,
    pages,
    missingAnswerPages: answerPages.length < request.expectedAnswerPages,
  };
  return {
    ...context,
    // 分批选择不改变整份答卷的审核依据；每次任务另行绑定完整选择范围。
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          ...context,
          request: { ...request, selectedPageIds: [], selectedQuestionIds: [] },
        }),
      )
      .digest('hex'),
  };
}

/** Map evidence on the cropped/rotated view back to its immutable original page; no pixel mutation. */
export function gradingOriginalRectangle(
  page: GradingPage & { width?: number; height?: number },
  input: unknown,
): GradingRectangle {
  const rectangle = gradingRectangleSchema.parse(input);
  const { x, y, width, height } = rectangle;
  const mapped =
    page.rotation === 90
      ? { x: y, y: Math.max(0, 1 - x - width), width: height, height: width }
      : page.rotation === 180
        ? { x: Math.max(0, 1 - x - width), y: Math.max(0, 1 - y - height), width, height }
        : page.rotation === 270
          ? { x: Math.max(0, 1 - y - height), y: x, width: height, height: width }
          : rectangle;
  const crop =
    page.width && page.height ? gradingEffectiveCrop(page, page.width, page.height) : page.crop;
  return {
    x: crop.x + mapped.x * crop.width,
    y: crop.y + mapped.y * crop.height,
    width: mapped.width * crop.width,
    height: mapped.height * crop.height,
  };
}
function intersects(a: GradingRectangle, b: GradingRectangle) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function validateEvidence(
  evidence: GradingEvidence[],
  preparation: GradingPreparation,
  model: boolean,
) {
  let covered = false;
  for (const locator of evidence) {
    const page = preparation.pages.find((value) => value.id === locator.pageId);
    if (
      !page ||
      page.role !== 'student_answer' ||
      (model && !preparation.request.selectedPageIds.includes(page.id))
    )
      invalid('作答依据必须对应明确选中的学生答卷页。');
    covered ||= page.redactions.some((redaction) =>
      intersects(
        gradingOriginalRectangle(page, locator.rectangle),
        gradingEffectiveRectangle(redaction, page.width, page.height),
      ),
    );
  }
  return covered;
}
function objectiveScore(rule: QuestionRule, answer: string): number | null {
  if (rule.kind === 'single_choice') {
    const selected = normalized(answer);
    return rule.options.includes(selected)
      ? selected === rule.correct
        ? rule.maxHundredths
        : 0
      : null;
  }
  if (rule.kind === 'multiple_choice') {
    const value = normalized(answer).replace(/[\s,，、;；]/gu, '');
    const selected = [...value];
    if (
      !selected.length ||
      !unique(selected) ||
      selected.some((item) => !rule.options.includes(item))
    )
      return null;
    if (selected.some((item) => !rule.correct.includes(item))) return 0;
    if (selected.length === rule.correct.length) return rule.maxHundredths;
    return rule.partial.mode === 'none'
      ? 0
      : rule.partial.mode === 'fixed'
        ? rule.partial.hundredths
        : selected.length * rule.partial.hundredths;
  }
  if (rule.kind === 'judgement') {
    const value = normalized(answer);
    return rule.correct.some((item) => normalized(item) === value)
      ? rule.maxHundredths
      : rule.incorrect.some((item) => normalized(item) === value)
        ? 0
        : null;
  }
  if (rule.kind === 'blank')
    return rule.accepted.some((item) => normalizeBlank(item, rule) === normalizeBlank(answer, rule))
      ? rule.maxHundredths
      : 0;
  return null;
}
function pending(rule: QuestionRule, reason: string, basisHash: string): GradingRow {
  return {
    questionId: rule.id,
    basisHash,
    status: 'pending',
    answer: null,
    scoreHundredths: null,
    reason,
    evidence: [],
    origin: 'model',
    reviewed: false,
    confidence: null,
  };
}

/**
 * 缺题、模糊及未支持题保持待人工与空分数；所有模型建议均未复核，不能直接入分。
 * Validate bounded model JSON, stable question IDs, score step and selected page evidence.
 * Missing/blurred/unsupported rows remain pending with null scores; never disappear or become zero.
 * 客观题由教师细则确定性计分；合法模型猜测分数不参与计分，但仍须通过边界校验。
 * Every row remains unreviewed. Pure: cannot confirm or write formal scores; no repair/retry.
 */
export function validateGradingOutput(raw: string, preparation: GradingPreparation): GradingRow[] {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > GRADING_LIMITS.outputBytes)
    invalid('阅卷返回超过大小上限。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid('阅卷返回不是有效 JSON，原输入保留。');
  }
  const output = gradingModelOutputSchema.parse(parsed);
  if (
    !unique(output.assessments.map((value) => value.questionId)) ||
    output.assessments.some(
      (value) => !preparation.request.selectedQuestionIds.includes(value.questionId),
    )
  )
    invalid('模型返回未知、未选择或重复的题目标识。');
  return preparation.rubric.definition.questions.map((rule) => {
    const value = output.assessments.find((item) => item.questionId === rule.id);
    if (!value)
      return pending(rule, '尚无本题作答建议，请补充范围或人工复核。', preparation.fingerprint);
    if (value.suggestedHundredths !== null) validatePoints(value.suggestedHundredths, rule);
    const covered = validateEvidence(value.evidence, preparation, true);
    if (
      ['unreadable', 'missing', 'unsupported'].includes(value.state) ||
      rule.kind === 'manual' ||
      covered ||
      value.evidence.length === 0
    ) {
      if (
        ['unreadable', 'missing', 'unsupported'].includes(value.state) &&
        value.suggestedHundredths !== null
      )
        invalid('无法判断的作答不能自动赋分。');
      return {
        ...pending(
          rule,
          covered ? '依据包含遮盖区域，须人工复核。' : value.reason,
          preparation.fingerprint,
        ),
        answer: value.answer,
        evidence: value.evidence,
        confidence: value.confidence,
      };
    }
    if (value.state === 'readable' && !value.answer?.trim()) invalid('可识别作答缺少识别内容。');
    if (value.state === 'blank' && value.answer?.trim()) invalid('空白状态与识别作答冲突。');
    const score =
      value.state === 'blank'
        ? 0
        : rule.kind === 'short_text'
          ? value.suggestedHundredths
          : objectiveScore(rule, value.answer!);
    if (score === null)
      return {
        ...pending(rule, '作答形式或建议分数不确定，须人工复核。', preparation.fingerprint),
        answer: value.answer,
        evidence: value.evidence,
      };
    validatePoints(score, rule);
    return {
      questionId: rule.id,
      basisHash: preparation.fingerprint,
      status: 'suggested',
      answer: value.answer,
      scoreHundredths: score,
      reason: value.reason,
      evidence: value.evidence,
      origin: rule.kind === 'short_text' ? 'model' : 'rule',
      reviewed: false,
      confidence: value.confidence,
    };
  });
}

/** 校验当前来源的完整行集合；不要求均已复核，不保存，旧来源抛 GRADING_STALE。 */
export function validateGradingRows(input: unknown, preparation: GradingPreparation): GradingRow[] {
  const rows = gradingRowSchema.array().min(1).max(GRADING_LIMITS.questions).parse(input);
  if (
    !unique(rows.map((row) => row.questionId)) ||
    rows.length !== preparation.rubric.definition.questions.length
  )
    invalid('复核题目不完整或重复。');
  for (const rule of preparation.rubric.definition.questions) {
    const row = rows.find((value) => value.questionId === rule.id);
    if (!row) invalid('复核缺少评分细则中的题目。');
    if (row.basisHash !== preparation.fingerprint)
      throw new DomainError('GRADING_STALE', '题目建议或审核来源已变化，请重新复核。');
    if (row.reviewed && row.origin !== 'teacher') invalid('模型建议不能自行标为教师复核。');
    if (row.reviewed && !row.evidence.length) invalid('人工复核必须记录可核对的原图位置。');
    validateEvidence(row.evidence, preparation, false);
    if (row.status === 'pending') {
      if (row.scoreHundredths !== null || row.reviewed) invalid('待处理题目不能带已确认分数。');
    } else {
      if (row.scoreHundredths === null) invalid('评分建议缺少分数。');
      validatePoints(row.scoreHundredths, rule);
    }
  }
  return preparation.rubric.definition.questions.map((rule) =>
    rows.find((row) => row.questionId === rule.id)!,
  );
}

/**
 * 人工修改接收当前来源的完整题目行和非空修改列表；每题须明确声明已核对并保留原图依据。
 * 返回分离的行，不冻结、不持久化、不调用模型。重复应用同一修改得到相同内容，无重试或取消任务。
 * ZodError 拒绝结构；GRADING_INVALID 拒绝无效分值/定位；GRADING_STALE 拒绝旧来源建议。
 */
export function applyGradingEdits(
  input: unknown,
  editsInput: unknown,
  preparation: GradingPreparation,
) {
  const rows = validateGradingRows(input, preparation);
  const edits = gradingEditSchema.array().min(1).max(GRADING_LIMITS.questions).parse(editsInput);
  if (!unique(edits.map((edit) => edit.questionId))) invalid('人工修改题目标识重复。');
  for (const edit of edits) {
    const rule = preparation.rubric.definition.questions.find(
      (value) => value.id === edit.questionId,
    );
    if (!rule) invalid('人工修改引用了不存在的题目。');
    validatePoints(edit.scoreHundredths, rule);
    validateEvidence(edit.evidence, preparation, false);
    rows[rows.findIndex((row) => row.questionId === rule.id)] = {
      questionId: rule.id,
      basisHash: preparation.fingerprint,
      status: 'suggested',
      answer: edit.answer,
      scoreHundredths: edit.scoreHundredths,
      reason: edit.reason,
      evidence: edit.evidence,
      origin: 'teacher',
      reviewed: true,
      confidence: null,
    };
  }
  return rows;
}

/**
 * 每题须由教师复核且保留当前来源指纹；缺页、未决或来源变化阻止整份冻结。
 * Require unchanged source fingerprint, complete pages and explicit review of every rubric row.
 * Returns the exact integer total and detached rows; it does not freeze, publish or touch scores.
 * GRADING_STALE rejects revised inputs; GRADING_INVALID blocks incomplete/unreviewed work.
 */
export function validateGradingReview(
  input: unknown,
  preparation: GradingPreparation,
  currentFingerprint: string,
) {
  if (currentFingerprint !== preparation.fingerprint)
    throw new DomainError('GRADING_STALE', '答卷或评分依据已变化，请重新复核。');
  const rows = validateGradingRows(input, preparation);
  if (
    preparation.missingAnswerPages ||
    rows.some((row) => row.status === 'pending' || !row.reviewed)
  )
    invalid('缺页、未决题目或未复核建议不能确认完整答卷。');
  return { rows, totalHundredths: rows.reduce((sum, row) => sum + row.scoreHundredths!, 0) };
}
