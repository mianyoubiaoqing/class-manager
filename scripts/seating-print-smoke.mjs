import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const packaged = process.argv.includes('--packaged');
const root = mkdtempSync(join(tmpdir(), 'cm-seating-print-smoke-'));
const output = resolve(
  'output/playwright',
  packaged ? 'seating-print-packaged' : 'seating-print-development',
);
mkdirSync(output, { recursive: true });
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: join(root, 'synthetic-user') };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = packaged
  ? (process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE ??
    resolve('release/win-unpacked/Class Manager.exe'))
  : electronPath;
let app;
const errors = [];
async function waitUntil(check, description) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
try {
  app = await electron.launch({
    executablePath,
    args: packaged ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  await app.evaluate(({ Menu, dialog }) => {
    globalThis.fetch = async () => {
      throw new Error('Print smoke forbids model calls');
    };
    globalThis.__cmPrintTest = { menu: null, messages: [], destination: null, printCalls: [] };
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = build(template);
      globalThis.__cmPrintTest.menu = menu;
      return menu;
    };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__cmPrintTest.messages.push(options.message);
      return { response: 0, checkboxChecked: false };
    };
    dialog.showSaveDialog = async () => {
      const filePath = globalThis.__cmPrintTest.destination;
      return { canceled: !filePath, filePath: filePath ?? undefined };
    };
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const api = window.classManager;
    const unwrap = (result) => {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    };
    const initial = unwrap(await api.snapshot());
    const epoch = initial.epoch;
    const small = unwrap(await api.createClass({ epoch, name: '打印历史 <合成班>' })).classes[0];
    for (let i = 0; i < 3; i++)
      unwrap(
        await api.saveStudent({
          epoch,
          classId: small.id,
          studentNumber: `P${i}`,
          displayName: i === 0 ? '<img src=x onerror=alert(1)>' : `打印合成${i}`,
        }),
      );
    async function confirm(classId, rows, columns, expectedRevision = 0) {
      const prepared = unwrap(
        await api.prepareSeating({
          epoch,
          classId,
          expectedRevision,
          source: { kind: 'empty', layout: { rows, columns, unavailable: [] } },
        }),
      );
      const ready = unwrap(
        await api.adjustSeating({ epoch, token: prepared.token, change: { kind: 'randomize' } }),
      );
      return unwrap(
        await api.confirmSeating({
          epoch,
          token: ready.token,
          expectedRevision,
          requestId: crypto.randomUUID(),
          reason: '合成打印验证',
        }),
      );
    }
    const smallV1 = await confirm(small.id, 2, 2);
    unwrap(
      await api.renameClass({
        epoch,
        id: small.id,
        expectedRevision: small.revision,
        name: '历史后已改班名',
      }),
    );
    await confirm(small.id, 3, 2, 1);
    const maxSnapshot = unwrap(await api.createClass({ epoch, name: '班'.repeat(80) }));
    const large = maxSnapshot.classes.find((item) => item.id !== small.id);
    for (let i = 0; i < 400; i++)
      unwrap(
        await api.saveStudent({
          epoch,
          classId: large.id,
          studentNumber: `MAX${String(i).padStart(29, '0')}`,
          displayName: '长'.repeat(60),
        }),
      );
    const max = await confirm(large.id, 20, 20);
    return {
      epoch,
      smallClassId: small.id,
      oldId: smallV1.versionId,
      largeClassId: large.id,
      maxId: max.versionId,
    };
  });
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  await page.getByRole('button', { name: '座次表', exact: true }).click();
  const area = page.getByRole('region', { name: '座位编排工作区' });
  await area.getByLabel('座位班级').selectOption(fixture.smallClassId);
  await area.getByLabel('已确认座位版本').selectOption(fixture.oldId);
  await area.getByText(/历史版本 ·/).waitFor();
  const opening = app.waitForEvent('window');
  await area.getByRole('button', { name: '预览与打印所选版本' }).click();
  let preview = await opening;
  await preview.locator('.sheet').waitFor();
  const original = await preview.locator('body').innerText();
  assert.match(original, /打印历史 <合成班>/);
  assert.doesNotMatch(original, /历史后已改班名/);
  assert.match(original, /<img src=x onerror=alert\(1\)>/);
  assert.equal(await preview.locator('img,script,iframe').count(), 0);
  assert.equal(await preview.evaluate(() => typeof window.classManager), 'undefined');
  const preferences = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((item) => item.getParentWindow())
      .webContents.getLastWebPreferences(),
  );
  assert.equal(preferences.javascript, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.preload, undefined);
  await preview.screenshot({ path: join(output, 'history-preview.png'), fullPage: true });
  const beforeTemp = await preview.url();

  async function menu(index) {
    await app.evaluate((_electron, index) => {
      const menu = globalThis.__cmPrintTest.menu;
      const item = menu.items[0].submenu.items[index];
      if (!item.enabled) throw new Error('Menu disabled');
      item.click();
    }, index);
  }
  async function idle() {
    await waitUntil(
      () => app.evaluate(() => globalThis.__cmPrintTest.menu.items[0].submenu.items[0].enabled),
      'print menu idle',
    );
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.getParentWindow());
    window.webContents.print = (options, callback) => {
      globalThis.__cmPrintTest.printCalls.push(options);
      callback(false, 'Print job canceled');
    };
  });
  await menu(0);
  await idle();
  assert.match(await app.evaluate(() => globalThis.__cmPrintTest.messages.at(-1)), /已取消打印/);
  await menu(1);
  await idle();
  assert.match(await app.evaluate(() => globalThis.__cmPrintTest.messages.at(-1)), /已取消 PDF/);
  const historicalPdf = join(output, 'history.pdf');
  await app.evaluate((_electron, path) => {
    globalThis.__cmPrintTest.destination = path;
  }, historicalPdf);
  await menu(1);
  await idle();
  assert.equal(readFileSync(historicalPdf).subarray(0, 5).toString(), '%PDF-');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((item) => item.getParentWindow())
      .close(),
  );
  await area.getByRole('status').filter({ hasText: '第 1 版预览已关闭' }).waitFor();
  assert.equal(existsSync(new URL(beforeTemp)), false, 'Owned temporary HTML must be removed');

  await area.getByLabel('座位班级').selectOption(fixture.largeClassId);
  await area
    .getByLabel('已确认座位版本')
    .locator('option')
    .filter({ hasText: '第 1 版' })
    .waitFor({ state: 'attached' });
  const maxOpening = app.waitForEvent('window');
  await area.getByRole('button', { name: '预览与打印所选版本' }).click();
  preview = await maxOpening;
  await preview.locator('.sheet').first().waitFor();
  const maximum = await preview.evaluate(() => {
    const sheets = [...document.querySelectorAll('.sheet')];
    const seats = [...document.querySelectorAll('.seat')];
    return {
      pageCount: sheets.length,
      members: seats.map((item) => item.getAttribute('data-student-id')).filter(Boolean),
      bounds:
        seats.every((seat) => {
          const rect = seat.getBoundingClientRect();
          return [...seat.children].every((text) => {
            const child = text.getBoundingClientRect();
            return (
              child.bottom <= rect.bottom &&
              child.right <= rect.right &&
              child.left >= rect.left &&
              text.scrollWidth <= text.clientWidth
            );
          });
        }) &&
        sheets.every((sheet) => {
          const header = sheet.querySelector('header').getBoundingClientRect();
          const front = sheet.querySelector('.front').getBoundingClientRect();
          const grid = sheet.querySelector('.grid').getBoundingClientRect();
          const footer = sheet.querySelector('footer').getBoundingClientRect();
          return front.bottom <= header.bottom && grid.bottom <= footer.top;
        }),
    };
  });
  assert.equal(maximum.members.length, 400);
  assert.equal(new Set(maximum.members).size, 400);
  assert.equal(
    maximum.bounds,
    true,
    'All labels, headers, grids and footers must fit without overlap',
  );
  await preview
    .locator('.sheet')
    .first()
    .screenshot({ path: join(output, 'maximum-first-page.png') });
  await preview
    .locator('.sheet')
    .last()
    .screenshot({ path: join(output, 'maximum-last-page.png') });
  const maximumPdf = join(output, 'maximum.pdf');
  await app.evaluate((_electron, path) => {
    globalThis.__cmPrintTest.destination = path;
  }, maximumPdf);
  await menu(1);
  await idle();
  assert.equal(readFileSync(maximumPdf).subarray(0, 5).toString(), '%PDF-');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((item) => item.getParentWindow())
      .close(),
  );
  await area.getByRole('status').filter({ hasText: '预览已关闭' }).waitFor();
  assert.equal(await area.getByRole('button', { name: '从最新版本调整' }).isEnabled(), true);
  assert.deepEqual(errors, []);
  const report = {
    status: 'passed',
    packaged,
    executablePath,
    at: new Date().toISOString(),
    confirmedHistoricalVersion: fixture.oldId,
    maximumVersion: fixture.maxId,
    maximumPageCount: maximum.pageCount,
    members: maximum.members,
    actualPdfGeneration: true,
    physicalPrinterDriver: 'controlled cancellation callback; no paper-output claim',
    historicalPdf,
    maximumPdf,
    errors,
  };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, members: report.members.length }, null, 2));
} finally {
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows())
          if (window.getParentWindow()) window.destroy();
      })
      .catch(() => {});
    await app.close();
  }
  const remaining = readdirSync(root);
  console.log(
    `Synthetic print workspace retained for audit (${remaining.length} top-level entries).`,
  );
}
