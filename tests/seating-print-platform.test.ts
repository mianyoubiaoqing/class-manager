import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { printView } from './fixtures/seating-print-view';
import { dutyPrintView } from './fixtures/duty-print-view';
import { createDutyPrintDocument } from '../src/core/duty-print';
import type { SeatingPrintReceipt } from '../src/shared/seating-records';
import { recoverPrintPreviews } from '../src/main/print-preview-files';

let source: string;
let dutySource: string;
const roots: string[] = [];
beforeAll(() => {
  source = buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/seating-print.ts'],
      write: false,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    }),
  ).outputFiles[0]!.text;
  dutySource = buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/duty-print.ts'],
      write: false,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    }),
  ).outputFiles[0]!.text;
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(
  loadError = false,
  cleanupFailure = false,
  kind: 'seating' | 'duty' = 'seating',
  batched = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'cm-print-platform-'));
  roots.push(root);
  const windows: FakeWindow[] = [];
  let closed: (() => void) | undefined;
  const print = vi.fn((_options: unknown, callback: (success: boolean, reason: string) => void) =>
    callback(false, 'Print job canceled'),
  );
  const pdf = vi.fn(async () => Buffer.from('synthetic-pdf'));
  const save = vi.fn(async () => ({ canceled: true, filePath: '' }));
  const message = vi.fn(async () => ({ response: 0 }));
  type Item = { label?: string; enabled?: boolean; click?: () => void; submenu?: Item[] };
  class FakeWindow {
    destroyed = false;
    menu: Item[] = [];
    shown = false;
    options: unknown;
    file = '';
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), print, printToPDF: pdf };
    constructor(options: unknown) {
      this.options = options;
      windows.push(this);
    }
    once(_event: string, fn: () => void) {
      closed = fn;
    }
    async loadFile(path: string) {
      this.file = path;
      if (loadError) throw new Error('synthetic load failure');
    }
    setMenu(menu: Item[]) {
      this.menu = menu;
    }
    setTitle() {}
    show() {
      this.shown = true;
    }
    close() {
      this.destroyed = true;
      closed?.();
    }
    destroy() {
      this.close();
    }
    isDestroyed() {
      return this.destroyed;
    }
  }
  const native = await import('node:module');
  const require = native.createRequire(join(process.cwd(), 'package.json'));
  const module = {
    exports: {} as {
      openSeatingPrintPreview: (...args: unknown[]) => Promise<SeatingPrintReceipt>;
      openDutyPrintPreview: (...args: unknown[]) => Promise<SeatingPrintReceipt>;
      printOutcome: (success: boolean, reason?: string) => string;
    },
  };
  new Function('require', 'module', 'exports', kind === 'duty' ? dutySource : source)(
    (name: string) =>
      name === 'electron'
        ? {
            BrowserWindow: FakeWindow,
            Menu: { buildFromTemplate: (items: Item[]) => items },
            dialog: { showSaveDialog: save, showMessageBox: message },
          }
        : name === 'node:fs' && cleanupFailure
          ? {
              ...require(name),
              unlinkSync: () => {
                throw new Error('Synthetic locked preview');
              },
            }
          : require(name),
    module,
    module.exports,
  );
  const open =
    kind === 'duty' ? module.exports.openDutyPrintPreview : module.exports.openSeatingPrintPreview;
  const paths = {
    temp: join(root, 'cache'),
    documents: root,
    dataRoot: join(root, 'workspace-data'),
  };
  const dutyView = batched ? dutyPrintView(400, 1, 2) : dutyPrintView();
  const workerCall = vi.fn(async (_operation: string, input: { pageOffset: number }) => ({
    ok: true,
    value: createDutyPrintDocument(dutyView, input.pageOffset),
  }));
  const result =
    kind === 'duty'
      ? open(
          {},
          { epoch: dutyView.record.requestId, versionId: dutyView.record.id },
          { call: workerCall },
          paths,
        )
      : open({}, printView(), paths);
  // Observe early rejection without turning expected load failure into an unhandled rejection.
  void result.catch(() => {});
  await setImmediate();
  return {
    root,
    window: windows[0]!,
    result,
    print,
    pdf,
    save,
    message,
    outcome: module.exports.printOutcome,
    workerCall,
  };
}
async function click(f: Awaited<ReturnType<typeof fixture>>, index: number) {
  f.window.menu[0]!.submenu![index]!.click!();
  const deadline = Date.now() + 2000;
  while (f.window.menu[0]!.submenu![0]!.enabled === false) {
    if (Date.now() > deadline) throw new Error('Print test callback did not finish');
    await setImmediate();
  }
}

test('preview is sandboxed, contains no preload and deletes only its temporary files on close', async () => {
  const f = await fixture();
  expect(f.window.options).toMatchObject({
    modal: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
    },
  });
  expect(JSON.stringify(f.window.options)).not.toContain('preload');
  expect(readFileSync(f.window.file, 'utf8')).toContain('合成打印班');
  f.window.close();
  expect(await f.result).toMatchObject({ status: 'closed', submittedJobs: 0, pdfExports: 0 });
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
});

test('duty adapter uses its own frozen document and label with shared cancel/export/cleanup behavior', async () => {
  const f = await fixture(false, false, 'duty');
  expect(readFileSync(f.window.file, 'utf8')).toContain('合成值日打印班');
  expect(readFileSync(f.window.file, 'utf8')).toContain('data-row="slot:');
  expect(f.window.options).toMatchObject({
    title: '值日打印预览 · 第 1 版',
    webPreferences: { javascript: false, sandbox: true },
  });
  await click(f, 0);
  expect(f.message).toHaveBeenLastCalledWith(
    f.window,
    expect.objectContaining({ message: expect.stringContaining('已取消打印') }),
  );
  await click(f, 1);
  expect(f.pdf).not.toHaveBeenCalled();
  f.save.mockResolvedValue({ canceled: false, filePath: join(f.root, 'duty.pdf') });
  await click(f, 1);
  expect(f.message).toHaveBeenLastCalledWith(
    f.window,
    expect.objectContaining({ message: '值日表 PDF 已保存。' }),
  );
  expect(readFileSync(join(f.root, 'duty.pdf'), 'utf8')).toBe('synthetic-pdf');
  f.window.close();
  expect(await f.result).toMatchObject({ status: 'exported', submittedJobs: 0, pdfExports: 1 });
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
});

test('duty batches load through worker, keep fixed version, and label export ranges explicitly', async () => {
  const f = await fixture(false, false, 'duty', true);
  expect(f.window.menu[0]!.submenu![0]!.label).toBe('打印当前批次…');
  const next = f.window.menu[0]!.submenu!.findIndex((item) => item.label === '下一批');
  const previous = f.window.menu[0]!.submenu!.findIndex((item) => item.label === '上一批');
  expect(f.window.menu[0]!.submenu![previous]!.enabled).toBe(false);
  expect(f.window.menu[0]!.submenu![next]!.enabled).toBe(true);
  await click(f, next);
  expect(f.workerCall).toHaveBeenLastCalledWith(
    'readDutyPrintBatch',
    expect.objectContaining({ pageOffset: 100 }),
  );
  expect(readFileSync(f.window.file, 'utf8')).toContain('data-page="101"');
  f.save.mockResolvedValue({ canceled: false, filePath: join(f.root, 'batch.pdf') });
  await click(f, 1);
  expect(f.message).toHaveBeenLastCalledWith(
    f.window,
    expect.objectContaining({ message: expect.stringContaining('其余批次须分别导出') }),
  );
  expect(f.save).toHaveBeenLastCalledWith(
    f.window,
    expect.objectContaining({ defaultPath: expect.stringContaining('-p101-') }),
  );
  await click(f, previous);
  expect(readFileSync(f.window.file, 'utf8')).toContain('data-page="1"');
  f.window.close();
  expect(await f.result).toMatchObject({ batchCount: 2, pdfExports: 1 });
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
});

test('closing during a batch read ignores its late result and never recreates private HTML', async () => {
  const f = await fixture(false, false, 'duty', true);
  let release!: (value: Awaited<ReturnType<typeof f.workerCall>>) => void;
  f.workerCall.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  f.window.menu[0]!.submenu!.find((item) => item.label === '下一批')!.click!();
  f.window.close();
  expect(await f.result).toMatchObject({ status: 'interrupted', submittedJobs: 0, pdfExports: 0 });
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
  release({ ok: true, value: createDutyPrintDocument(dutyPrintView(400, 1, 2), 100) });
  await setImmediate();
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
  expect(f.pdf).not.toHaveBeenCalled();
});

test.each(['versionId', 'revision', 'totalPageCount', 'pageOffset'] as const)(
  'a mismatched duty batch %s preserves the displayed version and permits an explicit retry',
  async (field) => {
    const f = await fixture(false, false, 'duty', true);
    const original = readFileSync(f.window.file, 'utf8');
    const next = createDutyPrintDocument(dutyPrintView(400, 1, 2), 100);
    const changed = {
      ...next,
      [field]: field === 'versionId' ? 'wrong-version' : Number(next[field]) + 1,
    };
    f.workerCall.mockResolvedValueOnce({ ok: true, value: changed });
    const nextIndex = f.window.menu[0]!.submenu!.findIndex((item) => item.label === '下一批');
    await click(f, nextIndex);
    expect(readFileSync(f.window.file, 'utf8')).toBe(original);
    expect(f.print).not.toHaveBeenCalled();
    expect(f.pdf).not.toHaveBeenCalled();
    expect(f.message).toHaveBeenLastCalledWith(
      f.window,
      expect.objectContaining({ message: expect.stringContaining('批次读取失败') }),
    );
    await click(f, nextIndex);
    expect(readFileSync(f.window.file, 'utf8')).toContain('data-page="101"');
    f.window.close();
    expect(await f.result).toMatchObject({ submittedJobs: 0, pdfExports: 0 });
    expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
  },
);

test('failed duty batch navigation disables print/export until the requested page loads again', async () => {
  const f = await fixture(false, false, 'duty', true);
  const load = vi.spyOn(f.window, 'loadFile');
  load.mockRejectedValueOnce(new Error('Synthetic batch navigation failure'));
  const nextIndex = f.window.menu[0]!.submenu!.findIndex((item) => item.label === '下一批');
  f.window.menu[0]!.submenu![nextIndex]!.click!();
  await vi.waitFor(() => expect(f.message).toHaveBeenCalled());
  await setImmediate();
  expect(f.window.menu[0]!.submenu![0]!.enabled).toBe(false);
  expect(f.window.menu[0]!.submenu![1]!.enabled).toBe(false);
  // Invoking stale menu callbacks cannot print a partially loaded document either.
  f.window.menu[0]!.submenu![0]!.click!();
  f.window.menu[0]!.submenu![1]!.click!();
  expect(f.print).not.toHaveBeenCalled();
  expect(f.pdf).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
  await click(f, nextIndex);
  expect(load).toHaveBeenCalledTimes(2);
  expect(f.window.menu[0]!.submenu![0]!.enabled).toBe(true);
  expect(f.window.menu[0]!.submenu![1]!.enabled).toBe(true);
  f.window.close();
  expect(await f.result).toMatchObject({ submittedJobs: 0, pdfExports: 0 });
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
});

test('driver cancellation is explicit, success is counted, and no automatic retry occurs', async () => {
  const f = await fixture();
  await click(f, 0);
  expect(f.message).toHaveBeenLastCalledWith(
    f.window,
    expect.objectContaining({ message: expect.stringContaining('已取消打印') }),
  );
  expect(f.print).toHaveBeenCalledTimes(1);
  f.print.mockImplementation((_options, callback) => callback(true, ''));
  await click(f, 0);
  expect(f.print).toHaveBeenCalledTimes(2);
  f.window.close();
  expect(await f.result).toMatchObject({ status: 'submitted', submittedJobs: 1 });
  expect(f.outcome(false, 'Invalid printer settings')).toBe('failed');
  expect(f.outcome(false, 'Print job failed')).toBe('failed');
});

test('closing with an unresolved print callback reports unknown outcome without retrying', async () => {
  const f = await fixture();
  f.print.mockImplementation(() => {});
  f.window.menu[0]!.submenu![0]!.click!();
  f.window.close();
  expect(await f.result).toMatchObject({ status: 'interrupted', submittedJobs: 0 });
  expect(f.print).toHaveBeenCalledTimes(1);
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
});

test('PDF cancel writes nothing, protected export is rejected, successful export uses frozen document', async () => {
  const f = await fixture();
  await click(f, 1);
  expect(f.pdf).not.toHaveBeenCalled();
  f.save.mockResolvedValue({
    canceled: false,
    filePath: join(f.root, 'workspace-data', 'data.sqlite'),
  });
  await click(f, 1);
  expect(f.pdf).not.toHaveBeenCalled();
  f.save.mockResolvedValue({ canceled: false, filePath: join(f.root, 'export.pdf') });
  await click(f, 1);
  expect(readFileSync(join(f.root, 'export.pdf'), 'utf8')).toBe('synthetic-pdf');
  f.window.close();
  expect(await f.result).toMatchObject({ pdfExports: 1 });
  expect(readdirSync(f.root).sort()).toEqual(['cache', 'export.pdf']);
});

test('load failure removes the private preview rather than leaving student labels behind', async () => {
  const f = await fixture(true);
  await expect(f.result).rejects.toThrow('synthetic load failure');
  expect(f.window.destroyed).toBe(true);
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
});

test('cleanup failure preserves the print receipt and warns about a recoverable private residue', async () => {
  const f = await fixture(false, true);
  f.window.close();
  expect(await f.result).toMatchObject({ status: 'closed', temporaryCleanupFailed: true });
  expect(readFileSync(f.window.file, 'utf8')).toContain('合成打印班');
  expect(await recoverPrintPreviews(join(f.root, 'cache'))).toBe(0);
  expect(readdirSync(join(f.root, 'cache'))).toEqual([]);
});

test.each(['print', 'pdf', 'cancel'] as const)(
  'closing after %s completes but before the notice is dismissed preserves the known result',
  async (operation) => {
    const f = await fixture();
    let release!: (value: { response: number }) => void;
    f.message.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    if (operation === 'print')
      f.print.mockImplementation((_options, callback) => callback(true, ''));
    if (operation === 'pdf')
      f.save.mockResolvedValue({ canceled: false, filePath: join(f.root, 'saved.pdf') });
    f.window.menu[0]!.submenu![operation === 'pdf' ? 1 : 0]!.click!();
    await setImmediate();
    expect(f.message).toHaveBeenCalled();
    f.window.close();
    const result = await f.result;
    expect(result.status).toBe(
      operation === 'print' ? 'submitted' : operation === 'pdf' ? 'exported' : 'cancelled',
    );
    release({ response: 0 });
    await setImmediate();
  },
);
