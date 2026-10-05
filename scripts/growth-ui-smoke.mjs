import { nodeBundleOptions } from './node-bundle-options.ts';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';
import { recordAuditIpcResults } from './ipc-receipt-probe.mjs';

// 教师操作经过实际 UI/IPC/Worker/SQLite；仅模型传输、文件选择和故障注入为替身。
const parent = resolve('output/playwright/growth');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const userData = join(root, 'user-data');
await build(
  nodeBundleOptions({
    entryPoints: ['tests/fixtures/growth-storage.ts'],
    outfile: join(root, 'fixture.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
  }),
);
const { seedGrowthWorkspace } = createRequire(import.meta.url)(join(root, 'fixture.cjs'));
const seed = await seedGrowthWorkspace(join(userData, 'workspace-data'));
const executable = process.env.CLASS_MANAGER_GROWTH_EXECUTABLE;
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: userData };
delete env.ELECTRON_RUN_AS_NODE;
if (executable) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`;
}
const report = {
  status: 'running',
  root,
  packaged: !!executable,
  externalRequests: 0,
  syntheticProviderCalls: 0,
  errors: [],
  gates: [],
};
let app, page;
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const call = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input }).then(value);
const button = (name) => page.getByRole('button', { name, exact: true });
const label = (name) =>
  ['记录类型', '跟进状态'].includes(name)
    ? page.getByRole('combobox', { name: new RegExp(`^${name}`) })
    : page.getByLabel(new RegExp(`^${name}`));
const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor();
const timeline = () => call('growthTimeline', { epoch: seed.epoch, studentId: seed.studentId });
async function waitForNavigationGuard(locked) {
  // 页面先更新学生选择，再通过 effect 更新全局导航；两端都就绪后才能检查或输入下一字段。
  await page.waitForFunction((locked) => {
    const student = document.querySelector('select[aria-label="档案学生"]');
    const navigation = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '班级名册',
    );
    return student?.disabled === locked && navigation?.disabled === locked;
  }, locked);
}
async function launch() {
  app = await electron.launch({
    executablePath: executable ?? electronPath,
    args: executable ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  report.runtime = await app.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node,
    executablePath: process.execPath,
  }));
  await app.evaluate(() => {
    globalThis.__growthAudit = { calls: 0, mode: 'success', wires: [], release: null };
    globalThis.fetch = async (_url, init) => {
      const state = globalThis.__growthAudit;
      state.calls++;
      const wire = JSON.parse(JSON.parse(init.body).messages[1].content);
      state.wires.push(wire);
      if (state.mode === 'offline') throw new TypeError('Synthetic growth offline transport');
      const reply = () =>
        new Response(
          JSON.stringify({
            id: 'synthetic-growth-ui-response',
            model: 'synthetic-growth-model',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content:
                    state.mode === 'invalid'
                      ? '{}'
                      : JSON.stringify({
                          formatVersion: 1,
                          factIds: wire.facts.map((f) => f.id),
                          suggestions: [
                            {
                              text: '建议教师核实后续练习情况，尚未执行。',
                              evidenceIds: [wire.facts[0].id],
                            },
                          ],
                          limitations: ['合成事实有限，不能推断成长原因。'],
                        }),
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      if (state.mode === 'pending')
        return new Promise((resolve) => {
          state.release = () => resolve(reply());
        });
      return reply();
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
}
async function prepare() {
  await button('预览在线总结的实际外发事实').click();
  await page.getByRole('heading', { name: '实际外发事实', exact: true }).waitFor();
}
async function generate(mode) {
  await app.evaluate((_electron, mode) => {
    globalThis.__growthAudit.mode = mode;
  }, mode);
  await prepare();
  await label('已逐项检查上方实际外发事实，允许本次可能付费的生成').check();
  await button('确认生成阶段总结草稿').click();
}
async function confirm(reason) {
  await button('保存教师复核草稿').click();
  await label('正式入档说明').fill(reason);
  await label('已核对正文与建议，不含编造事实、心理诊断或人格定性').check();
  assert.equal(await button('确认总结正式入档').isDisabled(), true);
  await label('已核对阶段、学生和确切来源，同意正式入档').check();
  await button('确认总结正式入档').click();
  await status('已正式入档');
}
try {
  await launch();
  assert.equal((await call('getDeepSeekStatus')).configured, false);
  await button('成长档案').click();
  await label('档案学生').selectOption(seed.studentId);
  // 正文为空时，每个其他字段也必须阻止换学生和离开。
  for (const name of [
    '记录来源',
    '后续行动',
    '后续结果',
    '用于阶段总结的最小事实摘要',
    '记录 / 更正说明',
  ]) {
    await label(name).fill('未保存的合成输入');
    await waitForNavigationGuard(true);
    assert.equal(await label('档案学生').isDisabled(), true, name);
    assert.equal(await button('班级名册').isDisabled(), true, name);
    await button('取消事件编辑').click();
    await waitForNavigationGuard(false);
  }
  await label('发生日期').fill('2026-10-01');
  await label('记录类型').selectOption('conversation');
  await label('跟进状态').selectOption('planned');
  await label('本地事实记录').fill('合成成长甲的完整私有谈话记录，不能外发。');
  await label('记录来源').fill('合成教师本地记录');
  await label('后续行动').fill('本地私有后续行动');
  await label('后续结果').fill('本地私有结果尚待核实');
  await label('用于阶段总结的最小事实摘要').fill('10月1日完成一次订正练习，后续结果待核实。');
  await label('记录 / 更正说明').fill('首次合成谈话记录');
  await button('保存事件记录').click();
  await status('事件已保存');
  const event = (await timeline()).events[0];
  assert.equal(event.revision, 1);
  await button('更正事件 2026-10-01').click();
  await label('跟进状态').selectOption('completed');
  await label('后续结果').fill('本地核对已完成');
  await label('记录 / 更正说明').fill('合成跟进完成更正');
  await button('保存事件记录').click();
  await status('事件已保存');
  await button('查看事件修订 2026-10-01').click();
  const history = page
    .locator('details')
    .filter({ has: page.getByText('事件修订记录', { exact: true }) });
  await history.waitFor();
  assert.match(await history.innerText(), /计划跟进/);
  assert.match(await history.innerText(), /已完成/);
  for (const text of [
    '合成教师本地记录',
    '本地私有后续行动',
    '本地私有结果尚待核实',
    '10月1日完成一次订正练习',
  ])
    assert.match(await history.innerText(), new RegExp(text));
  await history.screenshot({ path: join(root, 'event-history.png') });
  report.gates.push(
    'all event fields protect unsaved input',
    'offline actual event correction and complete immutable history',
  );
  await button('更正事件 2026-10-01').click();
  const otherStudent = (await call('snapshot')).students.find((s) => s.id !== seed.studentId);
  await label('档案学生').selectOption(otherStudent.id);
  await page.getByRole('heading', { name: '记录事件 / 谈话跟进', exact: true }).waitFor();
  assert.equal(await label('本地事实记录').inputValue(), '');
  await label('档案学生').selectOption(seed.studentId);
  report.gates.push('student switch clears unchanged event correction context');
  await label('阶段开始').fill('2026-10-01');
  await label('阶段结束').fill('2026-10-31');
  await label('确认仅使用合成资料，已核对最小摘要并去除可识别信息').check();
  await button('预览在线总结的实际外发事实').click();
  await status('没有可用事实');
  await page.getByRole('checkbox', { name: /2026-10-01 · 修订 2/ }).check();
  await label('关联考试').selectOption(seed.score.versionId);
  await page.getByRole('checkbox', { name: /合成学科 · 7/ }).check();
  await label('人工总结草稿').fill('合成阶段事实：完成一次练习；成绩7分，后续结果待核实。');
  await button('保存人工总结草稿').click();
  await status('人工总结已存为独立草稿');
  assert.equal((await timeline()).entries.length, 0);
  assert.equal(await button('确认总结正式入档').isDisabled(), true);
  await label('教师复核正文').fill('教师核对：合成阶段完成一次练习，成绩7分；后续情况须继续核实。');
  await confirm('合成人工总结核对入档');
  const formal = (await timeline()).entries[0].record;
  const confirmed = await call('readGrowthSummary', { epoch: seed.epoch, id: formal.draftId });
  assert.equal(confirmed.entryId, formal.id);
  const replay = await call('confirmGrowthSummary', {
    epoch: seed.epoch,
    id: formal.draftId,
    expectedRevision: formal.draftRevision,
    reason: '重复查询合成确认',
    acknowledgeReviewed: true,
    acknowledgeSources: true,
  });
  assert.equal(replay.entryId, formal.id);
  assert.equal(replay.replayed, true);
  assert.equal((await timeline()).entries.length, 1);
  assert.deepEqual(formal.source.selection.scores, [
    { versionId: seed.score.versionId, subjectId: seed.subjectId },
  ]);
  await button('关闭草稿编辑').click();
  report.gates.push(
    'offline independent manual draft and explicit teacher confirmation',
    'repeat formal confirmation and durable entry query',
    'exact score version and student provenance',
  );
  // 仅给本脚本拥有的隔离 userData 写入合成 Key。网络已在 Main 全面拦截。
  await call('saveDeepSeekKey', { apiKey: 'synthetic-growth-ui-key' });
  await button('班级名册').click();
  await button('成长档案').click();
  await label('档案学生').selectOption(seed.studentId);
  await label('阶段开始').fill('2026-10-01');
  await label('阶段结束').fill('2026-10-31');
  await label('确认仅使用合成资料，已核对最小摘要并去除可识别信息').check();
  await page.getByRole('checkbox', { name: /2026-10-01 · 修订 2/ }).check();
  await generate('success');
  await status('生成仅保存总结草稿');
  assert.equal((await timeline()).entries.length, 1);
  const generated = (await timeline()).summaries.find((s) => !!s.record.provider);
  assert.equal(generated.record.reviewed, false);
  assert.equal(generated.record.status, 'draft');
  const wires = await app.evaluate(() => globalThis.__growthAudit.wires);
  const wireText = JSON.stringify(wires);
  assert.match(wireText, /10月1日/);
  for (const text of [
    seed.studentId,
    seed.score.versionId,
    '合成成长甲',
    'GROWTH_001',
    '合成成长班',
    '完整私有谈话',
    '本地私有后续行动',
    '本地核对已完成',
  ])
    assert.equal(wireText.includes(text), false, text);
  const draftPanel = page
    .locator('.growth-section')
    .filter({ has: page.getByRole('heading', { name: '教师复核总结草稿', exact: true }) });
  await draftPanel.screenshot({ path: join(root, 'ai-draft.png') });
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await draftPanel.screenshot({ path: join(root, 'ai-draft-360.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await label('教师复核正文').fill(
    '教师复核合成AI草稿：完成一次订正练习；建议核实后续，资料有限。',
  );
  await confirm('合成AI草稿教师复核入档');
  await button('关闭草稿编辑').click();
  report.gates.push(
    'actual outbound preview and text boundary',
    'AI draft stays unreviewed until teacher save and explicit formal confirmation',
  );
  // provider 无效/断网后无自动重试，且事件表单仍能离线保存。
  for (const mode of ['invalid', 'offline']) {
    const before = await app.evaluate(() => globalThis.__growthAudit.calls);
    const count = (await timeline()).summaries.length;
    await generate(mode);
    await status(mode === 'invalid' ? 'VALIDATION' : 'NETWORK_ERROR');
    assert.equal(await app.evaluate(() => globalThis.__growthAudit.calls), before + 1);
    assert.equal((await timeline()).summaries.length, count);
    await button('取消总结准备').click();
  }
  await recordAuditIpcResults(app, '__growthCancellationResults', [
    'generateGrowthSummary',
    'cancelGrowthSummary',
  ]);
  await generate('pending');
  await app.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (!globalThis.__growthAudit.release) {
      if (Date.now() > deadline) throw Error('Synthetic pending provider did not start');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
  // 单次取消错误注入证明 UI 展示结构化失败，而非吞掉 ok:false。
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get('cm:cancelGrowthSummary');
    handlers.set('cm:cancelGrowthSummary', async (...args) => {
      handlers.set('cm:cancelGrowthSummary', original);
      return {
        ok: false,
        error: {
          code: 'SYNTHETIC_CANCEL_ERROR',
          message: '合成取消故障',
          operationId: 'synthetic-cancel-op',
        },
      };
    });
  });
  await button('取消总结生成').click();
  await status('SYNTHETIC_CANCEL_ERROR · synthetic-cancel-op');
  await button('取消总结生成').click();
  await status('已请求取消');
  const beforeCancel = (await timeline()).summaries.length;
  await app.evaluate(() => {
    globalThis.__growthAudit.release();
    globalThis.__growthAudit.release = null;
  });
  await app.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (
      !globalThis.__growthCancellationResults.some(
        (r) => r.method === 'generateGrowthSummary' && !r.ok && r.code === 'ABORTED',
      )
    ) {
      if (Date.now() > deadline) throw Error('Late growth result was not aborted');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  console.log(
    JSON.stringify({
      cancellation: await app.evaluate(() => globalThis.__growthCancellationResults),
      notices: await page.getByRole('status').allTextContents(),
    }),
  );
  assert.equal((await timeline()).summaries.length, beforeCancel);
  await button('取消总结准备').click();
  report.gates.push(
    'invalid/offline provider retains facts with no retry',
    'visible cancel failure and late response rejected',
  );
  await button('更正事件 2026-10-01').click();
  await label('用于阶段总结的最小事实摘要').fill('10月1日核实为两次订正练习。');
  await label('记录 / 更正说明').fill('合成事实后续核实更正');
  await button('保存事件记录').click();
  await status('事件已保存');
  const stale = await timeline();
  assert.equal(
    stale.entries.every((e) => e.stale),
    true,
  );
  assert.equal(stale.entries.find((e) => e.record.id === formal.id).record.content, formal.content);
  await page
    .getByText('来源更正或成员变化，请重新核对；历史正文保留。', { exact: true })
    .first()
    .waitFor();
  await button(`更正正式总结 ${formal.id}`).click();
  await page.getByRole('checkbox', { name: /2026-10-01 · 修订 3/ }).check();
  await label('人工总结草稿').fill('教师更正合成事实为两次订正练习，仍需跟进。');
  await button('保存人工总结草稿').click();
  await status('人工总结已存为独立草稿');
  await confirm('合成正式总结更正');
  await button('关闭草稿编辑').click();
  const corrected = await timeline();
  assert.ok(corrected.entries.find((e) => e.record.id === formal.id).supersededBy);
  assert.equal(
    corrected.entries.find((e) => e.record.id === formal.id).record.content,
    formal.content,
  );
  report.gates.push(
    'source correction flags history stale without rewriting',
    'formal correction creates successor and retains parent',
  );
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(root, 'growth-360.png'), fullPage: true });
  await page
    .locator('.growth-section')
    .filter({ has: page.getByRole('heading', { name: '正式阶段总结', exact: true }) })
    .screenshot({ path: join(root, 'formal-history-360.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(root, 'growth-history.png'), fullPage: true });
  // 实际课堂 preload 和管理 Main 拒绝档案读取；不向展示窗口传入任何档案内容。
  const applicationPath = await app.evaluate(({ app }) => app.getAppPath());
  const display = await app.evaluate(
    async ({ BrowserWindow, ipcMain }, paths) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: paths.preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      try {
        await window.loadFile(paths.html);
        const surface = await window.webContents.executeJavaScript(
          '({ admin: typeof window.classManager, display: Object.keys(window.classroomDisplay), require: typeof window.require })',
        );
        const denial = await ipcMain._invokeHandlers.get('cm:growthTimeline')(
          { sender: window.webContents, senderFrame: window.webContents.mainFrame },
          { epoch: 'not-authorized', studentId: 'not-authorized' },
        );
        return { surface, denial };
      } finally {
        window.destroy();
      }
    },
    {
      preload: join(applicationPath, 'dist/main/classroom-preload.cjs'),
      html: join(applicationPath, 'dist/renderer/classroom.html'),
    },
  );
  assert.equal(display.surface.admin, 'undefined');
  assert.equal(display.surface.require, 'undefined');
  assert.deepEqual(
    display.surface.display.sort(),
    ['readClock', 'readProjection', 'setFullscreen'].sort(),
  );
  assert.equal(display.denial.error.code, 'FORBIDDEN');
  report.gates.push(
    '360px no horizontal overflow',
    'actual classroom preload excludes archives and Main denies archive read',
  );
  const backup = join(root, 'growth-backup.cmbak');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, backup);
  await call('saveBackup', { epoch: seed.epoch });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, backup);
  const preview = await call('previewRestore');
  assert.equal(preview.growthEventCount, 1);
  assert.equal(preview.growthSummaryCount, 3);
  assert.equal(preview.growthEntryCount, 3);
  const restored = await call('commitRestore', { epoch: seed.epoch, token: preview.token });
  const oldEpoch = await page.evaluate((input) => window.classManager.growthTimeline(input), {
    epoch: seed.epoch,
    studentId: seed.studentId,
  });
  assert.equal(oldEpoch.error.code, 'STALE_WORKSPACE');
  seed.epoch = restored.epoch;
  assert.equal((await timeline()).entries.length, 3);
  await call('deleteDeepSeekKey');
  report.syntheticProviderCalls += await app.evaluate(() => globalThis.__growthAudit.calls);
  await closeAuditApplication(app, () => {});
  app = undefined;
  await launch();
  assert.equal((await call('getDeepSeekStatus')).configured, false);
  seed.epoch = (await call('snapshot')).epoch;
  assert.equal((await timeline()).entries.length, 3);
  assert.equal(
    (await call('readGrowthSummary', { epoch: seed.epoch, id: formal.draftId })).entryId,
    formal.id,
  );
  await button('成长档案').click();
  await label('档案学生').selectOption(seed.studentId);
  await page.getByText('教师更正合成事实为两次订正练习，仍需跟进。', { exact: true }).waitFor();
  report.gates.push(
    'Schema11 backup/restore counts and old epoch rejection',
    'no-credential reopen retains formal history',
  );
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
  if (page) {
    try {
      await page.screenshot({ path: join(root, 'failure.png'), fullPage: true });
    } catch {}
  }
} finally {
  try {
    await closeAuditApplication(app, () => {});
  } catch (error) {
    report.status = 'failed';
    report.closeError = String(error);
    process.exitCode = 1;
  }
  writeAuditReport(join(root, 'report.json'), report);
}
console.log(JSON.stringify(report));
