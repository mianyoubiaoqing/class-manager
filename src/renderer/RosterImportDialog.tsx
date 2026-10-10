import { useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, Upload, X } from 'lucide-react';
import type { Snapshot } from '../shared/contracts';
import type { RosterImportPreview } from '../shared/roster-import';
import { SchoolRosterCells, SchoolRosterHeaders } from './SchoolRosterTable';

export function RosterImportDialog({
  snapshot,
  initialClass,
  onSaved,
  onClose,
  onDirtyChange,
}: {
  snapshot: Snapshot;
  initialClass: string;
  onSaved: (value: Snapshot) => void;
  onClose: () => void;
  onDirtyChange: (value: boolean) => void;
}) {
  const api = window.classManager;
  const [classId, setClassId] = useState(
    snapshot.classes.some((c) => c.id === initialClass)
      ? initialClass
      : (snapshot.classes[0]?.id ?? ''),
  );
  const [preview, setPreview] = useState<RosterImportPreview>();
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [page, setPage] = useState(0),
    [problemsOnly, setProblemsOnly] = useState(false);
  const problemRows = preview?.rows.filter((row) => row.status === 'error') ?? [];
  const tableRows = problemsOnly ? problemRows : (preview?.rows ?? []);
  const pageCount = Math.max(1, Math.ceil(tableRows.length / 20));
  const blockedReason = !preview
    ? ''
    : problemRows.length
      ? `还有 ${problemRows.length} 行需要修正，本次未导入任何学生。请核对下方问题行，在 Excel 中更正并保存后，点击“选择名单文件”重新读取。`
      : preview.issues.length
        ? '文件仍有问题，本次未导入任何学生。请按上方提示修正并重新选择文件。'
        : !preview.canConfirm
          ? '没有需要新增或更新的学生；已有且资料相同的学生已跳过，无需再次导入。'
          : '';
  const dialog = useRef<HTMLDialogElement>(null),
    tableScroll = useRef<HTMLDivElement>(null),
    running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      alive.current = false;
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChange(true);
  }, [onDirtyChange]);
  useEffect(() => {
    if (tableScroll.current) {
      tableScroll.current.scrollTop = 0;
      tableScroll.current.scrollLeft = 0;
    }
  }, [page, problemsOnly, preview]);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice('');
    try {
      await work();
    } catch (e) {
      if (alive.current)
        setNotice(e instanceof Error ? e.message : '响应中断，请先核对名册；可用原预览重试。');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="roster-import-dialog"
      aria-labelledby="roster-import-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="flow-eyebrow">班级名册 / 批量导入</span>
          <h2 id="roster-import-title">把学生名单导入班级</h2>
        </div>
        <button className="icon-button" aria-label="关闭批量导入" disabled={busy} onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <ol className="flow-steps" aria-label="导入进度（按顺序完成）">
        <li className="active">1 选择班级与文件</li>
        <li className={preview ? 'active' : ''}>2 核对名单</li>
        <li>3 确认导入</li>
      </ol>
      <p className="field-hint">
        先选择已填写的名单文件，再核对学生，最后确认导入。选择文件后会自动显示核对结果。
      </p>
      <label>
        导入到哪个班级？
        <select
          aria-label="批量导入班级"
          value={classId}
          disabled={busy}
          onChange={(e) => {
            setClassId(e.target.value);
            setPreview(undefined);
            setPage(0);
            setProblemsOnly(false);
          }}
        >
          {snapshot.classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="import-file-guide">
        <FileSpreadsheet size={28} />
        <div>
          <h3>已有学生名单？直接选择文件</h3>
          <p>
            表头与学校花名册的18列一致，学生、父亲、母亲的联系资料分别保存。已有同格式文件可直接选择，无需改名或重新排列。至少填写“学号”和“姓名”；常见数字学号、补零显示、Excel
            日期和富文本可直接读取。身份证等长编号仍请保存为文本，避免 Excel
            丢失精度。每次导入一个班级，最多 10000 行、5 MiB。
          </p>
          <p className="field-hint">
            没有名单文件时，再下载空白模板填写。下载模板不会导入学生，请另存为新文件，避免替换原名单。
          </p>
          <div className="button-row">
            {(['xlsx', 'csv'] as const).map((format) => (
              <button
                key={format}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api.exportRosterTemplate({ epoch: snapshot.epoch, format });
                    if (!r.ok) throw new Error(r.error.message);
                    if (alive.current)
                      setNotice(
                        r.value
                          ? '空白模板已下载，尚未导入学生。请填写后点击“选择名单文件”。'
                          : '已取消下载模板。',
                      );
                  })
                }
              >
                下载空白 {format.toUpperCase()} 模板
              </button>
            ))}
            <button
              className="primary"
              disabled={busy || !classId}
              onClick={() =>
                void run(async () => {
                  setPreview(undefined);
                  const r = await api.previewRosterImport({ epoch: snapshot.epoch, classId });
                  if (!r.ok) throw new Error(r.error.message);
                  if (alive.current) {
                    setPreview(r.value ?? undefined);
                    setPage(0);
                    setProblemsOnly(Boolean(r.value?.rows.some((row) => row.status === 'error')));
                  }
                })
              }
            >
              <Upload size={16} />
              选择名单文件
            </button>
          </div>
        </div>
      </div>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!preview && (
        <p className="roster-import-next" role="status">
          下一步：点击“选择名单文件”，打开已有或已填写的 Excel / CSV 名单。
        </p>
      )}
      {preview && (
        <>
          <h3>核对导入结果 · {preview.className}</h3>
          <p>
            {preview.fileName} · 新增 {preview.added} 人 · 更新档案 {preview.updated} 人 · 跳过已有{' '}
            {preview.skipped} 人 · 待修正 {preview.rows.filter((r) => r.status === 'error').length}{' '}
            行
          </p>
          {preview.issues.map((issue) => (
            <p className="notice error" role="alert" key={issue}>
              {issue}
            </p>
          ))}
          {blockedReason && (
            <p
              id="roster-import-blocker"
              className={`notice ${problemRows.length || preview.issues.length ? 'error' : ''}`}
              role={problemRows.length || preview.issues.length ? 'alert' : 'status'}
            >
              {blockedReason}
            </p>
          )}
          {problemRows.length > 0 && (
            <div className="button-row">
              <button
                disabled={busy}
                onClick={() => {
                  setProblemsOnly(!problemsOnly);
                  setPage(0);
                }}
              >
                {problemsOnly
                  ? `查看全部 ${preview.rows.length} 行`
                  : `只看问题行（${problemRows.length}）`}
              </button>
              <span className="field-hint">
                {problemsOnly
                  ? '当前只显示阻止导入的问题行；文件行号对应 Excel 中的行号。'
                  : '点击“只看问题行”即可定位阻止导入的记录。'}
              </span>
            </div>
          )}
          <p id="roster-table-help" className="field-hint">
            本页 {tableRows.slice(page * 20, (page + 1) * 20).length} 条，共 {tableRows.length} 条。
            在表格内上下滚动查看本页记录；窗口较窄时可左右滚动查看完整列。点击表格后也可使用方向键滚动。
          </p>
          <div
            ref={tableScroll}
            className="table-scroll"
            role="region"
            aria-label="名册导入预览表格"
            aria-describedby="roster-table-help"
            tabIndex={0}
          >
            <table className="school-roster-table">
              <thead>
                <tr>
                  <SchoolRosterHeaders />
                  <th>文件行号</th>
                  <th>检查结果</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.slice(page * 20, (page + 1) * 20).map((r) => (
                  <tr key={r.row}>
                    <SchoolRosterCells
                      studentNumber={r.studentNumber}
                      displayName={r.displayName}
                      profile={r.profile}
                    />
                    <td>{r.row}</td>
                    <td
                      className={`roster-import-result ${r.status === 'error' ? 'import-error' : ''}`}
                    >
                      {r.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button disabled={busy || !page} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span>
              {page + 1} / {pageCount}
            </span>
            <button disabled={busy || page + 1 >= pageCount} onClick={() => setPage(page + 1)}>
              下一页
            </button>
          </div>
          <p className="workspace-muted">
            同班同学号、同姓名的学生会更新本次填写的非空档案字段；空白字段保留原资料，内容一致时跳过。不会转班或恢复停用记录。
          </p>
        </>
      )}
      <footer className="dialog-actions">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy || !preview?.canConfirm}
          aria-describedby={blockedReason ? 'roster-import-blocker' : undefined}
          title={blockedReason || undefined}
          onClick={() =>
            void run(async () => {
              const r = await api.confirmRosterImport({
                epoch: snapshot.epoch,
                token: preview!.token,
              });
              if (!r.ok) throw new Error(r.error.message);
              if (alive.current) {
                onSaved(r.value.snapshot);
                onClose();
              }
            })
          }
        >
          {busy
            ? '正在处理…'
            : problemRows.length
              ? `修正 ${problemRows.length} 行后可导入`
              : `确认导入${preview ? ` ${preview.added + preview.updated} 人` : ''}`}
        </button>
      </footer>
    </dialog>
  );
}
