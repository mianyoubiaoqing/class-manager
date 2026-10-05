import { z } from 'zod';

export const EXPLANATION_PROMPT_VERSION = 'score-explanation-v1';
export const EXPLANATION_LIMITS = Object.freeze({
  facts: 400,
  inputBytes: 128 * 1024,
  outputBytes: 64 * 1024,
  textCharacters: 1200,
});

export const explanationMetric = z.enum([
  'fullScore',
  'expectedCount',
  'validCount',
  'absentCount',
  'missingCount',
  'notSelectedCount',
  'mean',
  'median',
  'minimum',
  'maximum',
  'targetScore',
  'targetMetCount',
  'targetDenominator',
  'targetRatePercent',
  'studentScore',
  'studentStatus',
  'studentRatePercent',
]);
export type ExplanationMetric = z.infer<typeof explanationMetric>;
export const EXPLANATION_METRICS: Record<
  ExplanationMetric,
  { label: string; unit: string; scope: 'class' | 'student' | 'both' }
> = {
  fullScore: { label: '满分', unit: '分', scope: 'both' },
  expectedCount: { label: '应考人数', unit: '人', scope: 'class' },
  validCount: { label: '有效成绩人数', unit: '人', scope: 'class' },
  absentCount: { label: '缺考人数', unit: '人', scope: 'class' },
  missingCount: { label: '未录入人数', unit: '人', scope: 'class' },
  notSelectedCount: { label: '未选考人数', unit: '人', scope: 'class' },
  mean: { label: '均分', unit: '分', scope: 'class' },
  median: { label: '中位数', unit: '分', scope: 'class' },
  minimum: { label: '最低分', unit: '分', scope: 'class' },
  maximum: { label: '最高分', unit: '分', scope: 'class' },
  targetScore: { label: '目标分数线', unit: '分', scope: 'class' },
  targetMetCount: { label: '达标人数', unit: '人', scope: 'class' },
  targetDenominator: { label: '达标率分母（有效成绩人数）', unit: '人', scope: 'class' },
  targetRatePercent: { label: '达标率', unit: '%', scope: 'class' },
  studentScore: { label: '单科成绩', unit: '分', scope: 'student' },
  studentStatus: { label: '成绩状态', unit: '', scope: 'student' },
  studentRatePercent: { label: '单科得分率', unit: '%', scope: 'student' },
};

export const explanationSelectionSchema = z
  .object({
    subjectIds: z.array(z.uuid()).min(1).max(20),
    metrics: z.array(explanationMetric).min(1).max(17),
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('class') }).strict(),
      z.object({ kind: z.literal('student'), studentId: z.uuid() }).strict(),
    ]),
  })
  .strict();
export type ExplanationSelection = z.infer<typeof explanationSelectionSchema>;

const factValue = z.union([
  z.string().max(80),
  z.number().int().nonnegative().max(10000),
  z.null(),
]);
const wireFactSchema = z
  .object({
    id: z.string().regex(/^F\d{3}$/),
    subject: z.string().regex(/^S\d{2}$/),
    metric: explanationMetric,
    value: factValue,
  })
  .strict();
export const explanationWireSchema = z
  .object({
    formatVersion: z.literal(1),
    scope: z.enum(['class', 'student']),
    facts: z.array(wireFactSchema).min(1).max(EXPLANATION_LIMITS.facts),
  })
  .strict();
export type ExplanationWire = z.infer<typeof explanationWireSchema>;
export type ExplanationFact = ExplanationWire['facts'][number] & {
  subjectId: string;
  subjectName: string;
  label: string;
  unit: string;
};
export interface ExplanationPacket {
  sourceVersionId: string;
  examId: string;
  sourceRevision: number;
  selection: ExplanationSelection;
  facts: ExplanationFact[];
  wire: ExplanationWire;
  inputHash: string;
  promptVersion: typeof EXPLANATION_PROMPT_VERSION;
}

const text = z.string().trim().min(1).max(EXPLANATION_LIMITS.textCharacters);
const proposal = z
  .object({
    text,
    evidenceIds: z
      .array(z.string().regex(/^F\d{3}$/))
      .min(1)
      .max(12),
  })
  .strict();
export const explanationOutputSchema = z
  .object({
    formatVersion: z.literal(1),
    observations: z
      .array(
        z
          .object({
            factId: z.string().regex(/^F\d{3}$/),
            value: factValue,
          })
          .strict(),
      )
      .min(1)
      .max(40),
    interpretations: z.array(proposal.extend({ uncertainty: text }).strict()).max(12),
    questions: z.array(proposal).max(12),
    actions: z.array(proposal).max(12),
    limitations: z.array(text).min(1).max(8),
  })
  .strict();
export type ExplanationOutput = z.infer<typeof explanationOutputSchema>;

export const EXPLANATION_NOTICES = [
  '学情统计指标由本地引擎精确计算，诊断建议经教师审核确认后生效。',
  '本次分析基于科目汇总成绩，建议结合日常课堂表现与作业综合研判。',
  '学情诊断侧重阶段性学情反馈，助力针对性辅导与因材施教。',
  '生成的建议措施供教师备课与辅导参考，确认后可同步归档。',
] as const;
