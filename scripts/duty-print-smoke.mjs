import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packaged = process.argv.includes('--packaged');
const root = mkdtempSync(join(tmpdir(), 'cm-duty-print-'));
const output = resolve(
  'output/playwright',
  packaged ? 'duty-print-packaged' : 'duty-print-development',
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
async function idle() {
  const deadline = Date.now() + 60000;
  while (
    !(await app.evaluate(() => globalThis.__cmDutyPrint.menu.items[0].submenu.items[0].enabled))
  ) {
    if (Date.now() > deadline) throw new Error('Print action did not settle');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function menu(index) {
  await app.evaluate((_electron, index) => {
    const item = globalThis.__cmDutyPrint.menu.items[0].submenu.items[index];
    if (!item.enabled) throw new Error('Menu disabled');
    item.click();
  }, index);
  await idle();
}
async function closePreview() {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getParentWindow())
      .close(),
  );
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
      throw new Error('Print verification forbids model calls');
    };
    globalThis.__cmDutyPrint = { menu: null, destination: null, messages: [] };
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = build(template);
      globalThis.__cmDutyPrint.menu = menu;
      return menu;
    };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__cmDutyPrint.messages.push(options.message);
      return { response: 0 };
    };
    dialog.showSaveDialog = async () => {
      const filePath = globalThis.__cmDutyPrint.destination;
      return { canceled: !filePath, filePath: filePath ?? undefined };
    };
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const api = window.classManager;
    const value = (result) => {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    };
    const epoch = value(await api.snapshot()).epoch;
    const small = value(await api.createClass({ epoch, name: '值日打印历史 <合成班>' })).classes[0];
    for (let index = 0; index < 3; index++)
      value(
        await api.saveStudent({
          epoch,
          classId: small.id,
          studentNumber: `P${index}`,
          displayName: index === 0 ? '<img src=x onerror=alert(1)>' : `打印成员${index}`,
        }),
      );
    const dates = [1, 2].map((offset) =>
      new Date(Date.now() + offset * 86400000 + 8 * 3600000).toISOString().slice(0, 10),
    );
    const confirm = async (draft) =>
      value(
        await api.confirmDuty({
          epoch,
          token: draft.token,
          requestId: crypto.randomUUID(),
          expectedRevision: draft.expectedRevision,
          reason: '合成打印验证',
        }),
      );
    async function prepare(classId, title, count, groups) {
      const roster = value(await api.snapshot());
      return value(
        await api.prepareDuty({
          epoch,
          classId,
          expectedRevision: 0,
          source: {
            kind: 'new',
            title,
            participantIds: roster.students
              .filter((s) => s.classId === classId && s.active)
              .map((s) => s.id),
            dates,
            groupCount: groups,
            unavailable: [],
            posts: [
              {
                id: crypto.randomUUID(),
                name: count > 3 ? '岗'.repeat(60) : '清扫岗位',
                startMinute: 960,
                endMinute: 990,
                required: count / groups,
              },
            ],
          },
        }),
      );
    }
    const smallDraft = await prepare(small.id, '历史值日计划', 3, 1);
    const old = await confirm(smallDraft);
    value(
      await api.renameClass({
        epoch,
        id: small.id,
        expectedRevision: small.revision,
        name: '值日历史后已改班名',
      }),
    );
    const revision = value(
      await api.prepareDuty({
        epoch,
        classId: small.id,
        expectedRevision: 1,
        source: { kind: 'latest', planId: old.planId },
      }),
    );
    await confirm(revision);
    const snapshot = value(await api.createClass({ epoch, name: '班'.repeat(80) }));
    const large = snapshot.classes.find((item) => item.id !== small.id);
    for (let index = 0; index < 400; index++)
      value(
        await api.saveStudent({
          epoch,
          classId: large.id,
          studentNumber: `MAX${String(index).padStart(29, '0')}`,
          displayName: '长'.repeat(60),
        }),
      );
    let draft = await prepare(large.id, '期'.repeat(80), 400, 10);
    draft = value(
      await api.adjustDuty({
        epoch,
        token: draft.token,
        change: {
          kind: 'groups',
          groups: draft.draft.groups.map((g, index) => ({
            ...g,
            name: `${index}${'组'.repeat(39)}`,
          })),
        },
      }),
    );
    const maximum = await confirm(draft);
    const expectedRows = [
      ...draft.draft.groups.flatMap((g) => g.studentIds.map((id) => `group:${g.id}:${id}`)),
      ...draft.draft.days.flatMap((day) => [
        ...day.posts.flatMap((p) =>
          p.slots.map((_slot, index) => `slot:${day.date}:${p.postId}:${index}`),
        ),
        ...day.groupMemberIds.map((id) => `day:${day.date}:${id}`),
      ]),
    ];
    const batched = value(
      await api.prepareDuty({
        epoch,
        classId: large.id,
        expectedRevision: 0,
        source: {
          kind: 'new',
          title: '分批合成值日',
          participantIds: draft.draft.participantIds,
          dates: dates.slice(0, 1),
          groupCount: 1,
          unavailable: [],
          posts: [
            {
              id: crypto.randomUUID(),
              name: '分批清扫',
              startMinute: 1080,
              endMinute: 1100,
              required: 400,
            },
          ],
        },
      }),
    );
    const batch = await confirm(batched);
    return {
      epoch,
      smallClassId: small.id,
      oldId: old.versionId,
      largeClassId: large.id,
      maxId: maximum.versionId,
      maxPlanId: maximum.planId,
      batchPlanId: batch.planId,
      batchVersionId: batch.versionId,
      expectedRows,
    };
  });
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  await page.getByRole('button', { name: '值日轮换', exact: true }).click();
  const area = page.getByRole('region', { name: '值日轮换工作区' });
  await area.getByLabel('值日班级').selectOption(fixture.smallClassId);
  await area.getByLabel('已确认值日版本').selectOption(fixture.oldId);
  await area.getByText(/历史版本 ·/).waitFor();
  let opening = app.waitForEvent('window');
  await area.getByRole('button', { name: '预览与打印所选值日版本' }).click();
  let preview = await opening;
  await preview.locator('.sheet').first().waitFor();
  const historic = await preview.locator('body').innerText();
  assert.match(historic, /值日打印历史 <合成班>/);
  assert.doesNotMatch(historic, /值日历史后已改班名/);
  assert.match(historic, /<img src=x onerror=alert\(1\)>/);
  assert.equal(await preview.locator('script,img,iframe').count(), 0);
  assert.equal(await preview.evaluate(() => typeof window.classManager), 'undefined');
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getParentWindow())
      .webContents.getLastWebPreferences(),
  );
  assert.equal(prefs.javascript, false);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.preload, undefined);
  const blocked = await page.evaluate(
    (epoch) => window.classManager.createClass({ epoch, name: '不得创建' }),
    fixture.epoch,
  );
  assert.equal(blocked.error.code, 'BUSY');
  const read = await page.evaluate((input) => window.classManager.readDutyVersion(input), {
    epoch: fixture.epoch,
    versionId: fixture.oldId,
  });
  assert.equal(read.ok, true);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.getParentWindow()).webContents.print = (
      _options,
      callback,
    ) => callback(false, 'Print job canceled');
  });
  await menu(0);
  assert.match(await app.evaluate(() => globalThis.__cmDutyPrint.messages.at(-1)), /已取消打印/);
  await menu(1);
  assert.match(await app.evaluate(() => globalThis.__cmDutyPrint.messages.at(-1)), /已取消 PDF/);
  const historyPages = await preview.locator('.sheet').count();
  const oldTemp = preview.url();
  const historicalPdf = join(output, 'history.pdf');
  await app.evaluate((_electron, path) => {
    globalThis.__cmDutyPrint.destination = path;
  }, historicalPdf);
  await menu(1);
  assert.match(
    await app.evaluate(() => globalThis.__cmDutyPrint.messages.at(-1)),
    /值日表 PDF 已保存/,
  );
  assert.equal(readFileSync(historicalPdf).subarray(0, 5).toString(), '%PDF-');
  await preview
    .locator('.sheet')
    .first()
    .screenshot({ path: join(output, 'history-preview.png') });
  await closePreview();
  await area.getByRole('status').filter({ hasText: '第 1 版预览已关闭' }).waitFor();
  assert.equal(existsSync(new URL(oldTemp)), false);

  await area.getByLabel('值日班级').selectOption(fixture.largeClassId);
  await area
    .getByLabel('已确认值日版本')
    .locator('option')
    .filter({ hasText: '第 1 版' })
    .waitFor({ state: 'attached' });
  await area.getByLabel('已确认值日计划').selectOption(fixture.maxPlanId);
  await area
    .getByLabel('已确认值日版本')
    .locator(`option[value="${fixture.maxId}"]`)
    .waitFor({ state: 'attached' });
  opening = app.waitForEvent('window');
  await area.getByRole('button', { name: '预览与打印所选值日版本' }).click();
  preview = await opening;
  await preview.locator('.sheet').first().waitFor();
  const maximum = await preview.evaluate(() => {
    const sheets = [...document.querySelectorAll('.sheet')];
    const rows = [...document.querySelectorAll('[data-row]')];
    return {
      pageCount: sheets.length,
      rows: rows.map((row) => row.getAttribute('data-row')),
      bounds:
        sheets.every((sheet) => {
          const heading = sheet.querySelector('h3').getBoundingClientRect();
          const header = sheet.querySelector('header').getBoundingClientRect();
          const table = sheet.querySelector('table').getBoundingClientRect();
          const footer = sheet.querySelector('footer').getBoundingClientRect();
          return heading.bottom <= header.bottom && table.bottom <= footer.top;
        }) &&
        [...document.querySelectorAll('td,th')].every((cell) => {
          const box = cell.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(cell);
          const text = range.getBoundingClientRect();
          return (
            text.left >= box.left &&
            text.right <= box.right &&
            text.top >= box.top &&
            text.bottom <= box.bottom
          );
        }),
    };
  });
  assert.deepEqual([...maximum.rows].sort(), [...fixture.expectedRows].sort());
  assert.equal(maximum.rows.length, 560);
  assert.equal(maximum.bounds, true, 'All text, headers, rows and footers fit their pages');
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
    globalThis.__cmDutyPrint.destination = path;
  }, maximumPdf);
  await menu(1);
  assert.match(
    await app.evaluate(() => globalThis.__cmDutyPrint.messages.at(-1)),
    /值日表 PDF 已保存/,
  );
  assert.equal(readFileSync(maximumPdf).subarray(0, 5).toString(), '%PDF-');
  await closePreview();
  await area.getByRole('status').filter({ hasText: '预览已关闭' }).waitFor();
  assert.equal(await area.getByRole('button', { name: '调整本期最新版本' }).isEnabled(), true);
  await area.getByLabel('已确认值日计划').selectOption(fixture.batchPlanId);
  await area
    .getByLabel('已确认值日版本')
    .locator(`option[value="${fixture.batchVersionId}"]`)
    .waitFor({ state: 'attached' });
  opening = app.waitForEvent('window');
  await area.getByRole('button', { name: '预览与打印所选值日版本' }).click();
  preview = await opening;
  await preview.locator('.sheet').first().waitFor();
  const batchPages = [];
  const batchRows = [];
  const batchPdfs = [];
  for (let batch = 0; ; batch++) {
    const pages = await preview.locator('.sheet').count();
    assert.ok(pages <= 100);
    assert.equal(
      await preview.locator('.sheet').first().getAttribute('data-page'),
      String(batch * 100 + 1),
    );
    batchPages.push(pages);
    batchRows.push(
      ...(await preview
        .locator('[data-row]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))),
    );
    const pdf = join(output, `batch-${batch + 1}.pdf`);
    batchPdfs.push(pdf);
    await app.evaluate((_electron, path) => {
      globalThis.__cmDutyPrint.destination = path;
    }, pdf);
    await menu(1);
    assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
    const next = await app.evaluate(() =>
      globalThis.__cmDutyPrint.menu.items[0].submenu.items.findIndex(
        (item) => item.label === '下一批' && item.enabled,
      ),
    );
    if (next < 0) break;
    await menu(next);
  }
  assert.equal(batchRows.length, 1200);
  assert.equal(new Set(batchRows).size, 1200);
  assert.equal(batchPages.length, 2);
  const previous = await app.evaluate(() =>
    globalThis.__cmDutyPrint.menu.items[0].submenu.items.findIndex(
      (item) => item.label === '上一批',
    ),
  );
  await menu(previous);
  assert.equal(await preview.locator('.sheet').first().getAttribute('data-page'), '1');
  await closePreview();
  await area.getByRole('status').filter({ hasText: '2 批' }).waitFor();
  assert.deepEqual(errors, []);
  const report = {
    status: 'passed',
    packaged,
    executablePath,
    at: new Date().toISOString(),
    confirmedHistoricalVersion: fixture.oldId,
    maximumVersion: fixture.maxId,
    historicalPageCount: historyPages,
    maximumPageCount: maximum.pageCount,
    expectedRows: fixture.expectedRows,
    rowCount: maximum.rows.length,
    actualPdfGeneration: true,
    physicalPrinterDriver: 'controlled cancellation callback; no paper-output claim',
    historicalPdf,
    maximumPdf,
    batchPages,
    batchPdfs,
    batchRows: batchRows.length,
    batchVersionId: fixture.batchVersionId,
    errors,
  };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, expectedRows: report.expectedRows.length }, null, 2));
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
}
