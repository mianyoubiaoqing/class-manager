import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

const parent = resolve('output/playwright/customer-friction');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const { local, executablePath } = isolatedElectronRuntime('customer-friction-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const packagedExecutable = process.env.CLASS_MANAGER_FRICTION_EXECUTABLE;
const app = await electron.launch({
  executablePath: packagedExecutable || executablePath,
  args: packagedExecutable ? [] : ['.'],
  env,
});
const report = { status: 'running', root, checks: [], errors: [] };
try {
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw Error('Offline customer friction test');
    };
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await openWorkspacePage(page, '班主任管理', '班级名册');
  await page.getByRole('button', { name: '创建班级', exact: true }).last().click();
  await page.getByLabel('班级名称', { exact: true }).fill('合成空名单班');
  await page.getByRole('button', { name: '保存班级', exact: true }).click();
  const originalPath = join(root, '已有客户名单.csv');
  const original = '学生编号,姓名\r\n001,合成原始学生\r\n';
  writeFileSync(originalPath, original);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, originalPath);
  const protectedExport = await page.evaluate(async () => {
    const snapshot = await window.classManager.snapshot();
    return window.classManager.exportRosterTemplate({ epoch: snapshot.value.epoch, format: 'csv' });
  });
  const originalPreserved = readFileSync(originalPath, 'utf8') === original;
  report.checks.push({ existingTemplateRejected: !protectedExport.ok, originalPreserved });
  const nav = page.getByRole('navigation', { name: '班主任管理功能', exact: true });
  await nav.getByRole('button', { name: '上课点名', exact: true }).click();
  await page.getByRole('heading', { name: '上课点名', level: 1, exact: true }).waitFor();
  report.checks.push('Empty roster alone does not lock navigation');
  await nav.getByRole('button', { name: '班级名册', exact: true }).click();
  await page.getByRole('button', { name: '批量导入学生', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '把学生名单导入班级', exact: true });
  await dialog.waitFor();
  await page.screenshot({ path: join(root, 'import-before.png'), fullPage: true });
  const downloadLabel = await dialog
    .getByRole('button', { name: '下载空白 XLSX 模板', exact: true })
    .count();
  const progressLabel = await dialog.getByLabel('导入进度（按顺序完成）', { exact: true }).count();
  report.checks.push({ downloadLabel, progressLabel });
  await dialog.getByRole('button', { name: '关闭批量导入', exact: true }).click();
  await nav.getByRole('button', { name: '成绩管理', exact: true }).click();
  await page.getByRole('button', { name: '新建考试导入', exact: true }).click();
  await page.getByText('该班级没有在籍学生。', { exact: true }).waitFor();
  const emptyRosterAction = await page
    .getByRole('button', { name: '先导入学生名单', exact: true })
    .count();
  report.checks.push({ emptyRosterAction });
  await page.screenshot({ path: join(root, 'exam-before.png'), fullPage: true });
  assert.equal(
    originalPreserved,
    true,
    'Video 1: downloading a blank template must never replace the existing filled teacher roster',
  );
  assert.equal(protectedExport.ok, false, 'Existing template destination must be rejected');
  assert.equal(
    downloadLabel,
    1,
    'Video 1: clearly distinguish downloading a blank template from importing an existing roster',
  );
  assert.equal(
    progressLabel,
    1,
    'Video 2: indicate that steps are sequential progress, not navigation tabs',
  );
  assert.equal(
    emptyRosterAction,
    1,
    'Video 4: provide a direct next step for an empty examination roster',
  );
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.errors.push(e.message);
  throw e;
} finally {
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await app.close();
}
