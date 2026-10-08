import { useEffect, useState } from 'react';
import { Plus, Search, FileDown, Pencil, Trash2, ImagePlus } from 'lucide-react';
import type { DesktopApi, Snapshot } from '../../../shared/contracts';
import {
  teachingContentSchemas,
  type TeachingKind,
  type TeachingRecord,
} from '../../../shared/teaching-workbench';
import { TeachingDialog } from './TeachingDialog';
import { kindLabels, recordFields, today, localDateTime, recordTitle } from './record-fields';
export type Execute = <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>;
export function RecordsPanel({
  kind,
  records,
  snapshot,
  classId,
  api,
  execute,
  refresh,
  onDirtyChange,
}: {
  kind: TeachingKind;
  records: TeachingRecord[];
  snapshot: Snapshot;
  classId: string;
  api: DesktopApi;
  execute: Execute;
  refresh: () => Promise<void>;
  onDirtyChange: (v: boolean) => void;
}) {
  const [editing, setEditing] = useState<TeachingRecord | 'new'>();
  const [deleting, setDeleting] = useState<TeachingRecord>();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingDone, setPendingDone] = useState<Record<string, boolean>>({});
  const students = snapshot.students.filter((s) => s.classId === classId && s.active);
  useEffect(() => {
    onDirtyChange(Boolean(editing));
    return () => onDirtyChange(false);
  }, [editing, onDirtyChange]);
  const name = (id: string) =>
    snapshot.students.find((s) => s.id === id)?.displayName ?? '已归档学生';
  const selected = records.filter((r) => r.kind === kind);
  const statusLabels: Record<string, string> = {
    pending: '待审批',
    approved: '已批准',
    rejected: '未批准',
    closed: '已销假',
    high: '高',
    medium: '中',
    low: '低',
  };
  const filtered = selected.filter((r) => {
    const c = r.content as Record<string, unknown>;
    const date = String(c.date ?? c.due ?? c.start ?? c.dueAt ?? r.updatedAt).slice(0, 10);
    return (
      (!search ||
        `${recordTitle(c)} ${Object.values(c)
          .filter((v) => typeof v === 'string')
          .join(' ')} ${typeof c.studentId === 'string' ? name(c.studentId) : ''}`.includes(
          search,
        )) &&
      (!category || c.category === category || c.status === category || c.priority === category) &&
      (!from || date >= from) &&
      (!until || date <= until)
    );
  });
  function open(record?: TeachingRecord) {
    const initial: Record<string, unknown> = {};
    for (const f of recordFields[kind])
      initial[f.key] =
        f.type === 'date'
          ? today()
          : f.type === 'datetime'
            ? new Date(Date.now() + 3600000).toISOString()
            : f.type === 'boolean'
              ? false
              : f.type === 'number'
                ? (f.min ?? 0)
                : f.type === 'student'
                  ? (students[0]?.id ?? '')
                  : f.type === 'select'
                    ? (f.options?.[0]?.[0] ?? '')
                    : '';
    if (kind === 'homework')
      initial.submissions = students.map((s) => ({ studentId: s.id, done: false }));
    if (kind === 'activity') initial.photoIds = [];
    setForm(record ? { ...record.content } : initial);
    setError('');
    setPhotos({});
    setEditing(record ?? 'new');
    if (record && 'photoIds' in record.content)
      for (const id of record.content.photoIds)
        void api.readTeachingPhoto({ epoch: snapshot.epoch, id }).then((r) => {
          if (r.ok) setPhotos((p) => ({ ...p, [id]: r.value }));
        });
  }
  async function persist(content: unknown, record?: TeachingRecord): Promise<boolean> {
    const parsed = teachingContentSchemas[kind].safeParse(content);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map(
            (i) =>
              `${recordFields[kind].find((f) => f.key === String(i.path[0]))?.label ?? '内容'}：${i.message}`,
          )
          .join('；'),
      );
      return false;
    }
    setBusy(true);
    const result = await execute(async () => {
      const saved = await api.saveTeachingRecord({
        epoch: snapshot.epoch,
        classId,
        kind,
        ...(record ? { id: record.id } : {}),
        expectedRevision: record?.revision ?? 0,
        requestId: crypto.randomUUID(),
        content: parsed.data,
      });
      if (!saved.ok) {
        setError(saved.error.message);
        throw new Error(saved.error.message);
      }
      await refresh();
      return saved.value;
    }, '已保存到本地');
    setBusy(false);
    return Boolean(result);
  }
  return (
    <>
      <div className="tw-toolbar">
        <label className="tw-search">
          <Search size={16} />
          <input
            aria-label="搜索记录"
            placeholder="搜索学生、标题或内容"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="类型或状态"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">全部类型 / 状态</option>
          {[
            ...new Set(
              selected
                .map((r) => {
                  const c = r.content as Record<string, unknown>;
                  return String(c.category ?? c.status ?? c.priority ?? '');
                })
                .filter(Boolean),
            ),
          ].map((v) => (
            <option key={v} value={v}>
              {statusLabels[v] ?? v}
            </option>
          ))}
        </select>
        <input
          aria-label="开始日期"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span>至</span>
        <input
          aria-label="结束日期"
          type="date"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
        />
        <button className="primary" onClick={() => open()}>
          <Plus size={16} />
          新增{kindLabels[kind]}
        </button>
        {['leave', 'trace', 'talk'].includes(kind) && (
          <button
            onClick={() =>
              void execute(async () => {
                const r = await api.exportTeachingReport({
                  epoch: snapshot.epoch,
                  classId,
                  kind: kind as 'leave' | 'trace' | 'talk',
                  format: 'docx',
                });
                if (!r.ok) throw new Error(r.error.message);
                return r.value;
              })
            }
          >
            <FileDown size={16} />
            导出 Word
          </button>
        )}
      </div>
      {kind === 'notice' && (
        <p className="tw-hint">
          通知保存在本机，尚未接入实际群发送渠道。WorkBuddy 可读取草稿；接入接口说明见桥接设置。
        </p>
      )}
      {(kind === 'todo' || kind === 'reminder') && (
        <p className="tw-hint">
          到点会弹出系统通知并播放提示音。程序退出后不提醒；再次打开时可在这里查看逾期事项。
        </p>
      )}
      <div className="tw-card">
        <div className="tw-section-title">
          {kindLabels[kind]} · {filtered.length} 条
        </div>
        {!filtered.length ? (
          <div className="tw-empty">
            {selected.length
              ? '没有符合筛选条件的记录。'
              : `还没有${kindLabels[kind]}，点击右上角“新增”开始。`}
          </div>
        ) : (
          <div className="tw-record-list">
            {filtered.map((r) => {
              const c = r.content as Record<string, unknown>;
              const text = String(
                c.detail ??
                  c.content ??
                  c.reason ??
                  c.record ??
                  c.description ??
                  c.result ??
                  c.summary ??
                  '',
              );
              const submissions =
                kind === 'homework' && 'submissions' in r.content
                  ? r.content.submissions
                  : undefined;
              return (
                <article key={r.id} className="tw-record">
                  <div>
                    {(kind === 'todo' || kind === 'reminder') && (
                      <input
                        type="checkbox"
                        aria-label={`完成 ${recordTitle(c)}`}
                        checked={pendingDone[r.id] ?? Boolean(c.done)}
                        disabled={busy}
                        onChange={(e) => {
                          const done = e.target.checked;
                          setPendingDone((v) => ({ ...v, [r.id]: done }));
                          void persist({ ...c, done }, r).finally(() =>
                            setPendingDone((v) => {
                              const next = { ...v };
                              delete next[r.id];
                              return next;
                            }),
                          );
                        }}
                      />
                    )}
                    <h3>{recordTitle(c)}</h3>
                    <div className="tw-meta">
                      {typeof c.studentId === 'string' && <b>{name(c.studentId)}</b>}
                      <span>
                        {c.dueAt
                          ? new Date(String(c.dueAt)).toLocaleString('zh-CN')
                          : String(c.date ?? c.due ?? c.start ?? '')}
                      </span>
                      {Boolean(c.status) && (
                        <span className="tw-badge">{statusLabels[String(c.status)]}</span>
                      )}
                      {Boolean(c.priority) && (
                        <span className="tw-badge">{statusLabels[String(c.priority)]}优先级</span>
                      )}
                      {Boolean(c.dueAt) && !c.done && Date.parse(String(c.dueAt)) < Date.now() && (
                        <span className="tw-warning">已逾期</span>
                      )}
                      {submissions && (
                        <span className="tw-badge">
                          已交 {submissions.filter((s) => s.done).length} / {submissions.length}
                        </span>
                      )}
                    </div>
                    <p>{text}</p>
                    {Boolean(c.followUp) && <p>后续跟进：{String(c.followUp)}</p>}
                    {Boolean(c.end) && (
                      <p>
                        请假时间：{String(c.start)} 至 {String(c.end)}
                      </p>
                    )}
                    {kind === 'activity' && 'photoIds' in r.content && (
                      <p>{r.content.photoIds.length} 张活动照片 · 编辑可查看</p>
                    )}
                  </div>
                  <div className="tw-actions">
                    <button aria-label={`编辑 ${recordTitle(c)}`} onClick={() => open(r)}>
                      <Pencil size={15} />
                      编辑{kind === 'homework' ? ' / 收交' : ''}
                    </button>
                    {kind === 'leave' && (
                      <button
                        onClick={() =>
                          void execute(async () => {
                            const result = await api.exportTeachingReport({
                              epoch: snapshot.epoch,
                              classId,
                              kind: 'leave',
                              format: 'docx',
                              recordId: r.id,
                            });
                            if (!result.ok) throw new Error(result.error.message);
                            return result.value;
                          })
                        }
                      >
                        请假凭证
                      </button>
                    )}
                    <button aria-label={`删除 ${recordTitle(c)}`} onClick={() => setDeleting(r)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      {editing && (
        <TeachingDialog
          title={`${editing === 'new' ? '新增' : '编辑'}${kindLabels[kind]}`}
          busy={busy}
          onClose={() => setEditing(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void persist(form, editing === 'new' ? undefined : editing).then((saved) => {
                if (saved) setEditing(undefined);
              });
            }}
          >
            <div className="tw-form">
              {recordFields[kind].map((f) => (
                <label key={f.key} className={f.type === 'long' ? 'wide' : ''}>
                  {f.label}
                  {f.optional && <small>（可选）</small>}
                  {f.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(form[f.key])}
                      onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.checked }))}
                    />
                  ) : f.type === 'student' || f.type === 'select' ? (
                    <select
                      required
                      disabled={busy}
                      value={String(form[f.key] ?? '')}
                      onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                    >
                      {f.type === 'student' ? (
                        <>
                          <option value="">请选择学生</option>
                          {students.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.displayName}（{s.studentNumber}）
                            </option>
                          ))}
                        </>
                      ) : (
                        f.options?.map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))
                      )}
                    </select>
                  ) : f.type === 'long' ? (
                    <textarea
                      required={!f.optional}
                      disabled={busy}
                      rows={4}
                      maxLength={f.max ?? 2000}
                      value={String(form[f.key] ?? '')}
                      onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  ) : (
                    <input
                      required={!f.optional}
                      disabled={busy}
                      type={f.type === 'datetime' ? 'datetime-local' : (f.type ?? 'text')}
                      min={f.type === 'number' ? f.min : undefined}
                      max={f.type === 'number' ? f.max : undefined}
                      maxLength={f.type === 'number' ? undefined : (f.max ?? 120)}
                      value={
                        f.type === 'datetime'
                          ? localDateTime(String(form[f.key]))
                          : String(form[f.key] ?? '')
                      }
                      onChange={(e) =>
                        setForm((v) => ({
                          ...v,
                          [f.key]:
                            f.type === 'number'
                              ? Number(e.target.value)
                              : f.type === 'datetime' && e.target.value
                                ? new Date(e.target.value).toISOString()
                                : e.target.value,
                        }))
                      }
                    />
                  )}
                </label>
              ))}
            </div>
            {kind === 'homework' && (
              <fieldset>
                <legend>作业提交情况</legend>
                <button
                  type="button"
                  onClick={() =>
                    setForm((v) => ({
                      ...v,
                      submissions: students.map((s) => ({ studentId: s.id, done: true })),
                    }))
                  }
                >
                  全部标记已交
                </button>
                <div className="tw-checklist">
                  {students.map((s) => {
                    const entries = form.submissions as Array<{ studentId: string; done: boolean }>;
                    return (
                      <label key={s.id}>
                        <input
                          type="checkbox"
                          checked={entries.some((x) => x.studentId === s.id && x.done)}
                          onChange={(e) =>
                            setForm((v) => ({
                              ...v,
                              submissions: students.map((p) => ({
                                studentId: p.id,
                                done:
                                  p.id === s.id
                                    ? e.target.checked
                                    : entries.some((x) => x.studentId === p.id && x.done),
                              })),
                            }))
                          }
                        />
                        {s.displayName}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            {kind === 'activity' && (
              <fieldset>
                <legend>活动照片</legend>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      const r = await api.selectTeachingPhotos({ epoch: snapshot.epoch, classId });
                      if (!r.ok) throw new Error(r.error.message);
                      if ((form.photoIds as string[]).length + r.value.length > 30)
                        throw new Error('每项活动最多30张照片。');
                      setForm((v) => ({
                        ...v,
                        photoIds: [...(v.photoIds as string[]), ...r.value.map((p) => p.id)],
                      }));
                      setPhotos((p) => ({
                        ...p,
                        ...Object.fromEntries(r.value.map((p) => [p.id, p.dataUrl])),
                      }));
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : '照片读取失败，请重试。');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <ImagePlus size={16} />
                  添加照片
                </button>
                <div className="tw-photos">
                  {(form.photoIds as string[]).map((id) => (
                    <div key={id}>
                      {photos[id] && <img src={photos[id]} alt="活动照片" />}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setForm((v) => ({
                            ...v,
                            photoIds: (v.photoIds as string[]).filter((p) => p !== id),
                          }))
                        }
                      >
                        移除此照片
                      </button>
                    </div>
                  ))}
                </div>
              </fieldset>
            )}
            {error && <p role="alert">{error}</p>}
            <footer>
              <button type="button" disabled={busy} onClick={() => setEditing(undefined)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
            </footer>
          </form>
        </TeachingDialog>
      )}
      {deleting && (
        <TeachingDialog title="删除记录" onClose={() => setDeleting(undefined)} busy={busy}>
          <p>删除“{recordTitle(deleting.content)}”？记录会从日常列表隐藏，备份中仍保留历史。</p>
          <footer>
            <button disabled={busy} onClick={() => setDeleting(undefined)}>
              取消
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void execute(async () => {
                  const r = await api.deleteTeachingRecord({
                    epoch: snapshot.epoch,
                    id: deleting.id,
                    expectedRevision: deleting.revision,
                    requestId: crypto.randomUUID(),
                    deleted: true,
                  });
                  if (!r.ok) throw new Error(r.error.message);
                  await refresh();
                  setDeleting(undefined);
                  return true;
                }, '已删除').finally(() => setBusy(false));
              }}
            >
              确认删除
            </button>
          </footer>
        </TeachingDialog>
      )}
    </>
  );
}
