import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';
import { exerciseScoreUi } from './score-ui-smoke.mjs';
import { exerciseDutyUi } from './duty-ui-smoke.mjs';

const parent = resolve('output/playwright/guided-workflows');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const { local, executablePath } = isolatedElectronRuntime('guided-workflows-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'user-data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.CLASS_MANAGER_GUIDED_EXECUTABLE;
const app = await electron.launch({
  executablePath: packaged ?? executablePath,
  args: packaged ? [] : ['.'],
  env,
  timeout: 45000,
});
let page;
const report = {
  status: 'running',
  root,
  errors: [],
  gates: [],
  externalRequests: 0,
  packaged: !!packaged,
};
try {
  await app.evaluate(() => {
    globalThis.__guidedFetches = 0;
    globalThis.fetch = async () => {
      globalThis.__guidedFetches++;
      throw new Error('Guided workflow smoke forbids model requests');
    };
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await openWorkspacePage(page, '班主任管理', '班级名册');
  assert.equal(
    await page.getByRole('button', { name: '批量导入学生', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: '创建班级', exact: true }).last().click();
  await page.getByLabel('班级名称', { exact: true }).fill('合成批量导入班');
  await page.getByRole('button', { name: '保存班级', exact: true }).click();
  await page.getByRole('button', { name: '批量导入学生', exact: true }).waitFor();
  const call = async (name, input) => {
    const result = await page.evaluate(({ name, input }) => window.classManager[name](input), {
      name,
      input,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const rosterFile = join(root, '合成学生名单.csv');
  const templateFile = join(root, '班级名册模板.csv');
  await app.evaluate(
    ({ dialog }, paths) => {
      globalThis.__guidedRosterCancel = false;
      dialog.showOpenDialog = async () => ({
        canceled: globalThis.__guidedRosterCancel,
        filePaths: globalThis.__guidedRosterCancel ? [] : [paths.rosterFile],
      });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.templateFile });
    },
    { rosterFile, templateFile },
  );
  const openImport = async () => {
    await page.getByRole('button', { name: '批量导入学生', exact: true }).click();
    await page.getByRole('dialog', { name: '把学生名单导入班级', exact: true }).waitFor();
  };
  await openImport();
  let modal = page.getByRole('dialog', { name: '把学生名单导入班级', exact: true });
  assert.ok(
    (await modal.boundingBox()).width > 700,
    'Desktop import preview uses the wide dialog.',
  );
  await modal.getByRole('button', { name: '下载空白 CSV 模板', exact: true }).click();
  await modal.getByRole('status').filter({ hasText: '空白模板已下载' }).waitFor();
  assert.equal(readFileSync(templateFile, 'utf8'), '\uFEFF学生编号,姓名\r\n');
  writeFileSync(rosterFile, '学生编号,姓名\n0001,合成甲\n0001,合成甲\n0002,合成乙');
  await modal.getByRole('button', { name: '选择名单文件', exact: true }).click();
  await modal
    .getByText('文件内编号重复，请删除多余行后重新导入。', { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await modal.getByRole('button', { name: '确认导入 1 人', exact: true }).isDisabled(),
    true,
  );
  assert.equal((await call('snapshot')).students.length, 0);
  writeFileSync(
    rosterFile,
    '学生编号,姓名\n' +
      Array.from(
        { length: 45 },
        (_, i) => `${String(i + 1).padStart(4, '0')},合成学生${i + 1}`,
      ).join('\n'),
  );
  await modal.getByRole('button', { name: '选择名单文件', exact: true }).click();
  await modal.getByRole('button', { name: '确认导入 45 人', exact: true }).waitFor();
  assert.equal(await modal.locator('tbody tr').count(), 20);
  await modal.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await modal.locator('tbody tr').count(), 20);
  await modal.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await modal.locator('tbody tr').count(), 5);
  await page.screenshot({ path: join(root, 'roster-import-preview.png'), fullPage: true });
  // The actual native picker cancellation clears the old visible preview.
  await app.evaluate(() => {
    globalThis.__guidedRosterCancel = true;
  });
  await modal.getByRole('button', { name: '选择名单文件', exact: true }).click();
  await modal.locator('tbody').waitFor({ state: 'detached' });
  assert.equal(
    await modal.getByRole('button', { name: '确认导入', exact: true }).isDisabled(),
    true,
  );
  await app.evaluate(() => {
    globalThis.__guidedRosterCancel = false;
  });
  await modal.getByRole('button', { name: '选择名单文件', exact: true }).click();
  await modal.getByRole('button', { name: '确认导入 45 人', exact: true }).waitFor();
  // A lost reply occurs after the real SQLite transaction; retry must be idempotent.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('cm:confirmRosterImport');
    let lose = true;
    ipcMain.removeHandler('cm:confirmRosterImport');
    ipcMain.handle('cm:confirmRosterImport', async (event, input) => {
      const result = await original(event, input);
      if (result.ok && lose) {
        lose = false;
        throw new Error('合成导入回执中断');
      }
      return result;
    });
  });
  await modal.getByRole('button', { name: '确认导入 45 人', exact: true }).click();
  await modal.getByRole('status').filter({ hasText: '合成导入回执中断' }).waitFor();
  assert.equal((await call('snapshot')).students.length, 45);
  await modal.getByRole('button', { name: '确认导入 45 人', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  assert.equal((await call('snapshot')).students.length, 45);
  await openImport();
  modal = page.getByRole('dialog', { name: '把学生名单导入班级', exact: true });
  await modal.getByRole('button', { name: '选择名单文件', exact: true }).click();
  await modal.getByRole('button', { name: '确认导入 0 人', exact: true }).waitFor();
  assert.equal(
    await modal.getByRole('button', { name: '确认导入 0 人', exact: true }).isDisabled(),
    true,
  );
  await modal.getByRole('button', { name: '关闭批量导入', exact: true }).click();
  report.gates.push(
    'CSV template, duplicate rejection, 45-row paginated preview, native cancel, actual transaction with lost reply and exact retry, duplicate reimport skips existing identities.',
  );

  await openWorkspacePage(page, '班主任管理', '上课点名');
  await page.getByRole('tab', { name: '全班名单', exact: true }).click();
  assert.equal(await page.locator('#attendance-list-panel tbody tr').count(), 45);
  await page.getByRole('tab', { name: '逐人点名', exact: true }).click();
  await page.getByRole('button', { name: '到课并下一位', exact: true }).click();
  await page.getByRole('button', { name: '保存点名记录', exact: true }).click();
  await page.getByRole('button', { name: '确认保存点名', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '点名记录已保存' }).waitFor();
  await page.screenshot({ path: join(root, 'attendance-populated.png'), fullPage: true });
  report.gates.push(
    'Imported roster feeds actual attendance, preserves unmarked states and saves an explicitly reviewed record.',
  );
  await openWorkspacePage(page, '教师备课', '课堂与倒计时');
  const preview = page.locator('.classroom-preview-panel'),
    timer = page.locator('.activity-timer');
  const a = await preview.boundingBox(),
    b = await timer.boundingBox();
  assert.ok(
    a.x + a.width <= b.x && Math.abs(a.y - b.y) < 2,
    'Desktop preview and countdown must be side by side.',
  );
  await page.getByRole('button', { name: '10 分钟', exact: true }).click();
  assert.equal(await page.getByLabel('倒计时剩余时间', { exact: true }).innerText(), '10:00');
  await page.getByLabel('活动倒计时分钟').fill('');
  assert.equal(
    await page.getByRole('button', { name: '重置倒计时', exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel('活动倒计时分钟').fill('1');
  await page.getByRole('button', { name: '开始计时', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.timer-digits').textContent !== '01:00');
  await page.getByRole('button', { name: '暂停倒计时', exact: true }).click();
  const paused = await page.getByLabel('倒计时剩余时间').innerText();
  await page.waitForTimeout(1200);
  assert.equal(await page.getByLabel('倒计时剩余时间').innerText(), paused);
  await page.getByRole('button', { name: '重置倒计时', exact: true }).click();
  await page.getByRole('button', { name: '选择课件', exact: true }).click();
  await page.getByRole('dialog', { name: '确认课堂版本与范围', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭课件选择', exact: true }).click();
  await page.screenshot({ path: join(root, 'classroom-desktop.png'), fullPage: true });
  report.gates.push(
    'Classroom matches the two-column layout; activity timer validates input, starts, pauses and resets; lesson selection is a native modal.',
  );
  await openWorkspacePage(page, '教师备课', '本地备课');
  await page.getByRole('button', { name: '新建备课任务', exact: true }).click();
  await page.getByRole('heading', { name: '这节课准备怎么上？', exact: true }).waitFor();
  assert.equal(await page.locator('.lesson-preparation .flow-steps li').count(), 3);
  const library = await page.locator('.lesson-library').boundingBox();
  const preparation = await page.locator('.lesson-preparation').boundingBox();
  assert.ok(
    library.x + library.width <= preparation.x && Math.abs(library.y - preparation.y) < 2,
    'Desktop prep shows reference materials beside the three-step form.',
  );
  await page.screenshot({ path: join(root, 'prep-guidance.png'), fullPage: true });
  await page.getByRole('button', { name: '返回备课资料', exact: true }).click();
  await openWorkspacePage(page, '班主任管理', '班级名册');
  await exerciseScoreUi(app, page, root, root);
  report.gates.push(
    'New exam configuration and actual file preview, mapping, import, corrections and immutable score history all work.',
  );
  await exerciseDutyUi(app, page, root);
  report.gates.push(
    'Weekly duty cards retain actual replacement, absences, frozen completed days, revision history, lost-reply replay and narrow-window checks.',
  );
  for (const width of [1440, 1024, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(
      viewport.width <= width && viewport.width >= width - 40,
      `Requested ${width}px viewport actually rendered ${viewport.width}px.`,
    );
    for (const [area, label] of [
      ['教师备课', '课堂与倒计时'],
      ['班主任管理', '上课点名'],
      ['班主任管理', '值日轮换'],
      ['班主任管理', '成长档案'],
    ]) {
      await openWorkspacePage(page, area, label);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${label}: ${width}px`,
      );
      await page.screenshot({ path: join(root, `${label}-${width}.png`), fullPage: true });
    }
  }
  report.gates.push(
    'All four affected classroom/attendance/duty/growth pages fit 1440, 1024, 760 and 390px windows.',
  );
  report.externalRequests = await app.evaluate(() => globalThis.__guidedFetches);
  assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.errors.push(String(e));
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(
      join(root, 'failure-body.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  throw e;
} finally {
  await app.close();
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
