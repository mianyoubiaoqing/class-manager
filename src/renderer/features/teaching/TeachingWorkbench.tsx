import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu, Plus, Pencil, RefreshCw, Bell, Volume2 } from 'lucide-react';
import type { AppView } from '../../WorkspaceNavigation';
import type { Snapshot, Result } from '../../../shared/contracts';
import type {
  TeachingRecord,
  TeachingKind,
  TeachingSettings,
} from '../../../shared/teaching-workbench';
import type { ScoreVersionView } from '../../../shared/score-commands';
import { DutyPage } from '../../DutyPage';
import { RecordsPanel, type Execute } from './RecordsPanel';
import { StudentsPanel } from './StudentsPanel';
import { GradesPanel } from './GradesPanel';
import { SeatingPanel } from './SeatingPanel';
import { WorkBuddyPanel } from './WorkBuddyPanel';
import { TeachingDialog } from './TeachingDialog';
import { today, recordTitle } from './record-fields';
import './teaching-workbench.css';
const NAV = [
  ['dash', '📊', '仪表盘'],
  ['students', '👥', '学生管理'],
  ['grades', '📈', '成绩分析'],
  ['discipline', '⚠️', '违纪统计'],
  ['homework', '📝', '作业管理'],
  ['leave', '🏖️', '请假管理'],
  ['trace', '🗂️', '工作留痕'],
  ['talk', '💬', '谈话记录'],
  ['seating', '🪑', '排座位'],
  ['comms', '📞', '家校沟通'],
  ['activities', '🎉', '班级活动'],
  ['todos', '✅', '待办备忘'],
] as const;
type Module = (typeof NAV)[number][0];
const GROUPS: Partial<Record<Module, Array<[TeachingKind | 'contacts' | 'duty', string]>>> = {
  comms: [
    ['contacts', '家长台账'],
    ['visit', '家访记录'],
    ['parentMeeting', '家长会'],
    ['notice', '群通知'],
  ],
  activities: [
    ['meeting', '主题班会'],
    ['activity', '活动档案'],
    ['award', '荣誉记录'],
    ['duty', '值日安排'],
  ],
  todos: [
    ['todo', '待办事项'],
    ['reminder', '提醒'],
    ['notes', '班级备忘'],
  ],
};
const take = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
export function TeachingWorkbench({
  snapshot,
  selectedClass,
  onSnapshot,
  onDirtyChange,
  view,
  onNavigate,
  onSelectClass,
  children,
}: {
  snapshot: Snapshot;
  selectedClass: string;
  onSnapshot: (s: Snapshot) => void;
  onDirtyChange: (v: boolean) => void;
  view: AppView;
  onNavigate: (view: AppView) => boolean;
  onSelectClass: (id: string) => void;
  children?: ReactNode;
}) {
  const api = window.classManager;
  const tool = ['resources', 'lessons', 'classroom', 'grading'].includes(view);
  const [classId, setClassId] = useState(
    snapshot.classes.find((c) => c.id === selectedClass)?.id ?? snapshot.classes[0]?.id ?? '',
  );
  const [module, setModule] = useState<Module>('dash');
  const [sub, setSub] = useState<TeachingKind | 'contacts' | 'duty'>('contacts');
  const [records, setRecords] = useState<TeachingRecord[]>([]),
    [exams, setExams] = useState<ScoreVersionView[]>([]),
    [settings, setSettings] = useState<TeachingSettings>({ notifications: true, sound: true });
  const [message, setMessage] = useState(''),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [mobile, setMobile] = useState(false),
    [dirty, setDirty] = useState(false);
  const [classForm, setClassForm] = useState<{ rename: boolean; name: string }>();
  const [pending, setPending] = useState<() => void>();
  const [formError, setFormError] = useState('');
  const [clock, setClock] = useState(new Date());
  const locked = useRef(false),
    scope = useRef({ epoch: snapshot.epoch, classId });
  scope.current = { epoch: snapshot.epoch, classId };
  const execute: Execute = useCallback(async <T,>(work: () => Promise<T>, success?: string) => {
    if (locked.current) return undefined;
    locked.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = await work();
      if (success) {
        setMessage(success);
        setError(false);
      }
      return result;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作未完成，请重试。');
      setError(true);
      return undefined;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    const epoch = snapshot.epoch,
      id = classId;
    if (!id) {
      setLoading(false);
      return;
    }
    const [data, examList, preferences, current] = await Promise.all([
      api.listTeachingRecords({ epoch, classId: id }),
      api.listExams({ epoch, classId: id }),
      api.readTeachingSettings({ epoch }),
      api.snapshot(),
    ]);
    const views: ScoreVersionView[] = [];
    const list = take(examList);
    for (let start = 0; start < list.length; start += 10) {
      const batch = await Promise.all(
        list
          .slice(start, start + 10)
          .map((v) => api.readScoreVersion({ epoch, versionId: v.versionId })),
      );
      batch.forEach((r) => views.push(take(r)));
    }
    if (scope.current.epoch !== epoch || scope.current.classId !== id) return;
    setRecords(take(data));
    setExams(
      views.sort((a, b) => b.payload.definition.date.localeCompare(a.payload.definition.date)),
    );
    setSettings(take(preferences));
    onSnapshot(take(current));
  }, [api, classId, snapshot.epoch, onSnapshot]);
  useEffect(() => {
    setRecords([]);
    setExams([]);
    setLoading(true);
    void refresh()
      .catch((e) => {
        setMessage(e instanceof Error ? e.message : '资料读取失败。');
        setError(true);
      })
      .finally(() => setLoading(false));
  }, [refresh]);
  useEffect(() => {
    const changed = () => {
      void execute(refresh);
    };
    window.addEventListener('cm:bridgeChanged', changed);
    return () => window.removeEventListener('cm:bridgeChanged', changed);
  }, [execute, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const updateDirty = useCallback(
    (v: boolean) => {
      setDirty(v);
      onDirtyChange(v);
    },
    [onDirtyChange],
  );
  const move = (action: () => void) => {
    if (dirty) setPending(() => action);
    else action();
  };
  const go = (id: Module) =>
    move(() => {
      if (tool && !onNavigate('teaching')) return;
      setModule(id);
      setSub(GROUPS[id]?.[0]?.[0] ?? 'contacts');
      setMobile(false);
      setMessage('');
    });
  const classroom = snapshot.classes.find((c) => c.id === classId);
  const props = { snapshot, classId, records, execute, refresh, onDirtyChange: updateDirty };
  const recordKind: TeachingKind | undefined =
    module === 'discipline'
      ? 'discipline'
      : module === 'homework'
        ? 'homework'
        : module === 'leave'
          ? 'leave'
          : module === 'trace'
            ? 'trace'
            : module === 'talk'
              ? 'talk'
              : (module === 'comms' || module === 'activities' || module === 'todos') &&
                  sub !== 'contacts' &&
                  sub !== 'duty'
                ? sub
                : undefined;
  async function preferences(update: Partial<TeachingSettings>) {
    await execute(async () => {
      const r = take(
        await api.saveTeachingSettings({ epoch: snapshot.epoch, ...settings, ...update }),
      );
      setSettings(r);
      return r;
    }, '提醒设置已保存');
  }
  return (
    <section className="teaching-workbench" aria-label="班级教学工作台">
      <aside className={`tw-nav ${mobile ? 'open' : ''}`}>
        <button className="tw-brand" onClick={() => go('dash')}>
          🌿 班级教学工作台
        </button>
        <nav aria-label="班级教学功能">
          {NAV.map(([id, icon, label]) => (
            <button
              key={id}
              aria-label={label}
              aria-current={!tool && module === id ? 'page' : undefined}
              className={!tool && module === id ? 'active' : ''}
              disabled={busy}
              onClick={() => go(id)}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <nav aria-label="教师备课功能">
          <button onClick={() => go('dash')} aria-label="班级教学工作台" disabled={busy}>
            📊 工作台首页
          </button>
          {(
            [
              ['resources', '📚', '资源平台'],
              ['lessons', '📖', '本地备课'],
              ['classroom', '⏱️', '课堂与倒计时'],
              ['grading', '📋', '答卷建议与复核'],
            ] as const
          ).map(([target, icon, label]) => (
            <button
              key={target}
              aria-label={label}
              disabled={busy}
              className={view === target ? 'active' : ''}
              aria-current={view === target ? 'page' : undefined}
              onClick={() => {
                if (onNavigate(target)) setMobile(false);
              }}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <p>
          资料保存在本机
          <br />
          一次导入，各页面共用
        </p>
      </aside>
      <div className="tw-content">
        <header className="tw-topbar">
          <button
            className="tw-hamb"
            aria-label="展开教学功能菜单"
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          <select
            aria-label="教学工作台当前班级"
            value={classId}
            disabled={busy}
            onChange={(e) =>
              move(() => {
                if (tool && !onNavigate('teaching')) return;
                setClassId(e.target.value);
                onSelectClass(e.target.value);
              })
            }
          >
            <option value="">请选择班级</option>
            {snapshot.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            aria-label="编辑班级名称"
            disabled={!classroom || busy}
            onClick={() => {
              setFormError('');
              setClassForm({ rename: true, name: classroom?.name ?? '' });
            }}
          >
            <Pencil size={16} />
          </button>
          <button
            aria-label="新建班级"
            disabled={busy}
            onClick={() => {
              setFormError('');
              setClassForm({ rename: false, name: '' });
            }}
          >
            <Plus size={16} />
          </button>
          <span className="tw-clock">
            {clock.toLocaleString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <button
            aria-label="刷新教学资料"
            disabled={busy || dirty || !classId}
            onClick={() => void execute(refresh)}
          >
            <RefreshCw size={16} />
          </button>
        </header>
        <div className="tw-view">
          {!tool && (
            <div className="tw-page-head">
              <h2>{NAV.find((n) => n[0] === module)?.[2]}</h2>
              <p>
                {classroom?.name ?? '先创建班级'} ·{' '}
                {module === 'dash' ? '数据总览' : '与本机名册和成绩同步'}
              </p>
            </div>
          )}
          {message && (
            <div className={`tw-notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
              {message}
            </div>
          )}
          {busy && <p role="status">操作处理中…</p>}
          {tool ? (
            children
          ) : !classId ? (
            <div className="tw-card tw-empty">
              <h3>从创建一个班级开始</h3>
              <p>新建班级后导入学生名册，成绩、作业、请假和日常记录会自动关联这些学生。</p>
              <button className="primary" onClick={() => setClassForm({ rename: false, name: '' })}>
                创建班级
              </button>
            </div>
          ) : loading ? (
            <div className="tw-card tw-empty">正在读取本机资料…</div>
          ) : (
            <>
              {GROUPS[module] && (
                <div className="tw-tabs">
                  {GROUPS[module]!.map(([id, label]) => (
                    <button
                      key={id}
                      className={sub === id ? 'active' : ''}
                      onClick={() => move(() => setSub(id))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {module === 'dash' && (
                <Dashboard
                  snapshot={snapshot}
                  classId={classId}
                  records={records}
                  exams={exams}
                  onGo={go}
                />
              )}
              {(module === 'students' || (module === 'comms' && sub === 'contacts')) && (
                <StudentsPanel
                  key={`students:${classId}:${module}`}
                  {...props}
                  exams={exams}
                  contacts={module === 'comms'}
                />
              )}
              {module === 'grades' && (
                <GradesPanel
                  key={`grades:${classId}`}
                  {...props}
                  exams={exams}
                  onStudents={() => go('students')}
                />
              )}
              {module === 'seating' && (
                <SeatingPanel
                  key={`seating:${classId}`}
                  snapshot={snapshot}
                  classId={classId}
                  records={records}
                  execute={execute}
                  onDirtyChange={updateDirty}
                />
              )}
              {module === 'activities' && sub === 'duty' && (
                <DutyPage
                  key={classId}
                  snapshot={snapshot}
                  selectedClass={classId}
                  onDirtyChange={updateDirty}
                  navigationBusy={busy}
                />
              )}
              {recordKind && (
                <RecordsPanel
                  key={`${classId}:${recordKind}`}
                  {...props}
                  api={api}
                  kind={recordKind}
                />
              )}
              {module === 'todos' && (
                <div className="tw-toolbar tw-preferences">
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.notifications}
                      disabled={busy}
                      onChange={(e) => void preferences({ notifications: e.target.checked })}
                    />
                    <Bell size={16} />
                    系统通知
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.sound}
                      disabled={busy}
                      onChange={(e) => void preferences({ sound: e.target.checked })}
                    />
                    <Volume2 size={16} />
                    提示音
                  </label>
                </div>
              )}
            </>
          )}
          <WorkBuddyPanel
            snapshot={snapshot}
            onChanged={() =>
              void refresh().catch((e) => {
                setMessage(e instanceof Error ? e.message : '刷新失败。');
                setError(true);
              })
            }
          />
        </div>
      </div>
      {classForm && (
        <TeachingDialog
          title={classForm.rename ? '编辑班级名称' : '新建班级'}
          busy={busy}
          onClose={() => setClassForm(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void execute(async () => {
                const r = classForm.rename
                  ? await api.renameClass({
                      epoch: snapshot.epoch,
                      id: classId,
                      expectedRevision: classroom!.revision,
                      name: classForm.name,
                    })
                  : await api.createClass({ epoch: snapshot.epoch, name: classForm.name });
                if (!r.ok) {
                  setFormError(r.error.message);
                  throw new Error(r.error.message);
                }
                onSnapshot(r.value);
                if (!classForm.rename) {
                  const id =
                    r.value.classes.find((c) => !snapshot.classes.some((old) => old.id === c.id))
                      ?.id ?? classId;
                  setClassId(id);
                  onSelectClass(id);
                }
                setClassForm(undefined);
                return true;
              }, '班级已保存');
            }}
          >
            <label>
              班级名称
              <input
                required
                maxLength={80}
                autoFocus
                value={classForm.name}
                onChange={(e) => setClassForm({ ...classForm, name: e.target.value })}
              />
            </label>
            {!classForm.rename && <p className="tw-hint">将创建空白班级，请随后导入学生。</p>}
            {formError && <p role="alert">{formError}</p>}
            <footer>
              <button type="button" disabled={busy} onClick={() => setClassForm(undefined)}>
                取消
              </button>
              {!classForm.name.trim() && <p role="status">请输入班级名称，不能只填写空格。</p>}
              <button className="primary" disabled={busy || !classForm.name.trim()}>
                保存
              </button>
            </footer>
          </form>
        </TeachingDialog>
      )}
      {pending && (
        <TeachingDialog title="离开当前编辑？" onClose={() => setPending(undefined)}>
          <p>未保存的修改会丢失，已确认保存的数据会保留。</p>
          <footer>
            <button onClick={() => setPending(undefined)}>继续编辑</button>
            <button
              className="danger"
              onClick={() => {
                const action = pending;
                setPending(undefined);
                updateDirty(false);
                action();
              }}
            >
              放弃修改并离开
            </button>
          </footer>
        </TeachingDialog>
      )}
    </section>
  );
}
function Dashboard({
  snapshot,
  classId,
  records,
  exams,
  onGo,
}: {
  snapshot: Snapshot;
  classId: string;
  records: TeachingRecord[];
  exams: ScoreVersionView[];
  onGo: (m: Module) => void;
}) {
  const active = snapshot.students.filter((s) => s.active && s.classId === classId).length;
  const now = Date.now();
  const within = (r: TeachingRecord, days: number) =>
    'date' in r.content &&
    Date.parse(r.content.date) <= now &&
    Date.parse(r.content.date) >= now - days * 86400000;
  const openTasks = records.filter(
    (r) => (r.kind === 'todo' || r.kind === 'reminder') && 'done' in r.content && !r.content.done,
  );
  const cards: [string, number, Module][] = [
    ['班级人数', active, 'students'],
    [
      '近7天违纪',
      records.filter((r) => r.kind === 'discipline' && within(r, 7)).length,
      'discipline',
    ],
    [
      '待交作业（项）',
      records.filter(
        (r) =>
          r.kind === 'homework' &&
          'submissions' in r.content &&
          r.content.submissions.some((s) => !s.done),
      ).length,
      'homework',
    ],
    [
      '待批请假',
      records.filter(
        (r) => r.kind === 'leave' && 'status' in r.content && r.content.status === 'pending',
      ).length,
      'leave',
    ],
    ['近30天谈话', records.filter((r) => r.kind === 'talk' && within(r, 30)).length, 'talk'],
    ['未完成待办', openTasks.filter((r) => r.kind === 'todo').length, 'todos'],
  ];
  const distribution = new Map<string, number>();
  records
    .filter((r) => r.kind === 'discipline' && 'category' in r.content)
    .forEach((r) => {
      const cat = (r.content as { category: string }).category;
      distribution.set(cat, (distribution.get(cat) ?? 0) + 1);
    });
  const archives = new Set(
    records
      .filter((r) => r.kind === 'examArchive' && 'archived' in r.content && r.content.archived)
      .map((r) => (r.content as { examId: string }).examId),
  );
  const trend = exams
    .filter((v) => !archives.has(v.record.examId))
    .slice(0, 4)
    .reverse()
    .map((v) => {
      const values = v.statistics.subjects
        .filter((s) => s.mean !== null)
        .map(
          (s) =>
            (Number(s.mean) /
              Number(v.payload.analysis.subjects.find((sub) => sub.id === s.subjectId)!.maxScore)) *
            100,
        );
      return {
        name: v.payload.definition.name,
        value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
        valid: values.length > 0,
      };
    });
  return (
    <>
      <div className="tw-kpis">
        {cards.map(([label, value, module], i) => (
          <button key={label} className={`tw-kpi color-${i}`} onClick={() => onGo(module)}>
            <b>{value}</b>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="tw-card">
        <div className="tw-section-title">快捷操作</div>
        <div className="tw-quick-grid">
          {(
            [
              ['grades', '📈', '录入成绩'],
              ['discipline', '⚠️', '登记违纪'],
              ['homework', '📝', '布置作业'],
              ['leave', '🏖️', '登记请假'],
              ['talk', '💬', '新增谈话'],
              ['seating', '🪑', '调整座位'],
            ] as const
          ).map(([id, icon, label]) => (
            <button key={id} onClick={() => onGo(id)}>
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="tw-grid-2">
        <div className="tw-card">
          <div className="tw-section-title">违纪类型分布</div>
          {!distribution.size ? (
            <div className="tw-empty">暂无违纪记录</div>
          ) : (
            <div className="tw-bars">
              {[...distribution.entries()].map(([name, count]) => (
                <div key={name}>
                  <span>{name}</span>
                  <div
                    style={{ width: `${(count / Math.max(...distribution.values())) * 100}%` }}
                  />
                  <b>{count}</b>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="tw-card">
          <div className="tw-section-title">待办提醒</div>
          {!openTasks.length ? (
            <div className="tw-empty">暂无待办提醒</div>
          ) : (
            openTasks.slice(0, 5).map((r) => (
              <button className="tw-mini tw-task" key={r.id} onClick={() => onGo('todos')}>
                <b>{recordTitle(r.content)}</b>
                <span>
                  {'dueAt' in r.content ? new Date(r.content.dueAt).toLocaleString('zh-CN') : ''}
                </span>
                {'dueAt' in r.content && Date.parse(r.content.dueAt) < now && (
                  <small className="tw-warning">已逾期</small>
                )}
              </button>
            ))
          )}
        </div>
      </div>
      <div className="tw-card">
        <div className="tw-section-title">近4次考试班级均分趋势</div>
        {!trend.length ? (
          <div className="tw-empty">暂无考试成绩，点击“录入成绩”开始。</div>
        ) : (
          <>
            <div
              className="tw-trend"
              role="img"
              aria-label={trend
                .map((v) => `${v.name} ${v.valid ? v.value.toFixed(1) + '%' : '无有效分数'}`)
                .join('，')}
            >
              {trend.map((v) => (
                <div key={v.name}>
                  <b>{v.valid ? `${v.value.toFixed(1)}%` : '—'}</b>
                  <div style={{ height: `${v.value * 1.4}px` }} />
                  <span>{v.name}</span>
                </div>
              ))}
            </div>
            <p className="tw-hint">
              各科有效分数的平均得分率；缺考与缺失不按零分计算。不同科目组合的考试仅供参考。
            </p>
          </>
        )}
      </div>
      <p className="tw-hint">今日 {today()} · 页面统计来自本机真实记录。</p>
    </>
  );
}
