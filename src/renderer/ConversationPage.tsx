import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUp,
  Bot,
  CircleAlert,
  LoaderCircle,
  MessageSquare,
  Sparkles,
  UsersRound,
  X,
} from 'lucide-react';
import type { Result, Snapshot } from '../shared/contracts';
import type { ConversationTask, BusinessView } from '../shared/conversation';
import type { ModelSettingsView } from '../shared/model-providers';
import { ConversationMarkdown, DocumentCard, LessonCard } from './ConversationArtifacts';
import type { ConversationHistory, ConversationHistoryState } from '../shared/conversation-history';
import { ChangeValue, teacherReceipt, teacherToolLabel } from './ConversationPreview';

const promptSuggestions = [
  {
    icon: '📋',
    label: '查班级学生名册',
    desc: '核对学号、视力健康与在籍情况',
    prompt: '查看当前班级在籍名册',
  },
  {
    icon: '🪑',
    label: '教室智能调座',
    desc: '近视关注往前调、同桌互助平衡',
    prompt: '查看当前班级座位编排',
  },
  {
    icon: '📈',
    label: '考生成绩分析',
    desc: '平均分、及格率与薄弱名单',
    prompt: '查询近期考试情况',
  },
  {
    icon: '🧹',
    label: '今日值日生查询',
    desc: '轮换组员名单与卫生包干区',
    prompt: '查看当前班级值日轮换',
  },
];

const statuses = {
  prepared: '等待确认外发',
  planning: '理解需求中',
  proposed: '模型提议 · 尚未执行',
  executing: '本地执行中',
  completed: '本轮完成',
  failed: '本轮暂停 · 查看原因',
  cancelled: '已取消',
  unknown: '回包不明 · 先核对原业务',
};
const unsettled = (task?: ConversationTask) =>
  !!task && ['prepared', 'planning', 'proposed', 'executing'].includes(task.status);

export function ConversationPage({
  snapshot,
  onSnapshot,
  onNavigate,
  onDirtyChange,
  active,
  restoreNotice = '',
  onRestoreNotice,
  history,
  title,
  locked,
  onHistoryChange,
  onNewConversation,
}: {
  snapshot: Snapshot;
  onSnapshot: (value: Snapshot) => void;
  onNavigate: (view: BusinessView) => void;
  onDirtyChange: (dirty: boolean) => void;
  active: boolean;
  restoreNotice?: string;
  onRestoreNotice?: (message: string) => void;
  history: ConversationHistory;
  title: string;
  locked: boolean;
  onHistoryChange: (update: (state: ConversationHistoryState) => ConversationHistoryState) => void;
  onNewConversation: () => void;
}) {
  const api = window.classManager;
  const [settings, setSettings] = useState<ModelSettingsView>();
  const { messages, draft: text } = history.state;
  const classId = history.state.classId ?? '',
    studentId = history.state.studentId ?? '';
  const setClassId = (value: string) =>
    onHistoryChange((old) => ({ ...old, classId: value || null }));
  const setStudentId = (value: string) =>
    onHistoryChange((old) => ({ ...old, studentId: value || null }));
  const setText = (value: string) => onHistoryChange((old) => ({ ...old, draft: value }));
  const setMessages = (
    update:
      | ConversationHistoryState['messages']
      | ((messages: ConversationHistoryState['messages']) => ConversationHistoryState['messages']),
  ) =>
    onHistoryChange((old) => ({
      ...old,
      messages: typeof update === 'function' ? update(old.messages) : update,
    }));
  const [localBusy, setBusy] = useState(false);
  const archived = history.epoch !== snapshot.epoch;
  const busy = localBusy || locked || archived;
  const [error, setError] = useState('');
  const [task, setTask] = useState<ConversationTask>();
  const sessionId = history.id;
  const [localResult, setLocalResult] = useState('');
  const mounted = useRef(true);
  const settingsRevision = useRef<string | undefined>(undefined);
  const pending = useRef(0);
  const taskRef = useRef<ConversationTask | undefined>(undefined);
  const accepted = useRef(new Set<string>());
  taskRef.current = task;
  useEffect(() => {
    if (!task || !['planning', 'executing'].includes(task.status)) return;
    const preparation = task.preparation;
    let disposed = false,
      reading = false;
    const timer = setInterval(() => {
      if (reading || disposed) return;
      reading = true;
      void api
        .readConversation({ epoch: preparation.epoch, token: preparation.token })
        .then((result) => {
          if (
            !disposed &&
            mounted.current &&
            result.ok &&
            taskRef.current?.preparation.token === preparation.token &&
            ['planning', 'executing'].includes(taskRef.current.status)
          )
            setTask(result.value);
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }, 150);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [api, task?.status, task?.preparation.token]);
  useEffect(() => {
    mounted.current = true;
    void api
      .readModelSettings()
      .then((result) => {
        if (!mounted.current) return;
        if (result.ok) {
          if (settingsRevision.current && settingsRevision.current !== result.value.revision) {
            setTask(undefined);
            setLocalResult('');
          }
          settingsRevision.current = result.value.revision;
          setSettings(result.value);
        } else setError(result.error.message);
      })
      .catch(() => {
        if (mounted.current) setError('模型设置读取失败，请重新打开本页。');
      });
    return () => {
      mounted.current = false;
      const current = taskRef.current;
      if (current && unsettled(current))
        void api
          .cancelConversation({
            epoch: current.preparation.epoch,
            token: current.preparation.token,
          })
          .catch(() => {});
    };
  }, [api, snapshot.epoch, active]);
  useEffect(() => {
    onDirtyChange(localBusy || unsettled(task));
    return () => onDirtyChange(false);
  }, [localBusy, task, onDirtyChange]);
  const selected = settings?.providers.find((p) => p.provider === settings.selectedProvider);
  const token = () => ({ epoch: snapshot.epoch, token: task!.preparation.token });
  function acceptTask(value: ConversationTask) {
    taskRef.current = value;
    setTask(value);
    const append = (kind: string, answer?: string) => {
      const key = `${value.preparation.token}:${kind}:${kind === 'execution' ? (value.execution?.confirmedActionHash ?? '') : (value.proposal?.actionHash ?? '')}`;
      if (!answer || accepted.current.has(key)) return;
      accepted.current.add(key);
      setMessages((old) =>
        [
          ...old,
          {
            speaker: 'assistant' as const,
            text: teacherReceipt(answer),
            ...(kind === 'answer'
              ? {
                  document: value.document,
                  documents: value.documents,
                  lesson: value.lessonPreview,
                }
              : {}),
          },
        ].slice(-60),
      );
    };
    append('answer', value.reply ?? value.proposal?.explanation);
    append('execution', value.execution?.message);
    const navigationKey = `${value.preparation.token}:navigation`;
    if (value.execution?.navigate && !accepted.current.has(navigationKey)) {
      accepted.current.add(navigationKey);
      onNavigate(value.execution.navigate);
    }
  }
  async function run<T>(action: () => Promise<Result<T>>, accept: (value: T) => void) {
    pending.current += 1;
    setBusy(true);
    setError('');
    const recover = async () => {
      const current = taskRef.current;
      if (!current) return;
      try {
        const result = await api.readConversation({
          epoch: current.preparation.epoch,
          token: current.preparation.token,
        });
        if (mounted.current && result.ok) acceptTask(result.value);
      } catch {
        /* 查询失败保留原任务，不重放任何副作用。 */
      }
    };
    try {
      const result = await action();
      if (!mounted.current) return;
      if (result.ok) accept(result.value);
      else {
        setError(result.error.message);
        await recover();
      }
    } catch {
      if (mounted.current) {
        setError('操作处理中，正在同步最新状态，请稍后刷新。');
        await recover();
      }
    } finally {
      pending.current -= 1;
      if (mounted.current) setBusy(pending.current > 0);
    }
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    await sendMessage(text);
  }
  async function sendMessage(message: string) {
    if (!settings || unsettled(task) || busy) return;
    onRestoreNotice?.('');
    setLocalResult('');
    await run(async () => {
      const prepared = await api.prepareConversation({
        epoch: snapshot.epoch,
        configurationRevision: settings.revision,
        text: message,
        classId: classId || null,
        studentId: studentId || null,
        sessionId,
      });
      if (!prepared.ok) return prepared;
      taskRef.current = prepared.value;
      setTask({ ...prepared.value, status: 'planning' });
      setMessages((old) => [...old, { speaker: 'user' as const, text: message }].slice(-60));
      setText('');
      return api.generateConversation({
        epoch: snapshot.epoch,
        token: prepared.value.preparation.token,
        wireHash: prepared.value.preparation.wireHash,
        acknowledgeConversationSend: true,
      });
    }, acceptTask);
  }
  async function execute() {
    if (!task?.proposal) throw new Error('没有可执行提议');
    const value = await api.executeConversation({
      ...token(),
      actionHash: task.proposal.actionHash,
      acknowledgeActionPreview: true,
    });
    if (!value.ok) return value;
    if (
      value.value.proposal?.action.kind === 'tool' &&
      value.value.proposal.action.tool === 'commitRestore'
    )
      onRestoreNotice?.('工作区已恢复，旧对话上下文已清空。');
    const refreshed = await api.snapshot();
    if (refreshed.ok) onSnapshot(refreshed.value);
    return value;
  }
  function acceptExecution(value: ConversationTask) {
    acceptTask(value);
  }
  async function localQuery(kind: 'roster' | 'exams' | 'devices' | 'countdown') {
    if (busy || unsettled(task)) return;
    if ((kind === 'roster' || kind === 'exams') && !classId) {
      setError('请先明确选择班级。');
      return;
    }
    setTask(undefined);
    if (kind === 'roster') {
      setLocalResult(
        JSON.stringify(
          snapshot.students
            .filter((s) => s.classId === classId)
            .map((s) => ({
              studentNumber: s.studentNumber,
              displayName: s.displayName,
              active: s.active,
            })),
          null,
          2,
        ),
      );
      return;
    }
    await run<unknown>(
      () =>
        kind === 'exams'
          ? api.listExams({ epoch: snapshot.epoch, classId })
          : kind === 'devices'
            ? api.readDeviceStatus({ epoch: snapshot.epoch })
            : api.readCountdown({ epoch: snapshot.epoch }),
      (value) => setLocalResult(JSON.stringify(value, null, 2)),
    );
  }
  return (
    <section className="conversation-page" aria-label="统一业务对话">
      <div className="conversation-context">
        <div className="conversation-context-heading">
          <Bot size={20} />
          <strong>{title === '新会话' ? '业务助手' : title}</strong>
          <Sparkles size={14} style={{ color: 'var(--primary)' }} />
          <span style={{ fontSize: '12px' }}>
            {selected
              ? `${selected.label} · ${selected.textModel || '未配置型号'}`
              : '读取模型设置中'}
          </span>
        </div>
        {archived && (
          <p role="status">
            这是恢复前工作区的聊天记录，仅供查看。可以开启新会话继续处理当前资料。
          </p>
        )}
        <div className="conversation-selectors">
          <label>
            当前班级
            <select
              aria-label="对话当前班级"
              value={classId}
              disabled={busy || unsettled(task)}
              onChange={(e) => {
                setClassId(e.target.value);
                setStudentId('');
                setTask(undefined);
                setLocalResult('');
              }}
            >
              <option value="">未选择</option>
              {snapshot.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            当前学生
            <select
              aria-label="对话当前学生"
              value={studentId}
              disabled={!classId || busy || unsettled(task)}
              onChange={(e) => {
                setStudentId(e.target.value);
                setTask(undefined);
                setLocalResult('');
              }}
            >
              <option value="">未选择</option>
              {snapshot.students
                .filter((s) => s.classId === classId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.studentNumber} · {s.displayName}
                    {s.active ? '' : '（停用）'}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="conversation-shortcuts" aria-label="离线快捷操作">
          <details className="conversation-quick-menu">
            <summary>本地快捷查询</summary>
            <div className="conversation-quick-menu-content">
              {(['roster', 'exams', 'devices', 'countdown'] as const).map((kind, i) => (
                <button
                  key={kind}
                  disabled={busy || unsettled(task)}
                  onClick={() => void localQuery(kind)}
                >
                  {['名册', '考试', '设备状态', '倒计时'][i]}
                </button>
              ))}
            </div>
          </details>
          <button disabled={busy || unsettled(task)} onClick={() => onNavigate('providerSettings')}>
            模型设置
          </button>
          <button disabled={localBusy || locked || unsettled(task)} onClick={onNewConversation}>
            新对话
          </button>
        </div>
        {selected && (!selected.credentials.configured || !selected.textModel) && (
          <p className="conversation-warning">
            当前模型尚未配置 API Key，可点击上方“模型设置”配置，或使用离线快捷查询。
          </p>
        )}
      </div>
      <div className="conversation-thread" role="log" aria-label="本次对话记录" aria-live="polite">
        {restoreNotice && <p role="status">{restoreNotice}</p>}
        {!messages.length && !task && (
          <div className="conversation-empty">
            <MessageSquare size={36} style={{ color: 'var(--primary)', opacity: 0.85 }} />
            <h2>今天想处理什么？</h2>
            <p>说说您的备课或班级管理需求，也可以从下面的常用操作开始。</p>
            <div className="prompt-capsules-container">
              {promptSuggestions.map((item, idx) => (
                <div
                  key={idx}
                  className="prompt-capsule"
                  role="button"
                  tabIndex={0}
                  onClick={() => setText(item.prompt)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setText(item.prompt);
                  }}
                >
                  <span className="prompt-capsule-icon">{item.icon}</span>
                  <div className="prompt-capsule-body">
                    <div className="prompt-capsule-title">{item.label}</div>
                    <div className="prompt-capsule-desc">{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`conversation-message ${m.speaker}`}>
            <span>{m.speaker === 'user' ? '你' : '业务助手'}</span>
            {m.documents?.length ? (
              <>
                {m.documents.map((document, index) => (
                  <DocumentCard
                    key={index}
                    document={document}
                    disabled={busy || unsettled(task)}
                    onContinue={(prompt) => void sendMessage(prompt)}
                  />
                ))}
                {!m.documents.some((document) => document.body === m.text) && (
                  <ConversationMarkdown text={m.text} />
                )}
              </>
            ) : m.document ? (
              <DocumentCard
                document={m.document}
                disabled={busy || unsettled(task)}
                onContinue={(prompt) => void sendMessage(prompt)}
              />
            ) : (
              <ConversationMarkdown text={m.text} />
            )}
            {m.lesson && <LessonCard content={m.lesson} />}
          </div>
        ))}
        {localResult &&
          (() => {
            let parsedRoster: Array<{
              studentNumber: string;
              displayName: string;
              active: boolean;
            }> | null = null;
            try {
              const data = JSON.parse(localResult);
              if (Array.isArray(data) && data.length > 0 && 'studentNumber' in data[0]) {
                parsedRoster = data;
              }
            } catch {
              /* 忽略非 JSON 或非名册结构的结果，退化为原始文本输出 */
            }
            return (
              <article className="conversation-card genui-card">
                <div className="genui-card-header">
                  <h3>
                    <UsersRound size={16} /> 本地查询结果
                    {parsedRoster ? `（${parsedRoster.length} 人）` : ''}
                  </h3>
                  {parsedRoster && (
                    <button
                      type="button"
                      className="genui-open-studio-btn"
                      onClick={() => onNavigate('roster')}
                    >
                      在完整名册工坊中打开 →
                    </button>
                  )}
                </div>
                {parsedRoster ? (
                  <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr
                          style={{
                            textAlign: 'left',
                            borderBottom: '1px solid var(--border-color)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          <th style={{ padding: '6px 8px' }}>学号</th>
                          <th style={{ padding: '6px 8px' }}>姓名</th>
                          <th style={{ padding: '6px 8px' }}>状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsedRoster.map((s, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>
                              {s.studentNumber}
                            </td>
                            <td style={{ padding: '6px 8px', fontWeight: 500 }}>{s.displayName}</td>
                            <td style={{ padding: '6px 8px' }}>
                              <span
                                style={{
                                  display: 'inline-block',
                                  padding: '2px 8px',
                                  borderRadius: '12px',
                                  fontSize: '11px',
                                  background: s.active ? '#eaf4f0' : '#fee2e2',
                                  color: s.active ? '#177a62' : '#991b1b',
                                }}
                              >
                                {s.active ? '在籍' : '停用'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <ChangeValue text={localResult} />
                )}
              </article>
            );
          })()}
        {task && (
          <article
            className={`conversation-card ${task.status !== 'proposed' ? 'task-trace-compact' : ''} ${task.status === 'completed' ? 'task-trace-completed' : ''}`}
          >
            <h3>{statuses[task.status]}</h3>
            {task.status === 'planning' && (
              <div className="thinking-step-box" style={{ margin: '10px 0' }}>
                <span className="thinking-pulse-dot" />
                <span>{task.stream?.label ?? '助教正在理解需求并准备相关业务数据...'}</span>
              </div>
            )}
            {task.stream?.text && (
              <div className="conversation-stream" aria-label="流式回复">
                <ConversationMarkdown text={task.stream.text} />
                <small>{task.status === 'planning' ? '正在生成…' : '已收到的部分回复'}</small>
              </div>
            )}
            {task.warning && <p className="conversation-warning">{task.warning}</p>}
            {task.status === 'executing' && (
              <div className="thinking-step-box" style={{ margin: '10px 0' }}>
                <span className="thinking-pulse-dot" />
                <span>正在执行并更新结果…</span>
              </div>
            )}
            <p>
              对象：{task.preparation.context.className ?? '未选择班级'} ·{' '}
              {task.preparation.context.studentNumber
                ? `${task.preparation.context.studentNumber} ${task.preparation.context.studentName}`
                : '未选择学生'}
            </p>
            {!!task.toolCalls?.length && (
              <p className="conversation-progress">
                已核对 {task.toolCalls.length} 项资料与操作步骤。
              </p>
            )}
            {task.proposal && (
              <>
                <h4>
                  {task.proposal.action.kind === 'tool'
                    ? teacherToolLabel(task.proposal.action.tool)
                    : task.proposal.label}
                </h4>
                <p>模型提议：{task.proposal.explanation}</p>
                {!!task.remainingOperations && (
                  <p>
                    后续还有 {task.remainingOperations}{' '}
                    个步骤；本次按钮只确认当前操作，完成后会继续展示后续内容。
                  </p>
                )}
                {task.proposal.action.kind === 'unsupported' && (
                  <p>{task.proposal.action.reason}</p>
                )}
                {!!task.proposal.changes.length && (
                  <section className="conversation-proposal-changes" aria-label="变更预览">
                    <h4>变更预览</h4>
                    <div className="conversation-differences">
                      {task.proposal.changes.map((change, i) => (
                        <div key={i} className="diff-badge-row">
                          <strong>
                            {change.field.startsWith('操作 ')
                              ? teacherToolLabel(change.field.slice(3))
                              : change.field}
                          </strong>
                          <div className="teacher-change-values">
                            <div>
                              <small>目前</small>
                              <ChangeValue text={change.before} />
                            </div>
                            <div>
                              <small>确认后</small>
                              <ChangeValue text={change.after} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {task.status === 'proposed' && task.proposal.action.kind !== 'unsupported' && (
                  <>
                    <p className="conversation-confirm-note">
                      核对上方内容后，点击按钮即可确认本次操作。
                    </p>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => {
                        setTask({ ...task, status: 'executing' });
                        void run(execute, acceptExecution);
                      }}
                    >
                      {task.proposal.requiresWriteConfirmation
                        ? task.proposal.action.kind === 'tool'
                          ? '确认执行操作'
                          : '确认正式写入'
                        : '执行本地查询或导航'}
                    </button>
                  </>
                )}
              </>
            )}
            {task.execution && (
              <>
                <p>{teacherReceipt(task.execution.message)}</p>
              </>
            )}
            {task.error && (
              <p className="conversation-warning" role="alert">
                {task.error.message}
              </p>
            )}
            <div className="conversation-actions">
              {unsettled(task) && (
                <button
                  disabled={task.status === 'executing'}
                  onClick={() => void run(() => api.cancelConversation(token()), setTask)}
                >
                  <X size={16} />
                  取消当前任务
                </button>
              )}
              <button
                disabled={busy}
                onClick={() => void run(() => api.readConversation(token()), acceptTask)}
              >
                查看任务进展
              </button>
            </div>
          </article>
        )}
      </div>
      {error && !(task?.error && error.includes(task.error.message)) && (
        <div className="conversation-warning" role="alert">
          <CircleAlert size={18} />
          {error}
          <button
            disabled={busy}
            onClick={() => void run(() => api.readModelSettings(), setSettings)}
          >
            刷新模型设置
          </button>
        </div>
      )}
      <form
        className={
          unsettled(task)
            ? 'conversation-composer paused'
            : !messages.length && !task
              ? 'conversation-composer idle'
              : 'conversation-composer'
        }
        onSubmit={(e) => void prepare(e)}
      >
        <label htmlFor="conversation-input">发送消息</label>
        <textarea
          id="conversation-input"
          rows={3}
          maxLength={2000}
          value={text}
          disabled={busy || unsettled(task)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy && !unsettled(task) && text.trim() && settings)
                e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="给助教下达指令，例如：“帮我调座位”、“看期中成绩”、“查值日生” (按回车发送)..."
        />
        <div className="composer-bottom-bar">
          <div className="composer-chips-row">
            <span className="chips-label">常用直达:</span>
            <button
              type="button"
              className="chip-btn"
              disabled={busy || unsettled(task)}
              onClick={() => setText('查看当前班级在籍名册')}
            >
              📋 名册
            </button>
            <button
              type="button"
              className="chip-btn"
              disabled={busy || unsettled(task)}
              onClick={() => setText('查询近期考试情况')}
            >
              📊 考分
            </button>
            <button
              type="button"
              className="chip-btn"
              disabled={busy || unsettled(task)}
              onClick={() => setText('查看当前班级座位编排')}
            >
              🪑 换座
            </button>
            <button
              type="button"
              className="chip-btn"
              disabled={busy || unsettled(task)}
              onClick={() => setText('查看当前班级值日轮换')}
            >
              🧹 值日
            </button>
          </div>
          <div className="composer-action-group">
            <span className="composer-counter-tip">
              Enter 发送 · Shift+Enter 换行 · {text.length}/2000
            </span>
            {!!text.trim() && (
              <button
                type="button"
                className="btn-clear-input"
                disabled={busy || unsettled(task)}
                onClick={() => setText('')}
              >
                清空未提交输入
              </button>
            )}
            <button
              className="primary"
              disabled={busy || unsettled(task) || !text.trim() || !settings}
              type="submit"
            >
              {busy ? <LoaderCircle size={18} /> : <ArrowUp size={18} />}发送
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
