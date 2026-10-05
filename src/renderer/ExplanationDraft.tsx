import { Save, Trash2, Undo2 } from 'lucide-react';
import { EXPLANATION_NOTICES } from '../shared/score-explanation';
import type { ExplanationContent, ExplanationDraftView } from '../shared/explanation-drafts';
import { ExplanationFacts } from './ExplanationFacts';

const fields: Array<{ key: keyof ExplanationContent; label: string }> = [
  { key: 'interpretations', label: '解释与不确定性（教师编辑）' },
  { key: 'questions', label: '待核实问题（教师编辑）' },
  { key: 'actions', label: '跟进建议（尚未执行）' },
  { key: 'teacherNotes', label: '教师复核记录' },
];
export function ExplanationDraft({
  draft,
  content,
  dirty,
  busy,
  confirmDiscard,
  setConfirmDiscard,
  change,
  save,
  discard,
  reset,
}: {
  draft: ExplanationDraftView;
  content: ExplanationContent;
  dirty: boolean;
  busy: boolean;
  confirmDiscard: boolean;
  setConfirmDiscard: (value: boolean) => void;
  change: (value: ExplanationContent) => void;
  save: () => void;
  discard: () => void;
  reset: () => void;
}) {
  const discarded = draft.record.status === 'discarded';
  const original = draft.payload.original;
  return (
    <section className="score-section explanation-draft" aria-label="解释草案详情">
      <h3>
        解释草案 · 来源第 {draft.packet.sourceRevision} 版 · 编辑第 {draft.record.revision} 版
      </h3>
      <p>对象：{draft.scopeLabel}（来源版本名册）</p>
      {draft.stale && (
        <p className="score-warning" role="status">
          来源已过期：成绩已有更正。此处仍保留原始依据，重新生成不会覆盖此稿。
        </p>
      )}
      {discarded && <p className="score-warning">此草案已丢弃，只读保留。</p>}
      <div className="explanation-notices">
        {EXPLANATION_NOTICES.map((notice) => (
          <p key={notice}>{notice}</p>
        ))}
      </div>
      <h4>本地统计事实</h4>
      <ExplanationFacts packet={draft.packet} />
      <section aria-label="证据限制">
        <h4>证据限制</h4>
        <ul>
          {original.limitations.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      </section>
      <details className="explanation-original">
        <summary>模型原稿与引用（未经核实，不随编辑改变）</summary>
        <h4>模型补充与不确定性</h4>
        {original.interpretations.length ? (
          original.interpretations.map((item, i) => (
            <div key={i}>
              <p>{item.text}</p>
              <p>
                不确定性：{item.uncertainty} · 依据 {item.evidenceIds.join('、')}
              </p>
            </div>
          ))
        ) : (
          <p>没有补充结论。</p>
        )}
        <h4>待核实问题</h4>
        {original.questions.map((item, i) => (
          <p key={i}>
            {item.text} · 依据 {item.evidenceIds.join('、')}
          </p>
        ))}
        <h4>未执行的建议</h4>
        {original.actions.map((item, i) => (
          <p key={i}>
            {item.text} · 依据 {item.evidenceIds.join('、')}
          </p>
        ))}
        <p>模型引用的事实：{original.observations.map((item) => item.factId).join('、')}</p>
      </details>
      <fieldset disabled={busy || discarded} className="explanation-editor">
        <legend>教师编辑</legend>
        {fields.map(({ key, label }) => (
          <label key={key}>
            {label}
            <textarea
              aria-label={label}
              rows={4}
              maxLength={32000}
              value={content[key]}
              onChange={(event) => change({ ...content, [key]: event.target.value })}
            />
          </label>
        ))}
      </fieldset>
      {!discarded && (
        <div className="score-actions">
          <button type="button" className="primary" disabled={busy || !dirty} onClick={save}>
            <Save size={16} />
            保存教师编辑
          </button>
          <button type="button" disabled={busy || !dirty} onClick={reset}>
            <Undo2 size={16} />
            放弃本次编辑
          </button>
          <button type="button" disabled={busy || dirty} onClick={() => setConfirmDiscard(true)}>
            <Trash2 size={16} />
            丢弃草案
          </button>
          {dirty && <span role="status">编辑尚未保存</span>}
        </div>
      )}
      {confirmDiscard && (
        <div className="score-warning" role="group" aria-label="确认丢弃草案">
          <p>丢弃后不可编辑，原成绩不变，记录仍保留在备份中。</p>
          <div className="score-actions">
            <button type="button" disabled={busy || dirty} onClick={discard}>
              确认丢弃草案
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)}>
              保留草案
            </button>
          </div>
        </div>
      )}
      <details className="explanation-provenance">
        <summary>生成与来源记录</summary>
        <p>
          响应模型：{draft.payload.provider.responseModel} · 请求模型：
          {draft.payload.provider.requestModel}
        </p>
        <p>
          生成时间：{draft.payload.provider.generatedAt} · 用量：
          {draft.payload.provider.usage?.totalTokens ?? '未知'} Token
        </p>
        <p>响应编号：{draft.payload.provider.responseId}</p>
        <p>提示词版本：{draft.payload.promptVersion}</p>
        <p>来源版本：{draft.record.sourceVersionId}</p>
        <p>事实摘要：{draft.payload.inputHash}</p>
      </details>
    </section>
  );
}
