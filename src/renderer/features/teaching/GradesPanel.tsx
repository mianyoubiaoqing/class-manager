import { useEffect, useState } from 'react';
import { Plus, FileDown, FileUp, Pencil, Archive, BarChart3 } from 'lucide-react';
import type { Snapshot } from '../../../shared/contracts';
import type { ScoreVersionView } from '../../../shared/score-commands';
import type { TeachingRecord } from '../../../shared/teaching-workbench';
import { ScorePage } from '../../ScorePage';
import { ScoreResults } from '../../ScoreResults';
import {
  newExam,
  correctionDraft,
  customSubject,
  SUBJECT_CATALOG,
  type ExamDraft,
  scoreText,
} from '../../score-editor';
import { TeachingDialog, TeachingDialogCancel } from './TeachingDialog';
import type { Execute } from './RecordsPanel';
const cellKey = (studentId: string, subjectId: string) => `${studentId}:${subjectId}`;
const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
export function GradesPanel({
  snapshot,
  classId,
  exams,
  records,
  execute,
  refresh,
  onDirtyChange,
  onStudents,
}: {
  snapshot: Snapshot;
  classId: string;
  exams: ScoreVersionView[];
  records: TeachingRecord[];
  execute: Execute;
  refresh: () => Promise<void>;
  onDirtyChange: (v: boolean) => void;
  onStudents: () => void;
}) {
  const api = window.classManager;
  const [tab, setTab] = useState<'manage' | 'analysis' | 'import'>('manage');
  const [selected, setSelected] = useState('');
  const [archived, setArchived] = useState(false);
  const [draft, setDraft] = useState<ExamDraft>();
  const [cells, setCells] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [archive, setArchive] = useState<ScoreVersionView>();
  const [importDirty, setImportDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<typeof tab>();
  const [reloadError, setReloadError] = useState('');
  function changeTab(next: typeof tab) {
    if (next === tab || busy) return;
    if (importDirty || draft) setPendingTab(next);
    else setTab(next);
  }
  const archivedIds = new Set(
    records
      .filter((r) => r.kind === 'examArchive' && 'archived' in r.content && r.content.archived)
      .map((r) => (r.content as { examId: string }).examId),
  );
  const visible = exams.filter((v) => archivedIds.has(v.record.examId) === archived),
    view = visible.find((v) => v.record.id === selected) ?? visible[0];
  useEffect(() => {
    onDirtyChange(Boolean(draft) || importDirty || busy);
    return () => onDirtyChange(false);
  }, [draft, importDirty, busy, onDirtyChange]);
  function edit(v?: ScoreVersionView) {
    const d = v ? correctionDraft(snapshot.epoch, classId, v) : newExam(snapshot, classId);
    d.configuration.scoreBasis = 'raw';
    d.configuration.includeRanks = true;
    if (!v)
      d.configuration.subjects = d.configuration.subjects.map((s) => ({ ...s, precision: 2 }));
    setDraft(d);
    setCells(
      v
        ? Object.fromEntries(
            v.payload.analysis.entries.map((e) => [
              cellKey(e.studentId, e.subjectId),
              scoreText(e.score),
            ]),
          )
        : {},
    );
    setError('');
  }
  function subjectsChange(subjects: ExamDraft['configuration']['subjects']) {
    if (!draft) return;
    const group = draft.configuration.groups[0]!;
    setDraft({
      ...draft,
      configuration: {
        ...draft.configuration,
        subjects,
        groups: [{ ...group, subjectIds: subjects.map((s) => s.id) }],
      },
    });
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    const saved = await execute(async () => {
      const c = draft.configuration;
      for (const s of draft.roster)
        for (const subject of c.subjects) {
          const value = cells[cellKey(s.studentId, subject.id)]?.trim() ?? '';
          if (
            value &&
            !['缺考', '缺失', '未录入', '未选科', '未选考'].includes(value) &&
            (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) > Number(subject.maxScore))
          ) {
            setError(
              `${s.displayName}的${subject.name}须填写 0–${subject.maxScore} 的分数，或“缺考”；空白表示缺失。`,
            );
            throw new Error('成绩存在无效值。');
          }
        }
      const classroom = snapshot.classes.find((s) => s.id === classId)!;
      const csv = [
        ['学生编号', '姓名', '班级', ...c.subjects.map((s) => s.name)],
        ...draft.roster.map((s) => [
          s.studentNumber,
          s.displayName,
          classroom.name,
          ...c.subjects.map((sub) => {
            const value = cells[cellKey(s.studentId, sub.id)]?.trim() ?? '';
            return ({ 缺失: '未录入', 未选科: '未选考' } as Record<string, string>)[value] ?? value;
          }),
        ]),
      ]
        .map((row) => row.map(csvCell).join(','))
        .join('\r\n');
      const r = await api.saveTeachingExam({
        configuration: c,
        csv,
        requestId: crypto.randomUUID(),
        reason: c.expectedRevision ? '工作台核对成绩更正' : '工作台录入考试成绩',
      });
      if (!r.ok) {
        setError(r.error.message);
        throw new Error(r.error.message);
      }
      setDraft(undefined);
      setTab('analysis');
      setReloadError('');
      try {
        await refresh();
      } catch {
        setReloadError('成绩已保存，考试列表读取失败。请重新读取，不要重复提交。');
      }
      return true;
    }, '成绩已确认保存');
    setBusy(false);
    if (saved) {
      setDraft(undefined);
      setTab('analysis');
    }
  }
  return (
    <>
      <div className="tw-tabs">
        <button className={tab === 'manage' ? 'active' : ''} onClick={() => changeTab('manage')}>
          考试管理
        </button>
        <button
          className={tab === 'analysis' ? 'active' : ''}
          onClick={() => changeTab('analysis')}
        >
          多维度分析
        </button>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => changeTab('import')}>
          文件导入
        </button>
      </div>
      {reloadError && (
        <div role="alert">
          <p>{reloadError}</p>
          <button
            onClick={() =>
              void execute(async () => {
                await refresh();
                setReloadError('');
                return true;
              })
            }
          >
            重新读取考试列表
          </button>
        </div>
      )}
      {pendingTab && (
        <TeachingDialog title="离开当前编辑？" onClose={() => setPendingTab(undefined)}>
          <p>未保存的考试导入内容会丢失。</p>
          <footer>
            <button onClick={() => setPendingTab(undefined)}>继续编辑</button>
            <button
              className="danger"
              onClick={() => {
                setDraft(undefined);
                setImportDirty(false);
                setTab(pendingTab);
                setPendingTab(undefined);
              }}
            >
              放弃修改并离开
            </button>
          </footer>
        </TeachingDialog>
      )}
      {tab === 'import' ? (
        <>
          <p className="tw-hint">
            导入 XLSX / CSV 后先预览匹配结果，再确认入库。与本工作台的手工录入使用同一套成绩数据。
          </p>
          <ScorePage
            key={classId}
            snapshot={snapshot}
            selectedClass={classId}
            onDirtyChange={setImportDirty}
            navigationBusy={busy}
            onRoster={onStudents}
          />
          <button onClick={() => void refresh()}>刷新考试列表</button>
        </>
      ) : (
        <>
          <div className="tw-toolbar">
            <button
              className="primary"
              disabled={!snapshot.students.some((s) => s.classId === classId && s.active)}
              onClick={() => edit()}
            >
              <Plus size={16} />
              新增考试与录入
            </button>
            <button onClick={() => changeTab('import')}>
              <FileUp size={16} />
              导入成绩文件
            </button>
            <button
              onClick={() =>
                void execute(async () => {
                  const r = await api.exportTeachingReport({
                    epoch: snapshot.epoch,
                    classId,
                    kind: 'scores',
                    format: 'xlsx',
                  });
                  if (!r.ok) throw new Error(r.error.message);
                  return r.value;
                })
              }
            >
              <FileDown size={16} />
              导出全部成绩
            </button>
            <button aria-pressed={archived} onClick={() => setArchived(!archived)}>
              {archived ? '返回当前考试' : '查看已归档'}
            </button>
          </div>
          {!visible.length ? (
            <div className="tw-card tw-empty">
              {archived ? '暂无已归档考试。' : '还没有考试。先导入学生，再新建考试或导入成绩。'}
            </div>
          ) : tab === 'manage' ? (
            <div className="tw-card tw-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>考试</th>
                    <th>日期</th>
                    <th>人数</th>
                    <th>平均总分</th>
                    <th>最高总分</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((v) => (
                    <tr key={v.record.id}>
                      <td>{v.payload.definition.name}</td>
                      <td>{v.payload.definition.date}</td>
                      <td>{v.payload.analysis.roster.length}</td>
                      <td>{v.statistics.groups.map((g) => g.mean ?? '—').join(' / ')}</td>
                      <td>{v.statistics.groups.map((g) => g.maximum ?? '—').join(' / ')}</td>
                      <td>
                        <div className="tw-actions">
                          <button
                            onClick={() => {
                              setSelected(v.record.id);
                              setTab('analysis');
                            }}
                          >
                            <BarChart3 size={15} />
                            选用
                          </button>
                          {!archived && (
                            <button onClick={() => edit(v)}>
                              <Pencil size={15} />
                              成绩录入
                            </button>
                          )}
                          <button onClick={() => setArchive(v)}>
                            <Archive size={15} />
                            {archived ? '恢复' : '归档'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            view && (
              <>
                <div className="tw-toolbar">
                  <label>
                    当前考试
                    <select value={view.record.id} onChange={(e) => setSelected(e.target.value)}>
                      {visible.map((v) => (
                        <option key={v.record.id} value={v.record.id}>
                          {v.payload.definition.name} · {v.payload.definition.date}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button onClick={() => edit(view)}>编辑成绩</button>
                </div>
                <ScoreResults
                  key={view.record.id}
                  statistics={view.statistics}
                  subjects={view.payload.analysis.subjects}
                  groups={view.payload.analysis.groups}
                  roster={view.payload.analysis.roster}
                  entries={view.payload.analysis.entries}
                />
              </>
            )
          )}
        </>
      )}
      {draft && (
        <TeachingDialog
          title={draft.configuration.examId ? '成绩录入与更正' : '新增考试与录入'}
          onClose={() => setDraft(undefined)}
          busy={busy}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="tw-form">
              {(['name', 'date', 'academicYear', 'term', 'grade'] as const).map((k) => (
                <label key={k}>
                  {
                    {
                      name: '考试名称',
                      date: '考试日期',
                      academicYear: '学年',
                      term: '学期',
                      grade: '年级',
                    }[k]
                  }
                  <input
                    required
                    type={k === 'date' ? 'date' : 'text'}
                    maxLength={k === 'name' ? 100 : 30}
                    value={draft.configuration.definition[k]}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        configuration: {
                          ...draft.configuration,
                          definition: { ...draft.configuration.definition, [k]: e.target.value },
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            {!draft.configuration.examId && (
              <fieldset>
                <legend>选择本次考试科目</legend>
                <div className="tw-checklist">
                  {SUBJECT_CATALOG.map((s) => (
                    <label key={s.id}>
                      <input
                        type="checkbox"
                        checked={draft.configuration.subjects.some((x) => x.id === s.id)}
                        onChange={(e) =>
                          subjectsChange(
                            e.target.checked
                              ? [...draft.configuration.subjects, { ...s, precision: 2 }]
                              : draft.configuration.subjects.filter((x) => x.id !== s.id),
                          )
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
                <div className="tw-toolbar">
                  <input
                    aria-label="自定义科目"
                    maxLength={60}
                    placeholder="自定义科目名称"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void customSubject(custom)
                        .then((s) => {
                          if (draft.configuration.subjects.some((x) => x.id === s.id)) {
                            setError('该科目已选择。');
                            return;
                          }
                          subjectsChange([...draft.configuration.subjects, { ...s, precision: 2 }]);
                          setCustom('');
                        })
                        .catch((e) => setError(e instanceof Error ? e.message : '科目名称无效。'))
                    }
                  >
                    添加科目
                  </button>
                </div>
              </fieldset>
            )}
            <div className="tw-toolbar">
              {draft.configuration.subjects.map((s) => (
                <label key={s.id}>
                  {s.name}满分
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="10000"
                    value={s.maxScore}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        configuration: {
                          ...draft.configuration,
                          subjects: draft.configuration.subjects.map((x) =>
                            x.id === s.id ? { ...x, maxScore: e.target.value } : x,
                          ),
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <p className="tw-hint">
              填写原始分；缺考填“缺考”，未录入留空。点击“确认保存”后才写入数据库，空白不会当作零分。
            </p>
            <div className="tw-table-scroll tw-score-input">
              <table>
                <thead>
                  <tr>
                    <th>编号</th>
                    <th>姓名</th>
                    {draft.configuration.subjects.map((s) => (
                      <th key={s.id}>{s.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draft.roster.map((s) => (
                    <tr key={s.studentId}>
                      <td>{s.studentNumber}</td>
                      <td>{s.displayName}</td>
                      {draft.configuration.subjects.map((sub) => (
                        <td key={sub.id}>
                          <input
                            aria-label={`${s.displayName} ${sub.name}`}
                            maxLength={12}
                            value={cells[cellKey(s.studentId, sub.id)] ?? ''}
                            onChange={(e) =>
                              setCells((v) => ({
                                ...v,
                                [cellKey(s.studentId, sub.id)]: e.target.value,
                              }))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <p role="alert">{error}</p>}
            <footer>
              <TeachingDialogCancel disabled={busy} />
              <button className="primary" disabled={busy || !draft.configuration.subjects.length}>
                {busy ? '保存中…' : '确认保存全部成绩'}
              </button>
            </footer>
          </form>
        </TeachingDialog>
      )}
      {archive && (
        <TeachingDialog
          title={archived ? '恢复考试' : '归档考试'}
          busy={busy}
          onClose={() => setArchive(undefined)}
        >
          <p>
            {archived
              ? '恢复到当前考试列表。'
              : '考试会从本工作台的当前列表隐藏，成绩与修改历史仍保留，可在“已归档”中恢复。'}
          </p>
          <footer>
            <button disabled={busy} onClick={() => setArchive(undefined)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void execute(
                  async () => {
                    const existing = records.find(
                      (r) =>
                        r.kind === 'examArchive' &&
                        'examId' in r.content &&
                        r.content.examId === archive.record.examId,
                    );
                    const r = await api.saveTeachingRecord({
                      epoch: snapshot.epoch,
                      classId,
                      kind: 'examArchive',
                      ...(existing ? { id: existing.id } : {}),
                      expectedRevision: existing?.revision ?? 0,
                      requestId: crypto.randomUUID(),
                      content: { examId: archive.record.examId, archived: !archived },
                    });
                    if (!r.ok) throw new Error(r.error.message);
                    await refresh();
                    setArchive(undefined);
                    return true;
                  },
                  archived ? '考试已恢复' : '考试已归档',
                ).finally(() => setBusy(false));
              }}
            >
              {archived ? '确认恢复' : '确认归档'}
            </button>
          </footer>
        </TeachingDialog>
      )}
    </>
  );
}
