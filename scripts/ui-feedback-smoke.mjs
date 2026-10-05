import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeAuditApplication } from './live-audit-guards.ts';

const parent = path.join(process.env.USERPROFILE, 'ClassManagerSetupChecks');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'ui-feedback-'));
const outputBase = path.resolve('output/playwright/ui-feedback');
await fs.mkdir(outputBase, { recursive: true });
const output = await fs.mkdtemp(path.join(outputBase, 'run-'));
const executable = process.env.CLASS_MANAGER_UI_EXECUTABLE;
if (!executable)
  await fs.cp(path.dirname(electronPath), path.join(root, 'runtime'), { recursive: true });
await fs.mkdir(path.join(root, 'temp'));
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: path.join(root, 'data'),
  TEMP: path.join(root, 'temp'),
  TMP: path.join(root, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  status: 'running',
  executable: executable ?? 'development',
  root,
  output,
  gates: [],
  errors: [],
  externalRequests: 0,
};
let app, page;
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const areas = [
  ['教师备课', ['资料备课', '课堂与倒计时', '答卷建议与复核']],
  [
    '班主任管理',
    ['班级名册', '上课点名', '学生资料', '成绩管理', '座位编排', '值日轮换', '成长档案'],
  ],
  ['系统设置', ['模型设置', '数据与维护', '外设接口']],
];
async function navigate(area, label) {
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: area, exact: true })
    .click();
  await page.getByRole('heading', { name: area, exact: true, level: 1 }).waitFor();
  if (label) {
    await page
      .getByRole('region', { name: `${area}入口`, exact: true })
      .getByRole('button', { name: label, exact: true })
      .click();
    await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
  }
}
async function mainNav(label) {
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
  await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
}
async function assertFits(label) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
    label + ' horizontal overflow',
  );
  await captureWindow(label);
}
async function captureWindow(label) {
  // Native capture includes zoom correctly; allow the compositor to present the latest frame.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForTimeout(200);
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
  );
  await fs.writeFile(path.join(output, label + '.png'), Buffer.from(png, 'base64'));
}
async function checkDialog() {
  const dialog = page.getByRole('dialog', { name: '添加学生', exact: true });
  await dialog.waitFor();
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, 'Dialog exceeds viewport width');
  assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height, 'Dialog exceeds viewport height');
  const layout = await dialog.locator('form > label').evaluateAll((labels) =>
    labels.map((label) => {
      const control = label.querySelector('input,select');
      const r = control.getBoundingClientRect();
      const parent = label.closest('dialog').getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        dialogLeft: parent.left,
        dialogRight: parent.right,
      };
    }),
  );
  assert.equal(layout.length, 3);
  for (let i = 0; i < layout.length; i++) {
    const field = layout[i];
    assert.ok(
      field.left >= field.dialogLeft + 12 && field.right <= field.dialogRight - 12,
      'Field exceeds padded modal boundary',
    );
    if (i > 0)
      assert.ok(
        field.top >= layout[i - 1].bottom + 12,
        'Student fields overlap or crowd onto the same line',
      );
  }
}
try {
  app = await electron.launch({
    executablePath: executable ?? path.join(root, 'runtime/electron.exe'),
    args: executable ? [] : ['.'],
    env,
    timeout: 45000,
  });
  await app.evaluate(() => {
    globalThis.__uiFeedbackRequests = 0;
    globalThis.fetch = async () => {
      globalThis.__uiFeedbackRequests++;
      throw Error('UI acceptance forbids external models');
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await page.getByLabel('发送消息', { exact: true }).waitFor();
  assert.equal(await page.locator('.conversation-disclosure').count(), 0);
  assert.ok(!(await page.locator('body').innerText()).includes('正式调整前均由您核对确认'));
  const context = await page.locator('.conversation-selectors').evaluate((element) => ({
    display: getComputedStyle(element).display,
    gap: parseFloat(getComputedStyle(element).gap),
  }));
  assert.equal(context.display, 'grid');
  assert.ok(context.gap >= 12);
  assert.equal(
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button').count(),
    5,
  );
  await assertFits('conversation-desktop');
  report.gates.push(
    'Composer disclosure removed, spaced context layout, conversation default and five clear sidebar entries.',
  );
  const result = await page.evaluate(async () => {
    const snapshot = await window.classManager.snapshot();
    return window.classManager.createClass({
      epoch: snapshot.value.epoch,
      name: '合成测试班级名称较长用于核验选择框与窄窗口布局',
    });
  });
  assert.equal(result.ok, true);
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  await page.getByLabel('发送消息', { exact: true }).fill('保留这条未发送的备课需求');
  for (const [area, labels] of areas) {
    await navigate(area);
    const region = page.getByRole('region', { name: `${area}入口`, exact: true });
    assert.equal(await region.getByRole('button').count(), labels.length);
    await assertFits(area);
    for (const label of labels) {
      await navigate(area, label);
      // Drain reads initiated by newly mounted business pages before testing the next navigation.
      await page.waitForTimeout(150);
    }
  }
  await mainNav('业务对话');
  assert.equal(
    await page.getByLabel('发送消息', { exact: true }).inputValue(),
    '保留这条未发送的备课需求',
  );
  report.gates.push(
    'All 13 business functions remain reachable through the three independent workspace pages; conversation draft survives navigation.',
  );

  await navigate('系统设置', '模型设置');
  await page.getByLabel('文本模型 / Endpoint ID', { exact: true }).fill('synthetic-unsaved-model');
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '班主任管理', exact: true })
    .click();
  await page.locator('.navigation-feedback').waitFor();
  assert.equal(await page.locator('h1').innerText(), '模型设置');
  assert.equal(
    await page.getByLabel('文本模型 / Endpoint ID', { exact: true }).inputValue(),
    'synthetic-unsaved-model',
  );
  assert.match(await page.locator('.navigation-feedback').innerText(), /未保存|尚未保存/);
  assert.equal(
    await page
      .getByRole('navigation', { name: '主导航', exact: true })
      .locator('button:disabled')
      .count(),
    0,
  );
  await page.getByRole('button', { name: '返回模型设置', exact: true }).click();
  await page.getByRole('button', { name: '清空未保存输入', exact: true }).click();
  await page.getByText('未保存输入与检查准备已清空。', { exact: true }).waitFor();
  await navigate('班主任管理', '班级名册');
  report.gates.push(
    'Clicking navigation during unsaved model input gives a reason and return action, preserves input, and unlocks after clearing without a model request.',
  );

  await page.getByRole('button', { name: '添加学生', exact: true }).click();
  await checkDialog();
  await page.getByLabel('姓名', { exact: true }).fill('合成学生');
  await page.getByLabel('学生编号', { exact: true }).pressSequentially('STUDENT-2026');
  assert.equal(await page.getByLabel('学生编号', { exact: true }).inputValue(), 'STUDENT-2026');
  await page.screenshot({ path: path.join(output, 'student-dialog-desktop.png') });
  await page.getByRole('button', { name: '保存学生', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const snapshot = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.students[0].studentNumber, 'STUDENT-2026');
  assert.equal(snapshot.value.students[0].displayName, '合成学生');
  report.gates.push(
    'Student form fields fit separate padded rows; keyboard input persists and saves to the real isolated database.',
  );

  for (const [width, height, zoom, suffix] of [
    [1280, 820, 1.5, 'zoom150'],
    [390, 844, 1, 'narrow390'],
    [360, 800, 1, 'narrow360'],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [width, height, zoom]) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds({ width, height });
        win.webContents.setZoomFactor(zoom);
      },
      [width, height, zoom],
    );
    await mainNav('业务对话');
    const titleWidths = await page
      .locator('.prompt-capsule-body')
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width));
    assert.ok(
      titleWidths.every((width) => width >= 100),
      'Prompt card text squeezed vertically',
    );
    const clearButton = await page.locator('.btn-clear-input').boundingBox();
    assert.ok(
      clearButton.width >= 120 && clearButton.height < 70,
      'Clear button squeezed vertically',
    );
    await assertFits('conversation-' + suffix);
    await page
      .locator('.prompt-capsules-container')
      .evaluate((element) => element.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await captureWindow('conversation-prompts-' + suffix);
    await page
      .locator('.conversation-composer')
      .evaluate((element) => element.scrollIntoView({ behavior: 'instant', block: 'end' }));
    await captureWindow('conversation-composer-' + suffix);
    await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
    assert.ok(await page.getByRole('button', { name: '展开侧边栏', exact: true }).isVisible());
    await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
    await navigate('班主任管理', '班级名册');
    await page.getByRole('button', { name: '添加学生', exact: true }).click();
    await checkDialog();
    await captureWindow('student-dialog-' + suffix);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await navigate('教师备课');
    await assertFits('teaching-' + suffix);
    await navigate('系统设置');
    await assertFits('settings-' + suffix);
  }
  report.gates.push(
    '150% zoom and 390/360px windows: dialogs within viewport, workspace cards, no horizontal overflow, and sidebar collapse/reopen navigation.',
  );
  report.externalRequests = await app.evaluate(() => globalThis.__uiFeedbackRequests);
  assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.errors, []);
  await closeAuditApplication(app, () => {});
  app = undefined;
  report.status = 'passed';
  await save();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      .catch(() => {});
  await save();
  throw error;
} finally {
  if (app) await closeAuditApplication(app, () => {});
}
