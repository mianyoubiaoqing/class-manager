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
} from 'lucide-react';
import type { DesktopApi, Result, RestorePreview, Snapshot, Student } from '../shared/contracts';
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
  | { kind: 'seed' };
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
  const [view, setView] = useState<'roster' | 'maintenance'>('roster');
  const [notice, setNotice] = useState<Notice>();
  const [modal, setModal] = useState<Modal>();
  const [selectedClass, setSelectedClass] = useState('all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(0);
  const [lastBackup, setLastBackup] = useState<string>();
  const api = window.classManager;

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
            <span>{view === 'roster' ? '班级名册' : '数据与维护'}</span>
          </div>
          <span className="local-status">
            <span className="dot" />
            {busy ? '处理中' : snapshot ? '本地就绪' : '未就绪'}
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">CLASS MANAGER / M0</div>
              <h1>{view === 'roster' ? '班级名册' : '数据与维护'}</h1>
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
                onClick={() =>
                  void perform(() => api.snapshot(), acceptSnapshot, '已重新读取本地数据。')
                }
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
          <footer className="workspace-footer">
            <span>
              <ShieldCheck size={13} />
              仅合成数据 · 未连接云模型
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
      {modal && snapshot && (
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
