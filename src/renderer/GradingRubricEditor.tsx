import type { GradingRuleForm } from './grading-editor';
import { newGradingRule } from './grading-editor';
import { GRADING_LIMITS } from '../shared/grading';

export function GradingRubricEditor({
  title,
  onTitle,
  questions,
  onChange,
  disabled,
}: {
  title: string;
  onTitle: (title: string) => void;
  questions: GradingRuleForm[];
  onChange: (questions: GradingRuleForm[]) => void;
  disabled: boolean;
}) {
  const update = (index: number, patch: Partial<GradingRuleForm>) =>
    onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  return (
    <div className="grading-rubric-editor">
      <label>
        细则名称
        <input
          value={title}
          maxLength={120}
          disabled={disabled}
          onChange={(event) => onTitle(event.target.value)}
        />
      </label>
      {questions.map((q, index) => (
        <fieldset key={q.id} disabled={disabled} className="grading-rule">
          <legend>第 {index + 1} 个评分条目</legend>
          <div className="grading-grid">
            <label>
              显示题号
              <input
                value={q.label}
                maxLength={80}
                onChange={(e) => update(index, { label: e.target.value })}
              />
            </label>
            <label>
              题型
              <select
                value={q.kind}
                onChange={(e) => {
                  const kind = e.target.value;
                  if (
                    kind === 'single_choice' ||
                    kind === 'multiple_choice' ||
                    kind === 'judgement' ||
                    kind === 'blank' ||
                    kind === 'short_text' ||
                    kind === 'manual'
                  )
                    update(index, { kind });
                }}
              >
                <option value="single_choice">单选</option>
                <option value="multiple_choice">多选</option>
                <option value="judgement">判断</option>
                <option value="blank">简单填空</option>
                <option value="short_text">短文本</option>
                <option value="manual">仅人工评分</option>
              </select>
            </label>
            <label>
              满分
              <input
                inputMode="decimal"
                value={q.maxScore}
                onChange={(e) => update(index, { maxScore: e.target.value })}
              />
            </label>
            <label>
              给分步长
              <input
                inputMode="decimal"
                value={q.stepScore}
                onChange={(e) => update(index, { stepScore: e.target.value })}
              />
            </label>
          </div>
          <label>
            题干 / 对应内容
            <textarea
              value={q.prompt}
              maxLength={4000}
              onChange={(e) => update(index, { prompt: e.target.value })}
            />
          </label>
          {(q.kind === 'single_choice' || q.kind === 'multiple_choice') && (
            <label>
              可选字母（每行一个）
              <textarea
                value={q.options}
                onChange={(e) => update(index, { options: e.target.value })}
              />
            </label>
          )}
          {(q.kind === 'single_choice' ||
            q.kind === 'multiple_choice' ||
            q.kind === 'judgement') && (
            <label>
              {q.kind === 'judgement' ? '正确作答形式（每行一个）' : '正确选项（多选每行一个）'}
              <textarea
                value={q.correct}
                onChange={(e) => update(index, { correct: e.target.value })}
              />
            </label>
          )}
          {q.kind === 'judgement' && (
            <label>
              错误作答形式（每行一个）
              <textarea
                value={q.incorrect}
                onChange={(e) => update(index, { incorrect: e.target.value })}
              />
            </label>
          )}
          {q.kind === 'multiple_choice' && (
            <>
              <label>
                无错漏选规则
                <select
                  value={q.partialMode}
                  onChange={(e) => {
                    const partialMode = e.target.value;
                    if (
                      partialMode === 'none' ||
                      partialMode === 'fixed' ||
                      partialMode === 'per_correct'
                    )
                      update(index, { partialMode });
                  }}
                >
                  <option value="none">必须全对才给分</option>
                  <option value="fixed">漏选给固定分</option>
                  <option value="per_correct">按正确选项给部分分</option>
                </select>
              </label>
              {q.partialMode !== 'none' && (
                <label>
                  部分分值
                  <input
                    inputMode="decimal"
                    value={q.partialScore}
                    onChange={(e) => update(index, { partialScore: e.target.value })}
                  />
                </label>
              )}
            </>
          )}
          {q.kind === 'blank' && (
            <>
              <label>
                可接受答案（每行一个）
                <textarea
                  value={q.accepted}
                  onChange={(e) => update(index, { accepted: e.target.value })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={q.ignoreCase}
                  onChange={(e) => update(index, { ignoreCase: e.target.checked })}
                />
                忽略大小写
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={q.collapseWhitespace}
                  onChange={(e) => update(index, { collapseWhitespace: e.target.checked })}
                />
                合并连续空白
              </label>
            </>
          )}
          {(q.kind === 'short_text' || q.kind === 'manual') && (
            <label>
              {q.kind === 'manual' ? '人工评分要求 / 不支持原因' : '评分要点'}
              <textarea
                value={q.scoringPoints}
                maxLength={q.kind === 'manual' ? 1000 : 4000}
                onChange={(e) => update(index, { scoringPoints: e.target.value })}
              />
            </label>
          )}
          <button
            onClick={() => onChange(questions.filter((_, i) => i !== index))}
            disabled={questions.length <= 1}
          >
            移除此条目
          </button>
        </fieldset>
      ))}
      <button
        disabled={disabled || questions.length >= GRADING_LIMITS.questions}
        onClick={() =>
          onChange([...questions, { ...newGradingRule(), label: `第 ${questions.length + 1} 题` }])
        }
      >
        添加评分条目
      </button>
      <p className="muted">逐题满分合计必须等于科目满分。不支持的题目仍须保留人工评分条目。</p>
    </div>
  );
}
