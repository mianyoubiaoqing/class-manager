import { nodeBundleOptions } from './node-bundle-options.ts';
import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';

const parent = resolve('output/playwright/publication');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-')),
  userData = join(root, 'user-data');
await build(
  nodeBundleOptions({
    entryPoints: ['tests/fixtures/publication-runtime.ts'],
    outfile: join(root, 'fixture.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
  }),
);
const { seedPublicationWorkspace } = createRequire(import.meta.url)(join(root, 'fixture.cjs'));
const seed = await seedPublicationWorkspace(join(userData, 'workspace-data'));
const executable = process.env.CLASS_MANAGER_PUBLICATION_EXECUTABLE;
const { executablePath: auditExecutable } = isolatedElectronRuntime('publication-audit-');
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: userData };
delete env.ELECTRON_RUN_AS_NODE;
if (executable) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`;
}
const report = {
  status: 'running',
  externalRequests: 0,
  credentialReads: 0,
  errors: [],
  gates: [],
  root,
  packaged: Boolean(executable),
};
let app, page;
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const call = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input }).then(value);
const button = (name) => page.getByRole('button', { name, exact: true });
async function launch() {
  app = await electron.launch({
    executablePath: executable ?? auditExecutable,
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
    globalThis.__publicationCalls = 0;
    globalThis.fetch = async () => {
      globalThis.__publicationCalls++;
      throw Error('Publication audit forbids all provider requests');
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  assert.equal((await call('getDeepSeekStatus')).configured, false);
}
async function openReview() {
  await button('答卷建议与复核').click();
  await page.getByRole('combobox', { name: '考试', exact: true }).selectOption(seed.examId);
  await page.getByRole('button', { name: /合成甲.*已冻结复核/ }).click();
  await page.getByRole('heading', { name: '复核结果正式入分', exact: true }).waitFor();
}
try {
  await launch();
  await openReview();
  await button('查询入分结果').click();
  await page.getByText('未查到已提交记录；可重新准备入分差异。', { exact: true }).waitFor();
  await button('准备正式入分差异').click();
  await page.getByText(/原成绩：0.*新成绩：10/).waitFor();
  const visiblePreview = await page
    .locator('.grading-freeze')
    .filter({
      has: page.getByRole('heading', { name: '复核结果正式入分', exact: true }),
    })
    .innerText();
  assert.match(visiblePreview, /学生 .*合成甲 · 科目 合成学科 · 考试 合成阅卷测验/);
  assert.equal(visiblePreview.includes(seed.studentId), false);
  assert.equal(visiblePreview.includes(seed.subjectId), false);
  assert.equal(visiblePreview.includes(seed.examId), false);
  report.gates.push('teacher-readable student, subject and exam instead of internal IDs');
  assert.equal(await button('确认正式入分').isDisabled(), true);
  await page
    .getByRole('textbox', { name: '入分说明', exact: true })
    .fill('合成复核替换零分，核对所有依据');
  await page
    .getByRole('checkbox', { name: '已核对冻结复核和入分范围，同意正式写入成绩', exact: true })
    .check();
  assert.equal(await button('确认正式入分').isDisabled(), true);
  await page
    .getByRole('checkbox', { name: '已核对原成绩差异，明确同意替换本学生本科目成绩', exact: true })
    .check();
  assert.equal(await button('确认正式入分').isEnabled(), true);
  const publicationPanel = page.locator('.grading-freeze').filter({
    has: page.getByRole('heading', { name: '复核结果正式入分', exact: true }),
  });
  await publicationPanel.screenshot({ path: join(root, 'publication-ready.png') });
  await button('确认正式入分').click();
  await page.getByText(/已正式入分 · 成绩修订 2/).waitFor();
  const receipt = await call('readScorePublication', {
    epoch: seed.epoch,
    reviewId: seed.reviewId,
  });
  assert.equal(receipt.revision, 2);
  const result = await call('readScoreVersion', {
    epoch: seed.epoch,
    versionId: receipt.versionId,
  });
  assert.deepEqual(result.payload.publication, {
    reviewId: seed.reviewId,
    previousVersionId: seed.oldVersionId,
  });
  assert.equal(result.statistics.subjects[0].validCount, 2);
  assert.equal(
    result.payload.analysis.entries.find((e) => e.studentId === seed.studentId).score.hundredths,
    1000,
  );
  assert.equal(
    result.payload.analysis.entries.find((e) => e.studentId !== seed.studentId).score.hundredths,
    700,
  );
  assert.equal(
    (await call('readScoreVersion', { epoch: seed.epoch, versionId: seed.oldVersionId })).stale,
    true,
  );
  await button('查询入分结果').click();
  await page.getByText('已查到正式入分记录，重复操作不会再次改分。', { exact: true }).waitFor();
  assert.equal((await call('scoreHistory', { epoch: seed.epoch, examId: seed.examId })).length, 2);
  report.gates.push(
    'explicit difference and replacement approval',
    'single publication and source trace',
    'other student preserved and statistics updated',
    'persistent query without regrading',
  );
  await page.screenshot({ path: join(root, 'published.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await publicationPanel.screenshot({ path: join(root, 'published-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await button('班主任管理').click();
  await button('成绩管理').click();
  await page.getByRole('button', { name: /^查看 / }).click();
  await page.getByRole('heading', { name: /第 2 版/ }).waitFor();
  const statistics = page.getByRole('region', { name: '成绩统计', exact: true });
  await statistics.getByRole('cell', { name: '8.50', exact: true }).first().waitFor();
  await page.getByText('成绩来源与排除记录', { exact: true }).click();
  await page.getByText(`本版来自完整冻结复核 ${seed.reviewId}`, { exact: false }).waitFor();
  assert.match(await page.locator('.score-page').innerText(), new RegExp(seed.oldVersionId));
  await page.screenshot({ path: join(root, 'published-analysis.png'), fullPage: true });
  await page
    .getByRole('combobox', { name: '选择成绩版本', exact: true })
    .selectOption(seed.oldVersionId);
  await page.getByText('正在查看历史版本，已有更新。', { exact: false }).waitFor();
  await button('查看最新版本').click();
  await page.getByRole('heading', { name: /第 2 版/ }).waitFor();
  report.gates.push('visible updated analysis and provenance; retained stale parent');
  const backup = join(root, 'publication-backup.cmbak');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, backup);
  await call('saveBackup', { epoch: seed.epoch });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, backup);
  const restoredPreview = await call('previewRestore');
  assert.equal(restoredPreview.gradingPublicationCount, 1);
  const restored = await call('commitRestore', { epoch: seed.epoch, token: restoredPreview.token });
  const oldEpoch = await page.evaluate((input) => window.classManager.readScorePublication(input), {
    epoch: seed.epoch,
    reviewId: seed.reviewId,
  });
  assert.equal(oldEpoch.ok, false);
  assert.equal(oldEpoch.error.code, 'STALE_WORKSPACE');
  assert.equal(
    (await call('readScorePublication', { epoch: restored.epoch, reviewId: seed.reviewId }))
      .versionId,
    receipt.versionId,
  );
  report.gates.push(
    '360px no horizontal overflow',
    'current-schema backup/restore and old epoch rejection',
  );
  report.externalRequests += await app.evaluate(() => globalThis.__publicationCalls);
  await closeAuditApplication(app, () => {});
  app = undefined;
  await launch();
  const current = await call('snapshot');
  const persisted = await call('readScorePublication', {
    epoch: current.epoch,
    reviewId: seed.reviewId,
  });
  assert.equal(persisted.versionId, receipt.versionId);
  assert.equal(
    (await call('scoreHistory', { epoch: current.epoch, examId: seed.examId })).length,
    2,
  );
  report.gates.push('no-credential reopen retains committed fact');
  report.externalRequests += await app.evaluate(() => globalThis.__publicationCalls);
  assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.errors, []);
  report.receipt = persisted;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
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
