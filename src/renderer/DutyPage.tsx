import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  Pencil,
  Printer,
  Plus,
  RefreshCw,
  Save,
  Shuffle,
  UsersRound,
  X,
} from 'lucide-react';
import type { DesktopApi, Result, Snapshot } from '../shared/contracts';
import type {
  DutyPlanSummary,
  DutyPreparation,
  DutyVersion,
  DutyVersionView,
} from '../shared/duty-records';
import { DutyConfiguration } from './DutyConfiguration';
import { DutyGroups } from './DutyGroups';
import { DutySchedule } from './DutySchedule';
import './duty.css';

type Change = Parameters<DesktopApi['adjustDuty']>[0]['change'];
type Confirm = Parameters<DesktopApi['confirmDuty']>[0];
type Source = Parameters<DesktopApi['prepareDuty']>[0]['source'];
type History = { plans: DutyPlanSummary[]; history: DutyVersion[]; version?: DutyVersionView };
type Message = { text: string; error: boolean };

export function DutyPage({
  snapshot,
  onDirtyChange,
  navigationBusy,
}: {
  snapshot: Snapshot;
  onDirtyChange: (dirty: boolean) => void;
  navigationBusy: boolean;
}) {
  const api = window.classManager;
  const [classId, setClassId] = useState(snapshot.classes[0]?.id ?? '');
  const [records, setRecords] = useState<History>({ plans: [], history: [] });
  const [draft, setDraft] = useState<DutyPreparation>();
  const [creating, setCreating] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [reason, setReason] = useState('');
  const [command, setCommand] = useState<Confirm>();
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expired, setExpired] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pendingChange, setPendingChange] = useState<Change>();
  const dialog = useRef<HTMLDialogElement>(null);
  const locked = useRef(false);
  const sequence = useRef(0);
  const draftRef = useRef<DutyPreparation | undefined>(undefined);
  const disabled = busy || navigationBusy;
  const editDisabled = disabled || !draft || expired || uncertain || Boolean(command);
  const students = snapshot.students.filter((s) => s.active && s.classId === classId);
  const version = records.version;

  useEffect(() => {
    onDirtyChange(Boolean(draft) || creating || busy);
  }, [draft, creating, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!draft) {
      setExpired(false);
      return;
    }
    setExpired(Date.parse(draft.expiresAt) <= Date.now());
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(draft.expiresAt) - Date.now()) + 10,
    );
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    if (confirming || pendingChange) dialog.current?.showModal();
  }, [confirming, pendingChange]);

  function acceptDraft(value?: DutyPreparation) {
    draftRef.current = value;
    setDraft(value);
    setUncertain(false);
    setCancelFailed(false);
  }

  /** Serialize UI work; late replies after class/epoch changes or unmount cannot replace the view. */
  async function request<T>(
    work: () => Promise<Result<T>>,
    accept: (value: T) => void,
    onFailure?: (transport: boolean, code?: string) => void,
  ) {
    if (locked.current || navigationBusy) return;
    locked.current = true;
    const task = ++sequence.current;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await work();
      if (task !== sequence.current) return;
      if (result.ok) accept(result.value);
      else {
        onFailure?.(false, result.error.code);
        setMessage({
          text: `${result.error.message}（${result.error.code} · ${result.error.operationId}）`,
          error: true,
        });
      }
    } catch {
      if (task === sequence.current) {
        onFailure?.(true);
        setMessage({
          text: '操作响应中断。保存结果可能已生效，请使用原请求重试或关闭草案核对历史。',
          error: true,
        });
      }
    } finally {
      if (task === sequence.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  async function readRecords(targetClass: string, planId?: string): Promise<Result<History>> {
    const plans = await api.listDutyPlans({ epoch: snapshot.epoch, classId: targetClass });
    if (!plans.ok) return plans;
    const plan = plans.value.find((p) => p.planId === planId) ?? plans.value[0];
    if (!plan) return { ok: true, value: { plans: plans.value, history: [] } };
    const history = await api.dutyHistory({
      epoch: snapshot.epoch,
      classId: targetClass,
      planId: plan.planId,
    });
    if (!history.ok) return history;
    const current = await api.readDutyVersion({
      epoch: snapshot.epoch,
      versionId: plan.latestVersionId,
    });
    if (!current.ok) return current;
    return {
      ok: true,
      value: { plans: plans.value, history: history.value, version: current.value },
    };
  }

  useEffect(() => {
    const task = ++sequence.current;
    locked.current = true;
    setBusy(true);
    setLoaded(false);
    setRecords({ plans: [], history: [] });
    setMessage(undefined);
    void (
      classId
        ? readRecords(classId)
        : Promise.resolve({ ok: true as const, value: { plans: [], history: [] } })
    )
      .then((result) => {
        if (task !== sequence.current) return;
        if (result.ok) {
          setRecords(result.value);
          setLoaded(true);
        } else setMessage({ text: result.error.message, error: true });
      })
      .catch(() => {
        if (task === sequence.current)
          setMessage({ text: '值日历史读取失败，请重试。', error: true });
      })
      .finally(() => {
        if (task === sequence.current) {
          locked.current = false;
          setBusy(false);
        }
      });
    return () => {
      sequence.current++;
      const pending = draftRef.current;
      if (pending)
        void api.cancelDuty({ epoch: snapshot.epoch, token: pending.token }).catch(() => {});
    };
    // App prevents roster refresh during local edits; restore remounts the page by epoch.
  }, [classId, snapshot, api]);

  function refresh(planId?: string) {
    setLoaded(false);
    setRecords({ plans: records.plans, history: [] });
    void request(
      () => readRecords(classId, planId),
      (value) => {
        setRecords(value);
        setLoaded(true);
      },
    );
  }
  function prepare(source: Source) {
    setReason('');
    setCommand(undefined);
    void request(
      () =>
        api.prepareDuty({
          epoch: snapshot.epoch,
          classId,
          expectedRevision:
            source.kind === 'new'
              ? 0
              : records.plans.find((p) => p.planId === source.planId)!.revision,
          source,
        }),
      (value) => {
        acceptDraft(value);
        setCreating(false);
        setMessage({ text: '值日草案已生成，尚未保存。', error: false });
      },
    );
  }
  function adjust(change: Change) {
    if (!draft || editDisabled) return;
    setPendingChange(undefined);
    void request(
      () => api.adjustDuty({ epoch: snapshot.epoch, token: draft.token, change }),
      (value) => {
        acceptDraft(value);
        setGrouping(false);
        setMessage({ text: '草案已调整，尚未保存。', error: false });
      },
      (transport) => {
        if (transport) setUncertain(true);
      },
    );
  }
  function propose(change: Change) {
    if (change.kind === 'replace' || change.kind === 'unavailable') adjust(change);
    else setPendingChange(change);
  }
  function closeDraft(localOnly = false) {
    if (!draft) return;
    const planId = draft.planId;
    void request(
      async () => {
        if (!localOnly) {
          const result = await api.cancelDuty({ epoch: snapshot.epoch, token: draft.token });
          if (!result.ok) return result;
        }
        return { ok: true as const, value: undefined };
      },
      () => {
        acceptDraft(undefined);
        setCommand(undefined);
        setGrouping(false);
        setConfirming(false);
        setPendingChange(undefined);
        // Release local editing even when a lost adjustment reply left an unknown backend token.
        // A future prepare revokes that abandoned token; confirmed versions are never removed.
        setLoaded(false);
        setRecords({ plans: [], history: [] });
        const task = sequence.current;
        void readRecords(classId, planId)
          .then((result) => {
            if (sequence.current !== task) return;
            if (result.ok) {
              setRecords(result.value);
              setLoaded(true);
              setMessage({ text: '草案已关闭，已核对确认历史。已保存版本未删除。', error: false });
            } else
              setMessage({
                text: `草案已关闭，但历史读取失败：${result.error.message}`,
                error: true,
              });
          })
          .catch(() => {
            if (sequence.current === task)
              setMessage({ text: '草案已关闭，历史读取中断，请刷新历史。', error: true });
          });
      },
      () => setCancelFailed(true),
    );
  }
  function save() {
    if (!draft || locked.current) return;
    const original = command ?? {
      epoch: snapshot.epoch,
      token: draft.token,
      requestId: crypto.randomUUID(),
      expectedRevision: draft.expectedRevision,
      reason: reason.trim(),
    };
    setCommand(original);
    setConfirming(false);
    void request(
      () => api.confirmDuty(original),
      (receipt) => {
        acceptDraft(undefined);
        setCommand(undefined);
        setGrouping(false);
        setLoaded(false);
        setRecords({ plans: [], history: [] });
        setMessage({ text: `值日计划第 ${receipt.revision} 版已保存。`, error: false });
        const task = sequence.current;
        // A later read failure is not a failed save. Retry may reuse only the original confirmation.
        void readRecords(classId, receipt.planId)
          .then((result) => {
            if (sequence.current !== task) return;
            if (result.ok) {
              setRecords(result.value);
              setLoaded(true);
            } else
              setMessage({ text: `已保存，但历史读取失败：${result.error.message}`, error: true });
          })
          .catch(() => {
            if (sequence.current === task)
              setMessage({ text: '已保存，但历史读取中断，请刷新历史。', error: true });
          });
      },
      (_transport, code) => {
        // These domain rejections happen before any version is written. An ambiguous first
        // attempt must retain its exact request even if a later retry is rejected upstream.
        if (
          !command &&
          code &&
          ['DUTY_CONFLICT', 'VALIDATION', 'CONFLICT', 'STORAGE_LIMIT'].includes(code)
        )
          setCommand(undefined);
      },
    );
  }
  const arrangement = draft?.draft ?? version?.payload.arrangement;
  return (
    <section className="duty-page" aria-label="值日轮换工作区">
      <div className="duty-toolbar">
        <label>
          值日班级
          <select
            aria-label="值日班级"
            value={classId}
            disabled={disabled || Boolean(draft) || creating}
            onChange={(e) => setClassId(e.target.value)}
          >
            {!snapshot.classes.length && <option value="">暂无班级</option>}
            {snapshot.classes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button outlined"
          title="刷新值日历史"
          aria-label="刷新值日历史"
          disabled={disabled || Boolean(draft) || creating || !classId}
          onClick={() => refresh(version?.record.planId)}
        >
          <RefreshCw size={17} />
        </button>
        {!draft && !creating && (
          <button
            disabled={disabled || !classId || !loaded || !students.length}
            onClick={() => setCreating(true)}
          >
            <Plus size={16} />
            新建一期值日
          </button>
        )}
      </div>
      {message && (
        <div
          className={`notice ${message.error ? 'error' : 'success'}`}
          role={message.error ? 'alert' : 'status'}
        >
          {message.error ? <CircleAlert size={17} /> : <Check size={17} />}
          <span>{message.text}</span>
        </div>
      )}
      {busy && <p role="status">正在处理值日数据…</p>}
      {!creating && !draft && (
        <section className="duty-start-panel">
          <h2>本周值日</h2>
          <p>先设置分组、岗位和轮换规则，再预览每周安排。</p>
          <div className="button-row">
            {['设置分组', '添加岗位', '轮换规则'].map((label) => (
              <button
                key={label}
                disabled={disabled || !classId || !loaded || !students.length}
                onClick={() => setCreating(true)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>
      )}
      {creating ? (
        <DutyConfiguration
          students={students}
          disabled={disabled}
          onPrepare={prepare}
          onCancel={() => {
            setCreating(false);
            setMessage(undefined);
          }}
        />
      ) : (
        <>
          {!draft && (
            <div className="duty-toolbar">
              {records.plans.length > 0 && (
                <label>
                  值日计划
                  <select
                    aria-label="已确认值日计划"
                    disabled={disabled}
                    value={version?.record.planId ?? ''}
                    onChange={(e) => refresh(e.target.value)}
                  >
                    {!version && <option value="">选择计划</option>}
                    {records.plans.map((plan) => (
                      <option key={plan.planId} value={plan.planId}>
                        {plan.title} · {plan.firstDate} 至 {plan.lastDate}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {records.history.length > 0 && (
                <label>
                  确认版本
                  <select
                    aria-label="已确认值日版本"
                    disabled={disabled}
                    value={version?.record.id ?? ''}
                    onChange={(e) => {
                      const versionId = e.target.value;
                      setRecords({ ...records, version: undefined });
                      void request(
                        () => api.readDutyVersion({ epoch: snapshot.epoch, versionId }),
                        (value) => setRecords((prior) => ({ ...prior, version: value })),
                      );
                    }}
                  >
                    {!version && <option value="">选择版本</option>}
                    {records.history.map((record) => (
                      <option key={record.id} value={record.id}>
                        第 {record.revision} 版 ·{' '}
                        {new Date(record.createdAt).toLocaleString('zh-CN')} · {record.reason}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {version && (
                <button
                  disabled={disabled || !loaded}
                  onClick={() => prepare({ kind: 'latest', planId: version.record.planId })}
                >
                  <Pencil size={16} />
                  调整本期最新版本
                </button>
              )}
            </div>
          )}
          {version && (
            <button
              disabled={disabled}
              onClick={() =>
                void request(
                  () =>
                    api.previewDutyPrint({ epoch: snapshot.epoch, versionId: version.record.id }),
                  (receipt) =>
                    setMessage({
                      text: `第 ${receipt.revision} 版预览已关闭；已提交打印 ${receipt.submittedJobs} 次，已导出 PDF ${receipt.pdfExports} 份。${receipt.batchCount ? `本表共 ${receipt.pageCount} 页、${receipt.batchCount} 批，请按页码核对各批次是否齐全。` : ''}${receipt.status === 'cancelled' ? '最后一次打印已取消。' : receipt.status === 'export-cancelled' ? '最后一次 PDF 导出已取消。' : receipt.status === 'failed' ? '最后一次操作失败，请核对打印队列与导出文件。' : receipt.status === 'interrupted' ? '关闭时操作未结束，结果不明，请核对打印队列与导出文件。' : ''}${receipt.temporaryCleanupFailed ? '临时打印缓存未完全清理，请重新打开后重试。' : ''}`,
                      error:
                        receipt.status === 'failed' ||
                        receipt.status === 'interrupted' ||
                        receipt.temporaryCleanupFailed,
                    }),
                )
              }
            >
              <Printer size={16} />
              预览与打印所选值日版本
            </button>
          )}
          {draft ? (
            <>
              <div className="duty-summary">
                <strong>未保存值日草案</strong>
                <span>{draft.title}</span>
                <span>第 {draft.expectedRevision + 1} 版</span>
                <span>缺口 {draft.shortages.reduce((sum, item) => sum + item.missing, 0)}</span>
                <span>空组 {draft.emptyGroupIds.length}</span>
              </div>
              {expired && (
                <p className="notice error" role="alert">
                  草案已过期，请关闭草案后重新开始。
                </p>
              )}
              {uncertain && (
                <p className="notice error" role="alert">
                  调整结果未知，已停止编辑。请取消草案；取消失败时关闭本地草案并核对历史。
                </p>
              )}
              {command && (
                <p className="notice error" role="alert">
                  确认结果尚未核实。保留原请求重试，或关闭草案核对历史。
                </p>
              )}
              {draft.shortages.length > 0 && (
                <details className="duty-warning" open>
                  <summary>岗位缺口 · {draft.shortages.length} 项</summary>
                  <ul className="duty-shortages">
                    {draft.shortages.map((item) => (
                      <li key={`${item.date}:${item.postId}`}>
                        {item.date} ·{' '}
                        {draft.draft.posts.find((post) => post.id === item.postId)?.name} · 缺{' '}
                        {item.missing} 人
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {draft.emptyGroupIds.length > 0 && (
                <p role="alert" className="duty-warning">
                  空组：
                  {draft.emptyGroupIds
                    .map((id) => draft.draft.groups.find((g) => g.id === id)?.name)
                    .join('、')}
                </p>
              )}
              <div className="duty-toolbar">
                <button disabled={editDisabled || grouping} onClick={() => setGrouping(true)}>
                  <UsersRound size={16} />
                  调整分组与参与名单
                </button>
                <button
                  disabled={editDisabled || grouping}
                  onClick={() => propose({ kind: 'rotate' })}
                >
                  <Shuffle size={16} />
                  重新轮换未冻结日期
                </button>
              </div>
              {grouping && (
                <DutyGroups
                  arrangement={draft.draft}
                  students={students}
                  disabled={editDisabled}
                  onApply={propose}
                  onCancel={() => setGrouping(false)}
                />
              )}
            </>
          ) : version ? (
            <div className="duty-summary">
              <strong>{version.payload.title}</strong>
              <span>
                {version.stale ? '历史版本' : '最新版本'} · {version.payload.className}
              </span>
              <span>第 {version.record.revision} 版</span>
            </div>
          ) : (
            loaded && (
              <section className="duty-week-panel">
                <h2>每周安排</h2>
                <p>预览确认后，生成本周值日表。</p>
                <div className="duty-week-grid">
                  {['周一', '周二', '周三', '周四', '周五'].map((label) => (
                    <article className="duty-day-card" key={label}>
                      <strong>{label}</strong>
                      <div className="duty-day-empty">尚未安排</div>
                    </article>
                  ))}
                </div>
                <footer className="flow-next">
                  <p>更改安排不会自动覆盖已确认的历史值日记录。</p>
                  <button disabled={disabled || !students.length} onClick={() => setCreating(true)}>
                    新增值日安排
                  </button>
                </footer>
              </section>
            )
          )}
          {arrangement && !grouping && (
            <DutySchedule
              key={draft?.planId ?? version!.record.id}
              arrangement={arrangement}
              protectedDate={draft?.protectedDate ?? version!.record.protectedDate}
              disabled={disabled || Boolean(draft && editDisabled)}
              canComplete={Boolean(draft && draft.expectedRevision > 0 && draft.complete)}
              onChange={draft ? propose : undefined}
            />
          )}
          {draft && (
            <div className="duty-save">
              <label>
                保存原因
                <input
                  aria-label="值日保存原因"
                  value={reason}
                  maxLength={500}
                  disabled={disabled || Boolean(command)}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="duty-toolbar">
                <button disabled={disabled} onClick={() => closeDraft()}>
                  <X size={16} />
                  取消值日草案
                </button>
                {cancelFailed && (
                  <button disabled={disabled} onClick={() => closeDraft(true)}>
                    <RefreshCw size={16} />
                    关闭草案并核对历史
                  </button>
                )}
                {command ? (
                  <button disabled={disabled} className="primary" onClick={save}>
                    <RefreshCw size={16} />
                    使用原请求重试
                  </button>
                ) : (
                  <button
                    disabled={editDisabled || grouping || !draft.complete || !reason.trim()}
                    className="primary"
                    onClick={() => setConfirming(true)}
                  >
                    <Save size={16} />
                    确认保存值日
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {(confirming || pendingChange) && draft && (
        <dialog
          ref={dialog}
          aria-label={confirming ? '确认保存值日计划' : '确认调整值日草案'}
          onCancel={(e) => {
            e.preventDefault();
            setConfirming(false);
            setPendingChange(undefined);
          }}
        >
          <h2>{confirming ? '确认保存值日计划' : '确认调整值日草案'}</h2>
          <p>
            {draft.className} · {draft.title} · {draft.draft.dates.length} 天
          </p>
          {confirming ? (
            <p className="duty-reason">{reason}</p>
          ) : pendingChange?.kind === 'complete' ? (
            <p>{pendingChange.date} 将标为完成，确认保存后不能再更改该日安排。</p>
          ) : (
            <>
              <p>
                此次调整会重建
                {pendingChange?.kind === 'day-group'
                  ? `${pendingChange.date} 当天`
                  : '所有未冻结日期'}
                的岗位，清除相应日期的临时替换。过去和已完成日期保留原记录。
              </p>
              {pendingChange?.kind === 'participants' && (
                <ul>
                  {pendingChange.groups.map((group) => (
                    <li key={group.id}>
                      {group.name} · {group.studentIds.length} 人
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <div className="dialog-actions">
            <button
              onClick={() => {
                setConfirming(false);
                setPendingChange(undefined);
              }}
            >
              返回调整
            </button>
            <button
              className="primary"
              onClick={() => (confirming ? save() : pendingChange && adjust(pendingChange))}
            >
              <Check size={16} />
              {confirming ? '保存确认版本' : '应用调整'}
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
}
