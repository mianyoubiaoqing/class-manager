import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { closeAuditApplication } from './live-audit-guards.ts';

// 使用实际打包的 Electron/Main/Worker/SQLite；仅文件选择和供应商响应为合成替身。
// 混合交互必须持续真实单调时钟的一小时，不得加速计时或用替身补齐外部验收。
const executable = process.env.CLASS_MANAGER_STABILITY_EXECUTABLE;
if (!executable) throw Error('An explicitly verified packaged executable is required');
const parent = resolve('output/playwright/stability15');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: join(root, '合成数据') };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`;
const report = {
  status: 'running',
  root,
  executable: resolve(executable),
  startedAt: new Date().toISOString(),
  minimumDurationMs: 60 * 60 * 1000,
  errors: [],
  cycles: 0,
  normalReopens: 0,
  crashReopens: 0,
  baseline: { classes: 2, students: 100, exams: 3 },
  externalRequests: 0,
  faultCalls: 0,
  confirmedGrowthEvents: 0,
  resourceSamples: [],
  gates: [],
  limitations: [
    'Current Windows has developer tools; child PATH exposes only Windows System32.',
    'File dialogs are replaced with explicit synthetic paths; no human independent acceptance.',
    'Provider transport is synthetic; no real account or natural-language quality evidence.',
  ],
};
const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
const record = (event, details = {}) =>
  appendFileSync(
    join(root, 'events.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n',
  );
let app, page, snapshot, studentId, classId, subjectId, versionId;
let expectedGrowth = 0;
const unwrap = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.value;
};
const raw = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input });
const call = (name, input) =>
  raw(name, input).then((result) => {
    if (!result.ok) throw Error(`${name}: ${JSON.stringify(result.error)}`);
    return unwrap(result);
  });
async function launch() {
  app = await electron.launch({
    executablePath: resolve(executable),
    args: [],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  await app.evaluate(() => {
    globalThis.__stability15 = { calls: 0, mode: 'offline' };
    globalThis.fetch = async () => {
      const fixture = globalThis.__stability15;
      fixture.calls++;
      if (fixture.mode === 'server') return new Response('{}', { status: 503 });
      if (fixture.mode === 'invalid') return new Response('{broken');
      throw new TypeError('Synthetic stability offline transport');
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  report.runtime = await app.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node,
    exe: process.execPath,
  }));
}
async function dialogs(path, kind) {
  await app.evaluate(
    ({ dialog }, { path, kind }) => {
      if (kind === 'save')
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      else dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    },
    { path, kind },
  );
}
async function verifyBaseline() {
  snapshot = await call('snapshot');
  assert.equal(snapshot.schemaVersion, 11);
  assert.equal(snapshot.classes.length, 2);
  assert.equal(snapshot.students.length, 100);
  assert.equal((await call('listExams', { epoch: snapshot.epoch })).length, 3);
  assert.equal(
    (await call('growthTimeline', { epoch: snapshot.epoch, studentId })).events.length,
    expectedGrowth,
  );
  const scores = await call('readScoreVersion', { epoch: snapshot.epoch, versionId });
  assert.equal(scores.stale, false);
  assert.ok(scores.statistics.subjects.some((s) => s.absentCount > 0 && s.missingCount > 0));
}
async function fault(round) {
  const modes = ['offline', 'server', 'invalid'];
  const mode = modes[round % modes.length];
  await app.evaluate((_electron, mode) => {
    globalThis.__stability15.mode = mode;
  }, mode);
  const config = await call('readModelSettings');
  const prepared = await call('prepareConversation', {
    epoch: snapshot.epoch,
    configurationRevision: config.revision,
    text: '查询合成名册',
    classId,
    studentId,
  });
  const prep = prepared.preparation;
  const before = await app.evaluate(() => globalThis.__stability15.calls);
  const denied = await raw('generateConversation', {
    epoch: snapshot.epoch,
    token: prep.token,
    wireHash: prep.wireHash,
    acknowledgeOutboundPreview: false,
  });
  assert.equal(denied.ok, false);
  assert.equal(await app.evaluate(() => globalThis.__stability15.calls), before);
  const failed = await raw('generateConversation', {
    epoch: snapshot.epoch,
    token: prep.token,
    wireHash: prep.wireHash,
    acknowledgeOutboundPreview: true,
  });
  assert.equal(failed.ok, false);
  const task = await call('readConversation', { epoch: snapshot.epoch, token: prep.token });
  assert.equal(task.status, 'failed');
  assert.equal(await app.evaluate(() => globalThis.__stability15.calls), before + 1);
  assert.deepEqual(
    await call('readConversation', { epoch: snapshot.epoch, token: prep.token }),
    task,
  );
  report.faultCalls++;
  record('synthetic-provider-failure-single-call', { mode, error: task.error?.code });
}
async function saveGrowth() {
  const input = {
    epoch: snapshot.epoch,
    requestId: randomUUID(),
    studentId,
    content: {
      date: '2026-10-02',
      kind: 'event',
      description: `合成稳定性观察 ${expectedGrowth + 1}`,
      source: '合成测试观察',
      action: '',
      result: '本地记录完成',
      followUp: 'none',
      summaryFact: '',
    },
    reason: '已核对合成稳定性事实并确认保存',
  };
  const receipt = await call('saveGrowthEvent', input);
  assert.equal((await call('saveGrowthEvent', input)).id, receipt.id);
  expectedGrowth++;
  report.confirmedGrowthEvents = expectedGrowth;
}
async function restore() {
  const path = join(root, `synthetic-${report.cycles}.cmbackup`);
  await dialogs(path, 'save');
  await call('saveBackup', { epoch: snapshot.epoch });
  assert.doesNotMatch(
    readFileSync(path, 'utf8'),
    /sk-synthetic|conversation_intent|business-intent-v1/,
  );
  await dialogs(path, 'open');
  const preview = await call('previewRestore', { epoch: snapshot.epoch });
  const old = snapshot.epoch;
  await call('commitRestore', { epoch: old, token: preview.token });
  await verifyBaseline();
  assert.notEqual(snapshot.epoch, old);
  const stale = await raw('listExams', { epoch: old });
  assert.equal(stale.ok, false);
  record('backup-restore-new-epoch');
}
async function reopen(crash = false) {
  if (crash) {
    const pid = await app.evaluate(() => process.pid);
    const result = spawnSync('rtk', ['proxy', 'taskkill', '/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    await app.close().catch(() => {});
    report.crashReopens++;
  } else {
    await closeAuditApplication(app, () => {});
    report.normalReopens++;
  }
  app = undefined;
  await launch();
  await verifyBaseline();
  record(crash ? 'crash-reopen' : 'normal-reopen');
}
try {
  save();
  await launch();
  snapshot = await call('snapshot');
  await call('seedDemo', { epoch: snapshot.epoch });
  snapshot = await call('snapshot');
  classId = snapshot.classes[0].id;
  studentId = snapshot.students.find((s) => s.classId === classId).id;
  for (let exam = 0; exam < 3; exam++) {
    const currentClass = snapshot.classes[exam % 2];
    const students = snapshot.students.filter((s) => s.classId === currentClass.id);
    subjectId = randomUUID();
    const chineseId = randomUUID(),
      groupId = randomUUID();
    const config = {
      epoch: snapshot.epoch,
      classId: currentClass.id,
      expectedRevision: 0,
      definition: {
        name: `合成稳定性考试${exam + 1}`,
        date: `2026-09-${20 + exam}`,
        academicYear: '2026-2027',
        term: '上学期',
        grade: '高一',
      },
      subjects: [
        { id: subjectId, name: '数学', maxScore: '150', precision: 2 },
        { id: chineseId, name: '语文', maxScore: '100', precision: 2 },
      ],
      groups: [{ id: groupId, name: '合成科目组', subjectIds: [subjectId, chineseId] }],
      assignments: students.map((s) => ({ studentId: s.id, groupId })),
      scoreBasis: 'raw',
    };
    const path = join(root, `exam-${exam + 1}.csv`);
    writeFileSync(
      path,
      `学生编号,数学,语文\n${students[0].studentNumber},151,90\n${students[0].studentNumber},50,80\n`,
    );
    await dialogs(path, 'open');
    const bad = await call('previewScores', config);
    assert.equal(bad.canConfirm, false);
    await call('cancelScorePreview', { epoch: snapshot.epoch });
    writeFileSync(
      path,
      '学生编号,数学,语文\n' +
        students
          .map(
            (s, i) =>
              `${s.studentNumber},${i === 0 ? '0' : i === 1 ? '缺考' : i === 2 ? '' : 60 + i},${50 + i}`,
          )
          .join('\n'),
    );
    const preview = await call('previewScores', config);
    assert.equal(preview.canConfirm, true);
    const command = {
      epoch: snapshot.epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '核对合成基准数据后确认导入',
    };
    const receipt = await call('confirmScores', command);
    assert.equal((await call('confirmScores', command)).replayed, true);
    if (exam === 0) versionId = receipt.versionId;
  }
  await call('saveModelProviderKey', {
    provider: 'deepseek',
    apiKey: 'sk-synthetic-stability-only-never-real',
  });
  const models = await call('readModelSettings');
  await call('selectModelProvider', { provider: 'deepseek', expectedRevision: models.revision });
  await verifyBaseline();
  report.gates.push(
    '2 classes/100 students/3 exams: mixed full marks, zero, absent, missing, duplicate/invalid preview rejection, confirmed idempotent imports',
  );
  report.interactionStartedAt = new Date().toISOString();
  const start = performance.now();
  let nextMinute = 0,
    nextReopen = 5 * 60 * 1000,
    restored = false;
  const routes = [
    '班级名册',
    '成绩管理',
    '座位编排',
    '值日轮换',
    '成长档案',
    '资料备课',
    '课堂与倒计时',
    '答卷建议与复核',
    '外设接口',
    '模型设置',
    '数据与维护',
  ];
  record('interaction-hour-start');
  while (performance.now() - start < report.minimumDurationMs) {
    const elapsed = performance.now() - start;
    await page
      .getByRole('button', { name: routes[report.cycles % routes.length], exact: true })
      .click();
    await page.locator('h1').waitFor();
    await verifyBaseline();
    await call('readCountdown', { epoch: snapshot.epoch });
    await call('readDeviceStatus', { epoch: snapshot.epoch });
    if (elapsed >= nextMinute) {
      await saveGrowth();
      const existing = await call('readCountdown', { epoch: snapshot.epoch });
      await call('setCountdown', {
        epoch: snapshot.epoch,
        expectedRevision: existing?.revision ?? 0,
        setting: {
          name: '合成跨日期倒计时',
          targetDate: report.cycles % 2 ? '2026-10-01' : '2026-10-03',
          timeZone: 'Asia/Shanghai',
        },
      });
      await fault(Math.floor(elapsed / 60000));
      const metrics = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu, memory: m.memory })),
      );
      report.resourceSamples.push({ elapsedMs: Math.round(elapsed), metrics });
      nextMinute += 60000;
      console.log(
        JSON.stringify({
          root,
          elapsedMinutes: +(elapsed / 60000).toFixed(2),
          cycles: report.cycles,
          growth: expectedGrowth,
          errors: report.errors.length,
        }),
      );
    }
    if (!restored && elapsed >= 10 * 60 * 1000) {
      await restore();
      restored = true;
    }
    if (elapsed >= nextReopen) {
      await reopen(report.normalReopens === 5 && report.crashReopens === 0);
      nextReopen += 5 * 60 * 1000;
    }
    if (report.cycles % 30 === 0)
      await page.screenshot({ path: join(root, `screen-${report.cycles}.png`) });
    report.cycles++;
    report.durationMs = Math.round(performance.now() - start);
    save();
    await page.waitForTimeout(10000);
  }
  report.durationMs = Math.round(performance.now() - start);
  await reopen();
  assert.ok(report.durationMs >= report.minimumDurationMs);
  assert.ok(report.normalReopens >= 10);
  assert.equal(report.crashReopens, 1);
  assert.equal(report.errors.length, 0);
  report.gates.push(
    'Actual monotonic hour of mixed UI/local queries, confirmed writes and single-call synthetic offline/503/invalid faults; backup restore and epoch invalidation; normal and actual forced crash reopens; persisted data and exact growth counts',
  );
  await call('deleteModelProviderKey', { provider: 'deepseek' });
  // 先确认本轮应用关闭，再发布通过；关闭失败也必须进入失败报告。
  const closingApplication = app;
  app = undefined;
  await closeAuditApplication(closingApplication, () => {});
  report.shutdownVerified = true;
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  save();
  record('passed');
  console.log(JSON.stringify({ status: report.status, root, durationMs: report.durationMs }));
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  report.completedAt = new Date().toISOString();
  save();
  if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) {
    try {
      await closeAuditApplication(app, () => {});
    } catch (error) {
      report.status = 'failed';
      report.shutdownFailure = String(error);
      report.completedAt = new Date().toISOString();
      save();
      throw error;
    }
  }
}
