import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

const parent = resolve('output/playwright/computer-use-regressions');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const { local, executablePath } = isolatedElectronRuntime('cu-regressions-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath, args: ['.'], env });
const report = { status: 'running', root, checks: [], errors: [] };
try {
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw Error('Offline regression');
    };
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const s = await window.classManager.snapshot();
    const seeded = await window.classManager.seedDemo({ epoch: s.value.epoch });
    if (!seeded.ok) throw Error(seeded.error.message);
  });
  await page.reload();
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await openWorkspacePage(page, '班主任管理', '学生资料');
  await page.getByLabel('兴趣与特长', { exact: true }).fill('合成课堂观察');
  await page.getByRole('button', { name: '保存学生资料', exact: true }).click();
  await page.waitForTimeout(250);
  const confirm = page.getByRole('button', { name: '确认保存学生资料', exact: true });
  const visible = await confirm.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 110 && r.bottom <= innerHeight;
  });
  report.checks.push({ name: '保存后无需额外滚动即可核对并确认', passed: visible });
  await page.screenshot({ path: join(root, 'profile-confirm.png') });
  await page.getByRole('button', { name: '继续修改', exact: true }).click();
  await page.getByLabel('兴趣与特长', { exact: true }).fill('');
  await page.getByRole('button', { name: '确认保存学生资料', exact: true }).count();
  // Complete the deliberately edited record before navigation; never discard it implicitly.
  await page.getByRole('button', { name: '保存学生资料', exact: true }).click();
  await confirm.click();
  await page.getByText('学生资料已保存，原修订保留。', { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '教师备课', exact: true })
    .click();
  await page.waitForTimeout(250);
  const top = await page.evaluate(() => window.scrollY);
  report.checks.push({ name: '切换工作页回到页面开头', passed: top === 0, scrollY: top });
  await page.screenshot({ path: join(root, 'navigation.png') });
  await openWorkspacePage(page, '系统设置', '模型连接');
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  const connectionLayout = await page
    .getByRole('tabpanel', { name: '连接检查', exact: true })
    .evaluate((el) => {
      const panel = el.getBoundingClientRect();
      const button = el.querySelector('button').getBoundingClientRect();
      return {
        panelHeight: panel.height,
        buttonHeight: button.height,
        fullWidth: panel.width > el.parentElement.getBoundingClientRect().width * 0.9,
      };
    });
  report.checks.push({
    name: '连接检查表单紧凑并占满工作区',
    passed:
      connectionLayout.panelHeight < 350 &&
      connectionLayout.buttonHeight < 60 &&
      connectionLayout.fullWidth,
    ...connectionLayout,
  });
  await page.screenshot({ path: join(root, 'model-check.png') });
  await openWorkspacePage(page, '系统设置', '外设接口');
  const refreshHeight = await page
    .getByRole('button', { name: '刷新外设状态', exact: true })
    .evaluate((el) => el.getBoundingClientRect().height);
  report.checks.push({
    name: '外设工具栏按钮不被网格拉伸',
    passed: refreshHeight < 60,
    height: refreshHeight,
  });
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  await page.getByText('已重新读取本地数据。', { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const feedbackVisible = await page.locator('.workspace-feedback').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 72 && r.bottom <= innerHeight;
  });
  report.checks.push({ name: '页面下方也能看见保存和操作结果提示', passed: feedbackVisible });
  await page.screenshot({ path: join(root, 'device-feedback.png') });
  report.status =
    report.checks.every((c) => c.passed) && !report.errors.length ? 'passed' : 'failed';
} catch (e) {
  report.status = 'failed';
  report.errors.push(e.message);
} finally {
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await app.close();
}
if (report.status !== 'passed') process.exitCode = 1;
