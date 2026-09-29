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
  const expectedApis = [
    'snapshot',
    'createClass',
    'renameClass',
    'saveStudent',
    'setStudentActive',
    'seedDemo',
    'addSyntheticAsset',
    'saveBackup',
    'previewRestore',
    'commitRestore',
    'exportDiagnostics',
    'previewRecovery',
    'getDeepSeekStatus',
    'saveDeepSeekKey',
    'deleteDeepSeekKey',
    'checkDeepSeek',
    'cancelDeepSeekCheck',
    'getDeepSeekLedger',
  ];
  assert.equal(isolation.require, 'undefined');
  assert.equal(isolation.process, 'undefined');
  assert.deepEqual(isolation.api.sort(), expectedApis.sort());
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
  await page.getByRole('button', { name: '模型设置' }).click();
  await page.screenshot({ path: join(output, 'deepseek-settings.png'), fullPage: true });
  assert.match(await page.locator('.settings-section').first().innerText(), /未配置密钥/);
  const keyInput = page.getByPlaceholder('输入或粘贴 DeepSeek API Key (如 sk-...)');
  await keyInput.fill('sk-synthetic-desktop-smoke-test-key-1234');
  await page.getByRole('button', { name: '保存并加密存储', exact: true }).click();
  await waitForSaved(page, 'DeepSeek API Key 已安全加密存储');
  assert.match(await page.locator('.settings-section').first().innerText(), /sk-\.\.\.1234/);

  // 验证换 Key 时在途任务丢弃与迟到响应拦截端到端回归：
  // 1. 模拟在途检查请求挂起
  await page.evaluate(() => {
    // 注入一个人工延迟的 checkDeepSeek 拦截器模拟慢速响应
    const originalCheck = window.classManager.checkDeepSeek;
    window.__originalCheck = originalCheck;
    window.__checkHangPromise = new Promise((resolve) => {
      window.__resolveHang = resolve;
    });
    window.classManager.checkDeepSeek = async (input) => {
      await window.__checkHangPromise;
      return {
        ok: true,
        value: {
          type: input.type,
          success: true,
          model: 'deepseek-flash',
          durationMs: 9999,
          usage: null,
          message: '迟到的旧账号响应-不应显示',
          timestamp: new Date().toISOString(),
          promptVersion: 'ping-v1',
          credentialUpdatedAt: '2000-01-01T00:00:00.000Z',
        },
      };
    };
  });
  // 2. 点击文本模型检查，UI 进入正在检查状态
  await page.getByRole('button', { name: '检查文本模型连通性', exact: true }).click();
  await page.locator('text=正在检查文本模型').waitFor();

  // 3. 在途期间，用户换 Key 为账户 5678
  await keyInput.fill('sk-synthetic-desktop-smoke-test-key-5678');
  await page.getByRole('button', { name: '保存并加密存储', exact: true }).click();
  await waitForSaved(page, 'DeepSeek API Key 已安全加密存储');
  assert.match(await page.locator('.settings-section').first().innerText(), /sk-\.\.\.5678/);

  // 4. 恢复并返回迟到的旧任务响应，断言 UI 绝不展示该迟到结果与通知
  await page.evaluate(() => {
    window.__resolveHang?.();
    window.classManager.checkDeepSeek = window.__originalCheck;
  });
  await page.waitForTimeout(300);
  assert.doesNotMatch(await page.locator('body').innerText(), /迟到的旧账号响应-不应显示/);

  await page.getByRole('button', { name: '清除已存凭据', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '确认清除', exact: true }).click();
  await waitForSaved(page, '已清除保存的 API Key');
  assert.match(await page.locator('.settings-section').first().innerText(), /未配置密钥/);
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
      'deepseek-settings',
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
