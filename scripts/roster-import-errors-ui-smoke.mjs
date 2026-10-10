import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('output/playwright/roster-import-errors');
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(path.join(output, 'run-'));
const runtime = isolatedElectronRuntime('roster-errors-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: path.join(root, 'data'),
  TEMP: path.join(runtime.local, 'temp'),
  TMP: path.join(runtime.local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = { status: 'running', root, checks: [], errors: [] };
let app, page;
try {
  const rows = Array.from({ length: 50 }, (_, i) => `${i + 1},合成学生${i + 1},是`);
  const file = path.join(root, '合成名单.csv');
  await fs.writeFile(file, '学号,姓名,是否住校\n' + rows.join('\n') + '\n51,合成问题学生,未知编码');
  app = await electron.launch({
    executablePath: process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE ?? runtime.executablePath,
    args: process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '班主任管理', exact: true })
    .click();
  await page.getByRole('button', { name: '新建班级', exact: true }).click();
  await page.getByLabel('班级名称', { exact: true }).fill('合成导入检查班');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '学生管理', exact: true }).click();
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  const dialog = page.getByRole('dialog', { name: '把学生名单导入班级', exact: true });
  await dialog.getByRole('button', { name: '选择名单文件', exact: true }).click();
  await dialog.getByText(/待修正 1 行/).waitFor();
  assert.equal(
    await dialog.locator('tbody').getByText('合成问题学生', { exact: true }).isVisible(),
    true,
    'The blocking row on a later page must be visible immediately',
  );
  await dialog
    .getByRole('alert')
    .filter({ hasText: /还有 1 行需要修正/ })
    .waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: '修正 1 行后可导入', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    (await page.evaluate(() => window.classManager.snapshot())).value.students.length,
    0,
  );
  await page.screenshot({ path: path.join(root, 'blocked-preview.png'), fullPage: true });
  await dialog.getByRole('button', { name: '查看全部 51 行', exact: true }).click();
  assert.equal(
    await dialog.locator('tbody').getByText('合成学生1', { exact: true }).isVisible(),
    true,
  );
  await dialog.getByRole('button', { name: '只看问题行（1）', exact: true }).click();
  assert.equal(
    await dialog.locator('tbody').getByText('合成问题学生', { exact: true }).isVisible(),
    true,
  );
  report.checks.push(
    '50 valid rows plus one later-page error: the blocker is visible immediately, filters reset pagination, and confirmation explains why it is disabled.',
  );
  await fs.writeFile(file, '学号,姓名,是否住校\n' + rows.join('\n') + '\n51,合成问题学生,走读');
  await dialog.getByRole('button', { name: '选择名单文件', exact: true }).click();
  const confirm = dialog.getByRole('button', { name: '确认导入 51 人', exact: true });
  await confirm.waitFor();
  assert.equal(await confirm.isEnabled(), true);
  const table = dialog.locator('.table-scroll');
  await table.scrollIntoViewIfNeeded();
  const box = await table.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(
    () => document.querySelector('.roster-import-dialog .table-scroll').scrollTop > 0,
    null,
    { timeout: 2500 },
  );
  assert.ok(
    await table.evaluate((el) => el.scrollTop > 0),
    'The rows clipped below the preview must be reachable with the mouse wheel',
  );
  await dialog.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(
    await table.evaluate((el) => el.scrollTop),
    0,
    'Changing pages must reset the table scroll position',
  );
  assert.equal(
    await dialog.locator('tbody').getByText('合成学生21', { exact: true }).isVisible(),
    true,
  );
  await page.setViewportSize({ width: 720, height: 720 });
  await table.scrollIntoViewIfNeeded();
  const narrowBox = await table.boundingBox();
  assert.ok(
    await table.evaluate((el) => el.scrollWidth > el.clientWidth),
    'Narrow view should exercise horizontal overflow',
  );
  await page.mouse.move(narrowBox.x + narrowBox.width / 2, narrowBox.y + narrowBox.height / 2);
  await page.mouse.wheel(600, 0);
  await page.waitForFunction(
    () => document.querySelector('.roster-import-dialog .table-scroll').scrollLeft > 0,
    null,
    { timeout: 2500 },
  );
  const region = dialog.getByRole('region', { name: '名册导入预览表格', exact: true });
  await region.focus();
  await page.keyboard.press('Control+End');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.roster-import-dialog .table-scroll');
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    },
    null,
    { timeout: 2500 },
  );
  await dialog.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await table.evaluate((el) => el.scrollTop), 0);
  assert.equal(await table.evaluate((el) => el.scrollLeft), 0);
  assert.equal(
    await dialog.locator('tbody').getByText('合成学生41', { exact: true }).isVisible(),
    true,
  );
  await page.screenshot({ path: path.join(root, 'scrollable-preview.png'), fullPage: true });
  report.checks.push(
    'Mouse-wheel vertical scrolling exposes hidden rows; narrow-window horizontal scrolling and keyboard scrolling expose all columns and rows; changing pages resets both axes.',
  );
  await confirm.click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    (await page.evaluate(() => window.classManager.snapshot())).value.students.length,
    51,
  );
  report.checks.push(
    'Correcting and reselecting the file enables confirmation and imports all 51 students through real UI/IPC.',
  );
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  await dialog.getByRole('button', { name: '选择名单文件', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '没有需要新增或更新的学生' }).waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: '确认导入 0 人', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    (await page.evaluate(() => window.classManager.snapshot())).value.students.length,
    51,
  );
  report.checks.push(
    'Reimporting identical rows explains that there is nothing to save and creates no duplicate students.',
  );
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
  if (page)
    await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  if (app) await app.close().catch(() => {});
  console.log(JSON.stringify(report, null, 2));
}
