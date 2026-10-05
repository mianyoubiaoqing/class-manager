import type { QuestionRule } from '../shared/grading';
import { gradingScoreText } from './grading-editor';

/** 逐项展示教师细则的完整计分条件；只读，无推算、持久化或云请求。 */
export function GradingRuleDetails({ questions }: { questions: QuestionRule[] }) {
  return questions.map((q) => (
    <div key={q.id} className="grading-rule-details">
      <strong>
        {q.label} · 满分 {gradingScoreText(q.maxHundredths)} · 步长{' '}
        {gradingScoreText(q.stepHundredths)}
      </strong>
      <p>{q.prompt}</p>
      {(q.kind === 'single_choice' || q.kind === 'multiple_choice') && (
        <>
          <p>
            可选项：{q.options.join(' / ')}；正确选项：
            {Array.isArray(q.correct) ? q.correct.join(' / ') : q.correct}
          </p>
          <p>
            {q.kind === 'single_choice'
              ? '按正确选项给满分，其余可判定作答给零分。'
              : q.partial.mode === 'none'
                ? '必须全对才给分；错选或漏选给零分。'
                : q.partial.mode === 'fixed'
                  ? `全对给满分；无错漏选给 ${gradingScoreText(q.partial.hundredths)} 分；错选给零分。`
                  : `全对给满分；无错漏选每个正确选项给 ${gradingScoreText(q.partial.hundredths)} 分；错选给零分。`}
          </p>
        </>
      )}
      {q.kind === 'judgement' && (
        <p>
          正确作答：{q.correct.join(' / ')}；错误作答：{q.incorrect.join(' / ')}
          。其他形式须人工核对。
        </p>
      )}
      {q.kind === 'blank' && (
        <>
          <p>可接受答案：{q.accepted.join(' / ')}</p>
          <p>
            {q.normalization.ignoreCase ? '忽略大小写' : '区分大小写'}；
            {q.normalization.collapseWhitespace ? '合并连续空白' : '保留连续空白'}
            ；首尾空白按本地规则去除。
          </p>
        </>
      )}
      {q.kind === 'short_text' && <p>短文本评分要点：{q.scoringPoints}</p>}
      {q.kind === 'manual' && <p>仅人工评分：{q.explanation}</p>}
    </div>
  ));
}
