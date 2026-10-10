import { useEffect, useState } from 'react';
import { FileDown, FileUp, Plus, Search, Pencil, UserRound, Archive } from 'lucide-react';
import type { DesktopApi, Snapshot, Student } from '../../../shared/contracts';
import type { StudentProfile } from '../../../shared/pupils';
import type { TeachingRecord } from '../../../shared/teaching-workbench';
import type { ScoreVersionView } from '../../../shared/score-commands';
import { profileContent, profileFieldLabels } from '../../../shared/pupils';
import { RosterImportDialog } from '../../RosterImportDialog';
import { SchoolRosterCells, SchoolRosterHeaders } from '../../SchoolRosterTable';
import { TeachingDialog, TeachingDialogCancel } from './TeachingDialog';
import { type Execute } from './RecordsPanel';
import { kindLabels, recordTitle } from './record-fields';

export function StudentsPanel({
  snapshot,
  classId,
  records,
  exams,
  execute,
  refresh,
  onDirtyChange,
  contacts = false,
}: {
  snapshot: Snapshot;
  classId: string;
  records: TeachingRecord[];
  exams: ScoreVersionView[];
  execute: Execute;
  refresh: () => Promise<void>;
  onDirtyChange: (v: boolean) => void;
  contacts?: boolean;
}) {
  const api: DesktopApi = window.classManager;
  const [profiles, setProfiles] = useState<StudentProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [gender, setGender] = useState('');
  const [group, setGroup] = useState('');
  const [cards, setCards] = useState(false);
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [base, setBase] = useState<{ student?: Student; name: string; number: string }>();
  const [detail, setDetail] = useState<{
    student: Student;
    profile: StudentProfile;
    extra?: TeachingRecord;
    height: number;
    group: number;
    idCard: string;
    note: string;
  }>();
  const [deactivate, setDeactivate] = useState<Student>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const students = snapshot.students.filter((s) => s.classId === classId);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError('');
    void (async () => {
      const result: StudentProfile[] = [];
      const list = snapshot.students.filter((s) => s.classId === classId);
      for (let start = 0; start < list.length; start += 20) {
        const batch = await Promise.all(
          list
            .slice(start, start + 20)
            .map((s) => api.readStudentProfile({ epoch: snapshot.epoch, studentId: s.id })),
        );
        if (!alive) return;
        for (const r of batch) {
          if (!r.ok) throw new Error(r.error.message);
          result.push(r.value);
        }
      }
      if (alive) setProfiles(result);
    })()
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : '资料未能加载。');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [snapshot, classId, api]);
  useEffect(() => {
    onDirtyChange(Boolean(base || detail || importOpen));
    return () => onDirtyChange(false);
  }, [base, detail, importOpen, onDirtyChange]);
  const extraFor = (id: string) =>
    records.find(
      (r) => r.kind === 'studentExtra' && 'studentId' in r.content && r.content.studentId === id,
    );
  const profileFor = (id: string) => profiles.find((p) => p.studentId === id);
  const savedExtra = detail?.extra?.content as
    { height?: number; group?: number; idCard?: string; note?: string } | undefined;
  const detailDirty = Boolean(
    detail &&
    (JSON.stringify(detail.profile.content) !==
      JSON.stringify(profileFor(detail.student.id)?.content) ||
      detail.height !== (savedExtra?.height ?? 0) ||
      detail.group !== (savedExtra?.group ?? 1) ||
      detail.idCard !==
        (profileFor(detail.student.id)?.content.idCard || savedExtra?.idCard || '') ||
      detail.note !== (savedExtra?.note ?? '')),
  );
  const filtered = students.filter(
    (s) =>
      s.active !== archived &&
      `${s.displayName} ${s.studentNumber} ${profileFor(s.id)?.content.guardianName ?? ''} ${profileFor(s.id)?.content.fatherName ?? ''} ${profileFor(s.id)?.content.motherName ?? ''}`.includes(
        search,
      ) &&
      (!gender || profileFor(s.id)?.content.gender === gender) &&
      (!group ||
        (extraFor(s.id)?.content as { group?: number } | undefined)?.group === Number(group)),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 24) - 1));
  function showDetail(s: Student) {
    const profile = profileFor(s.id);
    if (!profile) {
      setLoadError('学生资料尚未加载，请稍候或重新打开此页面。');
      return;
    }
    const extra = extraFor(s.id),
      c = extra?.content as
        { height?: number; group?: number; idCard?: string; note?: string } | undefined;
    setError('');
    setDetail({
      student: s,
      profile: structuredClone(profile),
      extra,
      height: c?.height ?? 0,
      group: c?.group ?? 1,
      idCard: profile.content.idCard || c?.idCard || '',
      note: c?.note ?? '',
    });
  }
  const exportFile = (kind: 'roster' | 'profile', format: 'docx' | 'xlsx', studentId?: string) =>
    void execute(async () => {
      const r = await api.exportTeachingReport({
        epoch: snapshot.epoch,
        classId,
        kind,
        format,
        ...(studentId ? { studentId } : {}),
      });
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    });
  return (
    <>
      <div className="tw-toolbar">
        <label className="tw-search">
          <Search size={16} />
          <input
            aria-label="搜索学生"
            placeholder="姓名、编号或家长姓名"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <select
          aria-label="性别"
          value={gender}
          onChange={(e) => {
            setGender(e.target.value);
            setPage(0);
          }}
        >
          <option value="">全部性别</option>
          <option value="female">女</option>
          <option value="male">男</option>
          <option value="unspecified">未填写</option>
          <option value="other">其他</option>
        </select>
        <select
          aria-label="小组"
          value={group}
          onChange={(e) => {
            setGroup(e.target.value);
            setPage(0);
          }}
        >
          <option value="">全部小组</option>
          {[
            ...new Set(
              records
                .filter((r) => r.kind === 'studentExtra')
                .map((r) => (r.content as { group: number }).group),
            ),
          ]
            .sort((a, b) => a - b)
            .map((g) => (
              <option key={g} value={g}>
                第{g}组
              </option>
            ))}
        </select>
        <button aria-pressed={cards} onClick={() => setCards(!cards)}>
          {cards ? '表格视图' : '卡片视图'}
        </button>
        <button
          aria-pressed={archived}
          onClick={() => {
            setArchived(!archived);
            setPage(0);
          }}
        >
          {archived ? '查看在籍' : '查看停用'}
        </button>
        <button onClick={() => setImportOpen(true)}>
          <FileUp size={16} />
          批量导入
        </button>
        <button
          className="primary"
          onClick={() => {
            setError('');
            setBase({ name: '', number: '' });
          }}
        >
          <Plus size={16} />
          新增学生
        </button>
        <button onClick={() => exportFile('roster', 'xlsx')}>
          <FileDown size={16} />
          导出 Excel
        </button>
        <button onClick={() => exportFile('roster', 'docx')}>导出 Word</button>
      </div>
      {loading && <p role="status">正在读取学生联系资料…</p>}
      {loadError && <p role="alert">{loadError}</p>}
      <div className="tw-card">
        <div className="tw-section-title">
          {contacts ? '家长联系台账' : '学生花名册'} · {filtered.length} 人
        </div>
        {!contacts && !cards && filtered.length > 0 && (
          <p className="tw-hint">
            按学校花名册的18列表头与顺序显示。左右滚动查看全部字段，学号和姓名保持可见；点击姓名可编辑档案。
          </p>
        )}
        {!filtered.length ? (
          <div className="tw-empty">
            {students.length
              ? '没有符合筛选条件的学生。'
              : '先新增学生，或批量导入 XLSX / CSV 名册。'}
            {students.length > 0 && (
              <button
                onClick={() => {
                  setSearch('');
                  setGender('');
                  setGroup('');
                }}
              >
                清空筛选
              </button>
            )}
          </div>
        ) : cards ? (
          <div className="tw-student-cards">
            {filtered.slice(currentPage * 24, (currentPage + 1) * 24).map((s) => (
              <button className="tw-student-card" key={s.id} onClick={() => showDetail(s)}>
                <span className="tw-avatar">{s.displayName.slice(0, 1)}</span>
                <b>{s.displayName}</b>
                <small>{s.studentNumber}</small>
                <span>
                  {profileFor(s.id)?.content.guardianName ||
                    profileFor(s.id)?.content.fatherName ||
                    profileFor(s.id)?.content.motherName ||
                    '家长尚未填写'}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div
            className={`tw-table-scroll ${contacts ? '' : 'school-roster-scroll'}`}
            role="region"
            aria-label={contacts ? '家长联系表格' : '学生花名册表格'}
            tabIndex={0}
          >
            <table className={contacts ? undefined : 'school-roster-table'}>
              <thead>
                <tr>
                  {contacts ? (
                    <>
                      <th>学号</th>
                      <th>姓名</th>
                      <th>性别</th>
                      <th>家长</th>
                      <th>联系方式</th>
                    </>
                  ) : (
                    <SchoolRosterHeaders />
                  )}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(currentPage * 24, (currentPage + 1) * 24).map((s) => {
                  const p = profileFor(s.id);
                  return (
                    <tr key={s.id}>
                      {contacts ? (
                        <>
                          <td>{s.studentNumber}</td>
                          <td>
                            <button className="tw-text-button" onClick={() => showDetail(s)}>
                              {s.displayName}
                            </button>
                          </td>
                          <td>
                            {
                              { male: '男', female: '女', other: '其他', unspecified: '—' }[
                                p?.content.gender ?? 'unspecified'
                              ]
                            }
                          </td>
                          <td>
                            {p?.content.guardianName ||
                              p?.content.fatherName ||
                              p?.content.motherName ||
                              '—'}
                          </td>
                          <td>
                            {p?.content.guardianPhone ||
                              p?.content.fatherPhone ||
                              p?.content.motherPhone ||
                              '—'}
                          </td>
                        </>
                      ) : (
                        <SchoolRosterCells
                          studentNumber={s.studentNumber}
                          displayName={s.displayName}
                          profile={{
                            ...p?.content,
                            idCard:
                              p?.content.idCard ||
                              (extraFor(s.id)?.content as { idCard?: string } | undefined)
                                ?.idCard ||
                              '',
                          }}
                          name={
                            <button className="tw-text-button" onClick={() => showDetail(s)}>
                              {s.displayName}
                            </button>
                          }
                        />
                      )}
                      <td>
                        <div className="tw-actions">
                          <button
                            aria-label={`查看 ${s.displayName}`}
                            onClick={() => showDetail(s)}
                          >
                            <UserRound size={15} />
                            档案
                          </button>
                          <button
                            aria-label={`编辑 ${s.displayName}`}
                            onClick={() => {
                              setError('');
                              setBase({ student: s, name: s.displayName, number: s.studentNumber });
                            }}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            aria-label={`${s.active ? '停用' : '恢复'} ${s.displayName}`}
                            onClick={() => setDeactivate(s)}
                          >
                            <Archive size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="tw-pagination">
          <button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>
            上一页
          </button>
          <span>
            第 {currentPage + 1} / {Math.max(1, Math.ceil(filtered.length / 24))} 页
          </span>
          <button
            disabled={(currentPage + 1) * 24 >= filtered.length}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </button>
        </div>
      </div>
      {importOpen && (
        <RosterImportDialog
          snapshot={snapshot}
          initialClass={classId}
          onDirtyChange={onDirtyChange}
          onClose={() => setImportOpen(false)}
          onSaved={() => {
            setImportOpen(false);
            void refresh();
          }}
        />
      )}
      {base && (
        <TeachingDialog
          title={base.student ? '编辑学生' : '新增学生'}
          onClose={() => setBase(undefined)}
          busy={busy}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^[A-Z0-9_-]{1,32}$/.test(base.number.trim().toUpperCase())) {
                setError('编号可使用1–32位字母、数字、下划线或短横线。');
                return;
              }
              setBusy(true);
              void execute(async () => {
                const r = await api.saveStudent({
                  epoch: snapshot.epoch,
                  classId,
                  studentNumber: base.number,
                  displayName: base.name,
                  ...(base.student
                    ? { id: base.student.id, expectedRevision: base.student.revision }
                    : {}),
                });
                if (!r.ok) {
                  setError(r.error.message);
                  throw new Error(r.error.message);
                }
                setBase(undefined);
                try {
                  await refresh();
                } catch {
                  throw new Error('学生已保存，但列表读取失败。请刷新列表，无需再次保存。');
                }
                return true;
              }, '学生已保存').finally(() => setBusy(false));
            }}
          >
            <div className="tw-form">
              <label>
                姓名
                <input
                  required
                  maxLength={60}
                  value={base.name}
                  onChange={(e) => setBase({ ...base, name: e.target.value })}
                />
              </label>
              <label>
                学生编号
                <input
                  required
                  maxLength={32}
                  value={base.number}
                  onChange={(e) => setBase({ ...base, number: e.target.value })}
                />
              </label>
            </div>
            <p className="tw-hint">
              编号用于匹配成绩，请保持同一学生的编号一致。家长联系方式、身高与分组可在“档案”中填写。
            </p>
            {error && <p role="alert">{error}</p>}
            <footer>
              <TeachingDialogCancel disabled={busy} />
              <button className="primary" disabled={busy}>
                {busy ? '保存中…' : '保存学生'}
              </button>
            </footer>
          </form>
        </TeachingDialog>
      )}
      {detail && (
        <TeachingDialog
          title={`${detail.student.displayName} · 学生档案`}
          onClose={() => setDetail(undefined)}
          busy={busy}
          dirty={detailDirty}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              void execute(async () => {
                const r = await api.saveStudentProfile({
                  epoch: snapshot.epoch,
                  studentId: detail.student.id,
                  expectedRevision: detail.profile.revision,
                  expectedStudentRevision: detail.student.revision,
                  requestId: crypto.randomUUID(),
                  content: { ...detail.profile.content, idCard: detail.idCard },
                  reason: '工作台更新学生资料',
                });
                if (!r.ok) {
                  setError(r.error.message);
                  throw new Error(r.error.message);
                }
                const updated = {
                  ...detail.profile,
                  content: { ...detail.profile.content, idCard: detail.idCard },
                  revision: r.value.revision,
                };
                setProfiles((ps) =>
                  ps.map((p) => (p.studentId === detail.student.id ? updated : p)),
                );
                setDetail((d) => (d ? { ...d, profile: updated } : d));
                const extra = await api.saveTeachingRecord({
                  epoch: snapshot.epoch,
                  classId,
                  kind: 'studentExtra',
                  ...(detail.extra ? { id: detail.extra.id } : {}),
                  expectedRevision: detail.extra?.revision ?? 0,
                  requestId: crypto.randomUUID(),
                  content: {
                    studentId: detail.student.id,
                    height: detail.height,
                    group: detail.group,
                    idCard: detail.idCard,
                    note: detail.note,
                  },
                });
                if (!extra.ok) {
                  setError(`联系资料已保存；身高与分组未保存：${extra.error.message}`);
                  throw new Error(extra.error.message);
                }
                setDetail(undefined);
                try {
                  await refresh();
                } catch {
                  throw new Error('学生资料已保存，但列表读取失败。请刷新列表，无需再次保存。');
                }
                return true;
              }, '学生资料已保存').finally(() => setBusy(false));
            }}
          >
            <p className="tw-hint">
              学生编号：{detail.student.studentNumber} · 学生成绩和班务记录自动关联，无需重复导入。
            </p>
            <div className="tw-form">
              {Object.keys(profileContent.shape)
                .filter((key) => key !== 'idCard')
                .map((key) => {
                  const k = key as keyof StudentProfile['content'];
                  return (
                    <label
                      key={k}
                      className={
                        [
                          'interests',
                          'strengths',
                          'learningNeeds',
                          'teacherNotes',
                          'address',
                        ].includes(k)
                          ? 'wide'
                          : ''
                      }
                    >
                      {profileFieldLabels[k]}
                      {k === 'gender' || k === 'boarding' ? (
                        <select
                          aria-label={profileFieldLabels[k]}
                          value={detail.profile.content[k]}
                          onChange={(e) =>
                            setDetail({
                              ...detail,
                              profile: {
                                ...detail.profile,
                                content: {
                                  ...detail.profile.content,
                                  [k]: e.target.value,
                                },
                              },
                            })
                          }
                        >
                          <option value="unspecified">未填写</option>
                          {k === 'gender' ? (
                            <>
                              <option value="female">女</option>
                              <option value="male">男</option>
                              <option value="other">其他</option>
                            </>
                          ) : (
                            <>
                              <option value="yes">是</option>
                              <option value="no">否</option>
                            </>
                          )}
                        </select>
                      ) : (
                        <input
                          aria-label={profileFieldLabels[k]}
                          type={
                            k === 'birthDate'
                              ? 'date'
                              : k === 'birthMonth'
                                ? 'month'
                                : /Phone$/.test(k)
                                  ? 'tel'
                                  : 'text'
                          }
                          maxLength={
                            /Phone$/.test(k)
                              ? 40
                              : /Name$/.test(k)
                                ? 80
                                : k === 'address'
                                  ? 300
                                  : /IdCard$/.test(k)
                                    ? 40
                                    : /Registration$|Number$/.test(k)
                                      ? 40
                                      : k === 'povertyStatus'
                                        ? 300
                                        : 2000
                          }
                          value={detail.profile.content[k]}
                          onChange={(e) =>
                            setDetail({
                              ...detail,
                              profile: {
                                ...detail.profile,
                                content: { ...detail.profile.content, [k]: e.target.value },
                              },
                            })
                          }
                        />
                      )}
                    </label>
                  );
                })}
              <label>
                身高（厘米）
                <input
                  type="number"
                  min={0}
                  max={250}
                  value={detail.height}
                  onChange={(e) => setDetail({ ...detail, height: Number(e.target.value) })}
                />
              </label>
              <label>
                小组
                <input
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={detail.group}
                  onChange={(e) => setDetail({ ...detail, group: Number(e.target.value) })}
                />
              </label>
              <label>
                身份证号（可选）
                <input
                  maxLength={40}
                  value={detail.idCard}
                  onChange={(e) => setDetail({ ...detail, idCard: e.target.value })}
                />
                {detail.idCard && !/^\d{17}[\dXx]$/.test(detail.idCard) && (
                  <small>格式待核对，按原文保存。</small>
                )}
              </label>
              <label>
                备注
                <input
                  maxLength={2000}
                  value={detail.note}
                  onChange={(e) => setDetail({ ...detail, note: e.target.value })}
                />
              </label>
            </div>
            <h3>历次考试</h3>
            {!exams.length ? (
              <p className="tw-hint">暂无已确认的考试。</p>
            ) : (
              <div className="tw-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>考试</th>
                      <th>日期</th>
                      <th>科目成绩</th>
                      <th>总分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exams
                      .filter((v) =>
                        v.payload.analysis.roster.some((s) => s.studentId === detail.student.id),
                      )
                      .map((v) => (
                        <tr key={v.record.id}>
                          <td>{v.payload.definition.name}</td>
                          <td>{v.payload.definition.date}</td>
                          <td>
                            {v.payload.analysis.entries
                              .filter((s) => s.studentId === detail.student.id)
                              .map(
                                (s) =>
                                  `${v.payload.analysis.subjects.find((p) => p.id === s.subjectId)?.name} ${s.score.status === 'valid' ? s.score.hundredths / 100 : { absent: '缺考', missing: '缺失', not_selected: '未选科' }[s.score.status]}`,
                              )
                              .join(' · ')}
                          </td>
                          <td>
                            {v.statistics.totals.find((s) => s.studentId === detail.student.id)
                              ?.score ?? '未齐全'}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3>日常记录</h3>
            {records
              .filter(
                (r) =>
                  'studentId' in r.content &&
                  r.content.studentId === detail.student.id &&
                  r.kind !== 'studentExtra',
              )
              .map((r) => (
                <div className="tw-mini" key={r.id}>
                  <b>
                    {kindLabels[r.kind]} · {recordTitle(r.content)}
                  </b>
                  <p>
                    {String(
                      (r.content as Record<string, unknown>).content ??
                        (r.content as Record<string, unknown>).detail ??
                        (r.content as Record<string, unknown>).reason ??
                        '',
                    )}{' '}
                    · {r.updatedAt.slice(0, 10)}
                  </p>
                </div>
              ))}
            {error && <p role="alert">{error}</p>}
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (detailDirty) {
                    setError('资料尚未保存，请先保存资料后再导出学生报告。');
                    return;
                  }
                  setError('');
                  exportFile('profile', 'docx', detail.student.id);
                }}
              >
                <FileDown size={16} />
                导出学生报告
              </button>
              <span className="tw-hint">导出已保存的资料</span>
              <TeachingDialogCancel disabled={busy}>关闭</TeachingDialogCancel>
              <button className="primary" disabled={busy || !detail.student.active}>
                {busy ? '保存中…' : '保存资料'}
              </button>
            </footer>
          </form>
        </TeachingDialog>
      )}
      {deactivate && (
        <TeachingDialog
          title={deactivate.active ? '停用学生' : '恢复学生'}
          onClose={() => setDeactivate(undefined)}
          busy={busy}
        >
          <p>
            {deactivate.active
              ? '停用后不会出现在当前点名、作业和编排名单中，历史成绩与记录保留。'
              : '恢复后此学生会重新出现在在籍名单中。'}
          </p>
          <footer>
            <button disabled={busy} onClick={() => setDeactivate(undefined)}>
              取消
            </button>
            <button
              disabled={busy}
              className="primary"
              onClick={() => {
                setBusy(true);
                void execute(async () => {
                  const r = await api.setStudentActive({
                    epoch: snapshot.epoch,
                    id: deactivate.id,
                    expectedRevision: deactivate.revision,
                    active: !deactivate.active,
                  });
                  if (!r.ok) throw new Error(r.error.message);
                  await refresh();
                  setDeactivate(undefined);
                  return true;
                }, '学生状态已更新').finally(() => setBusy(false));
              }}
            >
              确认{deactivate.active ? '停用' : '恢复'}
            </button>
          </footer>
        </TeachingDialog>
      )}
    </>
  );
}
