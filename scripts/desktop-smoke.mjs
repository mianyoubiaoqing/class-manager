import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packaged = process.argv.includes('--packaged');
const root = mkdtempSync(join(tmpdir(), 'class-manager-desktop-'));
const dataDirectory = join(root, '合成 数据');
const output = resolve('output/playwright', packaged ? 'packaged' : 'development');
mkdirSync(output, { recursive: true });
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const options = {
  args: packaged ? [] : ['.'],
  cwd: process.cwd(),
  env,
  timeout: 45000,
  ...(packaged ? { executablePath: resolve('release/win-unpacked/Class Manager.exe') } : {}),
};
const errors = [];
let application;
const launch = async () => {
  application = await electron.launch(options);
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  return page;
};
const waitForSaved = async (page, text) => {
  await page.getByRole('status').filter({ hasText: text }).waitFor();
};
try {
  let page = await launch();
  const second = spawnSync(
    packaged ? options.executablePath : electronPath,
    packaged ? [] : ['.'],
    {
      cwd: process.cwd(),
      env,
      timeout: 15000,
      encoding: 'utf8',
    },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1,
  );
  await page.getByRole('button', { name: '载入合成样例', exact: true }).click();
  await page.getByRole('button', { name: '确认载入', exact: true }).click();
  await waitForSaved(page, '合成样例已保存');
  assert.equal(await page.locator('tbody tr').count(), 15);
  await page.getByRole('button', { name: '添加学生', exact: true }).click();
  await page.getByLabel('姓名', { exact: true }).fill('合成独立测试');
  await page.getByLabel('学生编号', { exact: true }).fill('E2E-001');
  await page.getByRole('button', { name: '保存学生', exact: true }).click();
  await waitForSaved(page, '学生记录已保存');
  await page.getByRole('textbox', { name: '搜索学生' }).fill('E2E-001');
  assert.equal(await page.locator('tbody tr').count(), 1);
  assert.match(await page.locator('tbody').innerText(), /合成独立测试/);
  await page.getByRole('button', { name: '编辑 E2E-001', exact: true }).click();
  await page.getByLabel('姓名', { exact: true }).fill('合成独立测试修订');
  await page.getByRole('button', { name: '保存学生', exact: true }).click();
  await waitForSaved(page, '学生记录已保存');
  await page.getByRole('textbox', { name: '搜索学生' }).fill('');
  await page.screenshot({ path: join(output, 'roster-desktop.png'), fullPage: true });
  const isolation = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    api: Object.keys(window.classManager),
  }));
  assert.equal(isolation.require, 'undefined');
  assert.equal(isolation.process, 'undefined');
  assert.equal(isolation.api.length, 12);
  const preferences = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 390, height: 844 }),
  );
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await page.screenshot({ path: join(output, 'roster-narrow.png'), fullPage: true });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1240, height: 820 }),
  );
  await page.getByRole('button', { name: '数据与维护' }).click();
  await page.getByRole('button', { name: '添加合成验证附件', exact: true }).click();
  await waitForSaved(page, '合成验证附件已保存');
  const backupPath = join(root, 'roundtrip.cmbackup');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, backupPath);
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  await waitForSaved(page, '备份已保存');
  const bundle = JSON.parse(readFileSync(backupPath, 'utf8'));
  assert.equal(bundle.assets.length, 1);
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  });
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  await waitForSaved(page, '已取消备份保存');
  const invalidPath = join(root, 'invalid.cmbackup');
  writeFileSync(invalidPath, '{"format":"not-a-backup"}');
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, invalidPath);
  await page.getByRole('button', { name: '选择备份恢复', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '不是受支持的 M0 备份' }).waitFor();
  const afterInvalid = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(afterInvalid.value.students.length, 101);
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, backupPath);
  await page.getByRole('button', { name: '选择备份恢复', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: join(output, 'restore-confirmation.png'), fullPage: true });
  await page.getByRole('button', { name: '确认替换并恢复', exact: true }).click();
  await waitForSaved(page, '备份已恢复');
  await page.getByRole('button', { name: '回退到恢复前', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '确认替换并恢复', exact: true }).click();
  await waitForSaved(page, '备份已恢复');
  const diagnosticsPath = join(root, 'diagnostics.json');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, diagnosticsPath);
  await page.getByRole('button', { name: '导出诊断', exact: true }).click();
  await waitForSaved(page, '诊断已保存');
  const diagnostics = readFileSync(diagnosticsPath, 'utf8');
  assert.doesNotMatch(diagnostics, /合成独立测试|E2E-001|DEMO-1|workspace-data|base64/);
  assert.equal(JSON.parse(diagnostics).counts.students, 101);
  await page.screenshot({ path: join(output, 'maintenance.png'), fullPage: true });
  await application.close();
  application = undefined;
  for (let index = 0; index < 10; index++) {
    page = await launch();
    const result = await page.evaluate(() => window.classManager.snapshot());
    assert.equal(result.ok, true);
    assert.equal(result.value.students.length, 101);
    assert.equal(result.value.assets.length, 1);
    assert.equal(
      result.value.students.find((student) => student.studentNumber === 'E2E-001').displayName,
      '合成独立测试修订',
    );
    await application.close();
    application = undefined;
  }
  assert.deepEqual(errors, []);
  const report = {
    status: 'passed',
    packaged,
    at: new Date().toISOString(),
    reopenCycles: 10,
    cases: [
      'single-instance',
      'create-edit',
      'sandbox',
      'narrow-layout',
      'backup',
      'cancel-save',
      'invalid-backup',
      'restore',
      'recovery-copy',
      'redacted-diagnostics',
      'reopen',
    ],
    dataDirectory,
    output,
    errors,
  };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (application) {
    const page = await application.firstWindow().catch(() => undefined);
    if (page) {
      console.error(
        (
          await page
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 7000),
      );
      await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    }
  }
  throw error;
} finally {
  await application?.close();
}
