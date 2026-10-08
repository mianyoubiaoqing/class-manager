import { useEffect, useRef, useState } from 'react';
import { Shuffle, Save, FileDown, Pencil } from 'lucide-react';
import type { Snapshot, DesktopApi } from '../../../shared/contracts';
import type {
  SeatingPreparation,
  SeatingVersionView,
  SeatingVersion,
} from '../../../shared/seating-records';
import type { TeachingRecord } from '../../../shared/teaching-workbench';
import type { StudentProfile } from '../../../shared/pupils';
import { TeachingDialog } from './TeachingDialog';
import type { Execute } from './RecordsPanel';
export function SeatingPanel({
  snapshot,
  classId,
  records,
  execute,
  onDirtyChange,
}: {
  snapshot: Snapshot;
  classId: string;
  records: TeachingRecord[];
  execute: Execute;
  onDirtyChange: (v: boolean) => void;
}) {
  const api = window.classManager;
  const [history, setHistory] = useState<SeatingVersion[]>([]),
    [version, setVersion] = useState<SeatingVersionView>(),
    [draft, setDraft] = useState<SeatingPreparation>();
  const [rows, setRows] = useState(8),
    [columns, setColumns] = useState(6),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<{ row: number; column: number }>(),
    [studentId, setStudentId] = useState('');
  const current = useRef<SeatingPreparation | undefined>(undefined);
  current.current = draft;
  useEffect(() => {
    let alive = true;
    void (async () => {
      const h = await api.seatingHistory({ epoch: snapshot.epoch, classId });
      if (!h.ok) throw new Error(h.error.message);
      if (alive) setHistory(h.value);
      if (h.value[0]) {
        const v = await api.readSeatingVersion({ epoch: snapshot.epoch, versionId: h.value[0].id });
        if (!v.ok) throw new Error(v.error.message);
        if (alive) {
          setVersion(v.value);
          setRows(v.value.payload.arrangement.layout.rows);
          setColumns(v.value.payload.arrangement.layout.columns);
        }
      }
    })().catch(
      (e) =>
        void execute(async () => {
          throw e;
        }),
    );
    return () => {
      alive = false;
      const d = current.current;
      if (d) void api.cancelSeating({ epoch: snapshot.epoch, token: d.token });
    };
  }, [snapshot.epoch, classId, api, execute]);
  useEffect(() => {
    onDirtyChange(Boolean(draft));
    return () => onDirtyChange(false);
  }, [draft, onDirtyChange]);
  const arrangement = draft?.draft ?? version?.payload.arrangement;
  async function run<T>(work: () => Promise<T>) {
    setBusy(true);
    const r = await execute(work);
    setBusy(false);
    return r;
  }
  async function prepare(empty = false) {
    const r = await run(async () => {
      const p = await api.prepareSeating({
        epoch: snapshot.epoch,
        classId,
        expectedRevision: history[0]?.revision ?? 0,
        source:
          version && !empty
            ? { kind: 'latest' }
            : { kind: 'empty', layout: { rows, columns, unavailable: [] } },
      });
      if (!p.ok) throw new Error(p.error.message);
      return p.value;
    });
    if (r) setDraft(r);
  }
  async function adjust(change: Parameters<DesktopApi['adjustSeating']>[0]['change']) {
    if (!draft) return;
    const r = await run(async () => {
      const a = await api.adjustSeating({ epoch: snapshot.epoch, token: draft.token, change });
      if (!a.ok) throw new Error(a.error.message);
      return a.value;
    });
    if (r) setDraft(r);
  }
  async function ordered(kind: 'height' | 'gender') {
    if (!draft) return;
    const ids = draft.draft.members.map((s) => s.studentId);
    const order = await run(async () => {
      if (kind === 'height') {
        const heights = new Map(
          records
            .filter(
              (r) => r.kind === 'studentExtra' && 'studentId' in r.content && 'height' in r.content,
            )
            .map((r) => {
              const c = r.content as { studentId: string; height: number };
              return [c.studentId, c.height];
            }),
        );
        if (ids.some((id) => !heights.get(id)))
          throw new Error('请先在学生档案中填写所有学生的身高，再按身高编排。');
        return [...ids].sort((a, b) => heights.get(a)! - heights.get(b)!);
      }
      const profiles: StudentProfile[] = [];
      for (let start = 0; start < ids.length; start += 20) {
        const r = await Promise.all(
          ids
            .slice(start, start + 20)
            .map((studentId) => api.readStudentProfile({ epoch: snapshot.epoch, studentId })),
        );
        for (const p of r) {
          if (!p.ok) throw new Error(p.error.message);
          profiles.push(p.value);
        }
      }
      if (profiles.some((p) => !['male', 'female'].includes(p.content.gender)))
        throw new Error('请先填写所有学生的性别，再使用男女交替编排。也可选择随机编排。');
      const male = profiles.filter((p) => p.content.gender === 'male').map((p) => p.studentId),
        female = profiles.filter((p) => p.content.gender === 'female').map((p) => p.studentId),
        result: string[] = [];
      for (let i = 0; i < Math.max(male.length, female.length); i++) {
        if (male[i]) result.push(male[i]!);
        if (female[i]) result.push(female[i]!);
      }
      return result;
    });
    if (order) await adjust({ kind: 'order', studentIds: order });
  }
  return (
    <>
      <div className="tw-toolbar">
        {history.length > 0 && (
          <label>
            座位表历史
            <select
              aria-label="座位表历史"
              value={version?.record.id ?? ''}
              disabled={busy || Boolean(draft)}
              onChange={(e) => {
                const versionId = e.target.value;
                void run(async () => {
                  const r = await api.readSeatingVersion({ epoch: snapshot.epoch, versionId });
                  if (!r.ok) throw new Error(r.error.message);
                  setVersion(r.value);
                  return true;
                });
              }}
            >
              {history.map((v) => (
                <option key={v.id} value={v.id}>
                  第 {v.revision} 版 · {new Date(v.createdAt).toLocaleString('zh-CN')}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          行数
          <input
            type="number"
            min={1}
            max={20}
            value={rows}
            onChange={(e) => setRows(Number(e.target.value))}
          />
        </label>
        <label>
          列数
          <input
            type="number"
            min={1}
            max={20}
            value={columns}
            onChange={(e) => setColumns(Number(e.target.value))}
          />
        </label>
        {!draft ? (
          <button className="primary" disabled={busy} onClick={() => void prepare()}>
            <Pencil size={16} />
            {version ? '调整座位' : '开始编排'}
          </button>
        ) : (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void adjust({
                  kind: 'layout',
                  layout: { rows, columns, unavailable: draft.draft.layout.unavailable },
                })
              }
            >
              应用行列
            </button>
            <button disabled={busy} onClick={() => void adjust({ kind: 'randomize' })}>
              <Shuffle size={16} />
              随机编排
            </button>
            <button disabled={busy} onClick={() => void ordered('height')}>
              按身高编排
            </button>
            <button disabled={busy} onClick={() => void ordered('gender')}>
              男女交替
            </button>
            <button
              className="primary"
              disabled={busy || !draft.complete}
              onClick={() =>
                void run(async () => {
                  const r = await api.confirmSeating({
                    epoch: snapshot.epoch,
                    token: draft.token,
                    expectedRevision: draft.expectedRevision,
                    requestId: crypto.randomUUID(),
                    reason: '工作台确认座位编排',
                  });
                  if (!r.ok) throw new Error(r.error.message);
                  setDraft(undefined);
                  const h = await api.seatingHistory({ epoch: snapshot.epoch, classId });
                  const v = await api.readSeatingVersion({
                    epoch: snapshot.epoch,
                    versionId: r.value.versionId,
                  });
                  if (!h.ok || !v.ok) throw new Error('座位已保存，请刷新查看。');
                  setHistory(h.value);
                  setVersion(v.value);
                  setDraft(undefined);
                  return true;
                })
              }
            >
              <Save size={16} />
              确认保存
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.cancelSeating({ epoch: snapshot.epoch, token: draft.token });
                  if (!r.ok) throw new Error(r.error.message);
                  setDraft(undefined);
                  return true;
                })
              }
            >
              放弃调整
            </button>
          </>
        )}
        {version && !draft && (
          <button
            onClick={() =>
              void run(async () => {
                const r = await api.exportTeachingSeatingImage({
                  epoch: snapshot.epoch,
                  versionId: version.record.id,
                });
                if (!r.ok) throw new Error(r.error.message);
                return r.value;
              })
            }
          >
            <FileDown size={16} />
            导出座位图片
          </button>
        )}
        <input
          aria-label="查找座位"
          placeholder="查找学生姓名或编号"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <p className="tw-hint">
        {version &&
          !draft &&
          version.record.id !== history[0]?.id &&
          '正在预览历史版本；“调整座位”会从最新版本开始，历史记录不会被覆盖。'}
        {draft
          ? '拖动可交换座位，双击可指派学生或清空座位。所有学生安排完成后点击“确认保存”。'
          : '点击“调整座位”进入编排；未保存的调整不会改变已确认座位表。'}
      </p>
      {!arrangement ? (
        <div className="tw-card tw-empty">还没有座位表。先导入学生，再点击“开始编排”。</div>
      ) : (
        <div className="tw-card tw-seating-scroll">
          <div className="tw-stage">讲台 · 第 1 排在最前方</div>
          <div
            className="tw-seat-board"
            style={{
              gridTemplateColumns: `repeat(${arrangement.layout.columns},minmax(90px,1fr))`,
            }}
          >
            {Array.from(
              { length: arrangement.layout.rows * arrangement.layout.columns },
              (_, i) => {
                const row = Math.floor(i / arrangement.layout.columns) + 1,
                  column = (i % arrangement.layout.columns) + 1;
                const assignment = arrangement.assignments.find(
                    (a) => a.row === row && a.column === column,
                  ),
                  member = arrangement.members.find((s) => s.studentId === assignment?.studentId);
                const blocked = arrangement.layout.unavailable.some(
                  (p) => p.row === row && p.column === column,
                );
                const match =
                  search &&
                  member &&
                  `${member.displayName} ${member.studentNumber}`.includes(search);
                return (
                  <button
                    key={`${row}:${column}`}
                    className={`tw-seat ${blocked ? 'blocked' : ''} ${match ? 'found' : ''}`}
                    disabled={blocked || busy}
                    draggable={Boolean(draft && member)}
                    onDragStart={(e) => {
                      if (member) e.dataTransfer.setData('text/plain', member.studentId);
                    }}
                    onDragOver={(e) => {
                      if (draft) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/plain');
                      if (draft && arrangement.members.some((s) => s.studentId === id))
                        void adjust({ kind: 'move', studentId: id, target: { row, column } });
                    }}
                    onDoubleClick={() => {
                      if (!draft) return;
                      setPick({ row, column });
                      setStudentId(member?.studentId ?? '');
                    }}
                    onClick={() => {
                      if (!draft) return;
                      setPick({ row, column });
                      setStudentId(member?.studentId ?? '');
                    }}
                    aria-label={`${row}排${column}列 ${member?.displayName ?? (blocked ? '不可用' : '空位')}`}
                  >
                    <small>
                      {row}排 {column}列
                    </small>
                    <b>{member?.displayName ?? (blocked ? '不可用' : '空位')}</b>
                    <span>{member?.studentNumber ?? '—'}</span>
                  </button>
                );
              },
            )}
          </div>
          {draft && !draft.complete && (
            <p className="tw-warning">
              尚有 {draft.unassignedStudentIds.length} 名学生未安排：
              {draft.unassignedStudentIds
                .map((id) => arrangement.members.find((m) => m.studentId === id)?.displayName)
                .join('、')}
            </p>
          )}
        </div>
      )}
      {pick && draft && (
        <TeachingDialog
          title={`${pick.row}排 ${pick.column}列`}
          onClose={() => setPick(undefined)}
          busy={busy}
        >
          <label>
            安排学生
            <select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">清空此座位</option>
              {draft.draft.members.map((s) => (
                <option key={s.studentId} value={s.studentId}>
                  {s.displayName}（{s.studentNumber}）
                </option>
              ))}
            </select>
          </label>
          <footer>
            <button disabled={busy} onClick={() => setPick(undefined)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                const occupant = draft.draft.assignments.find(
                  (a) => a.row === pick.row && a.column === pick.column,
                );
                if (!studentId && !occupant) {
                  setPick(undefined);
                  return;
                }
                void adjust(
                  studentId
                    ? { kind: 'move', studentId, target: pick }
                    : { kind: 'unassign', studentId: occupant!.studentId },
                ).then(() => setPick(undefined));
              }}
            >
              应用
            </button>
          </footer>
        </TeachingDialog>
      )}
    </>
  );
}
