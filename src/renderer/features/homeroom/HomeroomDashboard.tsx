import { useEffect, useState } from 'react';
import {
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  ContactRound,
  Grid2X2,
  GraduationCap,
  TrendingUp,
  UsersRound,
  Upload,
} from 'lucide-react';
import type { Snapshot } from '../../../shared/contracts';
import type { AttendanceRecord } from '../../../shared/pupils';
import type { ExamSummary } from '../../../shared/score-commands';
import { WorkspaceLinks, type AppView } from '../../WorkspaceNavigation';
import { ExternalResource } from '../../ResourceHub';
import { ClassDataImport } from './ClassDataImport';

export function HomeroomDashboard({
  snapshot,
  selectedClass,
  onNavigate,
  onCreateClass,
  onSelectClass,
  onSaved,
  onDirtyChange,
  importRequest = 0,
  onSelectExam,
  onManualEntry,
}: {
  snapshot: Snapshot;
  selectedClass: string;
  onNavigate: (view: AppView) => void;
  onCreateClass: () => void;
  onSelectClass: (id: string) => void;
  onSaved: (snapshot: Snapshot) => void;
  onDirtyChange: (dirty: boolean) => void;
  importRequest?: number;
  onSelectExam: (id: string) => void;
  onManualEntry: () => void;
}) {
  const classId = selectedClass === 'all' ? (snapshot.classes[0]?.id ?? '') : selectedClass;
  const classroom = snapshot.classes.find((c) => c.id === classId);
  const students = snapshot.students.filter((s) => s.active && s.classId === classId);
  const [importOpen, setImportOpen] = useState(false);
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (importRequest) setImportOpen(true);
  }, [importRequest]);
  useEffect(() => {
    let alive = true;
    setExams([]);
    setAttendance([]);
    setNotice('');
    setLoading(false);
    if (!classId) return;
    setLoading(true);
    void Promise.all([
      window.classManager.listExams({ epoch: snapshot.epoch, classId }),
      window.classManager.listAttendance({ epoch: snapshot.epoch, classId }),
    ])
      .then(([list, roll]) => {
        if (!alive) return;
        if (list.ok)
          setExams(
            [...list.value].sort(
              (a, b) =>
                b.definition.date.localeCompare(a.definition.date) ||
                b.updatedAt.localeCompare(a.updatedAt),
            ),
          );
        else setNotice(list.error.message);
        if (roll.ok) setAttendance(roll.value);
        else setNotice(roll.error.message);
      })
      .catch(() => {
        if (alive) setNotice('班级记录暂时没有读到，请刷新数据后重试。');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [snapshot, classId]);
  if (importOpen)
    return (
      <ClassDataImport
        key={classId}
        snapshot={snapshot}
        classId={classId}
        onSelectClass={onSelectClass}
        onCreateClass={onCreateClass}
        onDirtyChange={onDirtyChange}
        onNavigate={onNavigate}
        onSaved={(value) => {
          onSaved(value);
          setImportOpen(false);
        }}
        onClose={() => setImportOpen(false)}
      />
    );
  const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
  const latest = attendance
    .filter((a) => a.date === today)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const attendanceText = loading
    ? '正在读取今日记录…'
    : latest
      ? `到课 ${latest.rows.filter((r) => r.status === 'present').length} 人 · 迟到 ${latest.rows.filter((r) => r.status === 'late').length} 人 · 请假 ${latest.rows.filter((r) => r.status === 'excused').length} 人`
      : '今天还没有保存点名记录';
  const tasks = [
    { view: 'attendance', title: '上课点名', text: attendanceText, icon: ClipboardCheck },
    {
      view: 'scores',
      title: '成绩分析',
      text: loading
        ? '正在读取考试…'
        : exams[0]
          ? `最近：${exams[0].definition.name}`
          : '导入成绩，查看全班统计',
      icon: TrendingUp,
    },
    {
      view: 'roster',
      title: '花名册',
      text: `在籍 ${students.length} 人 · 添加或编辑学生`,
      icon: UsersRound,
    },
    { view: 'seating', title: '座次表', text: '查看、调整和打印班级座位', icon: Grid2X2 },
    {
      view: 'students',
      title: '学生档案',
      text: '基本资料、成绩和点名，一处查看',
      icon: ContactRound,
    },
    {
      view: 'growth',
      title: '成长记录',
      text: '记录表扬与提醒，整理阶段总结',
      icon: GraduationCap,
    },
    { view: 'duty', title: '值日表', text: '安排轮换、调整人员、记录完成', icon: CalendarDays },
    { view: 'lessons', title: '本地备课', text: '读取教材资料，准备教案和课件', icon: BookOpen },
  ] as const;
  return (
    <section className="shared-homeroom teacher-dashboard" aria-label="班主任工作台">
      <header className="shared-heading">
        <div>
          <h1>班主任工作台</h1>
          <p>今天的班级工作，从这里开始。</p>
        </div>
        <button onClick={onCreateClass}>新建班级</button>
      </header>
      <WorkspaceLinks view="classManagement" onNavigate={onNavigate} />
      <section className="teacher-welcome">
        <div>
          <h2>{classroom ? `欢迎使用 · ${classroom.name}` : '欢迎使用班主任工作台'}</h2>
          <p>
            {today} ·{' '}
            {classroom ? `在籍学生 ${students.length} 人` : '先创建一个班级，准备学生名单'}
          </p>
          {students.length > 0 && (
            <small>
              已保存 {students.length} 名学生和 {exams.length} 次考试
            </small>
          )}
        </div>
        <button
          className="primary"
          onClick={() => (classroom ? setImportOpen(true) : onCreateClass())}
        >
          <Upload size={17} />
          {classroom ? '导入资料' : '创建班级'}
        </button>
      </section>
      {!students.length && (
        <div className="teacher-first-use">
          <strong>{classroom ? '接下来，导入学生名单' : '第一次使用，只需准备班级和名单'}</strong>
          <p>成绩可以一起导入，也可以以后添加。保存后，点名、排座和值日都使用同一份名单。</p>
          {classroom && (
            <button className="shared-text-button" onClick={onManualEntry}>
              也可以手动添加学生 →
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="alert" className="shared-warning">
          {notice}
        </p>
      )}
      {['常规工作', '学生跟进与教学'].map((group, index) => (
        <section className="teacher-task-section" key={group}>
          <h2>{group}</h2>
          <div className="teacher-task-grid">
            {tasks.slice(index * 4, index * 4 + 4).map((task) => (
              <button
                className="teacher-task-card"
                key={task.view}
                aria-label={`打开${task.title}`}
                onClick={() => onNavigate(task.view)}
              >
                <span className="teacher-task-icon">
                  <task.icon size={24} />
                </span>
                <strong>{task.title}</strong>
                <span>{task.text}</span>
                <small>查看与处理 ›</small>
              </button>
            ))}
          </div>
        </section>
      ))}
      {exams.length > 0 && (
        <section className="teacher-recent" aria-label="最近考试">
          <h2>最近考试</h2>
          {exams.slice(0, 2).map((exam) => (
            <button key={exam.examId} onClick={() => onSelectExam(exam.versionId)}>
              <strong>{exam.definition.name}</strong>
              <span>
                {exam.definition.date} · {exam.studentCount} 人
              </span>
              <small>查看成绩 ›</small>
            </button>
          ))}
        </section>
      )}
      <details className="shared-card shared-external-services">
        <summary>江西班务平台与数据备份</summary>
        <div className="homeroom-services">
          <ExternalResource
            name="江西省高中生综合素质评价"
            description="综评填报、审核与档案查看"
            url="https://gzzs.jxedu.gov.cn/login"
            kind="heart"
          />
          <ExternalResource
            name="江西省教育考试院"
            description="考试通知、报名与成绩查询"
            url="https://www.jxeea.cn/"
            kind="graduation"
          />
        </div>
        <button onClick={() => onNavigate('maintenance')}>备份或恢复班级资料</button>
      </details>
    </section>
  );
}
