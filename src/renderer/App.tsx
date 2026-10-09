import { TeachingResources } from './features/resources/TeachingResources';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  FileText,
  FolderArchive,
  GraduationCap,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  UserRoundCheck,
  UserRoundMinus,
  UsersRound,
  X,
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  Eye,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  SquarePen,
  Trash2,
  XCircle,
} from 'lucide-react';
import type {
  DeepSeekCheckResult,
  DeepSeekCredentialStatus,
  DeepSeekLedgerSummary,
  DesktopApi,
  Result,
  RestorePreview,
  Snapshot,
  Student,
} from '../shared/contracts';
import metadata from '../../package.json';
import { ScorePage } from './ScorePage';
import { SeatingPage } from './SeatingPage';
import { DutyPage } from './DutyPage';
import { LessonPage } from './LessonPage';
import { ClassroomPage } from './ClassroomPage';
import { CountdownBanner } from './CountdownBanner';
import { GradingPage } from './GradingPage';
import { GrowthPage } from './GrowthPage';
import { DevicePage } from './DevicePage';
import { ModelSettingsPage } from './ModelSettingsPage';
import { ModelSelectionSummary } from './ModelSelectionSummary';
import { ConversationWorkspace } from './ConversationWorkspace';
import { FloatingAssistant } from './FloatingAssistant';
import { TeachingWorkbench } from './features/teaching/TeachingWorkbench';
import { ResourceHub } from './ResourceHub';
import { AttendancePage, StudentProfilesPage } from './PupilPages';
import { ClassDataImport, StudentDirectory } from './features/homeroom';
import type { GrowthSelection } from '../shared/growth';
import { RosterImportDialog } from './RosterImportDialog';
import {
  workspaceAreas,
  areaForView,
  viewLabel,
  WorkspaceHome,
  WorkspaceLinks,
  type AppView,
} from './WorkspaceNavigation';

declare global {
  interface Window {
    classManager: DesktopApi;
  }
}
type Notice = { text: string; error: boolean; code?: string };
type Modal =
  | { kind: 'class'; id?: string }
  | { kind: 'student'; student?: Student }
  | { kind: 'activation'; student: Student }
  | { kind: 'restore'; preview: RestorePreview; recovery?: boolean }
  | { kind: 'seed' }
  | { kind: 'deleteKey' };
const date = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

function Dialog({
  title,
  children,
  close,
  busy,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="dialog-header">
        <h2 id="modal-title">{title}</h2>
        <button
          type="button"
          className="icon-button"
          title="关闭"
          aria-label="关闭"
          onClick={close}
          disabled={busy}
        >
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<AppView>('classManagement');
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [view]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantExpanded, setAssistantExpanded] = useState(false);
  const [conversationMode, setConversationMode] = useState<'conversation' | 'sessions'>(
    'conversation',
  );
  const area = areaForView(view);
  const [navigationFeedback, setNavigationFeedback] = useState<{
    source: AppView;
    target: string;
  }>();
  const navigationFeedbackRef = useRef<HTMLDivElement>(null);
  const [scoreDirty, setScoreDirty] = useState(false);
  const [rosterImportOpen, setRosterImportOpen] = useState(false);

  const [selectedPupilId, setSelectedPupilId] = useState('');
  const [selectedScoreVersion] = useState('');
  const [growthScoreSeed, setGrowthScoreSeed] = useState<GrowthSelection['scores']>([]);
  const [rosterImportDirty, setRosterImportDirty] = useState(false);
  const [seatingDirty, setSeatingDirty] = useState(false);
  const [dutyDirty, setDutyDirty] = useState(false);
  const [lessonDirty, setLessonDirty] = useState(false);
  const [classroomDirty, setClassroomDirty] = useState(false);
  const [gradingDirty, setGradingDirty] = useState(false);
  const [growthDirty, setGrowthDirty] = useState(false);
  const [deviceDirty, setDeviceDirty] = useState(false);
  const [providerDirty, setProviderDirty] = useState(false);
  const [pupilDirty, setPupilDirty] = useState(false);
  const [workbenchDirty, setWorkbenchDirty] = useState(false);
  const [resourceDirty, setResourceDirty] = useState(false);
  const [conversationDirty, setConversationDirty] = useState(false);
  const [conversationRestoreNotice, setConversationRestoreNotice] = useState('');
  const [newConversationRequest, setNewConversationRequest] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const navigationDirty =
    rosterImportDirty ||
    scoreDirty ||
    seatingDirty ||
    dutyDirty ||
    lessonDirty ||
    classroomDirty ||
    gradingDirty ||
    growthDirty ||
    pupilDirty ||
    workbenchDirty ||
    resourceDirty ||
    deviceDirty ||
    providerDirty ||
    conversationDirty;
  const pendingViews: Array<[AppView, boolean]> = [
    ['roster', rosterImportDirty],
    ['scores', scoreDirty],
    ['seating', seatingDirty],
    ['duty', dutyDirty],
    ['lessons', lessonDirty],
    ['classroom', classroomDirty],
    ['grading', gradingDirty],
    ['growth', growthDirty],
    ['devices', deviceDirty],
    ['providerSettings', providerDirty],
    [view, pupilDirty],
    [view, workbenchDirty],
    [view, resourceDirty],
    ['conversation', conversationDirty],
  ];
  function canNavigate(target: string, preserveConversation = false): boolean {
    const pending = pendingViews.find(
      ([source, dirty]) => dirty && (!preserveConversation || source !== 'conversation'),
    );
    if (pending || busy || loading) {
      setNavigationFeedback({
        source: pending?.[0] ?? view,
        target,
      });
      requestAnimationFrame(() =>
        navigationFeedbackRef.current?.scrollIntoView({ block: 'nearest' }),
      );
      return false;
    }
    setNavigationFeedback(undefined);
    return true;
  }
  function navigate(next: AppView): boolean {
    if (next === 'conversation' || next === 'sessions') {
      setConversationMode(next === 'sessions' ? 'sessions' : 'conversation');
      setAssistantOpen(true);
      return true;
    }
    if (next === view) return true;
    if (!canNavigate(viewLabel(next), true)) return false;
    setView(next);
    return true;
  }
  function startNewConversation() {
    setAssistantOpen(true);
    if (conversationDirty) return;
    setConversationMode('conversation');
    setNewConversationRequest((value) => value + 1);
  }
  const [notice, setNotice] = useState<Notice>();
  const [modal, setModal] = useState<Modal>();
  const [classNameInput, setClassNameInput] = useState('');
  const [selectedClass, setSelectedClass] = useState('all');
  useEffect(() => {
    if (area?.id === 'classManagement' && selectedClass === 'all' && snapshot?.classes.length)
      setSelectedClass(snapshot.classes[0]!.id);
  }, [area?.id, selectedClass, snapshot]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(0);
  const [lastBackup, setLastBackup] = useState<string>();
  const [deepSeekStatus, setDeepSeekStatus] = useState<DeepSeekCredentialStatus>();
  const [deepSeekLedger, setDeepSeekLedger] = useState<DeepSeekLedgerSummary>();
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [testingType, setTestingType] = useState<'text' | 'vision' | null>(null);
  const [testResultText, setTestResultText] = useState<DeepSeekCheckResult | null>(null);
  const [testResultVision, setTestResultVision] = useState<DeepSeekCheckResult | null>(null);
  const checkTaskIdRef = useRef(0);
  const api = window.classManager;
  useEffect(() => {
    const changed = () => {
      void api.snapshot().then((result) => {
        if (result.ok) setSnapshot(result.value);
      });
    };
    window.addEventListener('cm:bridgeChanged', changed);
    return () => window.removeEventListener('cm:bridgeChanged', changed);
  }, [api]);

  async function loadDeepSeekData() {
    if (!api) return;
    const [statusRes, ledgerRes] = await Promise.all([
      api.getDeepSeekStatus(),
      api.getDeepSeekLedger(),
    ]);
    if (statusRes.ok) {
      setDeepSeekStatus(statusRes.value);
    }
    if (ledgerRes.ok) {
      setDeepSeekLedger(ledgerRes.value);
      setLedgerError(null);
    } else {
      setDeepSeekLedger(undefined);
      setLedgerError(ledgerRes.error.message);
    }
  }

  async function handleSaveKey(e: FormEvent) {
    e.preventDefault();
    const apiKeyToSave = keyInput.trim();
    // 立即清空输入框，无论后续成功或失败，绝不在组件状态中存留明文 Key
    setKeyInput('');
    if (!apiKeyToSave) return;

    // 递增任务版本，让任何旧账号在途检查任务彻底失效并取消在途调用
    checkTaskIdRef.current += 1;
    if (testingType !== null && api) {
      void api.cancelDeepSeekCheck();
      setTestingType(null);
    }
    setTestResultText(null);
    setTestResultVision(null);

    const success = await perform(
      () => api.saveDeepSeekKey({ apiKey: apiKeyToSave }),
      (statusValue) => {
        setDeepSeekStatus(statusValue);
        // 保存新凭据后彻底重置旧账号的测试结果，避免误认为新账号已验证
        setTestResultText(null);
        setTestResultVision(null);
      },
      'DeepSeek API Key 已安全加密存储。',
    );
    if (success) {
      void loadDeepSeekData();
    }
  }

  async function handleDeleteKey() {
    // 递增任务版本，让任何旧账号在途检查任务彻底失效并取消在途调用
    checkTaskIdRef.current += 1;
    if (testingType !== null && api) {
      void api.cancelDeepSeekCheck();
      setTestingType(null);
    }
    setTestResultText(null);
    setTestResultVision(null);

    const success = await perform(
      () => api.deleteDeepSeekKey(),
      () => {
        setDeepSeekStatus({ configured: false, maskedKey: null, updatedAt: null });
        setTestResultText(null);
        setTestResultVision(null);
      },
      '已清除保存的 API Key。',
    );
    if (success) {
      setModal(undefined);
      void loadDeepSeekData();
    }
  }

  async function handleCancelCheck() {
    checkTaskIdRef.current += 1;
    setTestingType(null);
    if (api) {
      const cancelRes = await api.cancelDeepSeekCheck();
      if (!cancelRes.ok) {
        setNotice({
          error: true,
          text: `取消操作失败: ${cancelRes.error.message}`,
          code: `${cancelRes.error.code} · ${cancelRes.error.operationId}`,
        });
        return;
      }
    }
    setNotice({ error: false, text: '已取消正在进行的检查任务。' });
  }

  async function handleCheckConnection(type: 'text' | 'vision') {
    const taskId = ++checkTaskIdRef.current;
    const initialCredentialTimestamp = deepSeekStatus?.updatedAt;
    setTestingType(type);
    setNotice(undefined);
    try {
      const res = await api.checkDeepSeek({ type });
      // 检查任务 ID 与凭据版本，若已被取消、更换 Key、删除 Key 或由新任务取代，则彻底丢弃响应与通知
      if (
        taskId !== checkTaskIdRef.current ||
        (initialCredentialTimestamp && deepSeekStatus?.updatedAt !== initialCredentialTimestamp)
      ) {
        return;
      }
      if (res.ok) {
        if (type === 'text') setTestResultText(res.value);
        else setTestResultVision(res.value);
        setNotice({ error: false, text: res.value.message });
      } else {
        const failedResult: DeepSeekCheckResult = {
          type,
          success: false,
          model: 'deepseek-flash',
          durationMs: 0,
          usage: null,
          message: res.error.message,
          timestamp: new Date().toISOString(),
          promptVersion: type === 'text' ? 'ping-v1' : 'synthetic-1x1-v1',
          credentialUpdatedAt: deepSeekStatus?.updatedAt,
        };
        if (type === 'text') setTestResultText(failedResult);
        else setTestResultVision(failedResult);
        setNotice({
          error: true,
          text: res.error.message,
          code: `${res.error.code} · ${res.error.operationId}`,
        });
      }
      void loadDeepSeekData();
    } catch {
      if (taskId === checkTaskIdRef.current) {
        setNotice({ error: true, text: '连接测试失败或被中断。' });
      }
    } finally {
      if (taskId === checkTaskIdRef.current) {
        setTestingType(null);
      }
    }
  }

  async function perform<T>(
    request: () => Promise<Result<T>>,
    accept: (value: T) => void,
    message?: string,
  ): Promise<boolean> {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await request();
      if (!result.ok) {
        setNotice({
          error: true,
          text: result.error.message,
          code: `${result.error.code} · ${result.error.operationId}`,
        });
        return false;
      }
      accept(result.value);
      if (message) setNotice({ error: false, text: message });
      return true;
    } catch {
      setNotice({ error: true, text: '桌面连接中断。请保留数据，退出后重新打开。' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function acceptSnapshot(value: Snapshot) {
    setSnapshot(value);
    setSelectedClass((current) =>
      current === 'all' || value.classes.some((item) => item.id === current) ? current : 'all',
    );
  }
  useEffect(() => {
    let mounted = true;
    if (!api) {
      setLoading(false);
      setNotice({ error: true, text: '请从桌面客户端启动，浏览器不提供本机数据接口。' });
      return;
    }
    api
      .snapshot()
      .then((result) => {
        if (!mounted) return;
        if (result.ok) setSnapshot(result.value);
        else
          setNotice({
            error: true,
            text: result.error.message,
            code: `${result.error.code} · ${result.error.operationId}`,
          });
      })
      .catch(() => {
        if (mounted)
          setNotice({ error: true, text: '本地数据服务未能启动，请保留数据并导出诊断。' });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [api]);

  const filtered =
    snapshot?.students.filter(
      (student) =>
        (selectedClass === 'all' || student.classId === selectedClass) &&
        (status === 'all' || student.active === (status === 'active')) &&
        `${student.displayName} ${student.studentNumber}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    ) ?? [];
  const pageCount = Math.max(1, Math.ceil(filtered.length / 15));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(currentPage * 15, (currentPage + 1) * 15);
  const disabled = busy || loading || !snapshot || navigationDirty;

  async function submitClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || modal?.kind !== 'class') return;
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (!name) {
      setNotice({ error: true, text: '请输入班级名称，不能只填写空格。' });
      return;
    }
    const current = snapshot.classes.find((item) => item.id === modal.id);
    const success = await perform(
      () =>
        current
          ? api.renameClass({
              epoch: snapshot.epoch,
              id: current.id,
              expectedRevision: current.revision,
              name,
            })
          : api.createClass({ epoch: snapshot.epoch, name }),
      (value) => {
        acceptSnapshot(value);
        if (!current) {
          const created = value.classes.find(
            (c) => !snapshot.classes.some((old) => old.id === c.id),
          );
          if (created) setSelectedClass(created.id);
        }
      },
      '班级已保存。',
    );
    if (success) setModal(undefined);
  }

  function openClass(id?: string) {
    setClassNameInput(snapshot?.classes.find((item) => item.id === id)?.name ?? '');
    setModal({ kind: 'class', id });
  }

  async function submitStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || modal?.kind !== 'student') return;
    const data = new FormData(event.currentTarget);
    const current = modal.student;
    const success = await perform(
      () =>
        api.saveStudent({
          epoch: snapshot.epoch,
          id: current?.id,
          expectedRevision: current?.revision,
          classId: String(data.get('classId')),
          studentNumber: String(data.get('studentNumber')),
          displayName: String(data.get('displayName')),
        }),
      acceptSnapshot,
      '学生记录已保存。',
    );
    if (success) setModal(undefined);
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} data-view={view}>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="brand">
            <span className="brand-mark">
              <GraduationCap size={22} />
            </span>
            <div>
              班级助手<small>教师工作台</small>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-toggle-btn"
            title="收起侧边栏"
            aria-label="收起侧边栏"
            onClick={() => setSidebarCollapsed(true)}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <div className="environment">
          <span className="dot" />
          Windows · 本地智能体<span className="version">v1.0</span>
        </div>
        <nav aria-label="主导航" className="primary-navigation">
          {workspaceAreas.map((item) => (
            <button
              key={item.id}
              className={area?.id === item.id ? 'nav-item selected' : 'nav-item'}
              aria-current={area?.id === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={22} className="nav-item-icon" />
              <span className="nav-item-text">{item.label}</span>
              <ChevronRight size={13} className="nav-item-arrow" />
            </button>
          ))}
        </nav>
        <section className="class-navigation" hidden={area?.id !== 'classManagement'}>
          <div className="section-label">
            班级 <span>{snapshot?.classes.length ?? 0}</span>
            <button
              className="icon-button"
              title="新建班级"
              aria-label="新建班级"
              disabled={disabled}
              onClick={() => openClass()}
            >
              <Plus size={17} />
            </button>
          </div>
          {snapshot?.classes.map((classroom) => (
            <div className="class-nav-row" key={classroom.id}>
              <button
                className={`class-nav ${selectedClass === classroom.id ? 'current' : ''}`}
                onClick={() => {
                  if (!canNavigate('班级名册')) return;
                  setView('roster');
                  setSelectedClass(classroom.id);
                  setPage(0);
                }}
              >
                <span className="class-dot" />
                <span>{classroom.name}</span>
                <small>
                  {
                    snapshot.students.filter(
                      (student) => student.classId === classroom.id && student.active,
                    ).length
                  }
                </small>
              </button>
              <button
                className="icon-button rename"
                title={`重命名 ${classroom.name}`}
                aria-label={`重命名 ${classroom.name}`}
                disabled={disabled}
                onClick={() => openClass(classroom.id)}
              >
                <Pencil size={13} />
              </button>
            </div>
          ))}
        </section>
        <button className="sidebar-guide" onClick={() => navigate('settings')}>
          <strong>{area?.id === 'classManagement' ? '一份资料，全班共用' : '第一次使用？'}</strong>
          <span>
            {area?.id === 'classManagement'
              ? '学生信息与成绩导入后，在各功能中直接选用。'
              : '三步准备好工作台'}
          </span>
          <small>查看入门引导 →</small>
        </button>
        <div className="sidebar-bottom">
          <ShieldCheck size={17} />
          <span>
            Class Manager<small>本地就绪 · 隐私防护</small>
          </span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="topbar-left">
            {sidebarCollapsed && (
              <div className="topbar-collapsed-controls">
                <button
                  type="button"
                  className="sidebar-toggle-btn topbar-toggle"
                  title="展开侧边栏"
                  aria-label="展开侧边栏"
                  onClick={() => setSidebarCollapsed(false)}
                >
                  <PanelLeftOpen size={18} />
                </button>
                <button
                  type="button"
                  className="topbar-new-chat-btn"
                  title="开启新对话"
                  aria-label="开启新对话"
                  onClick={startNewConversation}
                >
                  <SquarePen size={18} />
                </button>
              </div>
            )}
            <div className="breadcrumb">
              <span>
                {area?.label ??
                  (view === 'conversation' || view === 'sessions' ? '智能对话' : viewLabel(view))}
              </span>
            </div>
            {snapshot && snapshot.classes.length > 0 && area?.id === 'classManagement' && (
              <div className="current-class-badge" title="当前管理班级">
                <span className="current-class-label">当前管理：</span>
                <select
                  className="current-class-select"
                  aria-label="工作台当前管理班级"
                  disabled={navigationDirty}
                  value={selectedClass}
                  onChange={(e) => setSelectedClass(e.target.value)}
                >
                  <option value="all">
                    全部班级 ({snapshot.students.filter((s) => s.active).length}人在籍)
                  </option>
                  {snapshot.classes.map((c) => {
                    const count = snapshot.students.filter(
                      (s) => s.classId === c.id && s.active,
                    ).length;
                    return (
                      <option key={c.id} value={c.id}>
                        {c.name} ({count}人在籍)
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
          </div>
          <span className="local-status">
            <span className="dot" />
            {busy ? '处理中' : snapshot ? '本地就绪' : '未就绪'}
          </span>
        </header>
        <div className="content">
          {navigationFeedback && (navigationDirty || busy || loading) && (
            <div className="navigation-feedback" role="status" ref={navigationFeedbackRef}>
              <div>
                <strong>先完成{viewLabel(navigationFeedback.source)}中的当前操作</strong>
                <p>
                  内容尚未保存或操作仍在进行。请先保存、清空未保存输入或取消当前任务，再打开
                  {navigationFeedback.target}。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (navigationFeedback.source === 'conversation') setAssistantOpen(true);
                  else setView(navigationFeedback.source);
                  setNavigationFeedback(undefined);
                }}
              >
                返回{viewLabel(navigationFeedback.source)}
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">CLASS MANAGER / M1</div>
              <h1>
                {view === 'teaching' || view === 'resourceLibrary'
                  ? '教学资源库'
                  : view === 'classManagement'
                    ? '班主任工作台'
                    : view === 'lessons'
                      ? '从手边资料，开始一节课'
                      : view === 'conversation'
                        ? '教学事务，交给你的助手'
                        : view === 'sessions'
                          ? '继续上一次的工作'
                          : viewLabel(view)}
              </h1>
              <p className="page-description">
                {view === 'teaching' || view === 'resourceLibrary'
                  ? '按学科与教材章节整理教学资源，编辑模板并添加本机资料。'
                  : view === 'classManagement'
                    ? '先准备班级资料，再逐步处理点名、成绩和日常安排。'
                    : view === 'conversation'
                      ? '说出需要做的事，助手先梳理步骤，关键操作由你确认。'
                      : view === 'sessions'
                        ? '会话管理已经合并到智能对话，查找和继续都在这里。'
                        : (area?.entries.find((entry) => entry.view === view)?.description ??
                          area?.description)}
              </p>
            </div>
            <div className="heading-actions">
              {view === 'sessions' && (
                <button className="primary" disabled={disabled} onClick={startNewConversation}>
                  新建会话
                </button>
              )}
              {view === 'roster' && (
                <button
                  className="icon-button outlined"
                  title="创建班级"
                  aria-label="创建班级"
                  disabled={disabled}
                  onClick={() => openClass()}
                >
                  <GraduationCap size={18} />
                </button>
              )}
              <button
                className="icon-button outlined"
                title="重新读取数据"
                aria-label="重新读取数据"
                disabled={busy || loading || !api || navigationDirty}
                onClick={() => {
                  if (view === 'modelSettings') {
                    void loadDeepSeekData();
                  } else {
                    void perform(() => api.snapshot(), acceptSnapshot, '已重新读取本地数据。');
                  }
                }}
              >
                <RefreshCw size={17} />
              </button>
              {view === 'roster' && (
                <button
                  className="primary"
                  disabled={disabled || !snapshot.classes.length}
                  onClick={() => setModal({ kind: 'student' })}
                >
                  <Plus size={17} />
                  添加学生
                </button>
              )}
            </div>
          </div>
          {notice && (
            <div
              className={`notice workspace-feedback ${notice.error ? 'error' : 'success'}`}
              role={notice.error ? 'alert' : 'status'}
            >
              {notice.error ? <CircleAlert size={18} /> : <Check size={18} />}
              <div>
                {notice.text}
                {notice.code && <small>{notice.code}</small>}
              </div>
              <button
                className="icon-button"
                aria-label="关闭提示"
                title="关闭提示"
                onClick={() => setNotice(undefined)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {loading && (
            <div className="empty-state">
              <LoaderCircle className="spin" size={26} />
              <h2>正在读取本地数据</h2>
            </div>
          )}
          {!loading && !snapshot && (
            <div className="empty-state">
              <Database size={36} />
              <h2>数据未就绪</h2>
              <button
                disabled={busy || !api}
                onClick={() =>
                  void perform(
                    () => api.exportDiagnostics(),
                    (receipt) => {
                      setNotice({
                        error: false,
                        text: receipt ? `诊断已保存：${receipt.path}` : '已取消导出。',
                      });
                    },
                  )
                }
              >
                <ArrowDownToLine size={16} />
                导出诊断
              </button>
            </div>
          )}
          {snapshot && view !== 'classManagement' && view !== 'students' && (
            <WorkspaceLinks
              view={view}
              onNavigate={navigate}
              disabled={
                busy ||
                loading ||
                pendingViews.some(([source, dirty]) => source !== 'conversation' && dirty)
              }
            />
          )}
          {snapshot && area?.id === view && view !== 'classManagement' && view !== 'teaching' && (
            <WorkspaceHome area={area} onNavigate={navigate} />
          )}
          {snapshot && area?.id === 'classManagement' && (
            <TeachingWorkbench
              key={`homeroom-workbench:${snapshot.epoch}`}
              snapshot={snapshot}
              selectedClass={selectedClass}
              onSnapshot={setSnapshot}
              onDirtyChange={setWorkbenchDirty}
              view={view}
              onNavigate={navigate}
              onSelectClass={setSelectedClass}
              navigationBusy={navigationDirty}
              onImport={() => navigate('classImport')}
            >
              {view === 'classImport' && (
                <ClassDataImport
                  key={selectedClass}
                  snapshot={snapshot}
                  classId={
                    selectedClass === 'all' ? (snapshot.classes[0]?.id ?? '') : selectedClass
                  }
                  onSelectClass={setSelectedClass}
                  onCreateClass={() => openClass()}
                  onSaved={(saved) => {
                    acceptSnapshot(saved);
                    setView('classManagement');
                    setNotice({ error: false, text: '学生信息与成绩已保存，各页面可直接使用。' });
                  }}
                  onClose={() => navigate('classManagement')}
                  onDirtyChange={setRosterImportDirty}
                  onNavigate={navigate}
                />
              )}
              {snapshot && view === 'students' && (
                <StudentDirectory
                  key={`shared-students:${snapshot.epoch}:${selectedClass}`}
                  snapshot={snapshot}
                  selectedClass={selectedClass}
                  initialStudentId={selectedPupilId}
                  onNavigate={navigate}
                  onSelectStudent={setSelectedPupilId}
                  onEditProfile={(id) => {
                    setSelectedPupilId(id);
                    navigate('profiles');
                  }}
                  onAddStudent={() => setModal({ kind: 'student' })}
                  onEditStudent={(student) => setModal({ kind: 'student', student })}
                  onImport={() => {
                    navigate('classImport');
                  }}
                  onGrowth={(id, scores) => {
                    setSelectedPupilId(id);
                    setGrowthScoreSeed(scores);
                    navigate('growth');
                  }}
                />
              )}
              {snapshot && view === 'attendance' && (
                <AttendancePage
                  key={`attendance:${snapshot.epoch}`}
                  snapshot={snapshot}
                  selectedClass={selectedClass}
                  onRoster={() => setView('roster')}
                  onDirtyChange={setPupilDirty}
                />
              )}
              {snapshot && view === 'profiles' && (
                <StudentProfilesPage
                  key={`profiles:${snapshot.epoch}:${selectedClass}:${selectedPupilId}`}
                  initialStudentId={selectedPupilId}
                  snapshot={snapshot}
                  selectedClass={selectedClass}
                  onDirtyChange={setPupilDirty}
                />
              )}
              {snapshot && view === 'growth' && (
                <GrowthPage
                  key={`growth:${snapshot.epoch}:${selectedClass}:${selectedPupilId}`}
                  selectedClass={selectedClass}
                  initialStudentId={selectedPupilId}
                  initialScores={growthScoreSeed}
                  snapshot={snapshot}
                  onDirtyChange={setGrowthDirty}
                  navigationBusy={busy || loading}
                />
              )}
              {snapshot && ['growth', 'scores'].includes(view) && (
                <ModelSelectionSummary key={`model:${view}:${snapshot.epoch}`} />
              )}
              {snapshot && view === 'seating' && (
                <SeatingPage
                  key={`seating:${snapshot.epoch}:${selectedClass}`}
                  selectedClass={selectedClass}
                  snapshot={snapshot}
                  onDirtyChange={setSeatingDirty}
                  navigationBusy={busy}
                />
              )}
              {snapshot && view === 'duty' && (
                <DutyPage
                  key={`duty:${snapshot.epoch}:${selectedClass}`}
                  selectedClass={selectedClass}
                  snapshot={snapshot}
                  onDirtyChange={setDutyDirty}
                  navigationBusy={busy || loading}
                />
              )}
              {snapshot && view === 'scores' && (
                <ScorePage
                  key={`scores:${snapshot.epoch}:${selectedClass}:${selectedScoreVersion}`}
                  selectedClass={selectedClass}
                  initialVersionId={selectedScoreVersion}
                  onUnifiedImport={() => {
                    navigate('classImport');
                  }}
                  snapshot={snapshot}
                  onDirtyChange={setScoreDirty}
                  navigationBusy={busy || loading}
                  onRoster={() => navigate('roster')}
                />
              )}
              {snapshot && view === 'roster' && (
                <>
                  <section className="design-panel roster-panel">
                    <header>
                      <div>
                        <h2>学生名单</h2>
                        <p>
                          共 {snapshot.students.filter((student) => student.active).length}{' '}
                          人在籍，资料保存在本机。
                        </p>
                      </div>
                      <button
                        disabled={disabled || !snapshot.classes.length}
                        onClick={() => setRosterImportOpen(true)}
                      >
                        <FileText size={16} />
                        批量导入学生
                      </button>
                    </header>
                    <div className="roster-toolbar">
                      <label className="search">
                        <Search size={17} />
                        <input
                          aria-label="搜索学生"
                          placeholder="搜索姓名或编号"
                          value={search}
                          onChange={(event) => {
                            setSearch(event.target.value);
                            setPage(0);
                          }}
                        />
                      </label>
                      <select
                        aria-label="筛选班级"
                        value={selectedClass}
                        onChange={(event) => {
                          setSelectedClass(event.target.value);
                          setPage(0);
                        }}
                      >
                        <option value="all">全部班级</option>
                        {snapshot.classes.map((classroom) => (
                          <option key={classroom.id} value={classroom.id}>
                            {classroom.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="筛选状态"
                        value={status}
                        onChange={(event) => {
                          setStatus(event.target.value);
                          setPage(0);
                        }}
                      >
                        <option value="active">在籍</option>
                        <option value="inactive">停用</option>
                        <option value="all">全部状态</option>
                      </select>
                      <span className="result-count">共 {filtered.length} 条</span>
                      {selectedClass !== 'all' && (
                        <button
                          aria-label={`重命名 ${snapshot.classes.find((item) => item.id === selectedClass)?.name ?? '班级'}`}
                          disabled={disabled}
                          onClick={() => openClass(selectedClass)}
                        >
                          <Pencil size={16} /> 编辑班级名称
                        </button>
                      )}
                    </div>
                    {snapshot.classes.length === 0 ? (
                      <div className="empty-state">
                        <UsersRound size={40} />
                        <h2>尚无班级</h2>
                        <div className="button-row">
                          <button disabled={busy} onClick={() => openClass()}>
                            <Plus size={16} />
                            创建班级
                          </button>
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() => setModal({ kind: 'seed' })}
                          >
                            <Database size={16} />
                            载入合成样例
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th className="number-cell">序号</th>
                              <th>学生姓名</th>
                              <th>学生编号</th>
                              <th>所属班级</th>
                              <th>状态</th>
                              <th className="actions-cell">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {!rows.length && (
                              <tr>
                                <td colSpan={6}>
                                  <div className="empty-state" role="status">
                                    <p>未找到符合筛选条件的学生，已保存的名单仍在。</p>
                                    <button
                                      onClick={() => {
                                        setSearch('');
                                        setStatus('all');
                                        setPage(0);
                                      }}
                                    >
                                      清空搜索和状态筛选
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            )}
                            {rows.map((student, index) => (
                              <tr key={student.id}>
                                <td className="number-cell">
                                  {String(currentPage * 15 + index + 1).padStart(2, '0')}
                                </td>
                                <td>
                                  <span className="student-name">
                                    <span className="avatar">
                                      <UserRound size={16} />
                                    </span>
                                    {student.displayName}
                                  </span>
                                </td>
                                <td className="student-number">{student.studentNumber}</td>
                                <td>{student.className}</td>
                                <td>
                                  <span
                                    className={`status-badge ${student.active ? 'active' : ''}`}
                                  >
                                    <span />
                                    {student.active ? '在籍' : '停用'}
                                  </span>
                                </td>
                                <td>
                                  <div className="row-actions">
                                    <button
                                      className="icon-button"
                                      title={`编辑 ${student.displayName}`}
                                      aria-label={`编辑 ${student.studentNumber}`}
                                      disabled={busy}
                                      onClick={() => setModal({ kind: 'student', student })}
                                    >
                                      <Pencil size={16} />
                                    </button>
                                    <button
                                      className="icon-button"
                                      title={`${student.active ? '停用' : '恢复在籍'} ${student.displayName}`}
                                      aria-label={`${student.active ? '停用' : '恢复在籍'} ${student.studentNumber}`}
                                      disabled={busy}
                                      onClick={() => setModal({ kind: 'activation', student })}
                                    >
                                      {student.active ? (
                                        <UserRoundMinus size={16} />
                                      ) : (
                                        <UserRoundCheck size={16} />
                                      )}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {rows.length === 0 && (
                          <div className="empty-results">没有匹配的学生记录</div>
                        )}
                      </div>
                    )}
                    {snapshot.classes.length > 0 && (
                      <footer className="table-footer">
                        <span>班级名册 · 本机保存</span>
                        <div className="pagination">
                          <button
                            className="icon-button"
                            title="上一页"
                            aria-label="上一页"
                            disabled={currentPage === 0}
                            onClick={() => setPage(currentPage - 1)}
                          >
                            <ArrowLeft size={16} />
                          </button>
                          <span>
                            {currentPage + 1} / {pageCount}
                          </span>
                          <button
                            className="icon-button"
                            title="下一页"
                            aria-label="下一页"
                            disabled={currentPage + 1 >= pageCount}
                            onClick={() => setPage(currentPage + 1)}
                          >
                            <ArrowRight size={16} />
                          </button>
                        </div>
                      </footer>
                    )}
                  </section>
                  {rosterImportOpen && (
                    <RosterImportDialog
                      snapshot={snapshot}
                      initialClass={selectedClass}
                      onSaved={(saved) => {
                        acceptSnapshot(saved);
                        setNotice({ error: false, text: '学生名单已导入，可在名册核对学生数量。' });
                      }}
                      onClose={() => setRosterImportOpen(false)}
                      onDirtyChange={setRosterImportDirty}
                    />
                  )}
                </>
              )}
            </TeachingWorkbench>
          )}
          {snapshot && area?.id === 'teaching' && (
            <TeachingResources
              snapshot={snapshot}
              view={view}
              onNavigate={navigate}
              onDirtyChange={setResourceDirty}
            >
              {view === 'resources' && <ResourceHub />}
              {view === 'lessons' && (
                <LessonPage
                  key={`lessons:${snapshot.epoch}`}
                  snapshot={snapshot}
                  onDirtyChange={setLessonDirty}
                  navigationBusy={busy || loading}
                />
              )}
              {view === 'classroom' && (
                <ClassroomPage
                  key={`classroom:${snapshot.epoch}`}
                  snapshot={snapshot}
                  navigationBusy={busy || loading}
                  onDirtyChange={setClassroomDirty}
                />
              )}
              {view === 'grading' && (
                <GradingPage
                  key={`grading:${snapshot.epoch}`}
                  snapshot={snapshot}
                  onDirtyChange={setGradingDirty}
                  navigationBusy={busy || loading}
                />
              )}
              {['grading', 'lessons'].includes(view) && (
                <ModelSelectionSummary key={`model:${view}:${snapshot.epoch}`} />
              )}
            </TeachingResources>
          )}
          {snapshot && (
            <CountdownBanner key={`countdown:${snapshot.epoch}`} epoch={snapshot.epoch} />
          )}
          {snapshot && view === 'providerSettings' && (
            <ModelSettingsPage
              onDirtyChange={setProviderDirty}
              onDiagnostics={() => navigate('maintenance')}
              onLegacy={() => {
                setView('modelSettings');
                void loadDeepSeekData();
              }}
            />
          )}
          {snapshot && view === 'devices' && (
            <DevicePage
              key={`devices:${snapshot.epoch}`}
              snapshot={snapshot}
              onDirtyChange={setDeviceDirty}
              navigationBusy={busy || loading}
            />
          )}
          {snapshot && view === 'maintenance' && (
            <div className="maintenance">
              <section className="maintenance-section">
                <div className="maintenance-title">
                  <Database size={21} />
                  <h2>本地数据</h2>
                </div>
                <dl>
                  <div>
                    <dt>数据目录</dt>
                    <dd className="path">{snapshot.dataDirectory}</dd>
                  </div>
                  <div>
                    <dt>数据版本</dt>
                    <dd>Schema {snapshot.schemaVersion}</dd>
                  </div>
                  <div>
                    <dt>本机保留副本</dt>
                    <dd>{snapshot.recoveryCopies} 份</dd>
                  </div>
                  <div>
                    <dt>验证附件</dt>
                    <dd>{snapshot.assets.length} 份</dd>
                  </div>
                </dl>
                <div className="button-row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () => api.addSyntheticAsset({ epoch: snapshot.epoch }),
                        acceptSnapshot,
                        '合成验证附件已保存。',
                      )
                    }
                  >
                    <FileText size={16} />
                    添加合成验证附件
                  </button>
                </div>
                {snapshot.assets.length > 0 && (
                  <ul className="asset-list">
                    {snapshot.assets.map((asset) => (
                      <li key={asset.id}>
                        <FileText size={15} />
                        <span>{asset.name}</span>
                        <small>{asset.bytes} B</small>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="maintenance-section">
                <div className="maintenance-title">
                  <FolderArchive size={21} />
                  <h2>备份与恢复</h2>
                </div>
                <dl>
                  <div>
                    <dt>本次会话最近备份</dt>
                    <dd className="path">{lastBackup ?? '尚未导出'}</dd>
                  </div>
                  <div>
                    <dt>备份格式</dt>
                    <dd>.cmbackup · 不含模型凭据</dd>
                  </div>
                </dl>
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () => api.saveBackup({ epoch: snapshot.epoch }),
                        (receipt) => {
                          if (receipt) setLastBackup(receipt.path);
                          setNotice({
                            error: false,
                            text: receipt ? '备份已保存。' : '已取消备份保存。',
                          });
                        },
                      )
                    }
                  >
                    <ArrowDownToLine size={16} />
                    导出备份
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () => api.previewRestore(),
                        (preview) => {
                          if (preview) setModal({ kind: 'restore', preview });
                          else setNotice({ error: false, text: '已取消选择备份。' });
                        },
                      )
                    }
                  >
                    <Archive size={16} />
                    选择备份恢复
                  </button>
                  <button
                    disabled={busy || snapshot.recoveryCopies === 0}
                    onClick={() =>
                      void perform(
                        () => api.previewRecovery(),
                        (preview) => {
                          setModal({ kind: 'restore', preview, recovery: true });
                        },
                      )
                    }
                  >
                    <RefreshCw size={16} />
                    回退到恢复前
                  </button>
                </div>
              </section>
              <section className="maintenance-section">
                <div className="maintenance-title">
                  <ShieldCheck size={21} />
                  <h2>诊断信息</h2>
                </div>
                <dl>
                  <div>
                    <dt>包含内容</dt>
                    <dd>程序版本、记录数量、错误编号、模型响应校验与重试信息</dd>
                  </div>
                  <div>
                    <dt>排除内容</dt>
                    <dd>姓名、学生编号、附件与模型正文、完整路径、密钥</dd>
                  </div>
                </dl>
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () => api.exportDiagnostics(),
                      (receipt) => {
                        setNotice({
                          error: false,
                          text: receipt ? `诊断已保存：${receipt.path}` : '已取消导出。',
                        });
                      },
                    )
                  }
                >
                  <ArrowDownToLine size={16} />
                  导出诊断
                </button>
              </section>
            </div>
          )}
          {view === 'modelSettings' && (
            <div className="maintenance-view">
              <section className="settings-section">
                <div className="maintenance-title">
                  <KeyRound size={21} />
                  <h2>DeepSeek API 凭据</h2>
                </div>
                <dl>
                  <div>
                    <dt>存储状态</dt>
                    <dd>
                      {deepSeekStatus?.configured ? (
                        <span className="settings-badge configured">
                          <CheckCircle2 size={13} /> 已加密存储
                        </span>
                      ) : (
                        <span className="settings-badge unconfigured">
                          <CircleAlert size={13} /> 未配置密钥
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>当前凭据掩码</dt>
                    <dd className="path">
                      {deepSeekStatus?.configured
                        ? (deepSeekStatus.maskedKey ?? '已配置')
                        : '暂无凭据'}
                    </dd>
                  </div>
                  <div>
                    <dt>最后更新时间</dt>
                    <dd>{deepSeekStatus?.updatedAt ? date(deepSeekStatus.updatedAt) : '未记录'}</dd>
                  </div>
                  <div>
                    <dt>安全防护说明</dt>
                    <dd>
                      使用系统级安全存储（Windows
                      DPAPI）加密保存在本地。不进入名册备份、不进入诊断报告、不写入普通业务数据库，输入后不可读回明文。
                    </dd>
                  </div>
                </dl>
                <form className="settings-form" onSubmit={(e) => void handleSaveKey(e)}>
                  <input
                    className="settings-input"
                    type="password"
                    autoComplete="off"
                    placeholder="输入或粘贴 DeepSeek API Key (如 sk-...)"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    disabled={busy}
                  />
                  <button type="submit" className="primary" disabled={busy || !keyInput.trim()}>
                    <KeyRound size={16} />
                    保存并加密存储
                  </button>
                  {deepSeekStatus?.configured && (
                    <button
                      type="button"
                      className="danger-button"
                      disabled={busy}
                      onClick={() => setModal({ kind: 'deleteKey' })}
                    >
                      <Trash2 size={16} />
                      清除已存凭据
                    </button>
                  )}
                </form>
              </section>

              <section className="settings-section">
                <div className="maintenance-title">
                  <Sparkles size={21} />
                  <h2>双通道连接检查 (模型连通性诊断)</h2>
                </div>
                <div
                  className="banner-alert"
                  style={{
                    background: 'var(--primary-subtle)',
                    borderColor: 'rgba(23,122,98,0.2)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <ShieldCheck size={18} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                  <div>
                    连接测试向官方接口发起轻量握手验证。文本与视觉通道分别独立测试，确保各项能力正常。
                  </div>
                </div>

                <div className="test-grid">
                  <div className="test-card">
                    <div className="test-card-header">
                      <h3>
                        <FileText size={16} /> 文本模型检查
                      </h3>
                      <span className="test-model-tag">deepseek-flash</span>
                    </div>
                    <p className="test-card-desc">
                      向官方 Chat Completions 接口发送微型合成 Ping 消息，验证文本生成与认证可用性。
                    </p>
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          !deepSeekStatus?.configured ||
                          (testingType !== null && testingType !== 'text')
                        }
                        onClick={() => void handleCheckConnection('text')}
                      >
                        {testingType === 'text' ? (
                          <>
                            <LoaderCircle size={15} className="spin" /> 正在检查文本模型...
                          </>
                        ) : (
                          <>
                            <FileText size={15} /> 检查文本模型连通性
                          </>
                        )}
                      </button>
                      {testingType === 'text' && (
                        <button
                          type="button"
                          className="danger-button"
                          onClick={() => void handleCancelCheck()}
                        >
                          取消检查
                        </button>
                      )}
                    </div>
                    {testResultText &&
                      deepSeekStatus?.configured &&
                      (!testResultText.credentialUpdatedAt ||
                        testResultText.credentialUpdatedAt === deepSeekStatus.updatedAt) && (
                        <div
                          className={`test-result-box ${testResultText.success ? 'success' : 'failure'}`}
                        >
                          <div className="test-result-header">
                            {testResultText.success ? (
                              <CheckCircle2 size={16} />
                            ) : (
                              <XCircle size={16} />
                            )}
                            <span>{testResultText.message}</span>
                          </div>
                          {testResultText.success && (
                            <div className="test-result-details">
                              <span>
                                <Clock size={13} /> 耗时: {testResultText.durationMs}ms
                              </span>
                              <span>
                                <Cpu size={13} /> 响应模型: {testResultText.model}
                              </span>
                              {testResultText.usage && (
                                <span>
                                  <Coins size={13} /> Token:{' '}
                                  {testResultText.usage.totalTokens ?? '未知'} (Prompt:{' '}
                                  {testResultText.usage.promptTokens ?? '未知'}, Comp:{' '}
                                  {testResultText.usage.completionTokens ?? '未知'})
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                  </div>

                  <div className="test-card">
                    <div className="test-card-header">
                      <h3>
                        <Eye size={16} /> 视觉多模态检查
                      </h3>
                      <span className="test-model-tag">deepseek-flash (Vision)</span>
                    </div>
                    <p className="test-card-desc">
                      发送微型合成透明图片与简短提示词，验证 Flash 多模态图像理解与阅卷通道。
                    </p>
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          !deepSeekStatus?.configured ||
                          (testingType !== null && testingType !== 'vision')
                        }
                        onClick={() => void handleCheckConnection('vision')}
                      >
                        {testingType === 'vision' ? (
                          <>
                            <LoaderCircle size={15} className="spin" /> 正在检查视觉模型...
                          </>
                        ) : (
                          <>
                            <Eye size={15} /> 检查视觉模型连通性
                          </>
                        )}
                      </button>
                      {testingType === 'vision' && (
                        <button
                          type="button"
                          className="danger-button"
                          onClick={() => void handleCancelCheck()}
                        >
                          取消检查
                        </button>
                      )}
                    </div>
                    {testResultVision &&
                      deepSeekStatus?.configured &&
                      (!testResultVision.credentialUpdatedAt ||
                        testResultVision.credentialUpdatedAt === deepSeekStatus.updatedAt) && (
                        <div
                          className={`test-result-box ${testResultVision.success ? 'success' : 'failure'}`}
                        >
                          <div className="test-result-header">
                            {testResultVision.success ? (
                              <CheckCircle2 size={16} />
                            ) : (
                              <XCircle size={16} />
                            )}
                            <span>{testResultVision.message}</span>
                          </div>
                          {testResultVision.success && (
                            <div className="test-result-details">
                              <span>
                                <Clock size={13} /> 耗时: {testResultVision.durationMs}ms
                              </span>
                              <span>
                                <Cpu size={13} /> 响应模型: {testResultVision.model}
                              </span>
                              {testResultVision.usage && (
                                <span>
                                  <Coins size={13} /> Token:{' '}
                                  {testResultVision.usage.totalTokens ?? '未知'} (Prompt:{' '}
                                  {testResultVision.usage.promptTokens ?? '未知'}, Comp:{' '}
                                  {testResultVision.usage.completionTokens ?? '未知'})
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <div className="maintenance-title">
                  <Coins size={21} />
                  <h2>用量与调用账本</h2>
                </div>

                {ledgerError ? (
                  <div className="test-result-box failure">
                    <div className="test-result-header">
                      <XCircle size={16} />
                      <span>用量账本不可用: {ledgerError}</span>
                    </div>
                    <p className="test-card-desc">
                      账本文件存在损坏或不可读。系统已停止覆盖原始文件以保全历史数据，排查修复前无法展示用量统计。
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="ledger-stats-row">
                      <div className="ledger-stat-card">
                        <span>总调用次数</span>
                        <strong>{deepSeekLedger?.totalCalls ?? 0} 次</strong>
                      </div>
                      <div className="ledger-stat-card">
                        <span>成功调用</span>
                        <strong>{deepSeekLedger?.successCalls ?? 0} 次</strong>
                      </div>
                      <div className="ledger-stat-card">
                        <span>累计消耗 Token</span>
                        <strong>{deepSeekLedger?.totalTokens ?? 0}</strong>
                      </div>
                      <div className="ledger-stat-card">
                        <span>提示词 Token</span>
                        <strong>{deepSeekLedger?.promptTokens ?? 0}</strong>
                      </div>
                      <div className="ledger-stat-card">
                        <span>生成 Token</span>
                        <strong>{deepSeekLedger?.completionTokens ?? 0}</strong>
                      </div>
                    </div>

                    {!deepSeekLedger || deepSeekLedger.recentEntries.length === 0 ? (
                      <p className="test-card-desc">
                        暂无调用记录。配置密钥并执行连接检查后将记录于此。
                      </p>
                    ) : (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>时间</th>
                              <th>检查类型</th>
                              <th>请求模型</th>
                              <th>响应模型</th>
                              <th>状态</th>
                              <th>耗时</th>
                              <th>消耗 Token</th>
                            </tr>
                          </thead>
                          <tbody>
                            {deepSeekLedger.recentEntries.map((entry) => (
                              <tr key={entry.id}>
                                <td>{date(entry.timestamp)}</td>
                                <td>
                                  <span
                                    className={`table-badge ${entry.type === 'text_check' ? 'text' : 'vision'}`}
                                  >
                                    {entry.type === 'text_check'
                                      ? '文本检查'
                                      : entry.type === 'vision_check'
                                        ? '视觉检查'
                                        : entry.type === 'lesson_drafting'
                                          ? '资料备课'
                                          : entry.type === 'growth_summary'
                                            ? '成长总结'
                                            : entry.type === 'grading'
                                              ? '答卷建议'
                                              : '成绩解释'}
                                  </span>
                                </td>
                                <td>{entry.requestModel}</td>
                                <td>{entry.responseModel ?? '-'}</td>
                                <td>
                                  <span className={`table-badge ${entry.status}`}>
                                    {entry.status === 'success'
                                      ? '成功'
                                      : entry.status === 'in_progress'
                                        ? '进行中'
                                        : entry.status === 'interrupted'
                                          ? '中断'
                                          : (entry.errorCode ?? '失败')}
                                  </span>
                                </td>
                                <td>{entry.durationMs}ms</td>
                                <td>{entry.usage?.totalTokens ?? '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
          )}
          <footer className="workspace-footer">
            <span>
              <ShieldCheck size={13} />
              {deepSeekStatus?.configured ? '本地安全凭据已就绪' : '本地安全凭据未配置'} ·
              本地智能引擎
            </span>
            <span>v{metadata.version}</span>
          </footer>
        </div>
        {view !== 'conversation' && view !== 'sessions' && (
          <button
            type="button"
            className="floating-copilot-pill"
            title="召唤智能助教"
            aria-label="召唤智能助教"
            onClick={() => navigate('conversation')}
          >
            <Sparkles size={15} />
            <span>召唤助教</span>
          </button>
        )}
      </main>
      {snapshot && (
        <FloatingAssistant
          open={assistantOpen}
          expanded={assistantExpanded}
          working={conversationDirty}
          context={viewLabel(view)}
          onOpen={() => setAssistantOpen(true)}
          onClose={() => setAssistantOpen(false)}
          onExpand={() => setAssistantExpanded((value) => !value)}
        >
          <div className="chat-workspace-host">
            <ConversationWorkspace
              key={`conversation:${snapshot.epoch}`}
              snapshot={snapshot}
              onSnapshot={acceptSnapshot}
              onNavigate={(next) => {
                if (navigate(next)) setAssistantOpen(false);
              }}
              onDirtyChange={setConversationDirty}
              active={assistantOpen}
              mode={conversationMode}
              compact={!assistantExpanded}
              executionBlocked={
                pendingViews.some(([source, pending]) => pending && source !== 'conversation') ||
                busy
              }
              newRequest={newConversationRequest}
              onOpen={() => {
                setConversationMode('conversation');
                setAssistantOpen(true);
              }}
              onManage={() => setConversationMode('sessions')}
              restoreNotice={conversationRestoreNotice}
              onRestoreNotice={setConversationRestoreNotice}
            />
          </div>
        </FloatingAssistant>
      )}
      {busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle size={16} className="spin" />
          正在处理
        </div>
      )}
      {modal?.kind === 'deleteKey' && (
        <Dialog busy={busy} close={() => setModal(undefined)} title="确认清除 API Key">
          <div>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#37474f', lineHeight: 1.5 }}>
              确定要清除本机保存的 DeepSeek API Key 吗？
              <br />
              清除后系统将彻底删除本地加密凭据文件，后续 AI 模型功能将受阻，直到重新填写密钥。
            </p>
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={() => setModal(undefined)}>
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => void handleDeleteKey()}
              >
                确认清除
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {modal && modal.kind !== 'deleteKey' && snapshot && (
        <Dialog
          busy={busy}
          close={() => setModal(undefined)}
          title={
            modal.kind === 'class'
              ? modal.id
                ? '重命名班级'
                : '新建班级'
              : modal.kind === 'student'
                ? modal.student
                  ? '编辑学生'
                  : '添加学生'
                : modal.kind === 'restore'
                  ? modal.recovery
                    ? '确认恢复前副本'
                    : '确认恢复备份'
                  : modal.kind === 'seed'
                    ? '载入合成样例'
                    : modal.student.active
                      ? '停用学生记录'
                      : '恢复在籍'
          }
        >
          {notice?.error && (
            <div className="dialog-error" role="alert">
              {notice.text}
              <small>{notice.code}</small>
            </div>
          )}
          {modal.kind === 'class' && (
            <form onSubmit={(event) => void submitClass(event)}>
              <label>
                班级名称
                <input
                  name="name"
                  required
                  maxLength={80}
                  autoFocus
                  value={classNameInput}
                  onChange={(event) => setClassNameInput(event.target.value)}
                  aria-describedby="class-name-hint"
                />
              </label>
              {!classNameInput.trim() && (
                <p id="class-name-hint" className="field-hint" role="status">
                  请输入班级名称，不能只填写空格。
                </p>
              )}
              <div className="dialog-actions">
                <button type="button" disabled={busy} onClick={() => setModal(undefined)}>
                  取消
                </button>
                <button className="primary" disabled={busy || !classNameInput.trim()}>
                  保存班级
                </button>
              </div>
            </form>
          )}
          {modal.kind === 'student' && (
            <form onSubmit={(event) => void submitStudent(event)}>
              <label>
                姓名
                <input
                  name="displayName"
                  required
                  maxLength={60}
                  autoFocus
                  defaultValue={modal.student?.displayName ?? ''}
                />
              </label>
              <label>
                学生编号
                <input
                  name="studentNumber"
                  aria-label="学生编号"
                  required
                  maxLength={32}
                  pattern="[A-Za-z0-9_-]+"
                  title="字母、数字、下划线或连字符"
                  aria-describedby="student-number-hint"
                  defaultValue={modal.student?.studentNumber ?? ''}
                />
                <small id="student-number-hint" className="field-hint">
                  请使用字母或数字，也可包含下划线、连字符。
                </small>
              </label>
              <label>
                所属班级
                <select
                  name="classId"
                  defaultValue={
                    modal.student?.classId ??
                    (selectedClass !== 'all' ? selectedClass : snapshot.classes[0]?.id)
                  }
                >
                  {snapshot.classes.map((classroom) => (
                    <option key={classroom.id} value={classroom.id}>
                      {classroom.name}
                    </option>
                  ))}
                </select>
              </label>
              {modal.student && (
                <div className="history">
                  <h3>班级归属记录</h3>
                  {snapshot.enrollments
                    .filter((entry) => entry.studentId === modal.student!.id)
                    .map((entry) => (
                      <div key={entry.id}>
                        <span>
                          {snapshot.classes.find((item) => item.id === entry.classId)?.name}
                        </span>
                        <small>
                          {date(entry.validFrom)} 至 {entry.validTo ? date(entry.validTo) : '今'}
                        </small>
                      </div>
                    ))}
                </div>
              )}
              <div className="dialog-actions">
                <button type="button" disabled={busy} onClick={() => setModal(undefined)}>
                  取消
                </button>
                <button className="primary" disabled={busy}>
                  保存学生
                </button>
              </div>
            </form>
          )}
          {modal.kind === 'activation' && (
            <>
              <p>
                {modal.student.displayName} · {modal.student.studentNumber}
              </p>
              <p className="muted">
                {modal.student.active
                  ? '停用后保留记录与班级归属历史，不会删除学生。'
                  : '将在原班级创建新的在籍记录。'}
              </p>
              <div className="dialog-actions">
                <button disabled={busy} onClick={() => setModal(undefined)}>
                  取消
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    const student = modal.student;
                    if (
                      await perform(
                        () =>
                          api.setStudentActive({
                            epoch: snapshot.epoch,
                            id: student.id,
                            expectedRevision: student.revision,
                            active: !student.active,
                          }),
                        acceptSnapshot,
                        '学生状态已更新。',
                      )
                    )
                      setModal(undefined);
                  }}
                >
                  确认{modal.student.active ? '停用' : '恢复'}
                </button>
              </div>
            </>
          )}
          {modal.kind === 'seed' && (
            <>
              <p>2 个示范教学班 · 100 名演示学生</p>
              <p className="muted">
                用于初次启动快速体验与功能演练，不包含真实学生隐私。仅允许在空名册载入。
              </p>
              <div className="dialog-actions">
                <button disabled={busy} onClick={() => setModal(undefined)}>
                  取消
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await perform(
                        () => api.seedDemo({ epoch: snapshot.epoch }),
                        acceptSnapshot,
                        '合成样例已保存。',
                      )
                    )
                      setModal(undefined);
                  }}
                >
                  确认载入
                </button>
              </div>
            </>
          )}
          {modal.kind === 'restore' && (
            <>
              <div className="restore-warning">
                <CircleAlert size={20} />
                <p>
                  恢复将替换当前工作区的名册、成绩、教学、阅卷、计划与附件。原数据保留为本机副本，不会合并记录。
                </p>
              </div>
              <dl>
                <div>
                  <dt>{modal.recovery ? '副本校验时间' : '备份时间'}</dt>
                  <dd>{date(modal.preview.createdAt)}</dd>
                </div>
                <div>
                  <dt>班级 / 学生 / 附件</dt>
                  <dd>
                    {modal.preview.classCount} / {modal.preview.studentCount} /{' '}
                    {modal.preview.assetCount}
                  </dd>
                </div>
                <div>
                  <dt>考试 / 成绩版本</dt>
                  <dd>
                    {modal.preview.examCount} / {modal.preview.scoreVersionCount}
                  </dd>
                  <dt>解释草案（含已丢弃）</dt>
                  <dd>{modal.preview.explanationDraftCount}</dd>
                  <dt>座位版本</dt>
                  <dd>{modal.preview.seatingVersionCount}</dd>
                  <dt>值日版本</dt>
                  <dd>{modal.preview.dutyVersionCount}</dd>
                  <dt>资料版本</dt>
                  <dd>{modal.preview.materialVersionCount}</dd>
                  <dt>备课草案</dt>
                  <dd>{modal.preview.lessonDraftCount}</dd>
                  <dt>冻结教案</dt>
                  <dd>{modal.preview.lessonVersionCount}</dd>
                  <dt>课堂进度</dt>
                  <dd>{modal.preview.teachingSessionCount}</dd>
                  <dt>倒计时设置</dt>
                  <dd>{modal.preview.countdownCount}</dd>
                  <dt>评分细则版本</dt>
                  <dd>{modal.preview.rubricVersionCount}</dd>
                  <dt>阅卷草案 / 冻结复核</dt>
                  <dd>
                    {modal.preview.gradingDraftCount} / {modal.preview.gradingReviewCount}
                  </dd>
                  <dt>阅卷尝试 / 修订历史</dt>
                  <dd>
                    {modal.preview.gradingAttemptCount} / {modal.preview.gradingRevisionCount}
                    。正式入分记录 {modal.preview.gradingPublicationCount} 条 。成长事件 / 总结草案
                    / 正式条目 {modal.preview.growthEventCount} / {modal.preview.growthSummaryCount}{' '}
                    / {modal.preview.growthEntryCount}
                  </dd>
                </div>
              </dl>
              <div className="dialog-actions">
                <button disabled={busy} onClick={() => setModal(undefined)}>
                  取消
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await perform(
                        () =>
                          api.commitRestore({ epoch: snapshot.epoch, token: modal.preview.token }),
                        acceptSnapshot,
                        '备份已恢复，原数据副本已保留。',
                      )
                    ) {
                      setModal(undefined);
                      setPage(0);
                      setLastBackup(undefined);
                    }
                  }}
                >
                  确认替换并恢复
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}
