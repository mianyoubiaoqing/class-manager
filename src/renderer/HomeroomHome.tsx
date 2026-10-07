import { CalendarDays, Plus, UsersRound } from 'lucide-react';
import type { Snapshot } from '../shared/contracts';
import type { AppView } from './WorkspaceNavigation';
import { ExternalResource } from './ResourceHub';

export function HomeroomHome({
  snapshot,
  selectedClass,
  onNavigate,
  onAddStudent,
  onImportStudents,
}: {
  snapshot: Snapshot;
  selectedClass: string;
  onNavigate: (view: AppView) => void;
  onAddStudent: () => void;
  onImportStudents: () => void;
}) {
  const students = snapshot.students.filter(
    (student) => student.active && (selectedClass === 'all' || student.classId === selectedClass),
  );
  return (
    <div className="homeroom-home" aria-label="班主任管理入口">
      <div className="homeroom-stats">
        {['班级学生', '今天出勤', '待确认安排', '成长记录'].map((label, index) => (
          <section className="design-panel" key={label}>
            <h2>{label}</h2>
            <strong className="stat-value">
              {index === 0 && snapshot.classes.length ? students.length : '—'}
            </strong>
            {index > 0 && (
              <span className="stat-caption">
                {index === 1
                  ? '在点名页面查看'
                  : index === 2
                    ? '在座位与值日页面查看'
                    : '在成长档案查看'}
              </span>
            )}
          </section>
        ))}
      </div>
      <div className="homeroom-next">
        <section className="design-panel">
          <h2>下一步做什么</h2>
          <p>
            {snapshot.classes.length
              ? students.length
                ? '班级资料已就绪，开始处理今天的教学事务。'
                : '班级已创建，下一步导入学生名单，再开始点名与考试。'
              : '还没有班级资料，从名册开始。'}
          </p>
          <div className="design-actions">
            {snapshot.classes.length > 0 && students.length === 0 && (
              <button className="primary" onClick={onImportStudents}>
                批量导入学生
              </button>
            )}
            <button className="primary" onClick={() => onNavigate('roster')}>
              <UsersRound size={17} />
              管理班级名册
            </button>
            <button onClick={onAddStudent}>
              <Plus size={17} />
              {snapshot.classes.length ? '添加一名学生' : '创建第一个班级'}
            </button>
          </div>
          <p className="muted">资料保存在本机，关键变更会先预览，再由你确认。</p>
        </section>
        <section className="design-panel">
          <h2>今天的安排</h2>
          <p>集中处理点名、值日与关注事项。</p>
          <div className="arrangement-links">
            <CalendarDays size={26} />
            <button onClick={() => onNavigate('attendance')}>开始上课点名</button>
            <button onClick={() => onNavigate('duty')}>查看值日轮换</button>
          </div>
        </section>
      </div>
      <section className="design-panel">
        <h2>江西班务服务</h2>
        <p>打开外部平台办理对应事项。</p>
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
      </section>
      <p className="muted">平台账号在官网登录，成长资料可在本地整理后再由教师核对提交。</p>
    </div>
  );
}
