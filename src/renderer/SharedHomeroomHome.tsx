import { useEffect, useState } from 'react';
import { ArrowRight, Calendar, Check, ClipboardList, Search, Upload } from 'lucide-react';
import type { Snapshot } from '../shared/contracts';
import type { ExamSummary, ScoreVersionView } from '../shared/score-commands';
import type { AttendanceRecord } from '../shared/pupils';
import { WorkspaceLinks, type AppView } from './WorkspaceNavigation';
import { ClassDataImport } from './ClassDataImport';
import { ExternalResource } from './ResourceHub';

export function SharedHomeroomHome({
  snapshot,
  selectedClass,
  onNavigate,
  onCreateClass,
  onSelectClass,
  onSaved,
  onDirtyChange,
  importRequest = 0,
  onSelectStudent,
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
  onSelectStudent: (id: string) => void;
  onSelectExam: (id: string) => void;
  onManualEntry: () => void;
}) {
  const classId = selectedClass === 'all' ? (snapshot.classes[0]?.id ?? '') : selectedClass;
  const classroom = snapshot.classes.find((c) => c.id === classId);
  const students = snapshot.students.filter((s) => s.active && s.classId === classId);
  const [importOpen, setImportOpen] = useState(false),
    [search, setSearch] = useState('');
  const [exams, setExams] = useState<ExamSummary[]>([]),
    [examId, setExamId] = useState(''),
    [version, setVersion] = useState<ScoreVersionView>();
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]),
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (importRequest) setImportOpen(true);
  }, [importRequest]);
  useEffect(() => {
    let alive = true;
    setExams([]);
    setAttendance([]);
    setVersion(undefined);
    setExamId('');
    setNotice('');
    if (!classId) return;
    setLoading(true);
    void Promise.all([
      window.classManager.listExams({ epoch: snapshot.epoch, classId }),
      window.classManager.listAttendance({ epoch: snapshot.epoch, classId }),
    ])
      .then(([list, roll]) => {
        if (!alive) return;
        if (list.ok) {
          setExams(list.value);
          setExamId(list.value[0]?.examId ?? '');
        } else setNotice(list.error.message);
        if (roll.ok) setAttendance(roll.value);
        else setNotice(roll.error.message);
      })
      .catch(() => {
        if (alive) setNotice('读取班级记录失败，请刷新数据。');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [snapshot, classId]);
  useEffect(() => {
    let alive = true;
    setVersion(undefined);
    const exam = exams.find((e) => e.examId === examId);
    if (!exam) return;
    void window.classManager
      .readScoreVersion({ epoch: snapshot.epoch, versionId: exam.versionId })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setVersion(r.value);
        else setNotice(r.error.message);
      })
      .catch(() => {
        if (alive) setNotice('成绩读取失败，请重新选择考试。');
      });
    return () => {
      alive = false;
    };
  }, [snapshot.epoch, examId, exams]);
  if (!students.length || importOpen)
    return (
      <ClassDataImport
        key={classId}
        snapshot={snapshot}
        classId={classId}
        onSelectClass={onSelectClass}
        onCreateClass={onCreateClass}
        onSaved={(value) => {
          onSaved(value);
          setImportOpen(false);
        }}
        onDirtyChange={onDirtyChange}
        onNavigate={onNavigate}
        onClose={() => {
          setImportOpen(false);
          if (!students.length) onManualEntry();
        }}
      />
    );
  const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
  const latest = attendance
    .filter((a) => a.date === today)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const filtered = students.filter((s) =>
    `${s.displayName} ${s.studentNumber}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  function total(studentId: string) {
    if (!version) return '—';
    const entries = version.payload.analysis.entries.filter((e) => e.studentId === studentId);
    const valid = entries.filter((e) => e.score.status === 'valid');
    if (!valid.length) return entries.length ? '未录入 / 缺考' : '未录入';
    const sum =
      valid.reduce((n, e) => n + (e.score.status === 'valid' ? e.score.hundredths : 0), 0) / 100;
    const max = version.payload.analysis.subjects.reduce((n, s) => n + Number(s.maxScore), 0);
    const absent = entries.filter((e) => e.score.status === 'absent').length;
    return `${sum} / ${max}${valid.length !== version.payload.analysis.subjects.length ? '（部分成绩）' : ''}${absent ? ` · ${absent} 科缺考` : ''}`;
  }
  return (
    <section className="shared-homeroom" aria-label="班级资料总览">
      <header className="shared-heading">
        <div>
          <h1>{classroom?.name}，资料已准备好</h1>
          <p>从同一份班级资料开始日常工作，学生信息和成绩可以直接选用。</p>
        </div>
        <button className="primary" onClick={() => setImportOpen(true)}>
          <Upload size={17} />
          导入资料
        </button>
      </header>
      <WorkspaceLinks view="classManagement" onNavigate={onNavigate} />
      {notice && (
        <p role="alert" className="shared-warning">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="shared-note">
          正在读取班级资料…
        </p>
      )}
      <div className="shared-notice">
        <Check size={18} />
        <strong>
          已保存 {students.length} 名学生和 {exams.length} 次考试
        </strong>
        <span>点名、排班、成长档案可以直接使用本班资料。</span>
      </div>
      <section className="shared-card shared-stats" aria-label="班级资料统计">
        <div>
          <small>在籍学生</small>
          <strong>
            {students.length}
            <small> 人</small>
          </strong>
          <p>全班共用同一份名单</p>
        </div>
        <div>
          <small>已保存考试</small>
          <strong>
            {exams.length}
            <small> 次</small>
          </strong>
          <p>{exams[0] ? `最近：${exams[0].definition.name}` : '可稍后添加成绩'}</p>
        </div>
        <div>
          <small>今日点名</small>
          <strong>{latest ? '已保存' : '尚未开始'}</strong>
          <p>
            {latest
              ? `${latest.rows.filter((r) => r.status === 'present').length} 人到课`
              : `开始时自动带入 ${students.length} 人`}
          </p>
        </div>
        <div>
          <small>成长记录</small>
          <button className="shared-text-button" onClick={() => onNavigate('growth')}>
            查看本班档案
          </button>
          <p>记录事实，逐步积累</p>
        </div>
      </section>
      <div className="shared-quick-actions">
        {(
          [
            {
              view: 'attendance',
              icon: Check,
              title: '开始上课点名',
              description: `使用本班 ${students.length} 人名单`,
            },
            {
              view: 'scores',
              icon: ClipboardList,
              title: '查看与分析成绩',
              description: '选择已保存的考试',
            },
            {
              view: 'seating',
              icon: Calendar,
              title: '座位与值日安排',
              description: '直接选择本班学生',
            },
          ] as const
        ).map((item) => (
          <button key={item.view} onClick={() => onNavigate(item.view)}>
            <span className="shared-icon">
              <item.icon size={23} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </span>
            <ArrowRight size={18} />
          </button>
        ))}
      </div>
      <div className="shared-overview-columns">
        <section className="shared-card">
          <div className="shared-row">
            <h2>学生与成绩</h2>
            <button
              className="shared-text-button push-right"
              onClick={() => onNavigate('students')}
            >
              查看全班
            </button>
          </div>
          <div className="shared-row">
            <label className="shared-search">
              <Search size={16} />
              <input
                aria-label="总览搜索学生"
                placeholder="搜索姓名 / 学生编号"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label="总览选择考试"
              value={examId}
              onChange={(e) => setExamId(e.target.value)}
            >
              {!exams.length && <option value="">暂无考试</option>}
              {exams.map((e) => (
                <option key={e.examId} value={e.examId}>
                  {e.definition.name}
                </option>
              ))}
            </select>
          </div>
          <div className="shared-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>学生编号</th>
                  <th>最近考试总分</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 3).map((s) => (
                  <tr key={s.id}>
                    <td>{s.displayName}</td>
                    <td>{s.studentNumber}</td>
                    <td>{total(s.id)}</td>
                    <td>
                      <button className="shared-text-button" onClick={() => onSelectStudent(s.id)}>
                        查看学生 ›
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!filtered.length && <p>没有找到学生，请换个姓名或编号搜索。</p>}
          <p className="shared-note">所有页面使用本班学生名单；切换班级时，资料和成绩一同切换。</p>
        </section>
        <section className="shared-card shared-recent">
          <h2>本班最近资料</h2>
          {exams.slice(0, 2).map((exam) => (
            <div className="shared-recent-exam" key={exam.examId}>
              <strong>{exam.definition.name}</strong>
              <button className="shared-text-button" onClick={() => onSelectExam(exam.versionId)}>
                查看成绩
              </button>
              <p>
                {exam.studentCount} 人 · {exam.definition.date} · 已保存
              </p>
            </div>
          ))}
          {!exams.length && <p>还没有考试成绩，可点击右上方“导入资料”继续添加。</p>}
          <hr />
          <strong>继续添加资料</strong>
          <p>
            点击右上方“导入资料”，
            <br />
            新资料会匹配已有学生。
          </p>
          <button className="shared-text-button" onClick={onManualEntry}>
            管理班级名册
          </button>
        </section>
      </div>
      <details className="shared-card shared-external-services">
        <summary>江西班务服务</summary>
        <p>打开官网办理综评与考试事项，平台账号在官网登录。</p>
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
      </details>
    </section>
  );
}
