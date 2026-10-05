import {
  Award,
  BarChart3,
  BookOpen,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Database,
  GraduationCap,
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

export type WorkspaceAreaId = 'teaching' | 'classManagement' | 'settings';
export type AppView =
  BusinessView | 'conversation' | 'modelSettings' | 'sessions' | WorkspaceAreaId;
interface WorkspaceEntry {
  view: BusinessView;
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
    icon: GraduationCap,
    description: '整理教学资料、制作教案课件，安排课堂与答卷复核。',
    entries: [
      {
        view: 'lessons',
        label: '资料备课',
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
        label: '模型设置',
        description: '配置供应商、模型和账号，查看连接与用量。',
        icon: KeyRound,
      },
      {
        view: 'maintenance',
        label: '数据与维护',
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
      (view === 'modelSettings' && area.id === 'settings'),
  );
}
export function viewLabel(view: AppView): string {
  if (view === 'conversation') return '业务对话';
  if (view === 'sessions') return '会话管理';
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
  return (
    <section className="workspace-home" aria-label={`${area.label}入口`}>
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
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
}) {
  const area = areaForView(view);
  if (!area || area.id === view) return null;
  return (
    <nav className="workspace-links" aria-label={`${area.label}功能`}>
      <button type="button" onClick={() => onNavigate(area.id)}>
        全部功能
      </button>
      {area.entries.map((entry) => (
        <button
          key={entry.view}
          type="button"
          aria-current={view === entry.view ? 'page' : undefined}
          onClick={() => onNavigate(entry.view)}
        >
          {entry.label}
        </button>
      ))}
    </nav>
  );
}
