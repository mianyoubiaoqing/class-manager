import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAuditApplication, reservePaidAudit } from './live-audit-guards.ts';

// Explicit opt-in only. This is not part of any automated test command.
assert.ok(process.argv.includes('--allow-one-paid-request'), 'Paid-request opt-in required');
assert.ok(process.env.CLASS_MANAGER_LIVE_CREDENTIALS, 'Explicit credential directory required');
assert.ok(process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE, 'Explicit packaged executable required');
const output = resolve('output/live-explanation');
const reportPath = join(output, 'report.json');
mkdirSync(output, { recursive: true });
const releaseReservation = reservePaidAudit(join(output, 'paid-run.lock'));
if (existsSync(reportPath)) {
  const previous = JSON.parse(readFileSync(reportPath, 'utf8'));
  const provenPreflightFailure =
    process.argv.includes('--resume-after-zero-request-decryption') &&
    previous.status === 'failed' &&
    previous.requestCount === 0 &&
    previous.ledger?.totalCalls === 0 &&
    previous.generation?.error?.code === 'DECRYPTION_FAILED';
  assert.ok(
    !previous.generationAttempted || provenPreflightFailure,
    'A generation was already attempted. Obtain new authorization before another paid run.',
  );
  if (provenPreflightFailure) {
    const priorPath = join(output, 'preflight-decryption-report.json');
    assert.equal(existsSync(priorPath), false, 'Preserve the previous preflight report');
    copyFileSync(reportPath, priorPath);
  }
}
mkdirSync(output, { recursive: true });
const dataDirectory = mkdtempSync(join(output, 'isolated-'));
const credentialDirectory = join(dataDirectory, 'credentials');
mkdirSync(credentialDirectory);
const credentialNames = ['deepseek.enc', 'deepseek.meta.json'];
const source = resolve(process.env.CLASS_MANAGER_LIVE_CREDENTIALS);
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const originalHashes = credentialNames.map((name) => hashFile(join(source, name)));
const localStatePath = join(source, '..', 'Local State');
const originalContextHash = hashFile(localStatePath);
const report = {
  status: 'preparing',
  startedAt: new Date().toISOString(),
  generationAttempted: false,
  dataDirectory,
  executablePath: resolve(process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE),
  syntheticDataOnly: true,
  transport: 'real-provider-with-single-request-guard',
};
const saveReport = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const value = (result) => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
let application;
let page;
try {
  // Windows safeStorage also depends on Chromium's per-profile encrypted key.
  const context = JSON.parse(readFileSync(localStatePath, 'utf8')).os_crypt;
  assert.ok(context?.encrypted_key, 'Missing encryption context');
  writeFileSync(join(dataDirectory, 'Local State'), JSON.stringify({ os_crypt: context }));
  for (const name of credentialNames)
    copyFileSync(join(source, name), join(credentialDirectory, name));
  const env = { ...process.env, CLASS_MANAGER_DATA_DIR: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: report.executablePath,
    args: [],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  await application.evaluate(() => {
    const actualFetch = globalThis.fetch;
    globalThis.__liveExplanationRequests = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions')
        throw new Error('Live audit forbids other endpoints');
      if (++globalThis.__liveExplanationRequests !== 1)
        throw new Error('Live audit permits only one request');
      const body = JSON.parse(options.body);
      if (body.max_tokens > 4096 || body.messages.length !== 2)
        throw new Error('Unexpected generation bounds');
      const wire = JSON.parse(body.messages[1].content);
      if (
        Object.keys(wire).sort().join(',') !== 'facts,formatVersion,scope' ||
        wire.scope !== 'class' ||
        wire.facts.length !== 3
      )
        throw new Error('Unexpected synthetic outbound data');
      return actualFetch(url, { ...options, redirect: 'error' });
    };
  });
  page = await application.firstWindow();
  await page.getByText('本地就绪', { exact: true }).waitFor();
  assert.equal(
    value(await page.evaluate(() => window.classManager.getDeepSeekStatus())).configured,
    true,
  );
  await page.getByRole('button', { name: '班级名册', exact: true }).click();
  await page.getByRole('button', { name: '载入合成样例', exact: true }).click();
  await page.getByRole('button', { name: '确认载入', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '合成样例已保存' }).waitFor();
  const snapshot = value(await page.evaluate(() => window.classManager.snapshot()));
  const classroom = snapshot.classes[0];
  const students = snapshot.students.filter(
    (student) => student.active && student.classId === classroom.id,
  );
  assert.ok(students.length > 0);
  const subjectId = randomUUID();
  const groupId = randomUUID();
  const config = {
    epoch: snapshot.epoch,
    classId: classroom.id,
    expectedRevision: 0,
    definition: {
      name: '合成真实接口验收',
      date: '2026-09-30',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 }],
    groups: [{ id: groupId, name: '合成组', subjectIds: [subjectId] }],
    assignments: students.map((student) => ({ studentId: student.id, groupId })),
    scoreBasis: 'raw',
  };
  const csvPath = join(dataDirectory, 'synthetic-scores.csv');
  writeFileSync(
    csvPath,
    `学生编号,数学\n${students.map((student) => `${student.studentNumber},100`).join('\n')}\n`,
  );
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, csvPath);
  const preview = value(
    await page.evaluate((input) => window.classManager.previewScores(input), config),
  );
  assert.equal(preview.canConfirm, true);
  assert.equal(preview.statistics.subjects[0].mean, '100.00');
  const receipt = value(
    await page.evaluate((input) => window.classManager.confirmScores(input), {
      epoch: snapshot.epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '合成数据真实接口验收，不含真实学生信息',
    }),
  );
  const scoreInput = { epoch: snapshot.epoch, versionId: receipt.versionId };
  const beforeScore = value(
    await page.evaluate((input) => window.classManager.readScoreVersion(input), scoreInput),
  );
  const prepared = value(
    await page.evaluate((input) => window.classManager.prepareExplanation(input), {
      epoch: snapshot.epoch,
      sourceVersionId: receipt.versionId,
      selection: {
        subjectIds: [subjectId],
        metrics: ['fullScore', 'validCount', 'mean'],
        scope: { kind: 'class' },
      },
    }),
  );
  report.outboundFacts = prepared.packet.wire;
  report.status = 'requesting';
  // Durable guard is written before IPC: even an ambiguous failure must not trigger a rerun.
  report.generationAttempted = true;
  saveReport();
  const generated = await page.evaluate((input) => window.classManager.generateExplanation(input), {
    epoch: snapshot.epoch,
    token: prepared.token,
  });
  report.requestCount = await application.evaluate(() => globalThis.__liveExplanationRequests);
  report.ledger = value(await page.evaluate(() => window.classManager.getDeepSeekLedger()));
  report.generation = generated;
  saveReport();
  const generatedReceipt = value(generated);
  assert.equal(report.requestCount, 1);
  const draftInput = { epoch: snapshot.epoch, id: generatedReceipt.id };
  const draft = value(
    await page.evaluate((input) => window.classManager.readExplanation(input), draftInput),
  );
  report.provider = draft.payload.provider;
  report.original = draft.payload.original;
  assert.equal(report.ledger.totalCalls, 1);
  assert.equal(report.ledger.successCalls, 1);
  assert.equal(report.ledger.recentEntries[0].responseId, draft.payload.provider.responseId);
  assert.deepEqual(report.ledger.recentEntries[0].usage, draft.payload.provider.usage);
  assert.deepEqual(
    value(await page.evaluate((input) => window.classManager.readScoreVersion(input), scoreInput)),
    beforeScore,
  );
  await page.getByRole('button', { name: '成绩管理', exact: true }).click();
  await page.getByRole('button', { name: `查看 ${config.definition.name}`, exact: true }).click();
  await page.getByRole('button', { name: '查看草案', exact: true }).click();
  const detail = page.getByRole('region', { name: '解释草案详情', exact: true });
  await detail
    .getByLabel('教师复核记录')
    .fill('合成数据验收：模型建议未经业务核实，不代表正式评价。');
  await detail.getByRole('button', { name: '保存教师编辑', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '教师编辑已保存' }).waitFor();
  await detail.getByText('模型原稿与引用（未经核实，不随编辑改变）', { exact: true }).click();
  await detail.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(output, 'live-draft.png'), fullPage: true });
  const edited = value(
    await page.evaluate((input) => window.classManager.readExplanation(input), draftInput),
  );
  assert.equal(edited.record.revision, 2);
  assert.deepEqual(edited.payload.original, draft.payload.original);
  report.teacherEditSaved = true;
  report.scoreUnchanged = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : 'Unknown audit failure';
  process.exitCode = 1;
} finally {
  try {
    await closeAuditApplication(application, () => {
      // Remove only copied files, never the original credential directory.
      for (const name of credentialNames) rmSync(join(credentialDirectory, name), { force: true });
      rmSync(join(dataDirectory, 'Local State'), { force: true });
    });
  } catch {
    report.closeFailed = true;
    report.status = 'failed';
    process.exitCode = 1;
  }
  report.copiedEncryptionContextRemoved = !existsSync(join(dataDirectory, 'Local State'));
  report.copiedCredentialsRemoved = credentialNames.every(
    (name) => !existsSync(join(credentialDirectory, name)),
  );
  report.originalCredentialsUnchanged = credentialNames.every(
    (name, index) => hashFile(join(source, name)) === originalHashes[index],
  );
  report.originalEncryptionContextUnchanged = hashFile(localStatePath) === originalContextHash;
  if (!report.originalCredentialsUnchanged) {
    report.status = 'failed';
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  saveReport();
  if (
    !report.generationAttempted ||
    (report.requestCount === 0 &&
      report.ledger?.totalCalls === 0 &&
      report.generation?.error?.code === 'DECRYPTION_FAILED')
  )
    releaseReservation();
}
console.log(
  JSON.stringify(
    {
      status: report.status,
      requestCount: report.requestCount ?? 0,
      usage: report.provider?.usage ?? report.ledger?.recentEntries[0]?.usage ?? null,
      error: report.error,
      reportPath,
      copiedCredentialsRemoved: report.copiedCredentialsRemoved,
      originalCredentialsUnchanged: report.originalCredentialsUnchanged,
    },
    null,
    2,
  ),
);
