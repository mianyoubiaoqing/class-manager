import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const output = resolve('output/playwright/audit-fixes');
mkdirSync(output, { recursive: true });
const runtime = isolatedElectronRuntime('audit-fixes-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(runtime.local, 'data'),
  TEMP: join(runtime.local, 'temp'),
  TMP: join(runtime.local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const checks = [],
  errors = [];
let app;
try {
  app = await electron.launch({
    executablePath: process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE ?? runtime.executablePath,
    args: process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  const call = (method, input) =>
    page.evaluate(
      async ({ method, input }) => {
        const r = await window.classManager[method](input);
        if (!r.ok) throw Error(r.error.message);
        return r.value;
      },
      { method, input },
    );
  let snapshot = await call('snapshot');
  for (const name of ['回归合成甲班', '回归合成乙班'])
    snapshot = await call('createClass', { epoch: snapshot.epoch, name });
  for (const c of snapshot.classes)
    for (let i = 0; i < 2; i++)
      snapshot = await call('saveStudent', {
        epoch: snapshot.epoch,
        classId: c.id,
        studentNumber: `${c.name.includes('甲') ? 'A' : 'B'}${i}`,
        displayName: `${c.name}学生${i}`,
      });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cm:bridgeChanged')));
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  const teacher = () => nav.getByRole('button', { name: '教师备课', exact: true }).click();
  await teacher();
  const wb = page.getByRole('region', { name: '班级教学工作台' });
  const classSelect = wb.getByLabel('教学工作台当前班级', { exact: true });
  await classSelect
    .locator('option')
    .filter({ hasText: '回归合成乙班' })
    .waitFor({ state: 'attached' });
  const go = async (name) => {
    await wb
      .getByRole('navigation', { name: '班级教学功能', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
    await wb.getByRole('heading', { name, exact: true, level: 2 }).waitFor();
  };
  const leave = () => page.getByRole('dialog', { name: '离开当前编辑？', exact: true });
  assert.equal(await wb.getByRole('button', { name: '工作台首页', exact: true }).count(), 0);
  assert.equal(await wb.getByRole('button', { name: '仪表盘', exact: true }).count(), 1);
  checks.push('仪表盘是唯一首页导航入口');

  await go('排座位');
  await wb.getByRole('button', { name: '开始编排', exact: true }).click();
  await wb.getByRole('button', { name: '随机编排', exact: true }).waitFor();
  const before = await classSelect.inputValue(),
    target = snapshot.classes.find((c) => c.id !== before).id;
  await classSelect.selectOption(target);
  await leave().waitFor();
  await leave().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await classSelect.inputValue(), before);
  assert.equal(await wb.getByRole('button', { name: '放弃调整', exact: true }).count(), 1);
  await classSelect.selectOption(target);
  await leave().getByRole('button', { name: '放弃修改并离开', exact: true }).click();
  await wb.getByRole('button', { name: '开始编排', exact: true }).waitFor();
  assert.equal(await classSelect.inputValue(), target);
  checks.push('座位草稿切班：取消保留草稿，确认切至目标班级');

  await go('学生管理');
  await wb.getByRole('button', { name: '新增学生', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新增学生', exact: true });
  await dialog.getByLabel('姓名', { exact: true }).fill('提交时姓名');
  await dialog.getByLabel('学生编号', { exact: true }).fill('LATE-SAVE');
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('cm:saveStudent');
    globalThis.savedHandler = original;
    ipcMain.removeHandler('cm:saveStudent');
    ipcMain.handle('cm:saveStudent', async (...args) => {
      await new Promise((resolve) => {
        globalThis.releaseSave = resolve;
      });
      return original(...args);
    });
  });
  await dialog.getByRole('button', { name: '保存学生', exact: true }).click();
  await dialog.getByRole('button', { name: '保存中…', exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('姓名', { exact: true }).isEditable(), false);
  assert.equal(await dialog.getByLabel('学生编号', { exact: true }).isEditable(), false);
  await app.evaluate(() => globalThis.releaseSave());
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    (await call('snapshot')).students.find((s) => s.studentNumber === 'LATE-SAVE').displayName,
    '提交时姓名',
  );
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cm:saveStudent');
    ipcMain.handle('cm:saveStudent', globalThis.savedHandler);
  });
  checks.push('保存期间禁用整个表单，输入不会静默丢失');

  await go('成绩分析');
  await wb.getByRole('button', { name: '文件导入', exact: true }).click();
  await wb.getByRole('button', { name: '新建考试导入', exact: true }).click();
  await wb.getByLabel('考试名称', { exact: true }).fill('未保存导入草稿');
  await wb.getByRole('button', { name: '考试管理', exact: true }).click();
  await leave().waitFor();
  await leave().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await wb.getByLabel('考试名称', { exact: true }).inputValue(), '未保存导入草稿');
  await wb
    .getByRole('navigation', { name: '班级教学功能', exact: true })
    .getByRole('button', { name: '学生管理', exact: true })
    .click();
  await leave().waitFor();
  await leave().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await wb.getByLabel('考试名称', { exact: true }).inputValue(), '未保存导入草稿');
  await wb.getByRole('button', { name: '考试管理', exact: true }).click();
  await leave().getByRole('button', { name: '放弃修改并离开', exact: true }).click();
  checks.push('成绩导入内部标签与外部导航均保护草稿');

  await wb.getByRole('button', { name: '新增考试与录入', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新增考试与录入', exact: true });
  await dialog.getByLabel('考试名称', { exact: true }).fill('特殊成绩标记考试');
  const pupils = (await call('snapshot')).students.filter((s) => s.active && s.classId === target);
  for (const s of pupils)
    for (const subject of ['语文', '数学', '英语'])
      await dialog.getByLabel(`${s.displayName} ${subject}`, { exact: true }).fill('88');
  await dialog.getByLabel(`${pupils[0].displayName} 语文`, { exact: true }).fill('');
  await dialog.getByLabel(`${pupils[0].displayName} 数学`, { exact: true }).fill('未选考');
  await dialog.getByRole('button', { name: '确认保存全部成绩', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await wb.getByRole('button', { name: '考试管理', exact: true }).click();
  await wb.getByRole('button', { name: '成绩录入', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: '成绩录入与更正', exact: true });
  assert.equal(
    await dialog.getByLabel(`${pupils[0].displayName} 语文`, { exact: true }).inputValue(),
    '未录入',
  );
  assert.equal(
    await dialog.getByLabel(`${pupils[0].displayName} 数学`, { exact: true }).inputValue(),
    '未选考',
  );
  await dialog.getByLabel(`${pupils[1].displayName} 英语`, { exact: true }).fill('89');
  await dialog.getByRole('button', { name: '确认保存全部成绩', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const exams = await call('listExams', { epoch: snapshot.epoch, classId: target });
  const view = await call('readScoreVersion', {
    epoch: snapshot.epoch,
    versionId: exams.find((e) => e.definition.name === '特殊成绩标记考试').versionId,
  });
  assert.equal(view.record.revision, 2);
  assert(view.payload.analysis.entries.some((e) => e.score.status === 'missing'));
  assert(view.payload.analysis.entries.some((e) => e.score.status === 'not_selected'));
  checks.push('已有考试保留未录入与未选考标记后可直接更正');

  await wb.getByRole('button', { name: '新增考试与录入', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新增考试与录入', exact: true });
  await dialog.getByLabel('考试名称', { exact: true }).fill('保存后读取失败考试');
  for (const s of pupils)
    for (const subject of ['语文', '数学', '英语'])
      await dialog.getByLabel(`${s.displayName} ${subject}`, { exact: true }).fill('88');
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('cm:listExams');
    globalThis.examsHandler = original;
    let once = true;
    ipcMain.removeHandler('cm:listExams');
    ipcMain.handle('cm:listExams', async (...args) => {
      if (once) {
        once = false;
        return {
          ok: false,
          error: {
            code: 'STORAGE_ERROR',
            message: '合成列表读取失败',
            operationId: '11111111-1111-4111-8111-111111111111',
          },
        };
      }
      return original(...args);
    });
  });
  await dialog.getByRole('button', { name: '确认保存全部成绩', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await wb.getByRole('button', { name: '重新读取考试列表', exact: true }).waitFor();
  assert.equal(
    (await call('listExams', { epoch: snapshot.epoch, classId: target })).filter(
      (e) => e.definition.name === '保存后读取失败考试',
    ).length,
    1,
  );
  await wb.getByRole('button', { name: '重新读取考试列表', exact: true }).click();
  await wb
    .getByRole('button', { name: '重新读取考试列表', exact: true })
    .waitFor({ state: 'hidden' });
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cm:listExams');
    ipcMain.handle('cm:listExams', globalThis.examsHandler);
  });
  checks.push('成绩写入成功后刷新失败：关闭提交表单，仅重新读取');

  await go('排座位');
  for (let i = 0; i < 2; i++) {
    await wb.getByRole('button', { name: i ? '调整座位' : '开始编排', exact: true }).click();
    await wb.getByRole('button', { name: '随机编排', exact: true }).click();
    await wb.getByRole('button', { name: '确认保存', exact: true }).click();
    await wb.getByRole('button', { name: '调整座位', exact: true }).waitFor();
  }
  const history = await call('seatingHistory', { epoch: snapshot.epoch, classId: target });
  await wb.getByLabel('座位表历史', { exact: true }).selectOption(history[1].id);
  await wb.getByText('正在预览历史版本', { exact: false }).waitFor();
  assert.equal(await wb.getByLabel('座位表历史', { exact: true }).inputValue(), history[1].id);
  checks.push('座位历史支持查看旧版且不覆盖最新版本');

  await nav.getByRole('button', { name: '班主任管理', exact: true }).click();
  const top = page.getByLabel('工作台当前管理班级', { exact: true });
  await top.selectOption(snapshot.classes[0].id);
  await page.getByRole('button', { name: '上课点名', exact: true }).first().click();
  const inner = page.getByLabel('点名班级', { exact: true });
  await inner.waitFor();
  await top.selectOption(snapshot.classes[1].id);
  await page.waitForFunction(
    (id) => document.querySelector('[aria-label="点名班级"]')?.value === id,
    snapshot.classes[1].id,
  );
  const roll = page.locator('.roll-call-card');
  await roll.getByText('回归合成乙班学生0', { exact: false }).waitFor();
  checks.push('顶部班级切换同步点名班级和名单');

  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('cm:listTeachingRecords');
    globalThis.recordsHandler = original;
    let once = true;
    ipcMain.removeHandler('cm:listTeachingRecords');
    ipcMain.handle('cm:listTeachingRecords', async (...args) => {
      const result = await original(...args);
      if (once) {
        once = false;
        await new Promise((resolve) => {
          globalThis.releaseRecords = resolve;
        });
      }
      return result;
    });
  });
  await teacher();
  await wb.getByText('正在读取本机资料…', { exact: true }).waitFor();
  await nav.getByRole('button', { name: '班主任管理', exact: true }).click();
  snapshot = await call('saveStudent', {
    epoch: snapshot.epoch,
    classId: snapshot.classes[1].id,
    studentNumber: 'REFRESH-LATE',
    displayName: '晚到请求后新增学生',
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cm:bridgeChanged')));
  const classB = snapshot.classes[1].id,
    expected = snapshot.students.filter((s) => s.active && s.classId === classB).length;
  await page.waitForFunction(
    ({ classB, expected }) =>
      document
        .querySelector(`[aria-label="工作台当前管理班级"] option[value="${classB}"]`)
        .textContent.includes(`${expected}人在籍`),
    { classB, expected },
  );
  await app.evaluate(() => globalThis.releaseRecords());
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cm:listTeachingRecords');
    ipcMain.handle('cm:listTeachingRecords', globalThis.recordsHandler);
  });
  await page.waitForTimeout(300);
  assert(
    (await top.locator(`option[value="${classB}"]`).textContent()).includes(`${expected}人在籍`),
  );
  checks.push('卸载页面的旧请求不能覆盖最新学生快照');
  await page.screenshot({ path: join(output, 'final.png') });
  assert.equal(errors.length, 0);
} catch (e) {
  errors.push(e.stack);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  const result = { checks, errors, syntheticData: true, runtimeLocal: runtime.local };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
