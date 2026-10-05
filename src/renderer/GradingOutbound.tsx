import type { GradingPreparationView, RubricView } from '../shared/grading-records';
import { GradingRuleDetails } from './GradingRuleDetails';

/** 确认 Main 实际外发预览及所选完整细则；生成和取消由调用方执行，无独立请求或重试。 */
export function GradingOutbound({
  prepared,
  rubric,
  locked,
  expired,
  approved,
  onApprove,
  onGenerate,
  onCancel,
}: {
  prepared: GradingPreparationView;
  rubric: RubricView;
  locked: boolean;
  expired: boolean;
  approved: boolean;
  onApprove: (approved: boolean) => void;
  onGenerate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="grading-outbound">
      <h3>
        实际外发范围 · {prepared.images.length} 页 / {prepared.questionIds.length} 题
      </h3>
      <p>
        包含以下已遮盖考号身份的答卷切片与评分细则。
        {prepared.missingAnswerPages && '答卷仍缺页，不能冻结完整复核。'}
        {expired && '本次预览已过期，请重新准备。'}
      </p>
      {prepared.images.map((p) => (
        <figure key={p.pageId}>
          <figcaption>
            确认页序 {p.order} ·{' '}
            {p.role === 'student_answer'
              ? '学生答卷'
              : p.role === 'question_material'
                ? '题目材料'
                : '细则材料'}
          </figcaption>
          <img src={p.dataUrl} alt={`实际外发第${p.order}页`} />
        </figure>
      ))}
      <details open>
        <summary>本批外发评分细则</summary>
        <GradingRuleDetails
          questions={rubric.definition.questions.filter((q) => prepared.questionIds.includes(q.id))}
        />
      </details>
      <label>
        <input
          type="checkbox"
          disabled={locked || expired}
          checked={approved}
          onChange={(e) => onApprove(e.target.checked)}
        />
        已核对实际外发图和细则，同意本次云处理（可能计费）
      </label>
      <button disabled={locked || expired || !approved} onClick={onGenerate}>
        生成本批建议一次
      </button>
      <button disabled={locked} onClick={onCancel}>
        放弃本次外发
      </button>
    </div>
  );
}
