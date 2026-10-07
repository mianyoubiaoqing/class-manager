import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const output = resolve('output/playwright/figma-redesign');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-'));
const folder = join(root, '合成资料');
mkdirSync(folder);
mkdirSync(join(folder, '子文件夹'));
writeFileSync(join(folder, '课程.txt'), '这是合成教学资料。力有大小、方向和作用点。');
writeFileSync(join(folder, '子文件夹', '补充.txt'), '这是合成补充资料。');
writeFileSync(join(folder, '忽略.xlsx'), 'unsupported');
const { local, executablePath } = isolatedElectronRuntime('figma-redesign-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'user-data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath,
  args: ['.'],
  env,
  timeout: 45000,
});
const errors = [];
const gates = [];
try {
  await app.evaluate(({ dialog, shell }, folder) => {
    globalThis.__redesignOpened = [];
    globalThis.fetch = async () => {
      throw Error('No external model requests in UI verification');
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    shell.openExternal = async (url) => {
      globalThis.__redesignOpened.push(url);
    };
  }, folder);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  const main = page.getByRole('navigation', { name: '主导航', exact: true });
  assert.equal(await main.getByRole('button').count(), 4);
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  await page.screenshot({ path: join(root, 'chat.png'), fullPage: true });
  await page.getByRole('button', { name: '查看全部与管理', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索会话', exact: true }).waitFor();
  await page.screenshot({
    path: join(root, 'sessions.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '返回智能对话', exact: true }).click();
  gates.push('Exactly four main entries; conversation history and search remain available.');
  await main.getByRole('button', { name: '教师备课', exact: true }).click();
  assert.equal(await page.locator('.group-platform .resource-card').count(), 8);
  await page.getByText('江西省智慧教育平台', { exact: true }).waitFor();
  await page.getByText('豆包', { exact: true }).waitFor();
  await page
    .locator('.resource-card')
    .filter({ hasText: '豆包' })
    .getByRole('button', { name: '打开官网' })
    .click();
  assert.deepEqual(await app.evaluate(() => globalThis.__redesignOpened), [
    'https://www.doubao.com/chat/',
  ]);
  await page.screenshot({ path: join(root, 'resources.png'), fullPage: true });
  await page.getByRole('button', { name: '添加平台', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('名称', { exact: true }).fill('合成资源');
  await modal.getByLabel('网站地址', { exact: true }).fill('https://example.com/');
  await modal.getByRole('button', { name: '保存入口', exact: true }).click();
  await page.getByText('合成资源', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑 合成资源', exact: true }).click();
  await page.getByRole('button', { name: '移除入口', exact: true }).click();
  gates.push('Eight official resource entries open validated URLs; custom resource CRUD works.');
  await page
    .getByRole('navigation', { name: '教师备课功能', exact: true })
    .getByRole('button', { name: '本地备课', exact: true })
    .click();
  await page.getByRole('button', { name: '新建备课任务', exact: true }).waitFor();
  await page.screenshot({
    path: join(root, 'local-materials.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '选择本地文件夹', exact: true }).click();
  await page.getByRole('checkbox', { name: '读取 课程.txt', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '读取 子文件夹' }).count(), 0);
  assert.equal(
    await page.getByRole('checkbox', { name: '读取 忽略.xlsx', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('checkbox', { name: '读取 课程.txt', exact: true }).check();
  await page.getByRole('button', { name: '读取选中资料（1）', exact: true }).click();
  await page.getByText('课程.txt：已保存，可在下方选择使用', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('已保存资料', { exact: true }).locator('option').count(), 2);
  await page.getByRole('checkbox', { name: '包含子文件夹', exact: true }).check();
  await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  await page.getByRole('checkbox', { name: /读取 子文件夹.*补充.txt/ }).waitFor();
  await page.screenshot({ path: join(root, 'folder.png'), fullPage: true });
  await page.getByRole('button', { name: '移除入口', exact: true }).click();
  await page.getByRole('button', { name: '选择本地文件夹', exact: true }).waitFor();
  const removed = await page.evaluate(async () => {
    const snapshot = await window.classManager.snapshot();
    if (!snapshot.ok) return snapshot;
    return window.classManager.scanMaterialFolder({ epoch: snapshot.value.epoch });
  });
  assert.deepEqual(removed, { ok: true, value: null });
  gates.push(
    'Native folder selection, default scope, unsupported status, explicit read and recursive rescan persist actual local material.',
  );
  for (const label of ['课堂与倒计时', '答卷建议与复核']) {
    await page
      .getByRole('navigation', { name: '教师备课功能', exact: true })
      .getByRole('button', { name: label, exact: true })
      .click();
    await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
    await page.screenshot({
      path: join(root, label + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await main.getByRole('button', { name: '班主任管理', exact: true }).click();
  await page.getByText('江西省高中生综合素质评价', { exact: true }).waitFor();
  await page.getByText('江西省教育考试院', { exact: true }).waitFor();
  await page.screenshot({ path: join(root, 'homeroom.png'), fullPage: true });
  for (const label of [
    '班级名册',
    '上课点名',
    '学生资料',
    '成绩管理',
    '座位编排',
    '值日轮换',
    '成长档案',
  ]) {
    await page
      .getByRole('navigation', { name: '班主任管理功能', exact: true })
      .getByRole('button', { name: label, exact: true })
      .click();
    await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
    await page.screenshot({
      path: join(root, label + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await main.getByRole('button', { name: '系统设置', exact: true }).click();
  for (const label of ['模型连接', '数据与备份', '外设接口']) {
    await page
      .getByRole('navigation', { name: '系统设置功能', exact: true })
      .getByRole('button', { name: label, exact: true })
      .click();
    await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
    await page.screenshot({
      path: join(root, label + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await main.getByRole('button', { name: '教师备课', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 800));
  await page.screenshot({ path: join(root, 'resources-1024.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  gates.push(
    'All homeroom and settings subpages render; 1024px window has no horizontal overflow.',
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(root, 'report.json'),
    JSON.stringify({ status: 'passed', gates, errors, root }, null, 2),
  );
  console.log(JSON.stringify({ status: 'passed', gates, root }, null, 2));
} finally {
  await app.close();
}
