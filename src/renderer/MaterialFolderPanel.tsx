import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import type { FolderInventory, FolderReadReceipt } from '../shared/material-folders';

export function MaterialFolderPanel({
  epoch,
  disabled,
  onBusy,
  onRead,
  onUpload,
}: {
  epoch: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onRead: () => Promise<void>;
  onUpload?: () => void;
}) {
  const [inventory, setInventory] = useState<FolderInventory>();
  const [selected, setSelected] = useState<string[]>([]);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [busy, setBusy] = useState<'scan' | 'read'>();
  const [receipt, setReceipt] = useState<FolderReadReceipt>();
  const [error, setError] = useState('');
  useEffect(() => {
    void scan(false);
  }, []); // Parent is keyed by workspace epoch.
  async function scan(choose: boolean, remove = false) {
    if (busy || disabled) return;
    setBusy('scan');
    onBusy(true);
    setError('');
    try {
      const result = await window.classManager.scanMaterialFolder({
        epoch,
        choose,
        remove,
        includeChildren,
      });
      if (!result.ok) setError(result.error.message);
      else if (remove) {
        setInventory(undefined);
        setSelected([]);
        setReceipt(undefined);
      } else if (result.value) {
        setInventory(result.value);
        setSelected([]);
        setReceipt(undefined);
      }
    } catch {
      setError('无法读取文件清单，请重新选择文件夹。');
    } finally {
      setBusy(undefined);
      onBusy(false);
    }
  }
  async function read() {
    if (busy || disabled || !inventory || !selected.length) return;
    setBusy('read');
    onBusy(true);
    setError('');
    try {
      const result = await window.classManager.readMaterialFolder({
        epoch,
        token: inventory.token,
        ids: selected,
      });
      if (!result.ok) setError(result.error.message);
      else {
        setReceipt(result.value);
        setSelected([]);
        await onRead();
      }
    } catch {
      setError('读取中断，请在下方资料列表核对已经保存的文件后重新扫描。');
    } finally {
      setBusy(undefined);
      onBusy(false);
    }
  }
  const locked = disabled || Boolean(busy);
  const labels = {
    ready: '可读取',
    unsupported: '暂不支持',
    tooLarge: '超过 10 MiB',
    empty: '空文件',
  };
  return (
    <section className="design-panel material-folder-panel" aria-label="本地资料文件夹">
      <header>
        <div>
          <h2>本地资料来源</h2>
          <p>只读取你选择的资料；原文件保留在原来的位置。</p>
        </div>
        <button className="primary" disabled={locked} onClick={() => void scan(true)}>
          <FolderOpen size={18} />
          {inventory ? '更换文件夹' : '选择本地文件夹'}
        </button>
        {onUpload && (
          <button disabled={locked} aria-label="选择资料文件" onClick={onUpload}>
            上传文件
          </button>
        )}
      </header>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!inventory && (
        <div className="folder-placeholder">
          <FolderOpen size={30} />
          <div>
            <strong>还没有添加资料文件夹</strong>
            <p>可选择教材、课件或教研资料所在的文件夹。支持 TXT、DOCX、PDF、PNG、JPG。</p>
          </div>
        </div>
      )}
      {inventory && (
        <>
          <div className="folder-toolbar">
            <div>
              <strong>{inventory.folderName}</strong>
              <p>
                最近扫描：{new Date(inventory.scannedAt).toLocaleString('zh-CN')} ·{' '}
                {inventory.entries.length} 个文件
              </p>
            </div>
            <label>
              <input
                type="checkbox"
                checked={includeChildren}
                disabled={locked}
                onChange={(event) => setIncludeChildren(event.target.checked)}
              />
              包含子文件夹
            </label>
            <button disabled={locked} onClick={() => void scan(false)}>
              <RefreshCw size={15} />
              重新扫描
            </button>
            <button
              disabled={locked}
              onClick={() => {
                void scan(false, true);
              }}
            >
              移除入口
            </button>
          </div>
          {includeChildren !== inventory.includeChildren && (
            <p role="status">读取范围已改变，点击“重新扫描”更新清单。</p>
          )}
          {inventory.warnings.map((warning) => (
            <p key={warning} role="status">
              {warning}
            </p>
          ))}
          <div className="folder-file-list">
            {inventory.entries.map((entry) => (
              <label key={entry.id} className="folder-file">
                <input
                  type="checkbox"
                  aria-label={`读取 ${entry.name}`}
                  disabled={
                    locked ||
                    entry.status !== 'ready' ||
                    receipt?.files.some((file) => file.id && file.name === entry.name)
                  }
                  checked={selected.includes(entry.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, entry.id]
                        : selected.filter((id) => id !== entry.id),
                    )
                  }
                />
                <span>{entry.name}</span>
                <small>
                  {Math.ceil(entry.bytes / 1024)} KB · {labels[entry.status]}
                </small>
              </label>
            ))}
          </div>
          {!inventory.entries.length && <p>此文件夹中没有普通文件，或文件夹为空。</p>}
          <footer>
            <p>每次最多选择 25 份。读取后保存到本机备课资料库，不会自动上传模型。</p>
            <button
              className="primary"
              disabled={
                locked ||
                !selected.length ||
                selected.length > 25 ||
                includeChildren !== inventory.includeChildren
              }
              onClick={() => void read()}
            >
              读取选中资料（{selected.length}）
            </button>
          </footer>
        </>
      )}
      {busy && (
        <p role="status">
          {busy === 'scan' ? '正在扫描文件清单…' : '正在读取资料，请稍候…'}
          {busy === 'read' && (
            <button
              onClick={() => {
                void window.classManager
                  .cancelMaterialFolder({ epoch })
                  .then((result) => {
                    if (!result.ok) setError(result.error.message);
                  })
                  .catch(() => setError('取消请求未送达，请等待读取结果。'));
              }}
            >
              取消读取
            </button>
          )}
        </p>
      )}
      {receipt && (
        <div className="folder-receipt" role="status">
          <strong>
            {receipt.cancelled ? '已取消；已保存的资料保留。' : '读取完成。'}成功{' '}
            {receipt.files.filter((file) => file.id).length} 份，失败{' '}
            {receipt.files.filter((file) => file.error).length} 份。
          </strong>
          {receipt.files.map((file, index) => (
            <p key={index}>
              {file.name}：{file.id ? '已保存，可在下方选择使用' : file.error}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
