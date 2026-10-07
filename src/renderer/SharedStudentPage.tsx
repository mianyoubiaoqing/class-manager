import { useEffect, useState } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import type { Snapshot } from '../shared/contracts';
import type { ExamSummary, ScoreVersionView } from '../shared/score-commands';
import type { AttendanceRecord, StudentProfile } from '../shared/pupils';
import type { GrowthTimeline, GrowthSelection } from '../shared/growth';
import { WorkspaceLinks, type AppView } from './WorkspaceNavigation';
import { scoreText } from './score-editor';

function summary(version: ScoreVersionView, studentId: string) {
  const group = version.payload.analysis.groups.find(
    (g) => g.id === version.payload.analysis.roster.find((s) => s.studentId === studentId)?.groupId,
  );
  const subjects = version.payload.analysis.subjects.filter((s) =>
    group?.subjectIds.includes(s.id),
  );
  const entries = version.payload.analysis.entries.filter(
    (e) => e.studentId === studentId && subjects.some((s) => s.id === e.subjectId),
  );
  const sum =
    entries.reduce((n, e) => n + (e.score.status === 'valid' ? e.score.hundredths : 0), 0) / 100;
  return {
    total: sum,
    max: subjects.reduce((n, s) => n + Number(s.maxScore), 0),
    complete:
      entries.length === subjects.length && entries.every((e) => e.score.status === 'valid'),
    subjects,
    entries,
  };
}
export function SharedStudentPage({
  snapshot,
  selectedClass,
  initialStudentId,
  onNavigate,
  onSelectStudent,
  onEditProfile,
  onAddStudent,
  onImport,
  onGrowth,
}: {
  snapshot: Snapshot;
  selectedClass: string;
  initialStudentId: string;
  onNavigate: (view: AppView) => void;
  onSelectStudent: (id: string) => void;
  onEditProfile: (id: string) => void;
  onAddStudent: () => void;
  onImport: () => void;
  onGrowth: (id: string, scores: GrowthSelection['scores']) => void;
}) {
  const classId = selectedClass === 'all' ? (snapshot.classes[0]?.id ?? '') : selectedClass;
  const students = snapshot.students.filter((s) => s.active && s.classId === classId);
  const [studentId, setStudentId] = useState(
      students.find((s) => s.id === initialStudentId)?.id ?? students[0]?.id ?? '',
    ),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0);
  const [tab, setTab] = useState<'profile' | 'scores' | 'attendance' | 'growth'>('scores');
  const [exams, setExams] = useState<ExamSummary[]>([]),
    [versions, setVersions] = useState<ScoreVersionView[]>([]),
    [profile, setProfile] = useState<StudentProfile>(),
    [attendance, setAttendance] = useState<AttendanceRecord[]>([]),
    [growth, setGrowth] = useState<GrowthTimeline>();
  const [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(false);
  const student = students.find((s) => s.id === studentId);
  useEffect(() => {
    setStudentId(students.find((s) => s.id === initialStudentId)?.id ?? students[0]?.id ?? '');
    setPage(0);
  }, [snapshot, selectedClass, initialStudentId]);
  useEffect(() => {
    let alive = true;
    setExams([]);
    setVersions([]);
    setAttendance([]);
    setNotice('');
    if (!classId) return;
    void Promise.all([
      window.classManager.listExams({ epoch: snapshot.epoch, classId }),
      window.classManager.listAttendance({ epoch: snapshot.epoch, classId }),
    ])
      .then(async ([list, roll]) => {
        if (!alive) return;
        if (roll.ok) setAttendance(roll.value);
        else setNotice(roll.error.message);
        if (!list.ok) {
          setNotice(list.error.message);
          return;
        }
        const sorted = [...list.value].sort(
          (a, b) =>
            b.definition.date.localeCompare(a.definition.date) ||
            b.updatedAt.localeCompare(a.updatedAt),
        );
        setExams(sorted);
        const results = await Promise.all(
          sorted.slice(0, 10).map((e) =>
            window.classManager.readScoreVersion({
              epoch: snapshot.epoch,
              versionId: e.versionId,
            }),
          ),
        );
        if (!alive) return;
        setVersions(results.flatMap((r) => (r.ok ? [r.value] : [])));
        const failed = results.find((r) => !r.ok);
        if (failed && !failed.ok) setNotice(failed.error.message);
      })
      .catch(() => {
        if (alive) setNotice('读取学生与考试资料失败，请刷新数据。');
      });
    return () => {
      alive = false;
    };
  }, [snapshot, classId]);
  useEffect(() => {
    let alive = true;
    setProfile(undefined);
    setGrowth(undefined);
    setLoading(true);
    if (!studentId) {
      setLoading(false);
      return;
    }
    void Promise.all([
      window.classManager.readStudentProfile({ epoch: snapshot.epoch, studentId }),
      window.classManager.growthTimeline({ epoch: snapshot.epoch, studentId }),
    ])
      .then(([p, g]) => {
        if (!alive) return;
        if (p.ok) setProfile(p.value);
        else setNotice(p.error.message);
        if (g.ok) setGrowth(g.value);
        else setNotice(g.error.message);
      })
      .catch(() => {
        if (alive) setNotice('读取学生档案失败，请刷新数据。');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [snapshot.epoch, studentId]);
  const filtered = students.filter((s) =>
    `${s.displayName} ${s.studentNumber}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const relevant = versions
    .filter((v) => v.payload.analysis.roster.some((s) => s.studentId === studentId))
    .slice(0, 2);
  const latest = relevant[0] ? summary(relevant[0], studentId) : undefined;
  const previous = relevant[1] ? summary(relevant[1], studentId) : undefined;
  const comparable =
    latest &&
    previous &&
    latest.complete &&
    previous.complete &&
    JSON.stringify(
      latest.subjects.map(({ id, maxScore, precision }) => [id, maxScore, precision]).sort(),
    ) ===
      JSON.stringify(
        previous.subjects.map(({ id, maxScore, precision }) => [id, maxScore, precision]).sort(),
      );
  const selectedScores = relevant
    .flatMap((v) =>
      v.payload.analysis.subjects.map((s) => ({ versionId: v.record.id, subjectId: s.id })),
    )
    .slice(0, 20);
  return (
    <section className="shared-students" aria-label="学生与成绩资料">
      <header className="shared-heading">
        <div>
          <h1>学生与成绩，放在一起看</h1>
          <p>选中一个学生，查看同一份资料里的成绩、点名和成长记录。</p>
        </div>
        <button className="shared-text-button" onClick={() => onNavigate('classManagement')}>
          返回班级总览
        </button>
      </header>
      <WorkspaceLinks view="students" onNavigate={onNavigate} />
      <div className="shared-student-tools">
        <button onClick={onImport}>导入学生信息 / 成绩</button>
        <button className="shared-text-button" onClick={() => onNavigate('roster')}>
          管理班级名册
        </button>
        <button className="shared-text-button" onClick={() => onNavigate('scores')}>
          全部考试与成绩统计（{exams.length} 次）
        </button>
      </div>
      {notice && (
        <p className="shared-warning" role="alert">
          {notice}
        </p>
      )}
      {!students.length ? (
        <section className="shared-card">
          <h2>本班还没有学生资料</h2>
          <p>先导入学生信息或成绩，后续各功能直接使用这份名单。</p>
          <button className="primary" onClick={onImport}>
            开始导入资料
          </button>
        </section>
      ) : (
        <div className="shared-student-columns">
          <aside className="shared-card shared-student-list">
            <h3>本班学生 · {students.length} 人</h3>
            <label className="shared-search">
              <Search size={16} />
              <input
                aria-label="学生与成绩搜索"
                placeholder="搜索姓名 / 编号"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <div className="shared-student-list-items">
              {filtered.slice(page * 10, page * 10 + 10).map((s) => (
                <button
                  key={s.id}
                  className={s.id === studentId ? 'selected' : ''}
                  aria-pressed={s.id === studentId}
                  onClick={() => {
                    setStudentId(s.id);
                    onSelectStudent(s.id);
                  }}
                >
                  <span className="shared-student-avatar">{s.displayName.slice(0, 1)}</span>
                  <span>
                    <strong>{s.displayName}</strong>
                    <small>{s.studentNumber} · 在籍</small>
                  </span>
                </button>
              ))}
            </div>
            {!filtered.length && <p>没有找到学生。</p>}
            <p className="shared-note">
              点击姓名即可查看资料；
              <br />
              无需在各功能重新选学生。
            </p>
            {filtered.length > 10 && (
              <div className="shared-pagination">
                <button disabled={!page} onClick={() => setPage(page - 1)}>
                  上一页
                </button>
                <span>
                  {page + 1}/{Math.ceil(filtered.length / 10)}
                </span>
                <button
                  disabled={(page + 1) * 10 >= filtered.length}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            )}
            <button className="shared-add-student" onClick={onAddStudent}>
              <Plus size={16} />
              添加学生
            </button>
          </aside>
          {student && (
            <div className="shared-student-detail">
              <section className="shared-card shared-student-header">
                <div className="shared-row">
                  <span className="shared-student-avatar large">
                    {student.displayName.slice(0, 1)}
                  </span>
                  <div>
                    <h2>{student.displayName}</h2>
                    <p>
                      {student.className} · 学生编号 {student.studentNumber}
                    </p>
                  </div>
                  <span className="shared-badge">在籍</span>
                  <button className="push-right" onClick={() => onEditProfile(student.id)}>
                    编辑学生信息
                  </button>
                </div>
                <div className="shared-row">
                  <small>
                    {relevant[0]
                      ? `最近成绩：${relevant[0].payload.definition.name}`
                      : '尚未导入成绩'}
                  </small>
                  {latest && (
                    <strong>
                      {latest.total} / {latest.max}
                      {!latest.complete ? '（部分成绩）' : ''}
                    </strong>
                  )}
                  <small className="push-right">来源：本机已保存资料</small>
                </div>
              </section>
              <nav className="shared-student-tabs" aria-label="学生资料分类">
                {(
                  [
                    ['profile', '基本信息'],
                    ['scores', '考试成绩'],
                    ['attendance', '点名记录'],
                    ['growth', '成长档案'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={tab === id ? 'selected' : ''}
                    aria-current={tab === id ? 'page' : undefined}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {loading && <p role="status">正在读取学生档案…</p>}
              {tab === 'scores' && (
                <section className="shared-card">
                  <div className="shared-row">
                    <h3>成绩变化</h3>
                    <small className="push-right">只比较科目与满分一致、成绩完整的考试</small>
                  </div>
                  {relevant.length ? (
                    <>
                      <div className="shared-table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>考试 / 日期</th>
                              {latest?.subjects.map((s) => (
                                <th key={s.id}>
                                  {s.name} / {s.maxScore}
                                </th>
                              ))}
                              <th>总分</th>
                            </tr>
                          </thead>
                          <tbody>
                            {relevant.map((v) => {
                              const result = summary(v, studentId);
                              return (
                                <tr key={v.record.id}>
                                  <td>
                                    {v.payload.definition.name}
                                    <small className="shared-row-source">
                                      {v.payload.definition.date}
                                    </small>
                                  </td>
                                  {latest?.subjects.map((s) => (
                                    <td key={s.id}>
                                      {scoreText(
                                        result.entries.find((e) => e.subjectId === s.id)?.score ??
                                          null,
                                      )}
                                      {result.subjects.find((subject) => subject.id === s.id)
                                        ?.maxScore !== s.maxScore &&
                                      result.subjects.some((subject) => subject.id === s.id)
                                        ? ` / ${result.subjects.find((subject) => subject.id === s.id)!.maxScore} 满分`
                                        : ''}
                                    </td>
                                  ))}
                                  <td>
                                    {result.total} / {result.max}
                                    {!result.complete ? '（部分）' : ''}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="shared-notice">
                        <Check size={18} />
                        {comparable
                          ? `同口径总分较上次${latest!.total - previous!.total >= 0 ? '增加' : '减少'} ${Math.abs(latest!.total - previous!.total)} 分。`
                          : '尚未有两次完整、同口径考试，暂不计算总分变化。'}{' '}
                        缺考与未录入分别显示，不按 0 分处理。
                      </div>
                    </>
                  ) : (
                    <p>还没有该学生的考试成绩，点击“导入学生信息 / 成绩”继续添加。</p>
                  )}
                  <footer className="shared-footer">
                    <p>成长总结可以直接选择已保存的成绩作为依据。</p>
                    <button
                      className="primary"
                      disabled={!selectedScores.length}
                      onClick={() => onGrowth(student.id, selectedScores)}
                    >
                      用这些成绩整理成长总结
                    </button>
                  </footer>
                </section>
              )}
              {tab === 'profile' && (
                <section className="shared-card">
                  <h3>学生基本信息</h3>
                  <dl className="shared-profile-fields">
                    {[
                      ['姓名', student.displayName],
                      ['学生编号', student.studentNumber],
                      ['班级', student.className],
                      ['兴趣与特长', profile?.content.interests || '尚未填写'],
                      ['学习支持', profile?.content.learningNeeds || '尚未填写'],
                      ['教师备注', profile?.content.teacherNotes || '尚未填写'],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <button onClick={() => onEditProfile(student.id)}>编辑教学资料与联系信息</button>
                </section>
              )}
              {tab === 'attendance' && (
                <section className="shared-card">
                  <h3>本班点名记录</h3>
                  {attendance
                    .filter((r) => r.rows.some((s) => s.studentId === student.id))
                    .slice(0, 10)
                    .map((r) => {
                      const mark = r.rows.find((s) => s.studentId === student.id)!;
                      return (
                        <div className="shared-attendance-row" key={r.id}>
                          <strong>
                            {r.date} · {r.title}
                          </strong>
                          <span className="shared-badge">
                            {
                              {
                                present: '到课',
                                late: '迟到',
                                excused: '请假',
                                absent: '缺席',
                                unmarked: '未点名',
                              }[mark.status]
                            }
                          </span>
                          <p>{mark.note || '无备注'}</p>
                        </div>
                      );
                    })}
                  {!attendance.some((r) => r.rows.some((s) => s.studentId === student.id)) && (
                    <p>还没有点名记录，上课时会直接带入本班名单。</p>
                  )}
                  <button onClick={() => onNavigate('attendance')}>打开上课点名</button>
                </section>
              )}
              {tab === 'growth' && (
                <section className="shared-card">
                  <h3>成长档案</h3>
                  {growth?.events.slice(0, 5).map((e) => (
                    <article className="shared-attendance-row" key={e.id}>
                      <strong>{e.content.date}</strong>
                      <p>{e.content.description}</p>
                    </article>
                  ))}
                  {!growth?.events.length && (
                    <p>还没有日常跟进记录，可以从一次课堂表现或沟通开始记录。</p>
                  )}
                  <p className="shared-note">
                    日常记录 {growth?.events.length ?? 0} 条 · 正式总结{' '}
                    {growth?.entries.length ?? 0} 条
                  </p>
                  <button className="primary" onClick={() => onGrowth(student.id, [])}>
                    打开成长档案并记录
                  </button>
                </section>
              )}
              <p className="shared-note">
                可通过右下角智能助手查询成绩；发送前可核对将使用的资料。
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
