import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';

const runtime = isolatedElectronRuntime('audit-ux-regression-');
const packaged = process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE;
const output = resolve('output/playwright/audit-ux-regression', packaged ? 'packaged' : 'source');
mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(runtime.local, 'data'),
  TEMP: join(runtime.local, 'temp'),
  TMP: join(runtime.local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  syntheticData: true,
  runtimeLocal: runtime.local,
  packaged: Boolean(packaged),
  checks: [],
  errors: [],
};
let app, page;
try {
  app = await electron.launch({
    executablePath: packaged ?? runtime.executablePath,
    args: packaged ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
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
  snapshot = await call('createClass', { epoch: snapshot.epoch, name: '审计回归合成班' });
  const classId = snapshot.classes[0].id;
  for (const [number, name] of [
    ['R01', '回归合成学生甲'],
    ['R02', '回归合成学生乙'],
  ])
    snapshot = await call('saveStudent', {
      epoch: snapshot.epoch,
      classId,
      studentNumber: number,
      displayName: name,
    });
  const student = snapshot.students.find((s) => s.studentNumber === 'R01');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cm:bridgeChanged')));
  await page.getByLabel('工作台当前管理班级', { exact: true }).selectOption(classId);
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('cm:listTeachingRecords');
    globalThis.uxOriginalRecords = original;
    let once = true;
    ipcMain.removeHandler('cm:listTeachingRecords');
    ipcMain.handle('cm:listTeachingRecords', async (...args) => {
      const r = await original(...args);
      if (once) {
        once = false;
        await new Promise((resolve) => {
          globalThis.uxReleaseRecords = resolve;
        });
      }
      return r;
    });
  });
  await nav.getByRole('button', { name: '教师备课', exact: true }).click();
  const wb = page.getByRole('region', { name: '班级教学工作台' });
  await wb.getByText('正在读取本机资料…', { exact: true }).waitFor();
  await page.evaluate(async () => window.classManager.snapshot());
  const rename = async (name) => {
    await wb.getByLabel('编辑班级名称', { exact: true }).click();
    const d = page.getByRole('dialog', { name: '编辑班级名称', exact: true });
    await d.getByLabel('班级名称', { exact: true }).fill(name);
    await d.getByRole('button', { name: '保存', exact: true }).click();
    await d.waitFor({ state: 'hidden' });
    await wb.getByText('操作处理中…', { exact: true }).waitFor({ state: 'hidden' });
  };
  await rename('并发保存后合成班');
  await app.evaluate(() => globalThis.uxReleaseRecords());
  await wb.getByText('正在读取本机资料…', { exact: true }).waitFor({ state: 'hidden' });
  assert(
    (
      await wb
        .getByLabel('教学工作台当前班级', { exact: true })
        .locator('option:checked')
        .textContent()
    ).includes('并发保存后合成班'),
  );
  await rename('二次保存后合成班');
  assert.equal((await call('snapshot')).classes[0].name, '二次保存后合成班');
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cm:listTeachingRecords');
    ipcMain.handle('cm:listTeachingRecords', globalThis.uxOriginalRecords);
  });
  report.checks.push('并发旧快照不回滚改名，二次改名无版本冲突');
  const go = async (name) => {
    await wb
      .getByRole('navigation', { name: '班级教学功能', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
    await wb.getByRole('heading', { name, level: 2, exact: true }).waitFor();
    await wb.getByText('正在读取本机资料…', { exact: true }).waitFor({ state: 'hidden' });
  };
  const confirmation = () =>
    page.getByRole('alertdialog', { name: '放弃未保存内容？', exact: true });
  await go('学生管理');
  await wb.getByRole('button', { name: '新增学生', exact: true }).click();
  let d = page.getByRole('dialog', { name: '新增学生', exact: true });
  await d.getByLabel('姓名', { exact: true }).fill('尚未保存的合成姓名');
  await d.getByLabel('学生编号', { exact: true }).fill('DRAFT');
  await page.keyboard.press('Escape');
  await confirmation().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await d.getByLabel('姓名', { exact: true }).inputValue(), '尚未保存的合成姓名');
  await d.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation().getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  assert.equal((await call('snapshot')).students.length, 2);
  report.checks.push('新增学生 Esc 和取消均保护草稿，明确放弃后才关闭');
  await go('谈话记录');
  await wb.getByRole('button', { name: '新增谈话', exact: true }).click();
  d = page.getByRole('dialog', { name: '新增谈话', exact: true });
  const longContent = '合成长文本'.repeat(1200);
  await d.getByLabel('类型', { exact: true }).fill('长记录回归');
  await d.getByLabel('谈话内容', { exact: true }).fill(longContent);
  await d.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.screenshot({ path: join(output, 'discard-confirm.png') });
  await confirmation().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await d.getByLabel('谈话内容', { exact: true }).inputValue(), longContent);
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('cm:listTeachingRecords');
    globalThis.uxOriginalRecords = original;
    let once = true;
    ipcMain.removeHandler('cm:listTeachingRecords');
    ipcMain.handle('cm:listTeachingRecords', (...args) => {
      if (once) {
        once = false;
        return {
          ok: false,
          error: {
            code: 'STORAGE_ERROR',
            message: '合成刷新故障',
            operationId: '11111111-1111-4111-8111-111111111111',
          },
        };
      }
      return original(...args);
    });
  });
  await d.getByRole('button', { name: '保存', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  await wb.getByText('已保存到本地，但列表读取失败。', { exact: false }).first().waitFor();
  await page.screenshot({ path: join(output, 'committed-refresh-failure.png') });
  await wb.getByRole('button', { name: '重新读取列表', exact: true }).click();
  await wb.getByRole('button', { name: '编辑 长记录回归', exact: true }).waitFor();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cm:listTeachingRecords');
    ipcMain.handle('cm:listTeachingRecords', globalThis.uxOriginalRecords);
  });
  let records = await call('listTeachingRecords', { epoch: snapshot.epoch, classId, kind: 'talk' });
  assert.equal(records.length, 1);
  assert.equal(records[0].content.content, longContent);
  report.checks.push('关闭按钮保留长草稿；写入成功、刷新失败只重读列表，不重复记录');
  const saveTo = async (name) => {
    const path = join(output, name);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, path);
    return path;
  };
  const talkPath = await saveTo('synthetic-long-talk.docx');
  await wb.getByRole('button', { name: '导出 Word', exact: true }).click();
  await wb.getByText('操作处理中…', { exact: true }).waitFor({ state: 'hidden' });
  assert(
    (
      await (
        await JSZip.loadAsync(readFileSync(talkPath))
      )
        .file('word/document.xml')
        .async('string')
    ).includes(longContent),
  );
  await go('学生管理');
  await wb.getByRole('button', { name: '查看 回归合成学生甲', exact: true }).click();
  d = page.getByRole('dialog', { name: '回归合成学生甲 · 学生档案', exact: true });
  await d.getByLabel('联系电话', { exact: true }).fill('11111111111');
  await app.evaluate(({ ipcMain }) => {
    globalThis.uxOriginalExport = ipcMain._invokeHandlers.get('cm:exportTeachingReport');
    globalThis.uxExportCount = 0;
    ipcMain.removeHandler('cm:exportTeachingReport');
    ipcMain.handle('cm:exportTeachingReport', (...args) => {
      globalThis.uxExportCount++;
      return globalThis.uxOriginalExport(...args);
    });
  });
  await d.getByRole('button', { name: '导出学生报告', exact: true }).click();
  await d.getByRole('alert').filter({ hasText: '请先保存资料' }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.uxExportCount), 0);
  await d.getByRole('button', { name: '保存资料', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  await wb.getByRole('button', { name: '查看 回归合成学生甲', exact: true }).click();
  d = page.getByRole('dialog', { name: '回归合成学生甲 · 学生档案', exact: true });
  const profilePath = await saveTo('synthetic-long-profile.docx');
  await d.getByRole('button', { name: '导出学生报告', exact: true }).click();
  await wb.getByText('操作处理中…', { exact: true }).waitFor({ state: 'hidden' });
  const xml = await (
    await JSZip.loadAsync(readFileSync(profilePath))
  )
    .file('word/document.xml')
    .async('string');
  assert(xml.includes('11111111111') && xml.includes(longContent));
  await d.getByRole('button', { name: '关闭', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  report.checks.push('未保存资料阻止导出；保存后报告包含新电话及完整 6000 字谈话');
  snapshot = await call('snapshot');
  await call('setStudentActive', {
    epoch: snapshot.epoch,
    id: student.id,
    expectedRevision: snapshot.students.find((s) => s.id === student.id).revision,
    active: false,
  });
  await wb.getByLabel('刷新教学资料', { exact: true }).click();
  await wb.getByText('操作处理中…', { exact: true }).waitFor({ state: 'hidden' });
  await go('谈话记录');
  await wb.getByRole('button', { name: '编辑 长记录回归', exact: true }).click();
  d = page.getByRole('dialog', { name: '编辑谈话', exact: true });
  assert.equal(await d.getByLabel('学生', { exact: true }).inputValue(), student.id);
  assert(
    (await d.getByLabel('学生', { exact: true }).locator('option:checked').textContent()).includes(
      '保留历史身份',
    ),
  );
  await d.getByLabel('谈话内容', { exact: true }).fill('停用后的合成更正');
  await d.getByRole('button', { name: '保存', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  records = await call('listTeachingRecords', { epoch: snapshot.epoch, classId, kind: 'talk' });
  assert.equal(records[0].content.studentId, student.id);
  assert.equal(records[0].revision, 2);
  await wb.getByRole('button', { name: '新增谈话', exact: true }).click();
  d = page.getByRole('dialog', { name: '新增谈话', exact: true });
  assert.equal(
    await d.getByLabel('学生', { exact: true }).locator(`option[value="${student.id}"]`).count(),
    0,
  );
  await d.getByRole('button', { name: '取消', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  report.checks.push('停用学生历史谈话可更正并保留身份，新记录不能选停用学生');
  snapshot = await call('snapshot');
  await call('setStudentActive', {
    epoch: snapshot.epoch,
    id: student.id,
    expectedRevision: snapshot.students.find((s) => s.id === student.id).revision,
    active: true,
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cm:bridgeChanged')));
  await nav.getByRole('button', { name: '班主任管理', exact: true }).click();
  await page.getByLabel('工作台当前管理班级', { exact: true }).selectOption(classId);
  await page.getByRole('button', { name: '上课点名', exact: true }).first().click();
  await page.getByText('请选择状态，未点名的学生不会自动计为缺席。', { exact: true }).waitFor();
  await page.getByLabel('点名课时名称', { exact: true }).fill('未保存的数学课');
  await page.getByRole('tab', { name: '全班名单', exact: true }).click();
  await page.getByLabel('回归合成学生甲点名状态', { exact: true }).selectOption('late');
  await page.getByLabel('回归合成学生甲点名备注', { exact: true }).fill('未保存的到课备注');
  await page.getByRole('button', { name: '重新开始点名', exact: true }).click();
  let reset = page.getByRole('dialog', { name: '重新开始点名？', exact: true });
  await reset.getByRole('button', { name: '继续点名', exact: true }).click();
  assert.equal(
    await page.getByLabel('点名课时名称', { exact: true }).inputValue(),
    '未保存的数学课',
  );
  assert.equal(
    await page.getByLabel('回归合成学生甲点名状态', { exact: true }).inputValue(),
    'late',
  );
  assert.equal(
    await page.getByLabel('回归合成学生甲点名备注', { exact: true }).inputValue(),
    '未保存的到课备注',
  );
  await page.getByRole('button', { name: '重新开始点名', exact: true }).click();
  await reset.getByRole('button', { name: '放弃修改并重新开始', exact: true }).click();
  await reset.waitFor({ state: 'hidden' });
  await page.getByText('请选择状态，未点名的学生不会自动计为缺席。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('点名课时名称', { exact: true }).inputValue(), '课堂点名');
  assert.equal(
    await page.getByLabel('回归合成学生甲点名状态', { exact: true }).inputValue(),
    'unmarked',
  );
  assert.equal(await page.getByLabel('回归合成学生甲点名备注', { exact: true }).inputValue(), '');
  await page.getByLabel('回归合成学生甲点名状态', { exact: true }).selectOption('late');
  await page.getByLabel('回归合成学生乙点名状态', { exact: true }).selectOption('present');
  await page.getByRole('button', { name: '保存点名记录', exact: true }).click();
  await page.getByRole('button', { name: '确认保存点名', exact: true }).click();
  await page.getByText('点名记录已保存，后续更正会保留原版本。', { exact: true }).waitFor();
  assert.equal((await call('listAttendance', { epoch: snapshot.epoch, classId })).length, 1);
  report.checks.push('重新点名先确认，取消保留标题状态备注，明确重置后仍可保存点名');
} catch (e) {
  report.errors.push(e.stack);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  if (page)
    await page
      .context()
      .tracing.stop({ path: join(output, 'trace.zip') })
      .catch(() => {});
  if (app) await app.close();
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
