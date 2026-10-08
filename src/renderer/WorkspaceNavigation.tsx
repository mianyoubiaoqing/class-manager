import {
  Award,
  BarChart3,
  BookOpen,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Database,
  Grid2X2,
  KeyRound,
  Settings,
  SlidersHorizontal,
  UserRound,
  UserRoundCheck,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import type { BusinessView } from '../shared/conversation';
import { ResourceHub } from './ResourceHub';

export type WorkspaceAreaId = 'teaching' | 'classManagement' | 'settings';
export type AppView =
  | BusinessView
  | 'students'
  | 'conversation'
  | 'modelSettings'
  | 'sessions'
  | 'teacherWorkbench'
  | WorkspaceAreaId;
interface WorkspaceEntry {
  view: AppView;
  label: string;
  description: string;
  icon: LucideIcon;
}
interface WorkspaceArea {
  id: WorkspaceAreaId;
  label: string;
  description: string;
  icon: LucideIcon;
  entries: WorkspaceEntry[];
}
export const workspaceAreas: WorkspaceArea[] = [
  {
    id: 'teaching',
    label: '教师备课',
    icon: BookOpen,
    description: '整理教学资料、制作教案课件，安排课堂与答卷复核。',
    entries: [
      {
        view: 'teacherWorkbench',
        label: '班级教学工作台',
        description: '学生、成绩、作业与日常教学记录，集中管理。',
        icon: UsersRound,
      },
      {
        view: 'lessons',
        label: '本地备课',
        description: '导入资料，编写教案与课件，导出 Word 和 PPT。',
        icon: BookOpen,
      },
      {
        view: 'classroom',
        label: '课堂与倒计时',
        description: '展示课件、切换教学环节，管理课堂计时。',
        icon: Clock,
      },
      {
        view: 'grading',
        label: '答卷建议与复核',
        description: '设置评分细则，核对答卷建议并确认入分。',
        icon: ClipboardCheck,
      },
    ],
  },
  {
    id: 'classManagement',
    label: '班主任管理',
    icon: UsersRound,
    description: '集中处理名册、点名、成绩和日常班务。',
    entries: [
      {
        view: 'roster',
        label: '班级名册',
        description: '创建班级，添加学生，管理在籍状态。',
        icon: UsersRound,
      },
      {
        view: 'attendance',
        label: '上课点名',
        description: '记录出勤、请假、迟到和缺勤情况。',
        icon: UserRoundCheck,
      },
      {
        view: 'profiles',
        label: '学生资料',
        description: '维护学生基本信息、联系资料和教学关注。',
        icon: UserRound,
      },
      {
        view: 'scores',
        label: '成绩管理',
        description: '导入成绩，查看统计与历次考试变化。',
        icon: BarChart3,
      },
      {
        view: 'seating',
        label: '座位编排',
        description: '调整座位，确认并打印座位表。',
        icon: Grid2X2,
      },
      {
        view: 'duty',
        label: '值日轮换',
        description: '安排值日分组、岗位与轮换日程。',
        icon: CalendarDays,
      },
      {
        view: 'growth',
        label: '成长档案',
        description: '记录日常跟进，整理并确认阶段总结。',
        icon: Award,
      },
    ],
  },
  {
    id: 'settings',
    label: '系统设置',
    icon: Settings,
    description: '配置模型账号、备份资料并查看设备连接。',
    entries: [
      {
        view: 'providerSettings',
        label: '模型连接',
        description: '配置供应商、模型和账号，查看连接与用量。',
        icon: KeyRound,
      },
      {
        view: 'maintenance',
        label: '数据与备份',
        description: '备份、预览恢复业务资料，导出诊断。',
        icon: Database,
      },
      {
        view: 'devices',
        label: '外设接口',
        description: '查看课堂设备状态和接入情况。',
        icon: SlidersHorizontal,
      },
    ],
  },
];

export function areaForView(view: AppView): WorkspaceArea | undefined {
  return workspaceAreas.find(
    (area) =>
      area.id === view ||
      area.entries.some((entry) => entry.view === view) ||
      (view === 'students' && area.id === 'classManagement') ||
      (view === 'modelSettings' && area.id === 'settings'),
  );
}
export function viewLabel(view: AppView): string {
  const teacherLabels: Partial<Record<AppView, string>> = {
    classManagement: '班主任工作台',
    roster: '花名册',
    students: '学生档案',
    scores: '成绩分析',
    attendance: '上课点名',
    seating: '座次表',
    duty: '值日表',
  };
  if (teacherLabels[view]) return teacherLabels[view]!;
  if (view === 'conversation') return '智能对话';
  if (view === 'sessions') return '历史会话';
  if (view === 'modelSettings') return 'DeepSeek 兼容设置';
  const area = areaForView(view);
  return area?.entries.find((entry) => entry.view === view)?.label ?? area?.label ?? view;
}

export function WorkspaceHome({
  area,
  onNavigate,
}: {
  area: WorkspaceArea;
  onNavigate: (view: AppView) => void;
}) {
  if (area.id === 'teaching') return <ResourceHub />;
  return (
    <section className="workspace-home" aria-label={`${area.label}入口`}>
      <section className="design-panel getting-started">
        <h2>三步准备好工作台</h2>
        <p>首次使用时，请按顺序准备账号与班级资料。</p>
        <div className="getting-started-steps">
          <div>
            <strong>1 连接智能助手</strong>
            <p>由交付方设置模型账号，再检查连接。</p>
            <button onClick={() => onNavigate('providerSettings')}>查看模型连接</button>
          </div>
          <div>
            <strong>2 准备班级资料</strong>
            <p>创建班级并添加学生，开始管理班务。</p>
            <button onClick={() => onNavigate('roster')}>打开班级名册</button>
          </div>
          <div>
            <strong>3 定期备份</strong>
            <p>将备份保存到可靠位置，便于恢复或迁移。</p>
            <button onClick={() => onNavigate('maintenance')}>管理数据与备份</button>
          </div>
        </div>
      </section>
      <p className="workspace-introduction">{area.description}</p>
      <div className="workspace-entry-grid">
        {area.entries.map((entry) => (
          <button
            key={entry.view}
            type="button"
            className="workspace-entry"
            aria-label={entry.label}
            onClick={() => onNavigate(entry.view)}
          >
            <span className="workspace-entry-icon">
              <entry.icon size={23} />
            </span>
            <span className="workspace-entry-content">
              <strong>{entry.label}</strong>
              <span>{entry.description}</span>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

export function WorkspaceLinks({
  view,
  onNavigate,
  disabled = false,
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
  disabled?: boolean;
}) {
  const area = areaForView(view);
  if (!area) return null;
  if (area.id === 'classManagement') {
    return (
      <nav className="workspace-tabs shared-class-tabs" aria-label="班主任管理功能">
        {(
          [
            ['classManagement', '工作台'],
            ['roster', '花名册'],
            ['attendance', '上课点名'],
            ['scores', '成绩分析'],
            ['seating', '座次表'],
            ['duty', '值日表'],
            ['students', '学生档案'],
            ['growth', '成长记录'],
          ] as const
        ).map(([target, label]) => (
          <button
            key={target}
            className={
              view === target || (view === 'profiles' && target === 'students') ? 'selected' : ''
            }
            aria-current={
              view === target || (view === 'profiles' && target === 'students') ? 'page' : undefined
            }
            disabled={disabled}
            onClick={() => onNavigate(target)}
          >
            {label}
          </button>
        ))}
      </nav>
    );
  }
  return (
    <nav className="workspace-tabs" aria-label={`${area.label}功能`}>
      <button
        className={view === area.id ? 'selected' : ''}
        aria-current={view === area.id ? 'page' : undefined}
        disabled={disabled}
        onClick={() => onNavigate(area.id)}
      >
        {area.id === 'teaching' ? '资源工作台' : '设置概览'}
      </button>
      {area.entries.map((entry) => (
        <button
          key={entry.view}
          className={view === entry.view ? 'selected' : ''}
          aria-current={view === entry.view ? 'page' : undefined}
          disabled={disabled}
          onClick={() => onNavigate(entry.view)}
        >
          {entry.label}
        </button>
      ))}
    </nav>
  );
}
