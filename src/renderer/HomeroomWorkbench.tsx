import { useState } from 'react';
import {
  AlertTriangle,
  Award,
  BarChart3,
  Bell,
  BookOpen,
  Calendar,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardList,
  Compass,
  FileText,
  GraduationCap,
  Grid2X2,
  Heart,
  HeartHandshake,
  Home,
  Moon,
  Plus,
  Send,
  ShieldAlert,
  Smile,
  Sparkles,
  UserCheck,
  UserRound,
  UserRoundCheck,
  UsersRound,
  X,
} from 'lucide-react';
import type { Snapshot } from '../shared/contracts';
import type { AppView } from './WorkspaceNavigation';
import './homeroom-workbench.css';

interface HomeroomWorkbenchProps {
  snapshot: Snapshot;
  selectedClass: string;
  onNavigate: (view: AppView) => void;
  onOpenConversationPrompt?: (text: string) => void;
}

interface TodoItem {
  id: number;
  title: string;
  tag: string;
  time: string;
  priority: '高' | '中' | '普通';
  done: boolean;
}

export function HomeroomWorkbench({
  snapshot,
  selectedClass,
  onNavigate,
  onOpenConversationPrompt: _onOpenConversationPrompt,
}: HomeroomWorkbenchProps) {
  const currentClassroom =
    selectedClass !== 'all'
      ? snapshot.classes.find((c) => c.id === selectedClass)
      : snapshot.classes[0];
  const className = currentClassroom?.name ?? '高一(1)班';
  const activeStudentCount =
    snapshot.students.filter(
      (s) => s.active && (!currentClassroom || s.classId === currentClassroom.id),
    ).length || 45;

  const [activeSubview, setActiveSubview] = useState<
    'workbench' | 'safety' | 'duty' | 'schedule' | 'moral'
  >('workbench');

  // Todo items state
  const [todos, setTodos] = useState<TodoItem[]>([
    {
      id: 1,
      title: '处理张XX未归寝事宜',
      tag: '查寝',
      time: '今日 22:30',
      priority: '高',
      done: false,
    },
    {
      id: 2,
      title: '核实高一(1)班特异体质免体协议',
      tag: '特异体质',
      time: '今日 16:00',
      priority: '高',
      done: false,
    },
    {
      id: 3,
      title: '本周值日生卫生包干区检查',
      tag: '值日',
      time: '今日 17:30',
      priority: '中',
      done: false,
    },
    {
      id: 4,
      title: '高一期中历史复习提纲编制',
      tag: '教学',
      time: '明天 09:00',
      priority: '普通',
      done: true,
    },
  ]);
  const [newTodoText, setNewTodoText] = useState('');
  const [showAddTodo, setShowAddTodo] = useState(false);

  const doneCount = todos.filter((t) => t.done).length;
  const progressPercent = Math.round((doneCount / Math.max(1, todos.length)) * 100);

  // Copilot Drawer state
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotTab, setCopilotTab] = useState<'speech' | 'plan' | 'analysis' | 'review'>('speech');
  const [copilotInput, setCopilotInput] = useState('');
  const [chatLog, setChatLog] = useState<Array<{ sender: 'user' | 'assistant'; text: string }>>([
    {
      sender: 'assistant',
      text: '您好张老师！我是您的AI班主任助手。我可以为您实时生成沟通话术、制定班级活动方案、提供学情诊断与工作梳理。请问今天有什么可以帮您？',
    },
  ]);

  const speechPrompts = [
    '生成一段与留守学生家长的电话沟通话术',
    '写一份违纪学生批评教育的引导话术',
    '家长会班主任发言稿模板（高一年级）',
    '考后部分学生心理退步情绪疏导建议',
  ];
  const planPrompts = [
    '制定一份“预防校园欺凌”主题班会策划方案',
    '设计高一期中考后班级学风建设推进计划',
    '班委换届选举流程与民主评议表',
    '控辍保学后进生家访谈话与帮扶方案',
  ];
  const analysisPrompts = [
    '分析近期宿舍晚归与请假异常趋势',
    '针对近视率偏高的智能座次优化建议',
    '历史合格考薄弱名单与因材施教分层策略',
    '特异体质学生体育课与课间安全防范指南',
  ];
  const reviewPrompts = [
    '梳理本周班主任核心事务与待跟进闭环清单',
    '生成高一(1)班本月常规管理督查报告',
    '整理周末离校安全提醒通知短信',
    '提炼期中家校共育备忘录',
  ];

  const currentPrompts =
    copilotTab === 'speech'
      ? speechPrompts
      : copilotTab === 'plan'
        ? planPrompts
        : copilotTab === 'analysis'
          ? analysisPrompts
          : reviewPrompts;

  function handleSendCopilot(textToSend?: string) {
    const query = (textToSend ?? copilotInput).trim();
    if (!query) return;
    setChatLog((prev) => [...prev, { sender: 'user', text: query }]);
    setCopilotInput('');

    setTimeout(() => {
      let reply = '';
      if (copilotTab === 'speech') {
        reply = `【AI话术建议】\n尊敬的张老师，针对“${query}”，建议遵循“共情理解 + 客观陈述 + 携手共育”三步法：\n\n1. 开场共情：“家长您好，我是班主任张老师。今天主动给您致电，主要是想和您交流一下孩子近期在校的闪光点与近况…”\n2. 客观呈现事实，表达学校关怀与陪伴；\n3. 制定家校联动协议，约定每周定期沟通。\n（可直接使用，或点击跳转业务对话进一步微调）`;
      } else if (copilotTab === 'plan') {
        reply = `【AI方案草案】\n已为您起草《${query}》：\n\n一、活动目标：增强班级凝聚力，明确目标导向。\n二、时间地点：周五班会课 · 高一(1)班教室。\n三、活动流程：\n  1. 现状导入与视频微课（10分钟）\n  2. 互动研讨与代表发言（20分钟）\n  3. 班主任寄语与宣誓承诺（10分钟）\n四、落实措施：班委成立专项监督小组。`;
      } else {
        reply = `【AI专业诊断】\n结合班级当前数据，为您生成重点建议：\n1. 重点关注3名特异体质学生日常体温与活动负荷，备齐免体证明；\n2. 针对未归寝与控辍保学学生，建议立即建立档案并安排面对面谈心；\n3. 保持与家长的双向沟通渠道畅通。`;
      }
      setChatLog((prev) => [...prev, { sender: 'assistant', text: reply }]);
    }, 400);
  }

  function toggleTodo(id: number) {
    setTodos((prev) => prev.map((item) => (item.id === id ? { ...item, done: !item.done } : item)));
  }

  function handleAddTodo() {
    if (!newTodoText.trim()) return;
    setTodos((prev) => [
      ...prev,
      {
        id: Date.now(),
        title: newTodoText.trim(),
        tag: '日常',
        time: '今日',
        priority: '中',
        done: false,
      },
    ]);
    setNewTodoText('');
    setShowAddTodo(false);
  }

  return (
    <div className="homeroom-workbench">
      {/* 1. Header brand & profile bar */}
      <header className="workbench-header-bar">
        <div className="workbench-brand">
          <div className="workbench-badge-logo" aria-hidden="true">
            班
          </div>
          <div className="workbench-brand-info">
            <h1>
              AI班主任
              <span style={{ fontSize: 13, fontWeight: 'normal', color: '#64748b' }}>
                · 班主任工作台
              </span>
            </h1>
            <p>
              {className} · {activeStudentCount}人
            </p>
          </div>
        </div>

        <div className="workbench-header-center">
          <div className="workbench-view-title">工作台总览</div>
          <div className="workbench-view-sub">今日工作 一目了然</div>
        </div>

        <div className="workbench-teacher-profile">
          <div className="teacher-meta">
            <div className="teacher-name">张老师</div>
            <div className="teacher-role">{className}班主任</div>
          </div>
          <div className="teacher-avatar" aria-label="教师头像">
            张
          </div>
        </div>
      </header>

      {/* Subpage Tabs Bar */}
      <nav className="workbench-subnav-bar" aria-label="班主任子视图导航">
        <button
          type="button"
          className={`subnav-tab-btn ${activeSubview === 'workbench' ? 'active' : ''}`}
          onClick={() => setActiveSubview('workbench')}
        >
          <Home size={15} />
          工作台总览
        </button>
        <button
          type="button"
          className={`subnav-tab-btn ${activeSubview === 'safety' ? 'active' : ''}`}
          onClick={() => setActiveSubview('safety')}
        >
          <ShieldAlert size={15} />
          安全与特异体质台账
        </button>
        <button
          type="button"
          className={`subnav-tab-btn ${activeSubview === 'duty' ? 'active' : ''}`}
          onClick={() => setActiveSubview('duty')}
        >
          <CalendarDays size={15} />
          值日排班表
        </button>
        <button
          type="button"
          className={`subnav-tab-btn ${activeSubview === 'schedule' ? 'active' : ''}`}
          onClick={() => setActiveSubview('schedule')}
        >
          <Calendar size={15} />
          班级课程表
        </button>
        <button
          type="button"
          className={`subnav-tab-btn ${activeSubview === 'moral' ? 'active' : ''}`}
          onClick={() => setActiveSubview('moral')}
        >
          <Award size={15} />
          德育与活动库
        </button>
      </nav>

      {/* Test-compatible region: 班主任管理入口 */}
      <section className="workbench-entrance-bar workspace-home" aria-label="班主任管理入口">
        <div className="entrance-bar-label">
          <Compass size={16} />
          <span>班级基础与核心事务直达通道</span>
        </div>
        <div className="workbench-entrance-grid">
          <button
            type="button"
            className="workspace-entry"
            aria-label="班级名册"
            onClick={() => onNavigate('roster')}
          >
            <span className="workspace-entry-icon">
              <UsersRound size={16} />
            </span>
            <strong>班级名册</strong>
          </button>
          <button
            type="button"
            className="workspace-entry"
            aria-label="上课点名"
            onClick={() => onNavigate('attendance')}
          >
            <span className="workspace-entry-icon">
              <UserRoundCheck size={16} />
            </span>
            <strong>上课点名</strong>
          </button>
          <button
            type="button"
            className="workspace-entry"
            aria-label="学生资料"
            onClick={() => onNavigate('profiles')}
          >
            <span className="workspace-entry-icon">
              <UserRound size={16} />
            </span>
            <strong>学生资料</strong>
          </button>
          <button
            type="button"
            className="workspace-entry"
            aria-label="成绩管理"
            onClick={() => onNavigate('scores')}
          >
            <span className="workspace-entry-icon">
              <BarChart3 size={16} />
            </span>
            <strong>成绩管理</strong>
          </button>
          <button
            type="button"
            className="workspace-entry"
            aria-label="座位编排"
            onClick={() => onNavigate('seating')}
          >
            <span className="workspace-entry-icon">
              <Grid2X2 size={16} />
            </span>
            <strong>座位编排</strong>
          </button>
          <button
            type="button"
            className="workspace-entry"
            aria-label="值日轮换"
            onClick={() => onNavigate('duty')}
          >
            <span className="workspace-entry-icon">
              <CalendarDays size={16} />
            </span>
            <strong>值日轮换</strong>
          </button>
          <button
            type="button"
            className="workspace-entry"
            aria-label="成长档案"
            onClick={() => onNavigate('growth')}
          >
            <span className="workspace-entry-icon">
              <Award size={16} />
            </span>
            <strong>成长档案</strong>
          </button>
        </div>
      </section>

      {/* Main View: 工作台总览 */}
      {activeSubview === 'workbench' && (
        <>
          {/* SECTION 1: ALERT · 红线预警 */}
          <section className="workbench-section" aria-label="红线预警区">
            <div className="workbench-section-header">
              <div className="section-tag-and-title">
                <span className="section-tag alert-tag">ALERT · 红线预警</span>
                <div className="section-title-row">
                  <h2 className="section-title">今日风险事项</h2>
                  <span className="section-badge-counter">7 项待处理</span>
                </div>
              </div>
            </div>

            <div className="alert-cards-grid">
              <div
                className="alert-card type-red"
                role="button"
                tabIndex={0}
                onClick={() => setActiveSubview('safety')}
                title="点击查看特异体质台账"
              >
                <div className="alert-card-top">
                  <div className="alert-icon-wrap">
                    <Heart size={20} />
                  </div>
                  <div className="alert-number">3</div>
                </div>
                <div className="alert-card-body">
                  <h3>特异体质提醒</h3>
                  <p>3名学生需重点关注</p>
                </div>
                <div className="alert-card-bottom">
                  <span className="alert-priority-pill">高优先级</span>
                  <ChevronRight size={14} className="alert-arrow" />
                </div>
              </div>

              <div
                className="alert-card type-red"
                role="button"
                tabIndex={0}
                onClick={() => setActiveSubview('safety')}
                title="点击查看查寝登记"
              >
                <div className="alert-card-top">
                  <div className="alert-icon-wrap">
                    <Moon size={20} />
                  </div>
                  <div className="alert-number">1</div>
                </div>
                <div className="alert-card-body">
                  <h3>未归寝预警</h3>
                  <p>近期查寝异常记录</p>
                </div>
                <div className="alert-card-bottom">
                  <span className="alert-priority-pill">高优先级</span>
                  <ChevronRight size={14} className="alert-arrow" />
                </div>
              </div>

              <div
                className="alert-card type-red"
                role="button"
                tabIndex={0}
                onClick={() => onNavigate('profiles')}
                title="点击跟进控辍保学对象"
              >
                <div className="alert-card-top">
                  <div className="alert-icon-wrap">
                    <AlertTriangle size={20} />
                  </div>
                  <div className="alert-number">2</div>
                </div>
                <div className="alert-card-body">
                  <h3>控辍保学重点</h3>
                  <p>高风险学生需重点跟进</p>
                </div>
                <div className="alert-card-bottom">
                  <span className="alert-priority-pill">高优先级</span>
                  <ChevronRight size={14} className="alert-arrow" />
                </div>
              </div>

              <div
                className="alert-card type-yellow"
                role="button"
                tabIndex={0}
                onClick={() => onNavigate('growth')}
                title="点击关注学生心理情绪"
              >
                <div className="alert-card-top">
                  <div className="alert-icon-wrap">
                    <Smile size={20} />
                  </div>
                  <div className="alert-number">1</div>
                </div>
                <div className="alert-card-body">
                  <h3>临界厌学提醒</h3>
                  <p>情绪波动需关注</p>
                </div>
                <div className="alert-card-bottom">
                  <span className="alert-priority-pill">中优先级</span>
                  <ChevronRight size={14} className="alert-arrow" />
                </div>
              </div>
            </div>
          </section>

          {/* SECTION 2: TODAY · 今日待办 */}
          <section className="workbench-section" aria-label="今日待办清单">
            <div className="today-todo-panel">
              <div className="todo-header-row">
                <div className="section-tag-and-title">
                  <span className="section-tag today-tag">TODAY · 今日待办</span>
                  <div className="section-title-row">
                    <h2 className="section-title">今日待办清单</h2>
                    <span className="section-badge-counter">
                      {todos.length - doneCount} 项待完成
                    </span>
                  </div>
                </div>

                <div className="todo-progress-area">
                  <div>
                    <span className="todo-progress-num">{progressPercent}%</span>
                    <span className="todo-progress-sub">完成率</span>
                  </div>
                  <button
                    type="button"
                    className="todo-add-btn"
                    onClick={() => setShowAddTodo(!showAddTodo)}
                  >
                    <Plus size={15} />
                    新增
                  </button>
                </div>
              </div>

              {showAddTodo && (
                <div style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
                  <input
                    type="text"
                    value={newTodoText}
                    onChange={(e) => setNewTodoText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddTodo();
                    }}
                    placeholder="输入待办事项内容..."
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: 10,
                      border: '1px solid #cbd5e1',
                    }}
                  />
                  <button
                    type="button"
                    className="todo-add-btn"
                    style={{ padding: '8px 16px' }}
                    onClick={handleAddTodo}
                  >
                    添加
                  </button>
                </div>
              )}

              <div className="todo-checklist">
                {todos.map((todo) => (
                  <div key={todo.id} className={`todo-item ${todo.done ? 'done' : ''}`}>
                    <div className="todo-left">
                      <div
                        className={`todo-checkbox ${todo.done ? 'checked' : ''}`}
                        onClick={() => toggleTodo(todo.id)}
                        role="checkbox"
                        aria-checked={todo.done}
                        tabIndex={0}
                      >
                        {todo.done && <Check size={12} strokeWidth={3} />}
                      </div>
                      <span className="todo-title">{todo.title}</span>
                      <div className="todo-tags-row">
                        <span className="todo-tag">{todo.tag}</span>
                        <span className="todo-time">{todo.time}</span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        className={
                          todo.priority === '高'
                            ? 'priority-badge-red'
                            : todo.priority === '中'
                              ? 'priority-badge-orange'
                              : 'priority-badge-gray'
                        }
                      >
                        {todo.priority}
                      </span>
                      <ChevronRight size={14} color="#94a3b8" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* SECTION 3: 日常事务概览 */}
          <section className="workbench-section" aria-label="日常事务概览">
            <div className="workbench-section-header">
              <div className="section-tag-and-title">
                <span className="section-tag">DAILY · 常规工作</span>
                <h2 className="section-title">日常事务概览</h2>
              </div>
            </div>

            <div className="overview-cards-grid">
              <div className="overview-card" onClick={() => onNavigate('attendance')}>
                <div className="overview-card-top">
                  <div className="overview-card-icon">
                    <UserCheck size={18} />
                  </div>
                  <span className="overview-card-rate">98%</span>
                </div>
                <h4>考勤管理</h4>
                <p>今日到课率 · 异常1人</p>
              </div>

              <div className="overview-card" onClick={() => onNavigate('duty')}>
                <div className="overview-card-top">
                  <div className="overview-card-icon">
                    <ClipboardList size={18} />
                  </div>
                  <span className="overview-card-rate">85分</span>
                </div>
                <h4>值日卫生</h4>
                <p>今日第 1 周 · 卫生良好</p>
              </div>

              <div className="overview-card" onClick={() => onNavigate('scores')}>
                <div className="overview-card-top">
                  <div className="overview-card-icon">
                    <BarChart3 size={18} />
                  </div>
                  <span className="overview-card-rate">84.7</span>
                </div>
                <h4>成绩分析</h4>
                <p>期中均分 · 优秀率28%</p>
              </div>

              <div className="overview-card" onClick={() => setActiveSubview('safety')}>
                <div className="overview-card-top">
                  <div className="overview-card-icon">
                    <Moon size={18} />
                  </div>
                  <span className="overview-card-rate">92%</span>
                </div>
                <h4>宿舍管理</h4>
                <p>应归45人 · 待核实1人</p>
              </div>

              <div className="overview-card" onClick={() => onNavigate('profiles')}>
                <div className="overview-card-top">
                  <div className="overview-card-icon">
                    <HeartHandshake size={18} />
                  </div>
                  <span className="overview-card-rate">70%</span>
                </div>
                <h4>留守学生</h4>
                <p>重点帮扶3人 · 已访2人</p>
              </div>
            </div>
          </section>

          {/* SECTION 4: CORE · 核心工作推进 */}
          <section className="workbench-section" aria-label="核心工作推进">
            <div className="workbench-section-header">
              <div className="section-tag-and-title">
                <span className="section-tag core-tag">CORE · 核心工作</span>
                <h2 className="section-title">本周重点推进</h2>
              </div>
            </div>

            <div className="core-cards-grid">
              <div className="core-card" onClick={() => onNavigate('profiles')}>
                <div className="core-card-header">
                  <h4>控辍保学</h4>
                  <span className="core-card-pct">40%</span>
                </div>
                <div className="core-progress-track">
                  <div className="core-progress-fill" style={{ width: '40%' }} />
                </div>
                <p className="core-card-sub">2位重点生家访跟进</p>
              </div>

              <div className="core-card" onClick={() => onNavigate('growth')}>
                <div className="core-card-header">
                  <h4>成长档案</h4>
                  <span className="core-card-pct">10%</span>
                </div>
                <div className="core-progress-track">
                  <div className="core-progress-fill" style={{ width: '10%' }} />
                </div>
                <p className="core-card-sub">首批综合素质评语</p>
              </div>

              <div className="core-card" onClick={() => setCopilotOpen(true)}>
                <div className="core-card-header">
                  <h4>家校沟通</h4>
                  <span className="core-card-pct">0%</span>
                </div>
                <div className="core-progress-track">
                  <div className="core-progress-fill" style={{ width: '5%' }} />
                </div>
                <p className="core-card-sub">家长会发言材料筹备</p>
              </div>

              <div className="core-card" onClick={() => setActiveSubview('moral')}>
                <div className="core-card-header">
                  <h4>安全教育</h4>
                  <span className="core-card-pct">75%</span>
                </div>
                <div className="core-progress-track">
                  <div className="core-progress-fill" style={{ width: '75%' }} />
                </div>
                <p className="core-card-sub">交通与防溺水微课</p>
              </div>

              <div className="core-card" onClick={() => setActiveSubview('moral')}>
                <div className="core-card-header">
                  <h4>德育活动</h4>
                  <span className="core-card-pct">67%</span>
                </div>
                <div className="core-progress-track">
                  <div className="core-progress-fill" style={{ width: '67%' }} />
                </div>
                <p className="core-card-sub">班级学风建设推进</p>
              </div>
            </div>
          </section>

          {/* SECTION 5: TEACHING · 教学工作 */}
          <section className="workbench-section" aria-label="历史教学工作">
            <div className="workbench-section-header">
              <div className="section-tag-and-title">
                <span className="section-tag teaching-tag">TEACHING · 教学工作</span>
                <h2 className="section-title">历史学科进度</h2>
              </div>
            </div>

            <div className="teaching-cards-grid">
              <div className="teaching-card" onClick={() => onNavigate('lessons')}>
                <span className="teaching-card-label">今日课节安排</span>
                <span className="teaching-card-value">第 2 节</span>
                <span className="teaching-card-sub">必修上《秦统一多民族封建国家》</span>
              </div>

              <div className="teaching-card" onClick={() => onNavigate('classroom')}>
                <span className="teaching-card-label">教学周进度</span>
                <span className="teaching-card-value">第 13 周</span>
                <span className="teaching-card-sub">全学期共 20 周 · 进度正常</span>
              </div>

              <div className="teaching-card" onClick={() => onNavigate('grading')}>
                <span className="teaching-card-label">作业批改量</span>
                <span className="teaching-card-value">42 / 45 份</span>
                <span className="teaching-card-sub">剩余 3 份待复核</span>
              </div>

              <div className="teaching-card" onClick={() => onNavigate('scores')}>
                <span className="teaching-card-label">合格考过关预测</span>
                <span className="teaching-card-value">92%</span>
                <span className="teaching-card-sub">模拟测试过关率稳定</span>
              </div>
            </div>
          </section>
        </>
      )}

      {/* SUBVIEW 1: 安全与特异体质台账 */}
      {activeSubview === 'safety' && (
        <section className="subview-container" aria-label="安全与特异体质台账详情">
          <div className="subview-header-row">
            <div>
              <h2>安全与特异体质台账</h2>
              <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>
                学生健康与安全闭环管理
              </p>
            </div>
            <button
              type="button"
              className="subview-btn"
              onClick={() =>
                alert('台账导出功能：已生成《高一(1)班安全与特异体质台账.xlsx》并保存。')
              }
            >
              <FileText size={16} />
              导出台账
            </button>
          </div>

          <div className="alert-cards-grid">
            <div className="alert-card type-red">
              <div className="alert-card-top">
                <div className="alert-icon-wrap">
                  <Heart size={20} />
                </div>
                <div className="alert-number">3</div>
              </div>
              <div className="alert-card-body">
                <h3>特异体质学生</h3>
                <p>需重点关注</p>
              </div>
            </div>
            <div className="alert-card type-yellow">
              <div className="alert-card-top">
                <div className="alert-icon-wrap">
                  <Compass size={20} />
                </div>
                <div className="alert-number">1</div>
              </div>
              <div className="alert-card-body">
                <h3>未返校预警</h3>
                <p>周末未按时返校</p>
              </div>
            </div>
            <div className="alert-card type-red">
              <div className="alert-card-top">
                <div className="alert-icon-wrap">
                  <Moon size={20} />
                </div>
                <div className="alert-number">1</div>
              </div>
              <div className="alert-card-body">
                <h3>未归寝预警</h3>
                <p>晚查寝异常</p>
              </div>
            </div>
            <div className="alert-card type-yellow">
              <div className="alert-card-top">
                <div className="alert-icon-wrap">
                  <AlertTriangle size={20} />
                </div>
                <div className="alert-number">1</div>
              </div>
              <div className="alert-card-body">
                <h3>矛盾排查</h3>
                <p>等待班主任调解</p>
              </div>
            </div>
          </div>

          <div className="student-health-cards-grid">
            <div className="student-health-card">
              <div className="student-card-top">
                <div className="student-badge-avatar">刘</div>
                <div className="student-card-info">
                  <div className="student-card-name-row">
                    <span className="student-card-name">刘浩然</span>
                    <span className="student-tag-pill">特异体质</span>
                  </div>
                  <div className="student-card-sno">20260101</div>
                </div>
              </div>
              <dl className="student-health-details">
                <dt>病症类型</dt>
                <dd>先天性心脏病</dd>
                <dt>用药情况</dt>
                <dd>长期服药 (速效救心丸备班主任处)</dd>
                <dt>注意事项</dt>
                <dd>免剧烈运动、体育课免跑</dd>
                <dt>家长知情书</dt>
                <dd style={{ color: '#16a34a' }}>已签署 (归档完成)</dd>
              </dl>
              <div className="student-card-actions">
                <button type="button" className="action-view-btn">
                  查看详情
                </button>
                <button
                  type="button"
                  className="action-remind-btn"
                  onClick={() => alert('已向任课老师与体育老师发送安全提醒。')}
                >
                  <Bell size={14} />
                  提醒任课老师
                </button>
              </div>
            </div>

            <div className="student-health-card">
              <div className="student-card-top">
                <div className="student-badge-avatar">黄</div>
                <div className="student-card-info">
                  <div className="student-card-name-row">
                    <span className="student-card-name">黄雨萱</span>
                    <span className="student-tag-pill">特异体质</span>
                  </div>
                  <div className="student-card-sno">20260118</div>
                </div>
              </div>
              <dl className="student-health-details">
                <dt>病症类型</dt>
                <dd>重度哮喘</dd>
                <dt>用药情况</dt>
                <dd>随身携带沙丁胺醇吸入剂</dd>
                <dt>注意事项</dt>
                <dd>粉尘与冷空气过敏，免户外重体力值日</dd>
                <dt>家长知情书</dt>
                <dd style={{ color: '#16a34a' }}>已签署 (归档完成)</dd>
              </dl>
              <div className="student-card-actions">
                <button type="button" className="action-view-btn">
                  查看详情
                </button>
                <button
                  type="button"
                  className="action-remind-btn"
                  onClick={() => alert('已向任课老师与体育老师发送安全提醒。')}
                >
                  <Bell size={14} />
                  提醒任课老师
                </button>
              </div>
            </div>

            <div className="student-health-card">
              <div className="student-card-top">
                <div className="student-badge-avatar">周</div>
                <div className="student-card-info">
                  <div className="student-card-name-row">
                    <span className="student-card-name">周雨泽</span>
                    <span className="student-tag-pill">特异体质</span>
                  </div>
                  <div className="student-card-sno">20260139</div>
                </div>
              </div>
              <dl className="student-health-details">
                <dt>病症类型</dt>
                <dd>严重过敏体质 (花生/蚕豆)</dd>
                <dt>用药情况</dt>
                <dd>备抗组胺药</dd>
                <dt>注意事项</dt>
                <dd>食堂就餐单独标注，避免接触相关坚果</dd>
                <dt>家长知情书</dt>
                <dd style={{ color: '#16a34a' }}>已签署 (归档完成)</dd>
              </dl>
              <div className="student-card-actions">
                <button type="button" className="action-view-btn">
                  查看详情
                </button>
                <button
                  type="button"
                  className="action-remind-btn"
                  onClick={() => alert('已向食堂与生活老师发送提醒。')}
                >
                  <Bell size={14} />
                  提醒生活老师
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* SUBVIEW 2: 值日排班周视图 */}
      {activeSubview === 'duty' && (
        <section className="subview-container" aria-label="值日排班表周视图">
          <div className="subview-header-row">
            <div>
              <h2>值日排班表</h2>
              <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>
                第 1 周 · 周排班视图
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                className="subview-btn"
                onClick={() => alert('已自动一键轮换至下一轮组员！')}
              >
                一键轮换
              </button>
              <button
                type="button"
                className="subview-btn"
                onClick={() => alert('已成功复制当前排班至下周。')}
              >
                复制到下周
              </button>
              <button
                type="button"
                className="subview-btn"
                style={{ background: '#16a34a', color: '#fff', borderColor: '#16a34a' }}
                onClick={() => onNavigate('duty')}
              >
                前往值日系统设置
              </button>
            </div>
          </div>

          <div className="duty-week-table-wrap">
            <table className="duty-week-table">
              <thead>
                <tr>
                  <th style={{ width: '16%' }}>时段</th>
                  <th style={{ width: '16%' }}>周一</th>
                  <th style={{ width: '16%' }}>周二</th>
                  <th style={{ width: '16%' }}>周三</th>
                  <th style={{ width: '16%' }}>周四</th>
                  <th style={{ width: '16%' }}>周五</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="duty-period-cell">
                    早读
                    <div className="duty-period-time">07:00-07:30</div>
                  </td>
                  <td>
                    <span className="duty-student-chip">王明轩</span>
                    <span className="duty-student-chip">周俊杰</span>
                    <span className="duty-student-chip">赵子轩</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">李雨桐</span>
                    <span className="duty-student-chip">吴雅婷</span>
                    <span className="duty-student-chip">黄雨萱</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">张梓涵</span>
                    <span className="duty-student-chip">王文博</span>
                    <span className="duty-student-chip">周宇航</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">刘浩然</span>
                    <span className="duty-student-chip">李思远</span>
                    <span className="duty-student-chip">吴思琪</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">陈诗琪</span>
                    <span className="duty-student-chip">张嘉怡</span>
                    <span className="duty-student-chip">王博文</span>
                  </td>
                </tr>

                <tr>
                  <td className="duty-period-cell">
                    课间
                    <div className="duty-period-time">10:00-10:20</div>
                  </td>
                  <td>
                    <span className="duty-student-chip">李雨桐</span>
                    <span className="duty-student-chip">吴雅婷</span>
                    <span className="duty-student-chip">黄雨萱</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">张梓涵</span>
                    <span className="duty-student-chip">王文博</span>
                    <span className="duty-student-chip">周宇航</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">刘浩然</span>
                    <span className="duty-student-chip">李思远</span>
                    <span className="duty-student-chip">吴思琪</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">陈诗琪</span>
                    <span className="duty-student-chip">张嘉怡</span>
                    <span className="duty-student-chip">王博文</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">杨宇轩</span>
                    <span className="duty-student-chip">刘天佑</span>
                    <span className="duty-student-chip">李梓萱</span>
                  </td>
                </tr>

                <tr>
                  <td className="duty-period-cell">
                    晚自习
                    <div className="duty-period-time">18:00-21:30</div>
                  </td>
                  <td>
                    <span className="duty-student-chip">张梓涵</span>
                    <span className="duty-student-chip">王文博</span>
                    <span className="duty-student-chip">周宇航</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">刘浩然</span>
                    <span className="duty-student-chip">李思远</span>
                    <span className="duty-student-chip">吴思琪</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">陈诗琪</span>
                    <span className="duty-student-chip">张嘉怡</span>
                    <span className="duty-student-chip">王博文</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">杨宇轩</span>
                    <span className="duty-student-chip">刘天佑</span>
                    <span className="duty-student-chip">李梓萱</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">赵欣怡</span>
                    <span className="duty-student-chip">陈佳琪</span>
                    <span className="duty-student-chip">张皓宇</span>
                  </td>
                </tr>

                <tr>
                  <td className="duty-period-cell">
                    卫生区
                    <div className="duty-period-time">每日放学</div>
                  </td>
                  <td>
                    <span className="duty-student-chip">刘浩然</span>
                    <span className="duty-student-chip">李思远</span>
                    <span className="duty-student-chip">吴思琪</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">陈诗琪</span>
                    <span className="duty-student-chip">张嘉怡</span>
                    <span className="duty-student-chip">王博文</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">杨宇轩</span>
                    <span className="duty-student-chip">刘天佑</span>
                    <span className="duty-student-chip">李梓萱</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">赵欣怡</span>
                    <span className="duty-student-chip">陈佳琪</span>
                    <span className="duty-student-chip">张皓宇</span>
                  </td>
                  <td>
                    <span className="duty-student-chip">黄子涵</span>
                    <span className="duty-student-chip">杨晨曦</span>
                    <span className="duty-student-chip">刘欣妍</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* SUBVIEW 3: 班级课程表 */}
      {activeSubview === 'schedule' && (
        <section className="subview-container" aria-label="班级课程表">
          <div className="subview-header-row">
            <div>
              <h2>班级课程表</h2>
              <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>
                高一(1)班 · 2026-2027学年上学期
              </p>
            </div>
            <button
              type="button"
              className="subview-btn"
              onClick={() => alert('课程表导出：已生成可打印高清单页课表。')}
            >
              打印课程表
            </button>
          </div>

          <div
            style={{
              padding: '12px 18px',
              background: '#f0fdf4',
              borderRadius: 12,
              border: '1px solid #bbf7d0',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ fontWeight: 700, color: '#166534' }}>今日课程 (星期二):</span>
            <span style={{ fontSize: 13, color: '#15803d' }}>
              第1节 语文 ｜ 第2节 <strong>历史 (张老师)</strong> ｜ 第3节 数学 ｜ 第4节 英语 ｜
              第5节 物理 ｜ 第6节 体育 ｜ 第7节 自习
            </span>
          </div>

          <div className="timetable-grid-wrap">
            <table className="timetable-grid">
              <thead>
                <tr>
                  <th>节次</th>
                  <th>时间</th>
                  <th>周一</th>
                  <th>周二</th>
                  <th>周三</th>
                  <th>周四</th>
                  <th>周五</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1</td>
                  <td>08:00-08:45</td>
                  <td>
                    <span className="timetable-subject-pill">语文</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">数学</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">英语</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">物理</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">语文</span>
                  </td>
                </tr>
                <tr>
                  <td>2</td>
                  <td>08:55-09:40</td>
                  <td>
                    <span className="timetable-subject-pill">数学</span>
                  </td>
                  <td>
                    <span
                      className="timetable-subject-pill"
                      style={{ background: '#dcfce7', color: '#15803d' }}
                    >
                      历史 (您)
                    </span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">语文</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">化学</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">数学</span>
                  </td>
                </tr>
                <tr>
                  <td>3</td>
                  <td>10:20-11:05</td>
                  <td>
                    <span className="timetable-subject-pill">英语</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">物理</span>
                  </td>
                  <td>
                    <span
                      className="timetable-subject-pill"
                      style={{ background: '#dcfce7', color: '#15803d' }}
                    >
                      历史 (您)
                    </span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">生物</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">英语</span>
                  </td>
                </tr>
                <tr>
                  <td>4</td>
                  <td>11:15-12:00</td>
                  <td>
                    <span className="timetable-subject-pill">物理</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">化学</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">数学</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">地理</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">政治</span>
                  </td>
                </tr>
                <tr>
                  <td colSpan={7} style={{ background: '#f8fafc', color: '#94a3b8', padding: 6 }}>
                    午休 & 午餐 (12:00-14:00)
                  </td>
                </tr>
                <tr>
                  <td>5</td>
                  <td>14:00-14:45</td>
                  <td>
                    <span className="timetable-subject-pill">生物</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">地理</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">政治</span>
                  </td>
                  <td>
                    <span
                      className="timetable-subject-pill"
                      style={{ background: '#dcfce7', color: '#15803d' }}
                    >
                      历史 (您)
                    </span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">班会</span>
                  </td>
                </tr>
                <tr>
                  <td>6</td>
                  <td>14:55-15:40</td>
                  <td>
                    <span className="timetable-subject-pill">政治</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">体育</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">音乐</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">信息</span>
                  </td>
                  <td>
                    <span className="timetable-subject-pill">劳动</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* SUBVIEW 4: 德育与活动库 */}
      {activeSubview === 'moral' && (
        <section className="subview-container" aria-label="德育与活动库">
          <div className="subview-header-row">
            <div>
              <h2>德育与活动库</h2>
              <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>
                班会素材与德育活动全流程管理
              </p>
            </div>
            <button
              type="button"
              className="subview-btn"
              onClick={() => alert('素材导出：已生成《德育主题活动素材汇总包.zip》。')}
            >
              <FileText size={16} />
              导出素材
            </button>
          </div>

          <div className="alert-cards-grid">
            <div className="alert-card type-red">
              <div className="alert-card-top">
                <div
                  className="alert-icon-wrap"
                  style={{ background: '#fee2e2', color: '#dc2626' }}
                >
                  <BookOpen size={20} />
                </div>
                <div className="alert-number" style={{ color: '#dc2626' }}>
                  6
                </div>
              </div>
              <div className="alert-card-body">
                <h3>班会素材</h3>
                <p>套主题方案</p>
              </div>
            </div>

            <div className="alert-card type-yellow">
              <div className="alert-card-top">
                <div
                  className="alert-icon-wrap"
                  style={{ background: '#fef3c7', color: '#d97706' }}
                >
                  <Award size={20} />
                </div>
                <div className="alert-number" style={{ color: '#d97706' }}>
                  4
                </div>
              </div>
              <div className="alert-card-body">
                <h3>班级活动</h3>
                <p>项组织方案</p>
              </div>
            </div>

            <div className="alert-card type-yellow">
              <div className="alert-card-top">
                <div
                  className="alert-icon-wrap"
                  style={{ background: '#f3e8ff', color: '#7e22ce' }}
                >
                  <CalendarDays size={20} />
                </div>
                <div className="alert-number" style={{ color: '#7e22ce' }}>
                  4
                </div>
              </div>
              <div className="alert-card-body">
                <h3>本月排查</h3>
                <p>次已开展</p>
              </div>
            </div>

            <div className="alert-card type-yellow">
              <div className="alert-card-top">
                <div
                  className="alert-icon-wrap"
                  style={{ background: '#e0f2fe', color: '#0369a1' }}
                >
                  <GraduationCap size={20} />
                </div>
                <div className="alert-number" style={{ color: '#0369a1' }}>
                  12
                </div>
              </div>
              <div className="alert-card-body">
                <h3>德育融合</h3>
                <p>个历史育人素材</p>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '10px 0' }}>
            <span
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                background: '#fee2e2',
                color: '#b91c1c',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              🚩 爱国教育
            </span>
            <span
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                background: '#f1f5f9',
                color: '#475569',
                fontSize: 13,
              }}
            >
              ⚖️ 法治教育
            </span>
            <span
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                background: '#f1f5f9',
                color: '#475569',
                fontSize: 13,
              }}
            >
              🛡️ 安全教育
            </span>
            <span
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                background: '#f1f5f9',
                color: '#475569',
                fontSize: 13,
              }}
            >
              🌱 心理健康
            </span>
            <span
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                background: '#f1f5f9',
                color: '#475569',
                fontSize: 13,
              }}
            >
              🎯 励志成长
            </span>
            <span
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                background: '#dcfce7',
                color: '#15803d',
                fontSize: 13,
              }}
            >
              📜 史育融合
            </span>
          </div>

          <div className="student-health-cards-grid">
            <div className="student-health-card">
              <h3 style={{ margin: 0, fontSize: 16 }}>主题班会：《厚植家国情怀，书写时代华章》</h3>
              <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
                结合中国近代史民族觉醒历程，引导高一新生树立责任担当与时代使命感。
              </p>
              <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#0284c7' }}>
                <span>配套PPT · 24页</span>
                <span>活动方案 · 1份</span>
                <span>学习单 · 45份</span>
              </div>
              <button
                type="button"
                className="subview-btn"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => alert('已打开教案与PPT课件预览。')}
              >
                查看完整方案
              </button>
            </div>

            <div className="student-health-card">
              <h3 style={{ margin: 0, fontSize: 16 }}>史育融合：《从张謇实业救国看青年责任》</h3>
              <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
                历史学科与班级德育跨学科融合，结合选必历史工业化专题开展生涯启蒙与励志教育。
              </p>
              <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#0284c7' }}>
                <span>历史素养素材 · 5条</span>
                <span>讨论思考题 · 3道</span>
              </div>
              <button
                type="button"
                className="subview-btn"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => alert('已载入史育融合素材。')}
              >
                查看融合素材
              </button>
            </div>

            <div className="student-health-card">
              <h3 style={{ margin: 0, fontSize: 16 }}>安全防线：《知危险会避险 · 交通与防溺水》</h3>
              <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
                校园安全教育规范化班会，附周末离校安全知情同意书及应急处置推演流程。
              </p>
              <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#0284c7' }}>
                <span>安全警示短片 · 2部</span>
                <span>安全协议书 · 1份</span>
              </div>
              <button
                type="button"
                className="subview-btn"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => alert('已生成安全教育方案。')}
              >
                查看活动设计
              </button>
            </div>
          </div>
        </section>
      )}

      {/* 6. Floating Action Button (FAB) */}
      <button
        type="button"
        className={`workbench-fab ${copilotOpen ? 'active' : ''}`}
        aria-label="唤出AI班主任助手"
        title="唤出AI班主任助手"
        onClick={() => setCopilotOpen(!copilotOpen)}
      >
        <Sparkles size={24} />
      </button>

      {/* 7. AI Copilot Drawer ("AI班主任助手") */}
      <aside
        className={`copilot-drawer ${copilotOpen ? 'open' : ''}`}
        aria-label="AI班主任助手抽屉"
      >
        <div className="copilot-header">
          <div className="copilot-title-row">
            <div className="copilot-avatar-badge">
              <Sparkles size={18} />
            </div>
            <div className="copilot-title">
              <h3>AI班主任助手</h3>
              <p>当前页面 · {activeSubview === 'workbench' ? '工作台总览' : '班级专班工作'}</p>
            </div>
          </div>
          <button
            type="button"
            className="copilot-close-btn"
            aria-label="关闭助手抽屉"
            onClick={() => setCopilotOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <div className="copilot-tabs">
          <button
            type="button"
            className={`copilot-tab-btn ${copilotTab === 'speech' ? 'active' : ''}`}
            onClick={() => setCopilotTab('speech')}
          >
            话术生成
          </button>
          <button
            type="button"
            className={`copilot-tab-btn ${copilotTab === 'plan' ? 'active' : ''}`}
            onClick={() => setCopilotTab('plan')}
          >
            方案生成
          </button>
          <button
            type="button"
            className={`copilot-tab-btn ${copilotTab === 'analysis' ? 'active' : ''}`}
            onClick={() => setCopilotTab('analysis')}
          >
            分析建议
          </button>
          <button
            type="button"
            className={`copilot-tab-btn ${copilotTab === 'review' ? 'active' : ''}`}
            onClick={() => setCopilotTab('review')}
          >
            工作梳理
          </button>
        </div>

        <div className="copilot-body">
          <div className="copilot-hint-box">
            <Sparkles size={14} color="#16a34a" />
            <span>智能识别班级上下文，点击下方胶囊快速生成</span>
          </div>

          <div className="copilot-prompt-capsules">
            {currentPrompts.map((prompt, idx) => (
              <button
                key={idx}
                type="button"
                className="prompt-capsule"
                onClick={() => {
                  setCopilotInput(prompt);
                  handleSendCopilot(prompt);
                }}
              >
                {prompt}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
            {chatLog.map((msg, idx) => (
              <div
                key={idx}
                className="copilot-message-bubble"
                style={
                  msg.sender === 'user'
                    ? {
                        background: '#f1f5f9',
                        borderColor: '#e2e8f0',
                        color: '#1e293b',
                        alignSelf: 'flex-end',
                      }
                    : { whiteSpace: 'pre-wrap' }
                }
              >
                {msg.text}
              </div>
            ))}
          </div>
        </div>

        <div className="copilot-footer">
          <input
            type="text"
            className="copilot-input"
            value={copilotInput}
            onChange={(e) => setCopilotInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSendCopilot();
            }}
            placeholder="输入你的问题或管理需求..."
          />
          <button
            type="button"
            className="copilot-send-btn"
            aria-label="发送问题"
            onClick={() => handleSendCopilot()}
          >
            <Send size={15} />
          </button>
        </div>
      </aside>
    </div>
  );
}
