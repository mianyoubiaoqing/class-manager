import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, RefreshCw, Sparkles, X } from 'lucide-react';
import type { Result } from '../shared/contracts';
import type { ScoreVersionView } from '../shared/score-commands';
import {
  EXPLANATION_METRICS,
  type ExplanationMetric,
  type ExplanationSelection,
} from '../shared/score-explanation';
import type {
  ExplanationContent,
  ExplanationDraftSummary,
  ExplanationDraftView,
  ExplanationPreparation,
} from '../shared/explanation-drafts';
import { ExplanationFacts } from './ExplanationFacts';
import { ExplanationDraft } from './ExplanationDraft';
import './explanations.css';

function value<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(
      `${result.error.message}（${result.error.code} · ${result.error.operationId}）`,
    );
  return result.value;
}
const classMetrics: ExplanationMetric[] = ['fullScore', 'validCount', 'mean'];
const studentMetrics: ExplanationMetric[] = ['fullScore', 'studentStatus', 'studentScore'];

export function ScoreExplanation({
  epoch,
  version,
  onDirtyChange,
  suspended,
}: {
  epoch: string;
  version: ScoreVersionView;
  onDirtyChange: (dirty: boolean) => void;
  suspended: boolean;
}) {
  const api = window.classManager;
  const [selection, setSelection] = useState<ExplanationSelection>({
    scope: { kind: 'class' },
    subjectIds: [version.payload.analysis.subjects[0]!.id],
    metrics: classMetrics,
  });
  const [prepared, setPrepared] = useState<ExplanationPreparation>();
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const [drafts, setDrafts] = useState<ExplanationDraftSummary[]>([]);
  const [draft, setDraft] = useState<ExplanationDraftView>();
  const [content, setContent] = useState<ExplanationContent>();
  const [includeDiscarded, setIncludeDiscarded] = useState(false);
  const [page, setPage] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const locked = useRef(false);
  const listSequence = useRef(0);
  const dirty = Boolean(
    draft && content && JSON.stringify(draft.payload.content) !== JSON.stringify(content),
  );
  const disabled = Boolean(busy) || suspended;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onDirtyChange(false);
      void api.cancelExplanation({ epoch }).catch(() => {});
    };
  }, [api, epoch, onDirtyChange]);

  const refreshList = useCallback(async () => {
    const sequence = ++listSequence.current;
    const result = await api.listExplanations({
      epoch,
      examId: version.record.examId,
      includeDiscarded: true,
    });
    if (mounted.current && sequence === listSequence.current) setDrafts(value(result));
  }, [api, epoch, version.record.examId]);
  useEffect(() => {
    void refreshList().catch(() => {
      if (mounted.current) setMessage({ text: '无法读取解释草案，请刷新。', error: true });
    });
  }, [refreshList]);
  useEffect(() => {
    if (!prepared) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(prepared.expiresAt) - Date.now()) + 10,
    );
    return () => clearTimeout(timer);
  }, [prepared]);

  async function run(label: string, work: () => Promise<void>) {
    if (locked.current || suspended) return;
    locked.current = true;
    setBusy(label);
    setMessage(undefined);
    try {
      await work();
    } catch (error) {
      if (mounted.current)
        setMessage({
          text: error instanceof Error ? error.message : '操作响应中断，请刷新草案核对是否已保存。',
          error: true,
        });
    } finally {
      if (mounted.current) {
        locked.current = false;
        setBusy('');
      }
    }
  }
  async function read(id: string) {
    const result = value(await api.readExplanation({ epoch, id }));
    if (mounted.current) {
      setDraft(result);
      setContent(result.payload.content);
      onDirtyChange(false);
      setConfirmDiscard(false);
    }
  }
  function change(next: ExplanationSelection) {
    if (locked.current || dirty || suspended) return;
    setSelection(next);
    setPrepared(undefined);
    setConsented(false);
    void api.cancelExplanation({ epoch }).catch(() => {});
  }
  function prepare() {
    void run('准备出站指标', async () => {
      setPrepared(undefined);
      setConsented(false);
      const result = value(
        await api.prepareExplanation({ epoch, sourceVersionId: version.record.id, selection }),
      );
      if (mounted.current) {
        setPrepared(result);
        setNow(Date.now());
      }
    });
  }
  function generate() {
    if (!prepared || !consented || dirty) return;
    const token = prepared.token;
    setPrepared(undefined);
    setConsented(false);
    void run('正在生成解释', async () => {
      try {
        const receipt = value(await api.generateExplanation({ epoch, token }));
        if (!mounted.current) return;
        await read(receipt.id);
        await refreshList();
        if (mounted.current)
          setMessage({ text: '解释草案已保存，模型补充仍需教师核实。', error: false });
      } catch (error) {
        if (!mounted.current) return;
        let refreshed = false;
        try {
          await refreshList();
          refreshed = true;
        } catch {
          /* Preserve the original failure. */
        }
        throw new Error(
          `${error instanceof Error ? error.message : '生成响应中断。'} ${refreshed ? '已重新读取草案列表' : '草案列表刷新失败'}；结果可能已经保存，请先核对再重新生成。`,
          { cause: error },
        );
      }
    });
  }
  function save() {
    if (!draft || !content) return;
    const id = draft.record.id;
    void run('保存教师编辑', async () => {
      value(
        await api.editExplanation({ epoch, id, expectedRevision: draft.record.revision, content }),
      );
      if (!mounted.current) return;
      await read(id);
      await refreshList();
      if (mounted.current) setMessage({ text: '教师编辑已保存，原成绩未改变。', error: false });
    });
  }
  const filtered = drafts.filter((item) => includeDiscarded || item.record.status === 'draft');
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1));
  const expired = prepared ? now >= Date.parse(prepared.expiresAt) : true;
  return (
    <section className="score-section explanation-section" aria-label="成绩解释">
      <div className="score-actions">
        <h2>成绩解释</h2>
        <button
          type="button"
          disabled={disabled || dirty}
          onClick={() =>
            void run('刷新草案', async () => {
              if (draft) await read(draft.record.id);
              await refreshList();
            })
          }
        >
          <RefreshCw size={16} />
          刷新草案
        </button>
      </div>
      {message && (
        <div
          className={`notice ${message.error ? 'error' : 'success'}`}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </div>
      )}
      {busy && (
        <div className="score-actions">
          <span role="status">{busy}</span>
          {busy === '正在生成解释' && (
            <button
              type="button"
              onClick={() => {
                void api
                  .cancelExplanation({ epoch })
                  .then((result) => {
                    if (mounted.current && !result.ok)
                      setMessage({ text: result.error.message, error: true });
                  })
                  .catch(() => {
                    if (mounted.current)
                      setMessage({ text: '取消响应中断，请等候结果并核对草案。', error: true });
                  });
              }}
            >
              <X size={16} />
              取消解释生成
            </button>
          )}
        </div>
      )}
      {version.stale ? (
        <p className="score-warning">历史成绩版本仅供查阅；新解释须选择最新成绩版本。</p>
      ) : (
        <fieldset disabled={disabled || dirty} className="explanation-selection">
          <legend>生成范围</legend>
          <div className="score-fields">
            <label>
              解释范围
              <select
                aria-label="解释范围"
                value={selection.scope.kind}
                onChange={(event) =>
                  change({
                    ...selection,
                    scope:
                      event.target.value === 'class'
                        ? { kind: 'class' }
                        : {
                            kind: 'student',
                            studentId: version.payload.analysis.roster[0]!.studentId,
                          },
                    metrics: event.target.value === 'class' ? classMetrics : studentMetrics,
                  })
                }
              >
                <option value="class">班级</option>
                <option value="student">单个学生</option>
              </select>
            </label>
            {selection.scope.kind === 'student' && (
              <label>
                解释对象
                <select
                  aria-label="解释对象"
                  value={selection.scope.studentId}
                  onChange={(event) =>
                    change({
                      ...selection,
                      scope: { kind: 'student', studentId: event.target.value },
                    })
                  }
                >
                  {version.payload.analysis.roster.map((student) => (
                    <option key={student.studentId} value={student.studentId}>
                      {student.studentNumber} {student.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <fieldset>
            <legend>出站科目</legend>
            <div className="explanation-options">
              {version.payload.analysis.subjects.map((subject) => (
                <label className="score-check" key={subject.id}>
                  <input
                    type="checkbox"
                    checked={selection.subjectIds.includes(subject.id)}
                    onChange={(event) =>
                      change({
                        ...selection,
                        subjectIds: event.target.checked
                          ? [...selection.subjectIds, subject.id]
                          : selection.subjectIds.filter((id) => id !== subject.id),
                      })
                    }
                  />
                  {subject.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>出站指标</legend>
            <div className="explanation-options">
              {(Object.keys(EXPLANATION_METRICS) as ExplanationMetric[])
                .filter(
                  (key) =>
                    EXPLANATION_METRICS[key].scope === 'both' ||
                    EXPLANATION_METRICS[key].scope === selection.scope.kind,
                )
                .map((key) => (
                  <label className="score-check" key={key}>
                    <input
                      type="checkbox"
                      checked={selection.metrics.includes(key)}
                      onChange={(event) =>
                        change({
                          ...selection,
                          metrics: event.target.checked
                            ? [...selection.metrics, key]
                            : selection.metrics.filter((item) => item !== key),
                        })
                      }
                    />
                    {EXPLANATION_METRICS[key].label}
                  </label>
                ))}
            </div>
          </fieldset>
          <div>
            <button
              type="button"
              disabled={!selection.subjectIds.length || !selection.metrics.length}
              onClick={prepare}
            >
              <Eye size={16} />
              预览出站指标
            </button>
          </div>
        </fieldset>
      )}
      {prepared && (
        <section className="score-section" aria-label="出站确认">
          <h3>出站确认 · 来源第 {prepared.packet.sourceRevision} 版</h3>
          <p className="score-warning">
            将使用已配置的国产大模型生成学情诊断。系统已对学生姓名、学号等隐私身份在本地进行安全脱敏；生成结果将作为独立草稿保存，供教师核验。
          </p>
          <ExplanationFacts packet={prepared.packet} />
          <details>
            <summary>实际出站数据</summary>
            <pre className="explanation-wire">{JSON.stringify(prepared.packet.wire, null, 2)}</pre>
          </details>
          <label className="score-check">
            <input
              type="checkbox"
              checked={consented}
              disabled={disabled || expired}
              onChange={(event) => setConsented(event.target.checked)}
            />
            我确认发送这些指标并承担 API 费用
          </label>
          <div>
            <button
              type="button"
              className="primary"
              disabled={disabled || dirty || !consented || expired}
              onClick={generate}
            >
              <Sparkles size={16} />
              确认生成解释
            </button>
          </div>
          {expired && <p className="score-warning">出站确认已过期，请重新准备。</p>}
        </section>
      )}
      <section className="score-section" aria-label="已保存解释">
        <h3>已保存解释 · {filtered.length} 份</h3>
        <label className="score-check">
          <input
            type="checkbox"
            checked={includeDiscarded}
            onChange={(event) => {
              setIncludeDiscarded(event.target.checked);
              setPage(0);
            }}
          />
          包含已丢弃草案
        </label>
        {!filtered.length && <p>暂无解释草案。</p>}
        <div className="explanation-list">
          {filtered.slice(currentPage * 10, currentPage * 10 + 10).map((item) => (
            <div className="explanation-row" key={item.record.id}>
              <span>
                {item.scopeLabel} · {new Date(item.record.createdAt).toLocaleString()} ·{' '}
                {item.stale ? '来源已过期' : '来源有效'} ·{' '}
                {item.record.status === 'discarded' ? '已丢弃' : '草案'}
              </span>
              <button
                type="button"
                disabled={disabled || dirty}
                onClick={() => void run('读取解释', () => read(item.record.id))}
              >
                查看草案
              </button>
            </div>
          ))}
        </div>
        {filtered.length > 10 && (
          <div className="score-actions">
            <button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>
              上一页
            </button>
            <span>
              {currentPage + 1} / {Math.ceil(filtered.length / 10)}
            </span>
            <button
              type="button"
              disabled={(currentPage + 1) * 10 >= filtered.length}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </section>
      {draft && content && (
        <ExplanationDraft
          draft={draft}
          content={content}
          dirty={dirty}
          busy={disabled}
          confirmDiscard={confirmDiscard}
          setConfirmDiscard={setConfirmDiscard}
          change={(next) => {
            if (disabled) return;
            setConfirmDiscard(false);
            setContent(next);
            onDirtyChange(JSON.stringify(next) !== JSON.stringify(draft.payload.content));
          }}
          save={save}
          reset={() => {
            setContent(draft.payload.content);
            onDirtyChange(false);
          }}
          discard={() => {
            if (dirty || disabled) return;
            void run('丢弃解释', async () => {
              value(
                await api.discardExplanation({
                  epoch,
                  id: draft.record.id,
                  expectedRevision: draft.record.revision,
                }),
              );
              if (!mounted.current) return;
              await read(draft.record.id);
              await refreshList();
              if (mounted.current) setMessage({ text: '草案已丢弃，原成绩未改变。', error: false });
            });
          }}
        />
      )}
    </section>
  );
}
