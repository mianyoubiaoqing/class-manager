import { z } from 'zod';
import { MATERIAL_IMAGE_LIMITS } from './lessons';

export const GRADING_LIMITS = {
  questions: 200,
  pages: 20,
  selectedPages: 8,
  materials: 8,
  outputBytes: 1024 * 1024,
} as const;
const label = (max: number) => z.string().trim().min(1).max(max);
const questionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const points = z.number().int().min(0).max(9_999_999);
const option = z.string().regex(/^[A-Z]$/);
const base = {
  id: questionId,
  label: label(80),
  prompt: label(4000),
  maxHundredths: points.refine((value) => value > 0, '题目满分必须大于零'),
  stepHundredths: points.refine((value) => value > 0, '给分步长必须大于零'),
};
export const questionRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('single_choice'),
      options: z.array(option).min(2).max(26),
      correct: option,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('multiple_choice'),
      options: z.array(option).min(2).max(26),
      correct: z.array(option).min(1).max(26),
      partial: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('none') }).strict(),
        z.object({ mode: z.literal('fixed'), hundredths: points }).strict(),
        z.object({ mode: z.literal('per_correct'), hundredths: points }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('judgement'),
      correct: z.array(label(100)).min(1).max(20),
      incorrect: z.array(label(100)).min(1).max(20),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('blank'),
      accepted: z.array(label(200)).min(1).max(30),
      normalization: z
        .object({ ignoreCase: z.boolean(), collapseWhitespace: z.boolean() })
        .strict(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal('short_text'), scoringPoints: label(4000) }).strict(),
  z.object({ ...base, kind: z.literal('manual'), explanation: label(1000) }).strict(),
]);

/** Scores are integer hundredths; no model or UI may silently change the full-score basis. */
export const rubricDefinitionSchema = z
  .object({
    title: label(120),
    precision: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    maxHundredths: points.refine((value) => value > 0),
    questions: z.array(questionRuleSchema).min(1).max(GRADING_LIMITS.questions),
  })
  .strict();
export const rubricVersionSchema = z
  .object({
    id: z.uuid(),
    examId: z.uuid(),
    subjectId: z.uuid(),
    revision: z.number().int().positive(),
    definition: rubricDefinitionSchema,
  })
  .strict();

/** 单位矩形使用 0–1 坐标；其具体坐标空间由页面或证据契约说明。 */
export const gradingRectangleSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .refine((value) => value.x + value.width <= 1 && value.y + value.height <= 1, '区域超出原图');
/** crop 与 redactions 均相对标准化原图；先在原图遮盖，再裁剪，最后顺时针旋转。 */
export const gradingPageSchema = z
  .object({
    id: z.uuid(),
    role: z.enum(['question_material', 'rubric_material', 'student_answer']),
    sourceVersionId: z.uuid(),
    fragmentId: z.number().int().positive(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    crop: gradingRectangleSchema,
    redactions: z.array(gradingRectangleSchema).max(100),
  })
  .strict();
/** 只使用后台登记的标准化图像尺寸；不能以渲染层参数绕过解码像素上限。 */
export const gradingTransformSchema = z
  .object({
    page: gradingPageSchema,
    width: z.number().int().positive().max(MATERIAL_IMAGE_LIMITS.pixels),
    height: z.number().int().positive().max(MATERIAL_IMAGE_LIMITS.pixels),
  })
  .strict()
  .refine((value) => value.width * value.height <= MATERIAL_IMAGE_LIMITS.pixels);
export const gradingRequestSchema = z
  .object({
    examId: z.uuid(),
    scoreVersionId: z.uuid(),
    subjectId: z.uuid(),
    studentId: z.uuid(),
    rubricVersionId: z.uuid(),
    pages: z.array(gradingPageSchema).min(1).max(GRADING_LIMITS.pages),
    expectedAnswerPages: z.number().int().min(1).max(GRADING_LIMITS.pages),
    selectedPageIds: z.array(z.uuid()).min(1).max(GRADING_LIMITS.selectedPages),
    selectedQuestionIds: z.array(questionId).min(1).max(GRADING_LIMITS.questions),
    acknowledgeSyntheticOnly: z.literal(true),
    acknowledgeBindingAndOrder: z.literal(true),
    acknowledgePartial: z.boolean(),
  })
  .strict();

/** 模型和教师定位相对实际裁剪、旋转后的外发图像；映射回原图时保留原版本。 */
export const gradingEvidenceSchema = z
  .object({
    pageId: z.uuid(),
    rectangle: gradingRectangleSchema,
  })
  .strict();
export const modelAssessmentSchema = z
  .object({
    questionId,
    state: z.enum(['readable', 'blank', 'unreadable', 'missing', 'unsupported']),
    answer: z.string().max(4000).nullable(),
    suggestedHundredths: points.nullable(),
    reason: label(2000),
    evidence: z.array(gradingEvidenceSchema).max(8),
    confidence: z.number().finite().min(0).max(1).nullable().default(null),
  })
  .strict();
export const gradingModelOutputSchema = z
  .object({
    formatVersion: z.literal(1),
    assessments: z.array(modelAssessmentSchema).max(GRADING_LIMITS.questions),
  })
  .strict();

export const gradingRowSchema = z
  .object({
    questionId,
    basisHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['suggested', 'pending']),
    answer: z.string().max(4000).nullable(),
    scoreHundredths: points.nullable(),
    reason: label(2000),
    evidence: z.array(gradingEvidenceSchema).max(8),
    origin: z.enum(['rule', 'model', 'teacher']),
    reviewed: z.boolean(),
    confidence: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();
export const gradingEditSchema = z
  .object({
    questionId,
    answer: z.string().max(4000),
    scoreHundredths: points,
    reason: label(2000),
    evidence: z.array(gradingEvidenceSchema).min(1).max(8),
    acknowledgeReviewed: z.literal(true),
  })
  .strict();
export type QuestionRule = z.infer<typeof questionRuleSchema>;
export type RubricDefinition = z.infer<typeof rubricDefinitionSchema>;
export type RubricVersion = z.infer<typeof rubricVersionSchema>;
export type GradingRequest = z.infer<typeof gradingRequestSchema>;
export type GradingPage = z.infer<typeof gradingPageSchema>;
export type GradingRectangle = z.infer<typeof gradingRectangleSchema>;
export type GradingEvidence = z.infer<typeof gradingEvidenceSchema>;
export type GradingRow = z.infer<typeof gradingRowSchema>;
export type GradingTransform = z.infer<typeof gradingTransformSchema>;
