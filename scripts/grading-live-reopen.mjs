import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { closeAuditApplication } from './live-audit-guards.ts';

// Inspect the completed paid attempt offline. Never copies or reads user credentials.
const successfulFollowup = process.argv.includes('--successful-followup');
const output = resolve(successfulFollowup ? 'output/live-grading-followup' : 'output/live-grading');
const prior = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
assert.equal(prior.authorizationConsumed, true);
assert.equal(prior.requestCount, 1);
assert.equal(prior.status, successfulFollowup ? 'passed' : 'failed');
if (successfulFollowup) {
  assert.equal(prior.supportedAnswersMatchGold, true);
  assert.equal(prior.supportedScoresMatchGold, true);
  assert.equal(prior.teacherUiMatchesStoredResult, true);
}
const child = relative(output, resolve(prior.dataDirectory));
assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
assert.equal(existsSync(join(prior.dataDirectory, 'credentials', 'deepseek.enc')), false);
let evidenceOutput = output;
if (successfulFollowup) {
  const reopenRoot = join(output, 'reopen');
  mkdirSync(reopenRoot, { recursive: true });
  evidenceOutput = mkdtempSync(join(reopenRoot, 'run-'));
}
const reportPath = join(
  evidenceOutput,
  successfulFollowup ? 'report.json' : 'failed-reopen-report.json',
);
assert.equal(existsSync(reportPath), false, 'Preserve earlier evidence');
const report = {
  status: 'running',
  reportPath,
  externalRequests: 0,
  credentialReads: 0,
  errors: [],
};
let application;
try {
  const env = { ...process.env, CLASS_MANAGER_DATA_DIR: prior.dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: prior.executablePath, args: [], env });
  await application.evaluate(() => {
    globalThis.__offlineGradingCalls = 0;
    globalThis.fetch = async () => {
      globalThis.__offlineGradingCalls++;
      throw Error('Offline reopen forbids all provider requests');
    };
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  const value = (result) => {
    assert.equal(result.ok, true);
    return result.value;
  };
  const call = (name, input) =>
    page
      .evaluate(({ name, input }) => window.classManager[name](input), { name, input })
      .then(value);
  const epoch = (await call('snapshot')).epoch;
  assert.equal((await call('getDeepSeekStatus')).configured, false);
  const draft = await call('readGrading', { epoch, id: prior.draftId });
  assert.equal(draft.record.status, 'draft');
  assert.equal(draft.payload.rows.length, 6);
  assert.equal(
    draft.payload.rows.every((row) => !row.reviewed),
    true,
  );
  if (successfulFollowup) {
    assert.deepEqual(
      draft.payload.rows.map((row) => ({
        questionId: row.questionId,
        answer: row.answer,
        scoreHundredths: row.scoreHundredths,
        status: row.status,
        evidenceCount: row.evidence.length,
      })),
      prior.assessments.map(({ questionId, answer, scoreHundredths, status, evidenceCount }) => ({
        questionId,
        answer,
        scoreHundredths,
        status,
        evidenceCount,
      })),
    );
    assert.equal(draft.payload.rows[5].scoreHundredths, null);
    report.suggestionsPersisted = true;
    report.manualFormulaStillPending = true;
  } else {
    assert.equal(
      draft.payload.rows.every((row) => row.scoreHundredths === null),
      true,
    );
  }
  const attempts = await call('gradingAttempts', { epoch, id: prior.draftId });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].record.status, successfulFollowup ? 'succeeded' : 'failed');
  if (successfulFollowup) {
    assert.deepEqual(attempts[0].payload.provider, prior.provider);
    const ledger = await call('getDeepSeekLedger');
    assert.equal(ledger.totalCalls, 1);
    assert.equal(ledger.successCalls, 1);
    assert.deepEqual(ledger.recentEntries[0].usage, prior.provider.usage);
    report.providerUsagePersisted = true;
  } else {
    assert.equal(attempts[0].record.errorCode, 'TIMEOUT');
  }
  const history = await call('gradingHistory', { epoch, id: prior.draftId });
  assert.equal(history.length, successfulFollowup ? 2 : 1);
  assert.equal(history[0].record.revision, draft.record.revision);
  assert.equal(
    (
      await call('readScoreVersion', {
        epoch,
        versionId: draft.payload.request.scoreVersionId,
      })
    ).stale,
    false,
  );
  await page.getByRole('button', { name: '答卷建议与复核', exact: true }).click();
  await page
    .getByRole('combobox', { name: '考试', exact: true })
    .selectOption(draft.payload.request.examId);
  await page.getByRole('button', { name: /合成阅卷甲.*草案/ }).click();
  await page
    .getByText(
      successfulFollowup
        ? new RegExp(`本批建议已保存.*6 题 / 2 页.*Token ${prior.provider.usage.totalTokens}`)
        : /失败.*6 题 \/ 2 页.*Token 未知.*TIMEOUT/,
    )
    .waitFor();
  assert.equal(await page.locator('.grading-table-wrap tbody tr').count(), 6);
  assert.equal(
    await page.getByRole('button', { name: '确认冻结复核', exact: true }).isDisabled(),
    true,
  );
  if (successfulFollowup) {
    const rows = page.locator('.grading-table-wrap tbody tr');
    for (const [index, row] of draft.payload.rows.entries()) {
      assert.equal(
        await rows.nth(index).locator('td').nth(1).locator('p').first().textContent(),
        row.answer ?? '无法判定',
      );
      assert.equal(
        await rows.nth(index).locator('td').nth(2).textContent(),
        row.scoreHundredths === null ? '待人工' : String(row.scoreHundredths / 100),
      );
    }
    report.teacherUiMatchesStoredResult = true;
    await rows.last().scrollIntoViewIfNeeded();
    await page.locator('.grading-table-wrap').screenshot({
      path: join(evidenceOutput, 'successful-reopen-bottom.png'),
    });
  }
  await page.screenshot({
    path: join(evidenceOutput, successfulFollowup ? 'successful-reopen.png' : 'failed-reopen.png'),
    fullPage: true,
  });
  report.savedInputPreserved = true;
  if (!successfulFollowup) report.timeoutAttemptPersisted = true;
  report.noReviewOrScorePublished = true;
  report.providerUsage = successfulFollowup ? prior.provider.usage : 'unknown';
  report.externalRequests = await application.evaluate(() => globalThis.__offlineGradingCalls);
  assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  try {
    await closeAuditApplication(application, () => {});
  } catch (error) {
    report.status = 'failed';
    report.closeError = String(error);
    process.exitCode = 1;
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
