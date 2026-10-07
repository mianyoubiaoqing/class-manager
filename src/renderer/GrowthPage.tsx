import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicError, Result, Snapshot } from '../shared/contracts';
import type { ExamSummary, ScoreVersionView } from '../shared/score-commands';
import type {
  GrowthEvent,
  GrowthEventRevision,
  GrowthPreparation,
  GrowthSelection,
  GrowthSummaryView,
  GrowthTimeline,
} from '../shared/growth';
import { scoreText } from './score-editor';
import './growth.css';
import { WorkspaceTabs } from './WorkspaceTabs';

const localDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const emptyEvent = (): GrowthEvent['content'] => ({
  date: localDate(),
  kind: 'event',
  description: '',
  source: '教师记录',
  action: '',
  result: '',
  followUp: 'none',
  summaryFact: '',
});
class GrowthReadError extends Error {
  constructor(readonly detail: PublicError) {
    super(detail.message);
  }
}
const errorText = (error: PublicError) =>
  `${error.message}（${error.code} · ${error.operationId}）`;

/** 私有时间线；本地事实、待审草稿和正式条目分开展示，外发只发生在实际预览之后的明确确认。 */
export function GrowthPage({
  snapshot,
  onDirtyChange,
  navigationBusy,
  selectedClass,
  initialStudentId,
  initialScores = [],
}: {
  snapshot: Snapshot;
  onDirtyChange: (dirty: boolean) => void;
  navigationBusy: boolean;
  selectedClass?: string;
  initialStudentId?: string;
  initialScores?: GrowthSelection['scores'];
}) {
  const api = window.classManager;
  const students = snapshot.students.filter(
    (s) => !selectedClass || selectedClass === 'all' || s.classId === selectedClass,
  );
  const [tab, setTab] = useState<'timeline' | 'record' | 'summary'>(
    initialScores.length ? 'summary' : 'timeline',
  );
  const [studentId, setStudentId] = useState(
      students.find((s) => s.id === initialStudentId)?.id ?? students[0]?.id ?? '',
    ),
    [timeline, setTimeline] = useState<GrowthTimeline>();
  const [event, setEvent] = useState(emptyEvent),
    [eventId, setEventId] = useState<string>(),
    [eventRevision, setEventRevision] = useState<number>(),
    [eventReason, setEventReason] = useState('');
  const [eventBaseline, setEventBaseline] = useState(event);
  const [eventHistory, setEventHistory] = useState<GrowthEventRevision[]>();
  const [from, setFrom] = useState(`${localDate().slice(0, 7)}-01`),
    [to, setTo] = useState(localDate());
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]),
    [scores, setScores] = useState<GrowthSelection['scores']>([]);
  const [exams, setExams] = useState<ExamSummary[]>([]),
    [scoreVersion, setScoreVersion] = useState<ScoreVersionView>();
  const [manual, setManual] = useState(''),
    [supersedes, setSupersedes] = useState<string>();
  const [prepared, setPrepared] = useState<GrowthPreparation>(),
    [permission, setPermission] = useState(false),
    [outboundApproved, setOutboundApproved] = useState(false);
  const [draft, setDraft] = useState<GrowthSummaryView>(),
    [draftDirty, setDraftDirty] = useState(false);
  const [busy, setBusy] = useState(false),
    [generating, setGenerating] = useState(false),
    [configured, setConfigured] = useState(false),
    [message, setMessage] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true),
    running = useRef(false),
    sequence = useRef(0);
  const updateDraftDirty = useCallback((dirty: boolean) => setDraftDirty(dirty), []);
  const eventDirty = JSON.stringify(event) !== JSON.stringify(eventBaseline) || !!eventReason;
  const dirty = Boolean(eventDirty || manual.trim() || prepared || draftDirty || busy);
  function resetEvent() {
    const content = emptyEvent();
    setEvent(content);
    setEventBaseline(content);
    setEventId(undefined);
    setEventRevision(undefined);
    setEventReason('');
  }
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
      void api.cancelGrowthSummary({ epoch: snapshot.epoch }).catch(() => {});
    };
  }, [api, onDirtyChange, snapshot.epoch]);
  useEffect(() => {
    if (!prepared) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [prepared]);
  async function reload() {
    const result = await api.growthTimeline({ epoch: snapshot.epoch, studentId });
    if (!result.ok) throw new GrowthReadError(result.error);
    if (alive.current) setTimeline(result.value);
  }
  useEffect(() => {
    const current = ++sequence.current;
    setTimeline(undefined);
    setDraft(undefined);
    setSelectedEvents([]);
    setScores([]);
    setScoreVersion(undefined);
    setEventHistory(undefined);
    setSupersedes(undefined);
    if (!studentId) return;
    void Promise.all([
      api.growthTimeline({ epoch: snapshot.epoch, studentId }),
      api.listExams({ epoch: snapshot.epoch }),
      api.readModelSettings(),
    ])
      .then(([history, list, status]) => {
        if (!alive.current || current !== sequence.current) return;
        if (history.ok) setTimeline(history.value);
        else setMessage(`${history.error.message}（${history.error.code}）`);
        if (list.ok) {
          const classExams = list.value.filter(
            (e) => !selectedClass || selectedClass === 'all' || e.classId === selectedClass,
          );
          setExams(classExams);
          if (studentId === initialStudentId && initialScores.length) {
            const seed = initialScores.filter((s) =>
              classExams.some((e) => e.versionId === s.versionId),
            );
            setScores(seed);
            const dates = classExams
              .filter((e) => seed.some((s) => s.versionId === e.versionId))
              .map((e) => e.definition.date)
              .sort();
            if (dates[0]) setFrom(dates[0]);
          }
        }
        if (status.ok) {
          const selected = status.value.providers.find(
            (p) => p.provider === status.value.selectedProvider,
          );
          setConfigured(!!selected?.credentials.configured && !!selected.textModel);
        } else setConfigured(false);
      })
      .catch(() => {
        if (alive.current && current === sequence.current) setMessage('读取响应中断，请刷新档案。');
      });
  }, [api, snapshot.epoch, studentId]);
  async function run<T>(
    work: () => Promise<Result<T>>,
    accept: (value: T) => void | Promise<void>,
  ) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(undefined);
    const current = sequence.current;
    try {
      const result = await work();
      if (!alive.current || current !== sequence.current) return;
      if (!result.ok) {
        setMessage(`${result.error.message}（${result.error.code} · ${result.error.operationId}）`);
        return;
      }
      await accept(result.value);
    } catch (error) {
      if (alive.current && current === sequence.current)
        setMessage(
          error instanceof GrowthReadError
            ? errorText(error.detail)
            : '响应中断，请刷新档案或读取原草稿查询入档状态；不要再次付费生成。',
        );
    } finally {
      running.current = false;
      if (alive.current) {
        setBusy(false);
        setGenerating(false);
      }
    }
  }
  function invalidateSelection() {
    setPrepared(undefined);
    setOutboundApproved(false);
    void api.cancelGrowthSummary({ epoch: snapshot.epoch }).catch(() => {});
  }
  const selection: GrowthSelection = {
    studentId,
    from,
    to,
    events: (timeline?.events ?? [])
      .filter((e) => selectedEvents.includes(e.id))
      .map((e) => ({ id: e.id, revision: e.revision })),
    scores,
  };
  const prepareInput = {
    epoch: snapshot.epoch,
    selection,
    acknowledgeSyntheticOnly: true as const,
    acknowledgeRedacted: true as const,
  };
  const hasSummaryFacts = selection.events.length > 0 || selection.scores.length > 0;
  const blocked = busy || navigationBusy;
  const student = snapshot.students.find((s) => s.id === studentId);
  const readDraft = (id: string) =>
    void run(
      () => api.readGrowthSummary({ epoch: snapshot.epoch, id }),
      (value) => {
        setDraft(value);
      },
    );
  return (
    <div className="growth-page">
      <p className="growth-privacy-hint">
        仅合成验证，教师本地私有档案。跟进“已完成”只表示教师记录的状态，不表示通知已送达。模型不作心理诊断或人格定性。
      </p>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <div className="growth-controls">
        <label>
          档案学生
          <select
            aria-label="档案学生"
            disabled={dirty || navigationBusy}
            value={studentId}
            onChange={(e) => {
              resetEvent();
              setStudentId(e.target.value);
            }}
          >
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.studentNumber} {s.displayName}
                {s.active ? '' : '（已停用）'}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={blocked || draftDirty}
          onClick={() =>
            void run(
              () => api.growthTimeline({ epoch: snapshot.epoch, studentId }),
              (value) => {
                setTimeline(value);
                if (draft) {
                  const latest = value.summaries.find((s) => s.record.id === draft.record.id);
                  if (latest) setDraft(latest);
                }
              },
            )
          }
        >
          刷新档案与入档状态
        </button>
      </div>
      {!studentId && <p>请先建立合成学生名册。</p>}
      {student && !student.active && (
        <p className="notice warning">学生已停用，可读取历史；不能建立或确认当前记录。</p>
      )}
      {studentId && (
        <>
          <section className="growth-student-overview">
            <div className="growth-student-avatar">{student?.displayName.slice(0, 1)}</div>
            <div>
              <h2>{student?.displayName}</h2>
              <p>
                {student?.className} · {student?.studentNumber} ·{' '}
                {student?.active ? '在籍' : '已停用'}
              </p>
            </div>
            <div className="growth-stats">
              <span>
                <strong>{timeline?.events.length ?? 0}</strong>事实记录
              </span>
              <span>
                <strong>
                  {timeline?.events.filter((e) => e.content.followUp === 'planned').length ?? 0}
                </strong>
                待跟进
              </span>
              <span>
                <strong>{timeline?.entries.length ?? 0}</strong>正式总结
              </span>
            </div>
          </section>
          <WorkspaceTabs
            id="growth"
            label="成长档案视图"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'timeline', label: '成长时间线' },
              { value: 'record', label: '新增记录' },
              { value: 'summary', label: '阶段总结' },
            ]}
          />
          <section className="growth-section growth-record-form" hidden={tab !== 'record'}>
            <h2>{eventId ? '更正事件 / 谈话跟进' : '记录一次成长与跟进'}</h2>
            <p>写下实际发生的事情、采取的行动与后续结果。此处记录保存在本机。</p>
            <fieldset disabled={blocked || !student?.active}>
              <div className="growth-controls">
                <label>
                  发生日期
                  <input
                    type="date"
                    value={event.date}
                    onChange={(e) => setEvent({ ...event, date: e.target.value })}
                  />
                </label>
                <label>
                  记录类型
                  <select
                    value={event.kind}
                    onChange={(e) =>
                      setEvent({
                        ...event,
                        kind: e.target.value === 'conversation' ? 'conversation' : 'event',
                      })
                    }
                  >
                    <option value="event">日常事件</option>
                    <option value="conversation">谈话跟进</option>
                  </select>
                </label>
                <label>
                  跟进状态
                  <select
                    value={event.followUp}
                    onChange={(e) =>
                      setEvent({
                        ...event,
                        followUp:
                          e.target.value === 'completed'
                            ? 'completed'
                            : e.target.value === 'planned'
                              ? 'planned'
                              : 'none',
                      })
                    }
                  >
                    <option value="none">无需跟进</option>
                    <option value="planned">待跟进</option>
                    <option value="completed">已完成记录</option>
                  </select>
                </label>
              </div>
              <label>
                本地事实记录
                <textarea
                  maxLength={4000}
                  value={event.description}
                  onChange={(e) => setEvent({ ...event, description: e.target.value })}
                />
              </label>
              <label>
                记录来源
                <input
                  maxLength={300}
                  value={event.source}
                  onChange={(e) => setEvent({ ...event, source: e.target.value })}
                />
              </label>
              <label>
                后续行动
                <textarea
                  maxLength={2000}
                  value={event.action}
                  onChange={(e) => setEvent({ ...event, action: e.target.value })}
                />
              </label>
              <label>
                后续结果
                <textarea
                  maxLength={2000}
                  value={event.result}
                  onChange={(e) => setEvent({ ...event, result: e.target.value })}
                />
              </label>
              <label>
                给阶段总结用的一句话（可选）
                <textarea
                  maxLength={1000}
                  value={event.summaryFact}
                  placeholder="例如：完成小组展示，能用自己的话说明解题思路。请勿填写姓名、联系方式等个人标识。"
                  onChange={(e) => setEvent({ ...event, summaryFact: e.target.value })}
                />
              </label>
              <p
                className="field-hint"
                style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 8px' }}
              >
                用于阶段成长评价的关键事实摘要，保存后可在时间线中查看。
              </p>
              <label>
                记录 / 更正说明
                <input
                  maxLength={300}
                  value={eventReason}
                  onChange={(e) => setEventReason(e.target.value)}
                />
              </label>
              <button
                disabled={!event.description.trim() || !event.source.trim() || !eventReason.trim()}
                onClick={() =>
                  void run(
                    () =>
                      api.saveGrowthEvent({
                        epoch: snapshot.epoch,
                        requestId: crypto.randomUUID(),
                        studentId,
                        ...(eventId ? { id: eventId, expectedRevision: eventRevision } : {}),
                        content: event,
                        reason: eventReason,
                      }),
                    async () => {
                      resetEvent();
                      invalidateSelection();
                      await reload();
                      setMessage('事件已保存；必要更正历史保留。');
                    },
                  )
                }
              >
                保存事件记录
              </button>
              <button
                onClick={() => {
                  resetEvent();
                }}
              >
                取消事件编辑
              </button>
            </fieldset>
          </section>
          <section className="growth-section growth-timeline" hidden={tab !== 'timeline'}>
            <h2>事实时间线</h2>
            {!timeline?.events.length && (
              <div className="workspace-empty-guide">
                <h3>从一条真实记录开始</h3>
                <p>记录课堂表现、日常事件或谈话跟进，逐步建立学生的成长时间线。</p>
                <button
                  className="primary"
                  disabled={blocked || !student?.active}
                  onClick={() => setTab('record')}
                >
                  新增成长记录
                </button>
              </div>
            )}
            {timeline?.events.map((e) => (
              <article key={e.id}>
                <h3>
                  {e.content.date} · {e.content.kind === 'conversation' ? '谈话跟进' : '日常事件'} ·
                  修订 {e.revision}
                </h3>
                <p className="growth-text">{e.content.description}</p>
                <p>
                  来源：{e.content.source}；跟进：
                  {e.content.followUp === 'planned'
                    ? '待跟进'
                    : e.content.followUp === 'completed'
                      ? '已完成记录'
                      : '无需跟进'}
                </p>
                <p className="growth-text">
                  行动：{e.content.action || '未记录'}
                  <br />
                  结果：{e.content.result || '未记录'}
                </p>
                <p className="growth-text">
                  总结最小摘要：{e.content.summaryFact || '未填写，不可选为总结事实'}
                </p>
                <button
                  disabled={blocked || eventDirty || draftDirty || !student?.active}
                  onClick={() => {
                    setTab('record');
                    setEvent(e.content);
                    setEventBaseline(e.content);
                    setEventId(e.id);
                    setEventRevision(e.revision);
                    setEventReason('');
                  }}
                >
                  更正事件 {e.content.date}
                </button>
                <button
                  disabled={blocked}
                  onClick={() =>
                    void run(
                      () => api.growthEventHistory({ epoch: snapshot.epoch, id: e.id }),
                      setEventHistory,
                    )
                  }
                >
                  查看事件修订 {e.content.date}
                </button>
              </article>
            ))}
            {eventHistory && (
              <details open>
                <summary>事件修订记录</summary>
                {eventHistory.map((h) => (
                  <p className="growth-text" key={h.record.revision}>
                    修订 {h.record.revision} · {h.createdAt} · {h.reason}
                    <br />
                    {h.record.content.date}：{h.record.content.description}
                    <br />
                    类型：{h.record.content.kind === 'conversation' ? '谈话跟进' : '事件'} ·
                    跟进状态：
                    {h.record.content.followUp === 'none'
                      ? '无需跟进'
                      : h.record.content.followUp === 'planned'
                        ? '计划跟进'
                        : '已完成'}
                    <br />
                    来源：{h.record.content.source}
                    <br />
                    行动：{h.record.content.action || '未记录'}
                    <br />
                    结果：{h.record.content.result || '未记录'}
                    <br />
                    总结最小摘要：{h.record.content.summaryFact || '未填写'}
                  </p>
                ))}
              </details>
            )}
          </section>
          <section className="growth-section" hidden={tab !== 'summary'}>
            <h2>整理一份阶段总结</h2>
            <ol className="flow-steps">
              <li className="active">1 选择时间与依据</li>
              <li className={prepared || manual ? 'active' : ''}>2 人工撰写或助手起草</li>
              <li className={draft ? 'active' : ''}>3 教师复核后入档</li>
            </ol>
            <p>只使用你选择的记录与成绩。可以先人工撰写，也可以核对发送内容后让助手起草。</p>
            <fieldset disabled={blocked || draftDirty || !student?.active}>
              <div className="growth-controls">
                <label>
                  阶段开始
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                      invalidateSelection();
                    }}
                  />
                </label>
                <label>
                  阶段结束
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => {
                      setTo(e.target.value);
                      invalidateSelection();
                    }}
                  />
                </label>
              </div>
              {(timeline?.events ?? [])
                .filter((e) => e.content.date >= from && e.content.date <= to)
                .map((e) => (
                  <label className="growth-check" key={e.id}>
                    <input
                      type="checkbox"
                      checked={selectedEvents.includes(e.id)}
                      disabled={!e.content.summaryFact}
                      onChange={(input) => {
                        setSelectedEvents(
                          input.target.checked
                            ? [...selectedEvents, e.id]
                            : selectedEvents.filter((id) => id !== e.id),
                        );
                        invalidateSelection();
                      }}
                    />
                    {e.content.date} · 修订 {e.revision} · {e.content.summaryFact || '摘要不足'}
                  </label>
                ))}
              <label>
                关联考试
                <select
                  aria-label="关联考试"
                  value={scoreVersion?.record.id ?? ''}
                  onChange={(e) => {
                    if (!e.target.value) {
                      setScoreVersion(undefined);
                      return;
                    }
                    void run(
                      () =>
                        api.readScoreVersion({ epoch: snapshot.epoch, versionId: e.target.value }),
                      setScoreVersion,
                    );
                  }}
                >
                  <option value="">选择考试最新成绩版本</option>
                  {exams.map((exam) => (
                    <option key={exam.examId} value={exam.versionId}>
                      {exam.definition.date} {exam.definition.name} · 第 {exam.revision} 版
                    </option>
                  ))}
                </select>
              </label>
              {scoreVersion?.payload.analysis.subjects.map((subject) => {
                const score = scoreVersion.payload.analysis.entries.find(
                  (e) => e.studentId === studentId && e.subjectId === subject.id,
                )?.score;
                const selected = scores.some(
                  (s) => s.versionId === scoreVersion.record.id && s.subjectId === subject.id,
                );
                return (
                  <label className="growth-check" key={subject.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!score || scoreVersion.stale}
                      onChange={(e) => {
                        setScores(
                          e.target.checked
                            ? [
                                ...scores,
                                { versionId: scoreVersion.record.id, subjectId: subject.id },
                              ]
                            : scores.filter(
                                (s) =>
                                  s.versionId !== scoreVersion.record.id ||
                                  s.subjectId !== subject.id,
                              ),
                        );
                        invalidateSelection();
                      }}
                    />
                    {subject.name} · {score ? scoreText(score) : '无该学生记录'} · 来源{' '}
                    {scoreVersion.record.id}
                  </label>
                );
              })}
              {scores.length > 0 && (
                <details>
                  <summary>已选成绩来源 {scores.length} 项</summary>
                  {scores.map((s) => (
                    <p key={`${s.versionId}:${s.subjectId}`}>
                      成绩版本 {s.versionId} · 科目 {s.subjectId}
                    </p>
                  ))}
                  <button
                    onClick={() => {
                      setScores([]);
                      invalidateSelection();
                    }}
                  >
                    清空成绩引用
                  </button>
                </details>
              )}
              <label className="growth-check">
                <input
                  type="checkbox"
                  checked={permission}
                  onChange={(e) => {
                    setPermission(e.target.checked);
                    invalidateSelection();
                  }}
                />
                确认仅使用合成资料，已核对最小摘要并去除可识别信息
              </label>
              <label>
                人工总结草稿
                <textarea
                  value={manual}
                  maxLength={12000}
                  onChange={(e) => setManual(e.target.value)}
                />
              </label>
              {supersedes && <p>拟更正正式条目 {supersedes}；原条目保留。</p>}
              <button
                disabled={!permission || !manual.trim() || !hasSummaryFacts}
                onClick={() =>
                  void run(
                    () =>
                      api.createGrowthSummary({
                        ...prepareInput,
                        requestId: crypto.randomUUID(),
                        content: manual,
                        ...(supersedes ? { supersedesEntryId: supersedes } : {}),
                      }),
                    async (receipt) => {
                      setManual('');
                      setSupersedes(undefined);
                      await reload();
                      const result = await api.readGrowthSummary({
                        epoch: snapshot.epoch,
                        id: receipt.id,
                      });
                      if (result.ok) setDraft(result.value);
                      setMessage('人工总结已存为独立草稿，尚未正式入档。');
                    },
                  )
                }
              >
                保存人工总结草稿
              </button>
              <button
                disabled={!permission || !hasSummaryFacts}
                onClick={() =>
                  void run(
                    () => api.prepareGrowthSummary(prepareInput),
                    (value) => {
                      setPrepared(value);
                      setOutboundApproved(false);
                      setNow(Date.now());
                    },
                  )
                }
              >
                预览在线总结的实际外发事实
              </button>
              {!hasSummaryFacts && (
                <p role="status">
                  请勾选至少一条有摘要的成长记录，或关联考试后添加成绩依据。显示“摘要不足”的记录，请回到成长时间线点击编辑，填写“给阶段总结用的一句话”。
                </p>
              )}
              <button
                onClick={() => {
                  setManual('');
                  setSupersedes(undefined);
                  invalidateSelection();
                }}
              >
                取消总结准备
              </button>
            </fieldset>
            {prepared && (
              <div className="growth-outbound">
                <h3>实际外发事实</h3>
                <p
                  style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '6px 0 12px' }}
                >
                  已自动遮蔽学生个人敏感标识，将基于以下事实摘要生成成长总结。
                </p>
                {prepared.packet.wire.facts.map((f) => (
                  <p className="growth-text" key={f.id}>
                    {f.id}：{f.text}
                  </p>
                ))}
                <label className="growth-check">
                  <input
                    type="checkbox"
                    checked={outboundApproved}
                    disabled={blocked}
                    onChange={(e) => setOutboundApproved(e.target.checked)}
                  />
                  已逐项检查上方实际外发事实，允许本次可能付费的生成
                </label>
                {!configured && <p>未配置模型，可继续离线记录或保存人工总结草稿。</p>}
                {Date.parse(prepared.expiresAt) <= now && <p>准备已过期，请重新选择和核对。</p>}
                <button
                  disabled={
                    blocked ||
                    !configured ||
                    !outboundApproved ||
                    Date.parse(prepared.expiresAt) <= now
                  }
                  onClick={() => {
                    setGenerating(true);
                    void run(
                      () =>
                        api.generateGrowthSummary({ epoch: snapshot.epoch, token: prepared.token }),
                      async (receipt) => {
                        setPrepared(undefined);
                        setOutboundApproved(false);
                        await reload();
                        const result = await api.readGrowthSummary({
                          epoch: snapshot.epoch,
                          id: receipt.id,
                        });
                        if (result.ok) setDraft(result.value);
                        setMessage('生成仅保存总结草稿，尚未入档。');
                      },
                    );
                  }}
                >
                  确认生成阶段总结草稿
                </button>
                {generating && (
                  <button
                    onClick={() =>
                      void api
                        .cancelGrowthSummary({ epoch: snapshot.epoch })
                        .then((result) => {
                          if (result.ok) {
                            setPrepared(undefined);
                            setMessage('已请求取消；请刷新草稿确认是否在取消前已保存。');
                          } else
                            setMessage(`${errorText(result.error)}。请刷新草稿确认当前保存状态。`);
                        })
                        .catch(() => setMessage('操作响应中断，请刷新草稿确认最新状态。'))
                    }
                  >
                    取消总结生成
                  </button>
                )}
              </div>
            )}
          </section>
          <section className="growth-section" hidden={tab !== 'summary'}>
            <h2>总结草稿（含历史状态）</h2>
            {!timeline?.summaries.length && <p>暂无总结草稿。</p>}
            {timeline?.summaries.map((s) => (
              <p key={s.record.id}>
                {s.record.source.selection.from} 至 {s.record.source.selection.to} ·{' '}
                {s.record.status === 'draft'
                  ? '待审草稿'
                  : s.record.status === 'confirmed'
                    ? '已确认入档'
                    : '已放弃'}{' '}
                · 修订 {s.record.revision}
                {s.stale ? ' · 来源已变化，须重核' : ''}
                <button disabled={blocked || draftDirty} onClick={() => readDraft(s.record.id)}>
                  读取总结草稿 {s.record.id}
                </button>
              </p>
            ))}
          </section>
          {draft && (
            <div hidden={tab !== 'summary'}>
              <GrowthDraftEditor
                key={`${draft.record.id}:${draft.record.revision}`}
                view={draft}
                blocked={blocked || !student?.active}
                onDirtyChange={updateDraftDirty}
                onSave={(content) =>
                  void run(
                    () =>
                      api.editGrowthSummary({
                        epoch: snapshot.epoch,
                        id: draft.record.id,
                        expectedRevision: draft.record.revision,
                        content,
                      }),
                    async () => {
                      setDraftDirty(false);
                      await reload();
                      const latest = await api.readGrowthSummary({
                        epoch: snapshot.epoch,
                        id: draft.record.id,
                      });
                      if (latest.ok) setDraft(latest.value);
                    },
                  )
                }
                onConfirm={(reason) =>
                  void run(
                    () =>
                      api.confirmGrowthSummary({
                        epoch: snapshot.epoch,
                        id: draft.record.id,
                        expectedRevision: draft.record.revision,
                        reason,
                        acknowledgeReviewed: true,
                        acknowledgeSources: true,
                      }),
                    async (receipt) => {
                      setDraftDirty(false);
                      await reload();
                      const latest = await api.readGrowthSummary({
                        epoch: snapshot.epoch,
                        id: draft.record.id,
                      });
                      if (latest.ok) setDraft(latest.value);
                      setMessage(
                        `已正式入档 ${receipt.entryId}${receipt.replayed ? '（原确认回执）' : ''}`,
                      );
                    },
                  )
                }
                onDiscard={() =>
                  void run(
                    () =>
                      api.discardGrowthSummary({
                        epoch: snapshot.epoch,
                        id: draft.record.id,
                        expectedRevision: draft.record.revision,
                      }),
                    async () => {
                      setDraftDirty(false);
                      setDraft(undefined);
                      await reload();
                    },
                  )
                }
                onClose={() => {
                  setDraftDirty(false);
                  setDraft(undefined);
                }}
              />
            </div>
          )}
          <section className="growth-section" hidden={tab !== 'summary'}>
            <h2>正式阶段总结</h2>
            {!timeline?.entries.length && <p>暂无正式总结条目，草稿不会自动入档。</p>}
            {timeline?.entries.map((e) => (
              <article key={e.record.id}>
                <h3>
                  {e.record.source.selection.from} 至 {e.record.source.selection.to} · 正式条目
                </h3>
                {e.stale && (
                  <p className="notice warning">来源更正或成员变化，请重新核对；历史正文保留。</p>
                )}
                {e.supersededBy && <p>已被更正条目 {e.supersededBy} 接续，原依据保留。</p>}
                <p className="growth-text">{e.record.content}</p>
                <details>
                  <summary>正式总结来源与确认记录</summary>
                  <p>
                    条目 {e.record.id} · 原草稿 {e.record.draftId} / 修订 {e.record.draftRevision} ·{' '}
                    {e.record.createdAt} · {e.record.reason}
                  </p>
                  {e.record.source.selection.events.map((ref) => (
                    <p key={ref.id}>
                      事件 {ref.id} / 修订 {ref.revision}
                    </p>
                  ))}
                  {e.record.source.selection.scores.map((ref) => (
                    <p key={`${ref.versionId}:${ref.subjectId}`}>
                      成绩版本 {ref.versionId} / 科目 {ref.subjectId}
                    </p>
                  ))}
                </details>
                <button
                  disabled={
                    blocked || draftDirty || Boolean(manual) || !student?.active || !!e.supersededBy
                  }
                  onClick={() => {
                    setTab('summary');
                    setManual(e.record.content);
                    setSupersedes(e.record.id);
                    setFrom(e.record.source.selection.from);
                    setTo(e.record.source.selection.to);
                    setSelectedEvents([]);
                    setScores([]);
                    invalidateSelection();
                    setMessage('已建立人工更正输入，请重新选择最新事件和成绩来源后保存独立草稿。');
                  }}
                >
                  更正正式总结 {e.record.id}
                </button>
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function GrowthDraftEditor({
  view,
  blocked,
  onDirtyChange,
  onSave,
  onConfirm,
  onDiscard,
  onClose,
}: {
  view: GrowthSummaryView;
  blocked: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (content: string) => void;
  onConfirm: (reason: string) => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState(view.record.content),
    [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [sources, setSources] = useState(false);
  const changed = content !== view.record.content;
  useEffect(() => {
    onDirtyChange(changed);
    return () => onDirtyChange(false);
  }, [changed, onDirtyChange]);
  return (
    <section className="growth-section">
      <h2>教师复核总结草稿</h2>
      <p>
        状态：{view.record.status} · 修订 {view.record.revision} ·{' '}
        {view.record.provider ? 'AI 起草' : '人工草稿'}。保存复核后再确认，编辑不自动入档。
      </p>
      {view.stale && (
        <p className="notice warning">
          原事实或学生版本已变化，不能用此草稿入档；以最新来源新建草稿，旧内容保留。
        </p>
      )}
      <details>
        <summary>核对草稿确切来源</summary>
        {view.packet.wire.facts.map((f) => (
          <p key={f.id}>
            {f.id}：{f.text}
          </p>
        ))}
        {view.record.source.selection.events.map((ref) => (
          <p key={ref.id}>
            事件 {ref.id} / 修订 {ref.revision}
          </p>
        ))}
        {view.record.source.selection.scores.map((ref) => (
          <p key={`${ref.versionId}:${ref.subjectId}`}>
            成绩版本 {ref.versionId} / 科目 {ref.subjectId}
          </p>
        ))}
      </details>
      <label>
        教师复核正文
        <textarea
          maxLength={12000}
          disabled={blocked || view.record.status !== 'draft'}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setReviewed(false);
            setSources(false);
          }}
        />
      </label>
      {view.record.status === 'draft' && (
        <>
          <button disabled={blocked || !content.trim()} onClick={() => onSave(content)}>
            保存教师复核草稿
          </button>
          <label>
            正式入档说明
            <input
              maxLength={300}
              disabled={blocked}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setReviewed(false);
                setSources(false);
              }}
            />
          </label>
          <label className="growth-check">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={blocked}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            已核对正文与建议，不含编造事实、心理诊断或人格定性
          </label>
          <label className="growth-check">
            <input
              type="checkbox"
              checked={sources}
              disabled={blocked}
              onChange={(e) => setSources(e.target.checked)}
            />
            已核对阶段、学生和确切来源，同意正式入档
          </label>
          <button
            disabled={
              blocked ||
              changed ||
              !view.record.reviewed ||
              view.stale ||
              !reason.trim() ||
              !reviewed ||
              !sources
            }
            onClick={() => onConfirm(reason)}
          >
            确认总结正式入档
          </button>
          <button disabled={blocked} onClick={onDiscard}>
            放弃总结草稿
          </button>
        </>
      )}
      {view.entryId && (
        <p className="notice success">已查到正式条目 {view.entryId}，重复确认不会再次入档。</p>
      )}
      <button disabled={blocked} onClick={onClose}>
        关闭草稿编辑
      </button>
    </section>
  );
}
