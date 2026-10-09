import { BrowserWindow, dialog, Menu, type WebContentsPrintOptions } from 'electron';
import { join } from 'node:path';
import { atomicWrite } from '../core/files';
import { PRINT_BATCH_PAGES, type PrintDocument } from '../core/print-document';
import { DomainError } from '../core/errors';
import type { PrintReceipt } from '../shared/printing';
import { assertExportDestination } from './security';
import { createPrintPreviewFile } from './print-preview-files';

export const DOCUMENT_PRINT_OPTIONS: WebContentsPrintOptions = {
  silent: false,
  printBackground: true,
  landscape: true,
  pageSize: 'A4',
  margins: { marginType: 'none' },
  scaleFactor: 100,
};
export const DOCUMENT_PDF_OPTIONS = {
  printBackground: true,
  landscape: true,
  pageSize: 'A4',
  preferCSSPageSize: true,
  displayHeaderFooter: false,
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
} as const;

/** OS print callbacks are acknowledgments, not proof of paper delivery. Never retry automatically. */
export function printOutcome(success: boolean, reason?: string): PrintReceipt['status'] {
  if (success) return 'submitted';
  return reason === 'Print job canceled' ? 'cancelled' : 'failed';
}

/**
 * One owned, script-free preview with a native menu. Resolves only when the user closes it.
 * The parent holds its write slot throughout, so restore cannot switch the underlying workspace.
 * Only our generated HTML is written; callers cannot specify a path or HTML. Cleanup is nonrecursive.
 */
export async function openPrintPreview(
  parent: BrowserWindow,
  document: PrintDocument,
  paths: { temp: string; documents: string; dataRoot: string },
  kind: 'seating' | 'duty' | 'resource',
  loadBatch?: (pageOffset: number) => Promise<PrintDocument>,
): Promise<PrintReceipt> {
  const label = kind === 'seating' ? '座位表' : kind === 'resource' ? '教学资源' : '值日表';
  const previewLabel =
    kind === 'seating' ? '座位打印预览' : kind === 'resource' ? '教学资源打印预览' : '值日打印预览';
  const file = await createPrintPreviewFile(paths.temp, document.html);
  const { path } = file;
  let preview: BrowserWindow | undefined;
  const receipt: PrintReceipt = {
    versionId: document.versionId,
    revision: document.revision,
    pageCount: document.totalPageCount ?? document.pageCount,
    ...((document.totalPageCount ?? 0) > document.pageCount
      ? { batchCount: Math.ceil(document.totalPageCount! / PRINT_BATCH_PAGES) }
      : {}),
    status: 'closed',
    submittedJobs: 0,
    pdfExports: 0,
    temporaryCleanupFailed: file.priorResidues > 0,
  };
  try {
    preview = new BrowserWindow({
      parent,
      modal: true,
      show: false,
      width: 1180,
      height: 840,
      minWidth: 360,
      minHeight: 540,
      title: `${previewLabel} · 第 ${document.revision} 版`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        javascript: false,
      },
    });
    const window = preview;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    let active: 'print' | 'pdf' | 'batch' | undefined;
    let notifying = false;
    let ended = false;
    let loaded = true;
    const batchMode = Boolean(receipt.batchCount);
    const range = () =>
      batchMode
        ? `第 ${(document.pageOffset ?? 0) + 1}–${(document.pageOffset ?? 0) + document.pageCount} / ${receipt.pageCount} 页`
        : `${document.pageCount} 页`;
    let status = `第 ${document.revision} 版 · ${document.pageCount} 页`;
    const closed = new Promise<void>((resolve) => {
      window.once('closed', () => {
        ended = true;
        if (active) receipt.status = 'interrupted';
        resolve();
      });
    });
    function refreshMenu() {
      if (ended) return;
      window.setTitle(`${previewLabel} · ${range()} · ${status}`);
      window.setMenu(
        Menu.buildFromTemplate([
          {
            label: '打印',
            submenu: [
              {
                label: batchMode ? '打印当前批次…' : '打印所示确认版本…',
                accelerator: 'CmdOrCtrl+P',
                enabled: !active && !notifying && loaded,
                click: () => void print(),
              },
              {
                label: batchMode ? '导出当前批次 PDF…' : '导出所示版本 PDF…',
                enabled: !active && !notifying && loaded,
                click: () => void exportPdf(),
              },
              { type: 'separator' },
              { label: status, enabled: false },
              ...(batchMode
                ? [
                    { label: range(), enabled: false },
                    {
                      label: '上一批',
                      enabled: !active && !notifying && (document.pageOffset ?? 0) > 0,
                      click: () => void changeBatch((document.pageOffset ?? 0) - PRINT_BATCH_PAGES),
                    },
                    {
                      label: '下一批',
                      enabled:
                        !active &&
                        !notifying &&
                        (document.pageOffset ?? 0) + document.pageCount < receipt.pageCount,
                      click: () => void changeBatch((document.pageOffset ?? 0) + PRINT_BATCH_PAGES),
                    },
                  ]
                : []),
              { type: 'separator' },
              { label: '关闭预览', accelerator: 'Esc', click: () => window.close() },
            ],
          },
        ]),
      );
    }
    async function changeBatch(pageOffset: number) {
      if (active || notifying || ended || !loadBatch) return;
      active = 'batch';
      status = '正在读取打印批次';
      refreshMenu();
      try {
        const next = await loadBatch(pageOffset);
        if (ended) return;
        if (
          next.versionId !== document.versionId ||
          next.revision !== document.revision ||
          next.totalPageCount !== receipt.pageCount ||
          next.pageOffset !== pageOffset
        )
          throw new DomainError('CONFLICT', '打印批次与固定版本不一致。');
        // Reuse the single owned file. Creating a second preview would run startup cleanup
        // against the live first file. Main holds the workspace write slot across all batches.
        atomicWrite(path, next.html);
        loaded = false;
        await window.loadFile(path);
        if (ended) return;
        document = next;
        loaded = true;
        status = `第 ${document.revision} 版 · ${range()}`;
      } catch {
        if (!ended) {
          active = undefined;
          receipt.status = 'failed';
          await announce('批次读取失败，本次未打印。请重试切换批次或关闭预览。');
        }
      } finally {
        active = undefined;
        refreshMenu();
      }
    }
    async function announce(message: string) {
      status = message;
      notifying = true;
      refreshMenu();
      try {
        if (!ended)
          await dialog
            .showMessageBox(window, { type: 'info', message, buttons: ['确定'] })
            .catch(() => {});
      } finally {
        notifying = false;
        refreshMenu();
      }
    }
    async function print() {
      if (active || notifying || ended || !loaded) return;
      active = 'print';
      status = '正在等待打印操作';
      refreshMenu();
      try {
        const result = await new Promise<{ success: boolean; reason?: string }>(
          (resolve, reject) => {
            try {
              window.webContents.print(
                { ...DOCUMENT_PRINT_OPTIONS, landscape: kind !== 'resource' },
                (success, reason) => resolve({ success, reason }),
              );
            } catch (error) {
              reject(error);
            }
          },
        );
        if (ended) return;
        receipt.status = printOutcome(result.success, result.reason);
        if (receipt.status === 'submitted') receipt.submittedJobs++;
        active = undefined;
        await announce(
          receipt.status === 'submitted'
            ? `${batchMode ? `${range()} 已提交，其他批次须分别打印。` : ''}已提交打印队列，请核对打印机；不代表已出纸。`
            : receipt.status === 'cancelled'
              ? '已取消打印，确认版本未改变。'
              : '打印未成功，请检查打印机或导出 PDF；未自动重试。',
        );
      } catch {
        if (!ended) {
          receipt.status = 'failed';
          active = undefined;
          await announce('打印未成功；未自动重试，请核对打印队列。');
        }
      } finally {
        active = undefined;
        refreshMenu();
      }
    }
    async function exportPdf() {
      if (active || notifying || ended || !loaded) return;
      active = 'pdf';
      refreshMenu();
      try {
        const selected = await dialog.showSaveDialog(window, {
          defaultPath: join(
            paths.documents,
            `${kind}-v${document.revision}${batchMode ? `-p${(document.pageOffset ?? 0) + 1}-${(document.pageOffset ?? 0) + document.pageCount}` : ''}.pdf`,
          ),
          filters: [{ name: `${label} PDF`, extensions: ['pdf'] }],
          properties: ['showOverwriteConfirmation', 'createDirectory'],
        });
        if (ended) return;
        if (selected.canceled || !selected.filePath) {
          receipt.status = 'export-cancelled';
          active = undefined;
          await announce('已取消 PDF 导出。');
          return;
        }
        assertExportDestination(selected.filePath, paths.dataRoot);
        // Do not let an export overwrite the very document being previewed.
        assertExportDestination(selected.filePath, paths.temp);
        const bytes = await window.webContents.printToPDF({
          ...DOCUMENT_PDF_OPTIONS,
          landscape: kind !== 'resource',
        });
        if (ended) return;
        atomicWrite(selected.filePath, bytes);
        receipt.pdfExports++;
        receipt.status = 'exported';
        active = undefined;
        await announce(
          `${label} PDF 已保存。${batchMode ? `${range()}；其余批次须分别导出。` : ''}`,
        );
      } catch {
        if (!ended) {
          receipt.status = 'failed';
          active = undefined;
          await announce('PDF 导出失败，确认版本未改变。');
        }
      } finally {
        active = undefined;
        refreshMenu();
      }
    }
    await window.loadFile(path);
    if (ended) throw new DomainError('ABORTED', '打印预览已关闭。');
    refreshMenu();
    window.show();
    await closed;
    return receipt;
  } finally {
    if (preview && !preview.isDestroyed()) preview.destroy();
    const removed = await file.cleanup().catch(() => false);
    if (!removed) receipt.temporaryCleanupFailed = true;
  }
}
