import type { QuestionRule, RubricDefinition, GradingRectangle } from '../shared/grading';
import type { ScoreSubject } from '../shared/scores';

export interface GradingRuleForm {
  id: string;
  label: string;
  prompt: string;
  kind: QuestionRule['kind'];
  maxScore: string;
  stepScore: string;
  options: string;
  correct: string;
  incorrect: string;
  accepted: string;
  ignoreCase: boolean;
  collapseWhitespace: boolean;
  partialMode: 'none' | 'fixed' | 'per_correct';
  partialScore: string;
  scoringPoints: string;
}
export const gradingScoreText = (value: number) =>
  (value / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
/** 表单分数转整数百分之一分；不舍入、猜零或接受科学计数，失败保留原表单，无副作用。 */
export function gradingHundredths(raw: string, precision: number) {
  const text = raw.trim();
  if (!/^\d{1,5}(?:\.\d{1,2})?$/u.test(text) || (text.split('.')[1]?.length ?? 0) > precision)
    throw new Error(`评分分值须为非负数，最多 ${precision} 位小数。`);
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function newGradingRule(maxScore = '1'): GradingRuleForm {
  return {
    id: `q_${crypto.randomUUID().replaceAll('-', '')}`,
    label: '',
    prompt: '',
    kind: 'single_choice',
    maxScore,
    stepScore: '1',
    options: 'A\nB\nC\nD',
    correct: 'A',
    incorrect: '错误\n否',
    accepted: '',
    ignoreCase: false,
    collapseWhitespace: true,
    partialMode: 'none',
    partialScore: '1',
    scoringPoints: '',
  };
}
export function gradingRuleForm(rule: QuestionRule): GradingRuleForm {
  const form = {
    ...newGradingRule(gradingScoreText(rule.maxHundredths)),
    id: rule.id,
    label: rule.label,
    prompt: rule.prompt,
    kind: rule.kind,
    stepScore: gradingScoreText(rule.stepHundredths),
  };
  if (rule.kind === 'single_choice')
    return { ...form, options: rule.options.join('\n'), correct: rule.correct };
  if (rule.kind === 'multiple_choice')
    return {
      ...form,
      options: rule.options.join('\n'),
      correct: rule.correct.join('\n'),
      partialMode: rule.partial.mode,
      partialScore: rule.partial.mode === 'none' ? '1' : gradingScoreText(rule.partial.hundredths),
    };
  if (rule.kind === 'judgement')
    return { ...form, correct: rule.correct.join('\n'), incorrect: rule.incorrect.join('\n') };
  if (rule.kind === 'blank')
    return { ...form, accepted: rule.accepted.join('\n'), ...rule.normalization };
  if (rule.kind === 'short_text') return { ...form, scoringPoints: rule.scoringPoints };
  return { ...form, scoringPoints: rule.explanation };
}
const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
/** 根据教师完整表单构造细则；稳定题目标识不变，范围/满分与当前科目一致，后台再次校验。 */
export function gradingRubricFromForm(
  title: string,
  forms: GradingRuleForm[],
  subject: ScoreSubject,
): RubricDefinition {
  const questions: QuestionRule[] = forms.map((form) => {
    const base = {
      id: form.id,
      label: form.label.trim(),
      prompt: form.prompt.trim(),
      maxHundredths: gradingHundredths(form.maxScore, subject.precision),
      stepHundredths: gradingHundredths(form.stepScore, subject.precision),
    };
    switch (form.kind) {
      case 'single_choice':
        return {
          ...base,
          kind: form.kind,
          options: lines(form.options).map((value) => value.toUpperCase()),
          correct: form.correct.trim().toUpperCase(),
        };
      case 'multiple_choice':
        return {
          ...base,
          kind: form.kind,
          options: lines(form.options).map((value) => value.toUpperCase()),
          correct: lines(form.correct).map((value) => value.toUpperCase()),
          partial:
            form.partialMode === 'none'
              ? { mode: 'none' }
              : {
                  mode: form.partialMode,
                  hundredths: gradingHundredths(form.partialScore, subject.precision),
                },
        };
      case 'judgement':
        return {
          ...base,
          kind: form.kind,
          correct: lines(form.correct),
          incorrect: lines(form.incorrect),
        };
      case 'blank':
        return {
          ...base,
          kind: form.kind,
          accepted: lines(form.accepted),
          normalization: {
            ignoreCase: form.ignoreCase,
            collapseWhitespace: form.collapseWhitespace,
          },
        };
      case 'short_text':
        return { ...base, kind: form.kind, scoringPoints: form.scoringPoints };
      case 'manual':
        return { ...base, kind: form.kind, explanation: form.scoringPoints };
    }
  });
  return {
    title,
    questions,
    precision: subject.precision,
    maxHundredths: gradingHundredths(subject.maxScore, 2),
  };
}
/** 图像拖选归一化矩形；反向拖选、边界钳制，零面积不作依据，无副作用。 */
export function gradingDragRectangle(
  first: { x: number; y: number },
  last: { x: number; y: number },
): GradingRectangle | null {
  if (![first.x, first.y, last.x, last.y].every(Number.isFinite)) return null;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const x = Math.min(clamp(first.x), clamp(last.x)),
    y = Math.min(clamp(first.y), clamp(last.y));
  const width = Math.max(clamp(first.x), clamp(last.x)) - x,
    height = Math.max(clamp(first.y), clamp(last.y)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
