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
  HardDrive,
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
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  Eye,
  KeyRound,
  Sparkles,
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
  const [view, setView] = useState<'roster' | 'maintenance' | 'modelSettings'>('roster');
  const [notice, setNotice] = useState<Notice>();
  const [modal, setModal] = useState<Modal>();
  const [selectedClass, setSelectedClass] = useState('all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(0);
  const [lastBackup, setLastBackup] = useState<string>();
  const [deepSeekStatus, setDeepSeekStatus] = useState<DeepSeekCredentialStatus>();
  const [deepSeekLedger, setDeepSeekLedger] = useState<DeepSeekLedgerSummary>();
  const [keyInput, setKeyInput] = useState('');
  const [testingType, setTestingType] = useState<'text' | 'vision' | null>(null);
  const [testResultText, setTestResultText] = useState<DeepSeekCheckResult | null>(null);
  const [testResultVision, setTestResultVision] = useState<DeepSeekCheckResult | null>(null);
  const checkTaskIdRef = useRef(0);
  const api = window.classManager;

  async function loadDeepSeekData() {
    if (!api) return;
    const [statusRes, ledgerRes] = await Promise.all([
      api.getDeepSeekStatus(),
      api.getDeepSeekLedger(),
    ]);
    if (statusRes.ok) setDeepSeekStatus(statusRes.value);
    if (ledgerRes.ok) setDeepSeekLedger(ledgerRes.value);
  }

  async function handleSaveKey(e: FormEvent) {
    e.preventDefault();
    const apiKeyToSave = keyInput.trim();
    // 立即清空输入框，无论后续成功或失败，绝不在组件状态中存留明文 Key
    setKeyInput('');
    if (!apiKeyToSave) return;
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
    setTestingType(type);
    setNotice(undefined);
    try {
      const res = await api.checkDeepSeek({ type });
      // 检查任务 ID，若已被取消或由新任务取代，则丢弃迟到响应
      if (taskId !== checkTaskIdRef.current) return;
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

  const activeCount = snapshot?.students.filter((student) => student.active).length ?? 0;
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
  const disabled = busy || loading || !snapshot;

  async function submitClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || modal?.kind !== 'class') return;
    const name = String(new FormData(event.currentTarget).get('name') ?? '');
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
      acceptSnapshot,
      '班级已保存。',
    );
    if (success) setModal(undefined);
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <GraduationCap size={24} />
          </span>
          <div>
            班级管理<small>本地工作台</small>
          </div>
        </div>
        <div className="environment">
          <span className="dot" />
          Windows · 单机<span className="version">M0</span>
        </div>
        <nav aria-label="主导航">
          <button
            className={view === 'roster' ? 'nav-item selected' : 'nav-item'}
            onClick={() => setView('roster')}
          >
            <UsersRound size={18} />
            班级名册
            <ChevronRight size={14} />
          </button>
          <button
            className={view === 'maintenance' ? 'nav-item selected' : 'nav-item'}
            onClick={() => setView('maintenance')}
          >
            <HardDrive size={18} />
            数据与维护
            <ChevronRight size={14} />
          </button>
          <button
            className={view === 'modelSettings' ? 'nav-item selected' : 'nav-item'}
            onClick={() => {
              setView('modelSettings');
              void loadDeepSeekData();
            }}
          >
            <KeyRound size={18} />
            模型设置
            <ChevronRight size={14} />
          </button>
        </nav>
        <section className="class-navigation">
          <div className="section-label">
            班级 <span>{snapshot?.classes.length ?? 0}</span>
            <button
              className="icon-button"
              title="新建班级"
              aria-label="新建班级"
              disabled={disabled}
              onClick={() => setModal({ kind: 'class' })}
            >
              <Plus size={17} />
            </button>
          </div>
          {snapshot?.classes.map((classroom) => (
            <div className="class-nav-row" key={classroom.id}>
              <button
                className={`class-nav ${selectedClass === classroom.id ? 'current' : ''}`}
                onClick={() => {
                  setSelectedClass(classroom.id);
                  setView('roster');
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
                onClick={() => setModal({ kind: 'class', id: classroom.id })}
              >
                <Pencil size={13} />
              </button>
            </div>
          ))}
        </section>
        <div className="sidebar-bottom">
          <ShieldCheck size={17} />
          <span>
            合成数据验证<small>未进入真实班级业务</small>
          </span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            工作台 <ChevronRight size={14} />
            <span>
              {view === 'roster' ? '班级名册' : view === 'maintenance' ? '数据与维护' : '模型设置'}
            </span>
          </div>
          <span className="local-status">
            <span className="dot" />
            {busy ? '处理中' : snapshot ? '本地就绪' : '未就绪'}
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">CLASS MANAGER / M1</div>
              <h1>
                {view === 'roster'
                  ? '班级名册'
                  : view === 'maintenance'
                    ? '数据与维护'
                    : 'DeepSeek 本地配置与连接检查'}
              </h1>
            </div>
            <div className="heading-actions">
              {view === 'roster' && (
                <button
                  className="icon-button outlined"
                  title="创建班级"
                  aria-label="创建班级"
                  disabled={disabled}
                  onClick={() => setModal({ kind: 'class' })}
                >
                  <GraduationCap size={18} />
                </button>
              )}
              <button
                className="icon-button outlined"
                title="重新读取数据"
                aria-label="重新读取数据"
                disabled={busy || loading || !api}
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
              className={`notice ${notice.error ? 'error' : 'success'}`}
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
          {snapshot && view === 'roster' && (
            <>
              <section className="metrics" aria-label="名册概况">
                <div>
                  <UsersRound size={20} />
                  <span>
                    在籍学生
                    <strong>
                      {activeCount}
                      <small>人</small>
                    </strong>
                  </span>
                </div>
                <div>
                  <GraduationCap size={20} />
                  <span>
                    班级
                    <strong>
                      {snapshot.classes.length}
                      <small>个</small>
                    </strong>
                  </span>
                </div>
                <div>
                  <UserRoundMinus size={20} />
                  <span>
                    停用记录
                    <strong>
                      {snapshot.students.length - activeCount}
                      <small>人</small>
                    </strong>
                  </span>
                </div>
              </section>
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
              </div>
              {snapshot.classes.length === 0 ? (
                <div className="empty-state">
                  <UsersRound size={40} />
                  <h2>尚无班级</h2>
                  <div className="button-row">
                    <button disabled={busy} onClick={() => setModal({ kind: 'class' })}>
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
                            <span className={`status-badge ${student.active ? 'active' : ''}`}>
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
                  {rows.length === 0 && <div className="empty-results">没有匹配的学生记录</div>}
                </div>
              )}
              {snapshot.classes.length > 0 && (
                <footer className="table-footer">
                  <span>合成名册 · 本机保存</span>
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
            </>
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
                    <dd>程序版本、记录数量、错误编号</dd>
                  </div>
                  <div>
                    <dt>排除内容</dt>
                    <dd>姓名、编号、附件正文、完整路径、密钥</dd>
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
                  <h2>双通道连接检查 (合成测试)</h2>
                </div>
                <div className="banner-alert">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>费用与通道独立性提示：</strong>
                    连接测试将向 DeepSeek 官方接口发起微型合成请求，产生极少量 Token 消耗（通常 &lt;
                    100 Tokens）。文本模型与视觉模型分别独立验证，文本通过不代表视觉多模态接口通过。
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
                                {entry.type === 'text_check' ? '文本检查' : '视觉检查'}
                              </span>
                            </td>
                            <td>{entry.requestModel}</td>
                            <td>{entry.responseModel ?? '-'}</td>
                            <td>
                              <span
                                className={`table-badge ${entry.status === 'success' ? 'success' : 'failed'}`}
                              >
                                {entry.status === 'success' ? '成功' : (entry.errorCode ?? '失败')}
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
              </section>
            </div>
          )}
          <footer className="workspace-footer">
            <span>
              <ShieldCheck size={13} />
              {deepSeekStatus?.configured ? '本地安全凭据已就绪' : '本地安全凭据未配置'} · 合成验证
            </span>
            <span>v{metadata.version}</span>
          </footer>
        </div>
      </main>
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
                  defaultValue={snapshot.classes.find((item) => item.id === modal.id)?.name ?? ''}
                />
              </label>
              <div className="dialog-actions">
                <button type="button" disabled={busy} onClick={() => setModal(undefined)}>
                  取消
                </button>
                <button className="primary" disabled={busy}>
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
                  required
                  maxLength={32}
                  pattern="[A-Za-z0-9_-]+"
                  title="字母、数字、下划线或连字符"
                  defaultValue={modal.student?.studentNumber ?? ''}
                />
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
              <p>2 个虚构班级 · 100 名合成学生</p>
              <p className="muted">仅用于本地验证，不包含真实学生资料。仅允许在空名册载入。</p>
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
                <p>恢复将替换当前名册与附件。原数据保留为本机副本，不会合并记录。</p>
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
