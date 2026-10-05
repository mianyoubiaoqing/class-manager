import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  Grid2X2,
  LockKeyhole,
  Move,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Shuffle,
  UnlockKeyhole,
  X,
} from 'lucide-react';
import type { DesktopApi, Result, Snapshot } from '../shared/contracts';
import type {
  SeatingPreparation,
  SeatingVersion,
  SeatingVersionView,
} from '../shared/seating-records';
import {
  seatKey,
  type SeatingDraft,
  type SeatingLayout,
  type SeatPosition,
} from '../shared/seating';
import { SeatingBoard } from './SeatingBoard';
import './seating.css';

type ConfirmCommand = Parameters<DesktopApi['confirmSeating']>[0];
type Change = Parameters<DesktopApi['adjustSeating']>[0]['change'];
type Message = { text: string; error: boolean };

export function SeatingPage({
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
  const [history, setHistory] = useState<SeatingVersion[]>([]);
  const [version, setVersion] = useState<SeatingVersionView>();
  const [draft, setDraft] = useState<SeatingPreparation>();
  const [layout, setLayout] = useState<SeatingLayout>({ rows: 10, columns: 6, unavailable: [] });
  const [rows, setRows] = useState(10);
  const [columns, setColumns] = useState(6);
  const [mode, setMode] = useState<'move' | 'layout'>('move');
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [reason, setReason] = useState('');
  const [command, setCommand] = useState<ConfirmCommand>();
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expired, setExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const locked = useRef(false);
  const sequence = useRef(0);
  const draftRef = useRef<SeatingPreparation | undefined>(undefined);
  const classRef = useRef(classId);
  classRef.current = classId;

  // Local navigation cannot discard a draft or race a write. Backend tokens remain authoritative.
  useEffect(() => {
    onDirtyChange(Boolean(draft) || busy);
  }, [draft, busy, onDirtyChange]);
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
    if (confirming) dialog.current?.showModal();
  }, [confirming]);

  function acceptDraft(value: SeatingPreparation | undefined) {
    setCancelFailed(false);
    draftRef.current = value;
    setDraft(value);
    if (value) {
      setLayout(value.draft.layout);
      setRows(value.draft.layout.rows);
      setColumns(value.draft.layout.columns);
    }
  }

  async function request<T>(
    work: () => Promise<Result<T>>,
    accept: (value: T) => void,
    onFailure?: () => void,
  ) {
    if (locked.current || navigationBusy) return;
    locked.current = true;
    const task = ++sequence.current;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await work();
      if (sequence.current !== task) return;
      if (result.ok) accept(result.value);
      else {
        onFailure?.();
        setMessage({
          text: `${result.error.message}（${result.error.code} · ${result.error.operationId}）`,
          error: true,
        });
      }
    } catch {
      if (sequence.current === task) {
        onFailure?.();
        setMessage({
          text: '操作响应超时，请刷新后重试。',
          error: true,
        });
      }
    } finally {
      if (sequence.current === task) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  async function loadHistory(targetClass: string) {
    const records = await api.seatingHistory({ epoch: snapshot.epoch, classId: targetClass });
    if (!records.ok) return records;
    const current = records.value[0]
      ? await api.readSeatingVersion({ epoch: snapshot.epoch, versionId: records.value[0].id })
      : undefined;
    if (current && !current.ok) return current;
    return { ok: true as const, value: { history: records.value, version: current?.value } };
  }

  useEffect(() => {
    const task = ++sequence.current;
    locked.current = true;
    setBusy(true);
    setLoaded(false);
    setHistory([]);
    setVersion(undefined);
    setMessage(undefined);
    void (
      classId
        ? loadHistory(classId)
        : Promise.resolve({ ok: true as const, value: { history: [], version: undefined } })
    )
      .then((result) => {
        if (task !== sequence.current) return;
        if (result.ok) {
          setHistory(result.value.history);
          setVersion(result.value.version);
          setLoaded(true);
        } else setMessage({ text: result.error.message, error: true });
      })
      .catch(() => {
        if (task === sequence.current)
          setMessage({ text: '座位历史读取失败，请重试。', error: true });
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
        void api.cancelSeating({ epoch: snapshot.epoch, token: pending.token }).catch(() => {});
    };
    // App blocks snapshot refresh while a draft exists; restore remounts by workspace epoch.
  }, [classId, snapshot, api]);

  const disabled = busy || navigationBusy;
  const editDisabled = disabled || !draft || expired || Boolean(command);
  const currentDraft: SeatingDraft = draft?.draft ??
    version?.payload.arrangement ?? {
      layout,
      members: [],
      assignments: [],
      lockedStudentIds: [],
    };
  const selectedLocked = currentDraft.lockedStudentIds.includes(selectedStudentId);

  function prepare(latest: boolean) {
    setSelectedStudentId('');
    setReason('');
    setCommand(undefined);
    void request(
      () =>
        api.prepareSeating({
          epoch: snapshot.epoch,
          classId,
          expectedRevision: history[0]?.revision ?? 0,
          source: latest ? { kind: 'latest' } : { kind: 'empty', layout },
        }),
      (value) => {
        acceptDraft(value);
        setMode('move');
        setMessage({ text: '座位草案已建立，尚未保存。', error: false });
      },
    );
  }

  function adjust(change: Change) {
    if (!draft || editDisabled) return;
    void request(
      () => api.adjustSeating({ epoch: snapshot.epoch, token: draft.token, change }),
      (value) => {
        acceptDraft(value);
        setMessage({ text: '草案已调整，尚未保存。', error: false });
      },
    );
  }

  function selectSeat(position: SeatPosition) {
    if (editDisabled) return;
    if (mode === 'layout') {
      const unavailable = currentDraft.layout.unavailable;
      const exists = unavailable.some((item) => seatKey(item) === seatKey(position));
      adjust({
        kind: 'layout',
        layout: {
          ...currentDraft.layout,
          unavailable: exists
            ? unavailable.filter((item) => seatKey(item) !== seatKey(position))
            : [...unavailable, position],
        },
      });
    } else if (selectedStudentId) {
      adjust({ kind: 'move', studentId: selectedStudentId, target: position });
    } else {
      setSelectedStudentId(
        currentDraft.assignments.find((item) => seatKey(item) === seatKey(position))?.studentId ??
          '',
      );
    }
  }

  function resize() {
    const next = { rows, columns, unavailable: layout.unavailable };
    if (draft) adjust({ kind: 'layout', layout: next });
    else {
      if (
        !Number.isInteger(rows) ||
        rows < 1 ||
        rows > 20 ||
        !Number.isInteger(columns) ||
        columns < 1 ||
        columns > 20
      ) {
        setMessage({ text: '行数和列数须为 1–20 的整数。', error: true });
        return;
      }
      setLayout(next);
    }
  }

  function cancel() {
    if (!draft) return;
    void request(
      async () => {
        const cancelled = await api.cancelSeating({ epoch: snapshot.epoch, token: draft.token });
        if (!cancelled.ok) return cancelled;
        return loadHistory(classId);
      },
      (value) => {
        acceptDraft(undefined);
        setCommand(undefined);
        setSelectedStudentId('');
        setConfirming(false);
        setHistory(value.history);
        setVersion(value.version);
        setLoaded(true);
        setMessage({ text: '草案已关闭，已核对确认历史。已保存版本未删除。', error: false });
      },
      () => setCancelFailed(true),
    );
  }

  function closeLocalDraft() {
    // A lost adjustment reply can leave a newer private token. Never cancel that unknown token;
    // release only the local view and reread history. A new prepare revokes the abandoned draft.
    acceptDraft(undefined);
    setCommand(undefined);
    setVersion(undefined);
    setLoaded(false);
    setConfirming(false);
    setSelectedStudentId('');
    void request(
      () => loadHistory(classId),
      (value) => {
        setHistory(value.history);
        setVersion(value.version);
        setLoaded(true);
        setMessage({
          text: '本地草案已关闭，已重新核对确认历史。未删除已保存版本。',
          error: false,
        });
      },
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
      async () => {
        const result = await api.confirmSeating(original);
        return result;
      },
      (value) => {
        acceptDraft(undefined);
        setCommand(undefined);
        setSelectedStudentId('');
        setLoaded(false);
        setVersion(undefined);
        setMessage({ text: `座位方案第 ${value.revision} 版已保存。`, error: false });
        // A read failure must not turn an acknowledged commit into an apparent failed save.
        const targetClass = classId;
        const task = sequence.current;
        void loadHistory(targetClass)
          .then((read) => {
            if (sequence.current !== task || classRef.current !== targetClass) return;
            if (read.ok) {
              setHistory(read.value.history);
              setVersion(read.value.version);
              setLoaded(true);
            } else setMessage({ text: `已保存，但读取失败：${read.error.message}`, error: true });
          })
          .catch(() => {
            if (sequence.current === task)
              setMessage({ text: '已保存，但读取中断。请刷新历史。', error: true });
          });
      },
    );
  }

  return (
    <section className="seating-page" aria-label="座位编排工作区">
      <div className="seating-toolbar">
        <label>
          座位班级
          <select
            aria-label="座位班级"
            value={classId}
            disabled={disabled || Boolean(draft)}
            onChange={(event) => setClassId(event.target.value)}
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
          type="button"
          className="icon-button outlined"
          title="刷新座位历史"
          aria-label="刷新座位历史"
          disabled={disabled || Boolean(draft) || !classId}
          onClick={() =>
            void request(
              () => loadHistory(classId),
              (value) => {
                setHistory(value.history);
                setVersion(value.version);
                setLoaded(true);
              },
            )
          }
        >
          <RefreshCw size={17} />
        </button>
        {!draft && (
          <>
            <button disabled={disabled || !classId || !loaded} onClick={() => prepare(false)}>
              <Plus size={16} />
              新建座位草案
            </button>
            <button disabled={disabled || !history.length || !loaded} onClick={() => prepare(true)}>
              <Grid2X2 size={16} />
              从最新版本调整
            </button>
          </>
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
      {busy && <p role="status">正在处理座位数据…</p>}
      {!draft && version && (
        <button
          disabled={disabled}
          onClick={() =>
            void request(
              () =>
                api.previewSeatingPrint({ epoch: snapshot.epoch, versionId: version.record.id }),
              (receipt) =>
                setMessage({
                  text: `第 ${receipt.revision} 版预览已关闭；已提交打印 ${receipt.submittedJobs} 次，已导出 PDF ${receipt.pdfExports} 份。${receipt.status === 'cancelled' ? '最后一次打印已取消。' : receipt.status === 'export-cancelled' ? '最后一次 PDF 导出已取消。' : receipt.status === 'failed' ? '最后一次操作失败，请核对打印队列与导出文件。' : receipt.status === 'interrupted' ? '关闭时操作未结束，结果不明，请核对打印队列与导出文件。' : ''}${receipt.temporaryCleanupFailed ? '临时打印缓存未完全清理，请重新打开后重试。' : ''}`,
                  error:
                    receipt.status === 'failed' ||
                    receipt.status === 'interrupted' ||
                    receipt.temporaryCleanupFailed,
                }),
            )
          }
        >
          <Printer size={16} />
          预览与打印所选版本
        </button>
      )}
      {draft ? (
        <>
          <div className="seating-summary">
            <strong>未保存草案</strong>
            <span>成员 {draft.draft.members.length}</span>
            <span>可用座位 {draft.availableSeatCount}</span>
            <span>未安排 {draft.unassignedStudentIds.length}</span>
          </div>
          {expired && (
            <div className="notice error" role="alert">
              草案已过期，请取消后重新开始。已确认版本不受影响。
            </div>
          )}
          {command && (
            <div className="notice error" role="alert">
              确认结果尚未核实。保留原请求重试，或取消草案后刷新历史核对。
            </div>
          )}
          <div className="seating-toolbar">
            <div className="seating-modes" role="group" aria-label="座位编辑模式">
              <button
                title="调整成员座位"
                aria-pressed={mode === 'move'}
                disabled={editDisabled}
                onClick={() => setMode('move')}
              >
                <Move size={16} />
                调位
              </button>
              <button
                title="标记不可用位置"
                aria-pressed={mode === 'layout'}
                disabled={editDisabled}
                onClick={() => setMode('layout')}
              >
                <Grid2X2 size={16} />
                布局
              </button>
            </div>
            <button disabled={editDisabled} onClick={() => adjust({ kind: 'randomize' })}>
              <Shuffle size={16} />
              随机编排
            </button>
            <label>
              调位学生
              <select
                aria-label="调位学生"
                disabled={editDisabled}
                value={selectedStudentId}
                onChange={(event) => setSelectedStudentId(event.target.value)}
              >
                <option value="">未选择</option>
                {draft.draft.members.map((item) => (
                  <option key={item.studentId} value={item.studentId}>
                    {item.studentNumber} · {item.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="icon-button outlined"
              title={selectedLocked ? '解锁学生座位' : '锁定学生座位'}
              aria-label={selectedLocked ? '解锁学生座位' : '锁定学生座位'}
              disabled={editDisabled || !selectedStudentId}
              onClick={() =>
                adjust({ kind: 'lock', studentId: selectedStudentId, locked: !selectedLocked })
              }
            >
              {selectedLocked ? <UnlockKeyhole size={17} /> : <LockKeyhole size={17} />}
            </button>
          </div>
        </>
      ) : (
        history.length > 0 && (
          <div className="seating-toolbar">
            <label>
              已确认版本
              <select
                aria-label="已确认座位版本"
                disabled={disabled}
                value={version?.record.id ?? ''}
                onChange={(event) => {
                  setVersion(undefined);
                  void request(
                    () =>
                      api.readSeatingVersion({
                        epoch: snapshot.epoch,
                        versionId: event.target.value,
                      }),
                    setVersion,
                  );
                }}
              >
                {!version && <option value="">选择版本</option>}
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    第 {item.revision} 版 · {new Date(item.createdAt).toLocaleString('zh-CN')} ·{' '}
                    {item.reason}
                  </option>
                ))}
              </select>
            </label>
            {version && (
              <span>
                {version.stale ? '历史版本' : '最新版本'} · {version.payload.className}
              </span>
            )}
            {version?.rosterChanged && <span className="seating-warning">当前名册已变化</span>}
          </div>
        )
      )}
      {
        <div className="seating-toolbar">
          {!draft && version && <strong>新草案布局</strong>}
          <label>
            行数
            <input
              aria-label="座位行数"
              type="number"
              min={1}
              max={20}
              value={rows}
              disabled={disabled || Boolean(command) || expired}
              onChange={(event) => setRows(Number(event.target.value))}
            />
          </label>
          <label>
            列数
            <input
              aria-label="座位列数"
              type="number"
              min={1}
              max={20}
              value={columns}
              disabled={disabled || Boolean(command) || expired}
              onChange={(event) => setColumns(Number(event.target.value))}
            />
          </label>
          <button disabled={disabled || Boolean(command) || expired} onClick={resize}>
            <Grid2X2 size={16} />
            应用行列
          </button>
        </div>
      }
      <SeatingBoard
        draft={currentDraft}
        selectedStudentId={selectedStudentId}
        disabled={editDisabled}
        onSeat={selectSeat}
      />
      {draft && (
        <div className="seating-save">
          <label>
            保存原因
            <input
              aria-label="座位保存原因"
              value={reason}
              maxLength={500}
              disabled={disabled || Boolean(command)}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="seating-toolbar">
            <button disabled={disabled} onClick={cancel}>
              <X size={16} />
              取消座位草案
            </button>
            {cancelFailed && (
              <button disabled={disabled} onClick={closeLocalDraft}>
                <RefreshCw size={16} />
                关闭草案并核对历史
              </button>
            )}
            {command ? (
              <button className="primary" disabled={disabled} onClick={save}>
                <RefreshCw size={16} />
                使用原请求重试
              </button>
            ) : (
              <button
                className="primary"
                disabled={editDisabled || !draft.complete || !reason.trim()}
                onClick={() => setConfirming(true)}
              >
                <Save size={16} />
                确认保存座位
              </button>
            )}
          </div>
        </div>
      )}
      {confirming && draft && (
        <dialog
          ref={dialog}
          aria-label="确认保存座位方案"
          onCancel={(event) => {
            event.preventDefault();
            setConfirming(false);
          }}
        >
          <h2>确认保存座位方案</h2>
          <p>
            {draft.className} · {draft.draft.members.length} 名成员 · 第{' '}
            {draft.expectedRevision + 1} 版
          </p>
          <p className="seating-reason">{reason}</p>
          <div className="dialog-actions">
            <button onClick={() => setConfirming(false)}>返回调整</button>
            <button className="primary" onClick={save}>
              <Save size={16} />
              保存确认版本
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
}
