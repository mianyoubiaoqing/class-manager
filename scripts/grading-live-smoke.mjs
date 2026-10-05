import { nodeBundleOptions } from './node-bundle-options.ts';
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
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
import { join, resolve, relative, isAbsolute } from 'node:path';
import { closeAuditApplication, reservePaidAudit, writeAuditReport } from './live-audit-guards.ts';

// Opt-in only. Never run from npm check or synthetic desktop suites.
if (process.argv.includes('--dry-run')) {
  console.log(
    JSON.stringify(
      {
        status: 'dry-run',
        credentialReads: 0,
        externalRequests: 0,
        syntheticDataOnly: true,
        pages: 2,
        questions: 6,
        humanGoldTotal: 9,
        model: 'deepseek-flash',
        paidRequests: 1,
        retries: 0,
        authorization: process.argv.includes('--new-authorization-after-timeout')
          ? 'new explicit single-request authorization required; previous authorization consumed'
          : 'original single-request scope; an existing paid-run lock forbids repeating it',
      },
      null,
      2,
    ),
  );
} else {
  const preflight = process.argv.includes('--synthetic-preflight');
  const followup = process.argv.includes('--new-authorization-after-timeout');
  assert.ok(
    preflight || process.argv.includes('--allow-one-paid-request'),
    'Explicit single-request authorization required',
  );
  assert.ok(
    preflight || process.env.CLASS_MANAGER_LIVE_CREDENTIALS,
    'Explicit local credential directory required',
  );
  assert.ok(process.env.CLASS_MANAGER_GRADING_EXECUTABLE, 'Explicit audited executable required');
  const previousReport = resolve('output/live-grading/report.json');
  if (followup) {
    const prior = JSON.parse(readFileSync(previousReport, 'utf8'));
    assert.equal(prior.status, 'failed');
    assert.equal(prior.authorizationConsumed, true);
    assert.equal(prior.requestCount, 1);
    assert.ok(prior.error?.startsWith('TIMEOUT:'));
    assert.equal(existsSync(resolve('output/live-grading/paid-run.lock')), true);
  }
  const parent = resolve(
    preflight
      ? 'output/live-grading-preflight'
      : followup
        ? 'output/live-grading-followup'
        : 'output/live-grading',
  );
  mkdirSync(parent, { recursive: true });
  const output = preflight ? mkdtempSync(join(parent, 'run-')) : parent;
  const release = preflight ? () => {} : reservePaidAudit(join(output, 'paid-run.lock'));
  const reportPath = join(output, 'report.json');
  assert.equal(
    existsSync(reportPath),
    false,
    'Preserve prior evidence; no automatic second attempt',
  );
  const root = mkdtempSync(join(output, 'isolated-')),
    credentialDirectory = join(root, 'credentials'),
    localContext = join(root, 'Local State');
  const source = preflight ? '' : resolve(process.env.CLASS_MANAGER_LIVE_CREDENTIALS),
    originalContext = join(source, '..', 'Local State');
  const names = ['deepseek.enc', 'deepseek.meta.json'];
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const report = {
    status: 'preparing',
    startedAt: new Date().toISOString(),
    generationAttempted: false,
    authorizationConsumed: false,
    requestCount: 0,
    externalRequests: 0,
    credentialReads: 0,
    transport: preflight ? 'synthetic-preflight' : 'real-provider',
    authorizationScope: followup
      ? 'new single request after documented timeout'
      : 'original single request',
    ...(followup ? { previousReport } : {}),
    syntheticDataOnly: true,
    retries: 0,
    executablePath: resolve(process.env.CLASS_MANAGER_GRADING_EXECUTABLE),
    dataDirectory: root,
  };
  const save = () => writeAuditReport(reportPath, report);
  const value = (result) => {
    if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
  };
  let application, page, originalHashes, contextHash;
  try {
    await build(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/grading-runtime.ts'],
        outfile: join(root, 'fixture.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
      }),
    );
    const { seedGradingWorkspace } = createRequire(import.meta.url)(join(root, 'fixture.cjs'));
    const seeded = await seedGradingWorkspace(join(root, 'workspace-data'), root);
    const epoch = seeded.epoch;
    if (!preflight) {
      originalHashes = names.map((name) => hash(join(source, name)));
      contextHash = hash(originalContext);
      const context = JSON.parse(readFileSync(originalContext, 'utf8')).os_crypt;
      assert.ok(context?.encrypted_key, 'Missing encryption context');
      mkdirSync(credentialDirectory);
      writeFileSync(localContext, JSON.stringify({ os_crypt: context }));
      for (const name of names) copyFileSync(join(source, name), join(credentialDirectory, name));
      report.credentialReads = names.length;
    }
    const env = { ...process.env, CLASS_MANAGER_DATA_DIR: root };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      executablePath: report.executablePath,
      args: [],
      cwd: process.cwd(),
      env,
      timeout: 45000,
    });
    // Pin endpoint, protocol and exact outgoing bytes. The original fetch is called once.
    await application.evaluate((_electron, preflight) => {
      const originalFetch = globalThis.fetch;
      globalThis.__gradingLive = {
        count: 0,
        expectedImages: [],
        expectedQuestionIds: [],
        wireHash: null,
      };
      globalThis.fetch = async (url, init) => {
        const guard = globalThis.__gradingLive;
        if (String(url) !== 'https://api.deepseek.com/chat/completions')
          throw Error('Unexpected endpoint');
        const body = JSON.parse(init.body);
        if (
          body.model !== 'deepseek-flash' ||
          body.max_tokens !== 16384 ||
          body.response_format?.type !== 'json_object' ||
          body.messages.length !== 2
        )
          throw Error('Unexpected protocol');
        const parts = body.messages[1].content,
          wire = JSON.parse(parts[0].text),
          images = parts.filter((p) => p.type === 'image_url').map((p) => p.image_url.url);
        if (
          JSON.stringify(images) !== JSON.stringify(guard.expectedImages) ||
          JSON.stringify(wire.questions.map((q) => q.id)) !==
            JSON.stringify(guard.expectedQuestionIds) ||
          wire.pages.length !== 2
        )
          throw Error('Unexpected outgoing selection');
        if (
          /PRIVATE_SYNTHETIC|SYNTHETIC_GOLD|合成阅卷甲|sourceVersionId|originalAssetId|file:\/\//.test(
            JSON.stringify(wire),
          )
        )
          throw Error('Unexpected private data');
        if (guard.count !== 0) throw Error('Only one request authorized');
        guard.count++;
        if (preflight) {
          const answers = [
            'B',
            'A',
            'true',
            'Newton',
            'magnitude, direction, point of application',
          ];
          return new Response(
            JSON.stringify({
              id: 'synthetic-live-preflight',
              model: 'synthetic',
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: JSON.stringify({
                      formatVersion: 1,
                      assessments: wire.questions.map((q, index) => ({
                        questionId: q.id,
                        state: q.kind === 'manual' ? 'unsupported' : 'readable',
                        answer: q.kind === 'manual' ? null : answers[index],
                        suggestedHundredths: q.kind === 'short_text' ? 300 : null,
                        reason: 'Synthetic preflight, not provider recognition',
                        confidence: null,
                        evidence:
                          q.kind === 'manual'
                            ? []
                            : [
                                {
                                  pageId: wire.pages[index < 3 ? 0 : 1].pageId,
                                  rectangle: {
                                    x: 0.08,
                                    y: 0.22 + (index % 3) * 0.23,
                                    width: 0.85,
                                    height: 0.06,
                                  },
                                },
                              ],
                      })),
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            }),
          );
        }
        return originalFetch(url, { ...init, redirect: 'error' });
      };
    }, preflight);
    page = await application.firstWindow();
    await page.getByText('本地就绪', { exact: true }).waitFor();
    const call = (name, input) =>
      page
        .evaluate(({ name, input }) => window.classManager[name](input), { name, input })
        .then(value);
    if (preflight) await call('saveDeepSeekKey', { apiKey: 'sk-synthetic-live-preflight-key' });
    assert.equal((await call('getDeepSeekStatus')).configured, true);
    const base = { stepHundredths: 100 };
    const definition = {
      title: '合成普通题型人工金标准',
      precision: 0,
      maxHundredths: 1000,
      questions: [
        {
          ...base,
          id: 'single',
          label: '第 1 题',
          prompt: 'Page 1 Q1: read the handwritten selected letter.',
          kind: 'single_choice',
          maxHundredths: 100,
          options: ['A', 'B', 'C', 'D'],
          correct: 'B',
        },
        {
          ...base,
          id: 'multi',
          label: '第 2 题',
          prompt:
            'Page 1 Q2: read selected letters. One correct selection without an incorrect selection gets 1 point.',
          kind: 'multiple_choice',
          maxHundredths: 200,
          options: ['A', 'B', 'C', 'D'],
          correct: ['A', 'C'],
          partial: { mode: 'per_correct', hundredths: 100 },
        },
        {
          ...base,
          id: 'judge',
          label: '第 3 题',
          prompt: 'Page 1 Q3: read the written true/false answer.',
          kind: 'judgement',
          maxHundredths: 100,
          correct: ['true'],
          incorrect: ['false'],
        },
        {
          ...base,
          id: 'blank',
          label: '第 4 题',
          prompt: 'Page 2 Q4: read the SI unit of force.',
          kind: 'blank',
          maxHundredths: 200,
          accepted: ['Newton', 'N'],
          normalization: { ignoreCase: true, collapseWhitespace: true },
        },
        {
          ...base,
          id: 'short',
          label: '第 5 题',
          prompt: 'Page 2 Q5: read the three elements of a force.',
          kind: 'short_text',
          maxHundredths: 300,
          scoringPoints:
            'magnitude, direction, point of application; each element earns 1 point; all three earn 3 points.',
        },
        {
          ...base,
          id: 'manual',
          label: '第 6 题',
          prompt: 'Page 2 Q6: unsupported formula, retain manual review.',
          kind: 'manual',
          maxHundredths: 100,
          explanation: '公式不在普通题型支持范围，标为unsupported，由教师对照原图补评。',
        },
      ],
    };
    const rubric = await call('createRubric', {
      epoch,
      requestId: randomUUID(),
      scoreVersionId: seeded.score.versionId,
      subjectId: seeded.subjectId,
      definition,
    });
    const pages = [];
    for (const file of seeded.imageFiles) {
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, file);
      const preview = await call('previewMaterial', { epoch });
      const material = await call('confirmMaterial', {
        epoch,
        token: preview.token,
        requestId: randomUUID(),
      });
      pages.push({
        id: randomUUID(),
        role: 'student_answer',
        sourceVersionId: material.id,
        fragmentId: 1,
        rotation: 0,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        redactions: [{ x: 0, y: 0, width: 1, height: 0.07 }],
      });
    }
    const request = {
      examId: seeded.score.examId,
      scoreVersionId: seeded.score.versionId,
      subjectId: seeded.subjectId,
      studentId: seeded.studentId,
      rubricVersionId: rubric.id,
      pages,
      expectedAnswerPages: 2,
      selectedPageIds: pages.map((p) => p.id),
      selectedQuestionIds: definition.questions.map((q) => q.id),
      acknowledgeSyntheticOnly: true,
      acknowledgeBindingAndOrder: true,
      acknowledgePartial: false,
    };
    const draft = await call('createGrading', { epoch, requestId: randomUUID(), request });
    await page.getByRole('button', { name: '答卷建议与复核', exact: true }).click();
    await page.getByRole('button', { name: '刷新目录', exact: true }).waitFor();
    await page
      .getByRole('combobox', { name: '考试', exact: true })
      .selectOption(seeded.score.examId);
    await page.getByRole('button', { name: /合成阅卷甲.*草案/ }).click();
    await page.getByText(/已复核 0\/6 题/).waitFor();
    // Prepare after UI mount/read has finished; navigation cleanup can cancel earlier tokens.
    const prepared = await call('prepareGrading', {
      epoch,
      id: draft.id,
      expectedRevision: draft.revision,
      selectedPageIds: request.selectedPageIds,
      selectedQuestionIds: request.selectedQuestionIds,
      acknowledgeReplaceReviewed: false,
    });
    assert.equal(prepared.images.length, 2);
    assert.equal(prepared.missingAnswerPages, false);
    await application.evaluate(
      (_electron, expected) => {
        globalThis.__gradingLive.expectedImages = expected.images;
        globalThis.__gradingLive.expectedQuestionIds = expected.ids;
      },
      { images: prepared.images.map((p) => p.dataUrl), ids: prepared.questionIds },
    );
    // UI preparation would replace the reserved packet. Use the already inspected packet
    // through the same named generation API, then read it back in the teacher UI.
    report.wireHash = prepared.wireHash;
    report.pages = 2;
    report.questions = 6;
    report.draftId = draft.id;
    report.generationAttempted = !preflight;
    report.authorizationConsumed = !preflight;
    report.status = 'generating';
    save();
    const result = await page.evaluate((input) => window.classManager.generateGrading(input), {
      epoch,
      token: prepared.token,
      wireHash: prepared.wireHash,
      acknowledgeOutboundPreview: true,
    });
    report.requestCount = await application.evaluate(() => globalThis.__gradingLive.count);
    report.externalRequests = preflight ? 0 : report.requestCount;
    const attempts = await call('gradingAttempts', { epoch, id: draft.id });
    report.attemptStatus = attempts[0]?.record.status;
    report.provider = attempts[0]?.payload.provider ?? null;
    report.ledger = await call('getDeepSeekLedger');
    save();
    value(result);
    const view = await call('readGrading', { epoch, id: draft.id });
    assert.equal(view.record.status, 'draft');
    assert.equal(
      view.payload.rows.every((row) => !row.reviewed),
      true,
    );
    report.assessments = view.payload.rows.map((row, index) => ({
      questionId: row.questionId,
      answer: row.answer,
      scoreHundredths: row.scoreHundredths,
      status: row.status,
      expectedAnswer: seeded.gold.answers[index],
      goldHundredths: seeded.gold.scores[index] * 100,
      evidenceCount: row.evidence.length,
    }));
    report.supportedScoresMatchGold = view.payload.rows
      .slice(0, 5)
      .every((row, index) => row.scoreHundredths === seeded.gold.scores[index] * 100);
    // Compare recognition independently of awarded points; full short-text points alone
    // cannot establish that the image answer was read correctly.
    const normalizedAnswer = (answer) =>
      (answer ?? '')
        .toLowerCase()
        .replace(/\band\b/g, '')
        .replace(/[^a-z0-9]/g, '');
    report.supportedAnswersMatchGold = view.payload.rows.slice(0, 5).every((row, index) => {
      const answer = normalizedAnswer(row.answer);
      return (
        answer === normalizedAnswer(seeded.gold.answers[index]) || (index === 3 && answer === 'n')
      );
    });
    save();
    assert.equal(
      report.supportedAnswersMatchGold,
      true,
      'Recognized answers differ from human gold',
    );
    assert.equal(report.supportedScoresMatchGold, true, 'Supported answers differ from human gold');
    assert.equal(
      view.payload.rows[5].scoreHundredths,
      null,
      'unsupported formula must remain manual',
    );
    assert.equal(report.requestCount, 1);
    assert.equal(report.ledger.totalCalls, 1);
    assert.equal(report.ledger.successCalls, 1);
    assert.deepEqual(report.ledger.recentEntries[0].usage, report.provider.usage);
    assert.equal(
      (await call('readScoreVersion', { epoch, versionId: seeded.score.versionId })).stale,
      false,
    );
    await page.getByRole('button', { name: '重新读取答卷与尝试', exact: true }).click();
    await page.getByText(new RegExp(`修订 ${view.record.revision} · 已复核 0/6 题`)).waitFor();
    const uiRows = page.locator('.grading-table-wrap tbody tr');
    assert.equal(await uiRows.count(), 6);
    for (const [index, row] of view.payload.rows.entries()) {
      assert.equal(
        await uiRows.nth(index).locator('td').nth(1).locator('p').first().textContent(),
        row.answer ?? '无法判定',
      );
      assert.equal(
        await uiRows.nth(index).locator('td').nth(2).textContent(),
        row.scoreHundredths === null ? '待人工' : String(row.scoreHundredths / 100),
      );
    }
    await page.getByText(/本批建议已保存.*6 题 \/ 2 页 · Token/).waitFor();
    report.teacherUiMatchesStoredResult = true;
    await page
      .locator('.grading-table-wrap')
      .screenshot({ path: join(output, 'live-suggestions.png') });
    report.status = 'passed';
    report.completedAt = new Date().toISOString();
    save();
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : 'Live audit failed';
    if (application)
      report.requestCount = await application
        .evaluate(() => globalThis.__gradingLive?.count ?? 0)
        .catch(() => report.requestCount);
    report.externalRequests = preflight ? 0 : report.requestCount;
    save();
    throw error;
  } finally {
    try {
      await closeAuditApplication(application, () => {
        // Only these two task-owned copies are deleted, after resolving containment.
        for (const path of [credentialDirectory, localContext]) {
          const child = relative(root, resolve(path));
          assert.ok(
            child && !child.startsWith('..') && !isAbsolute(child),
            'Cleanup path leaves audit root',
          );
        }
        rmSync(credentialDirectory, { recursive: true, force: true });
        rmSync(localContext, { force: true });
        if (!report.generationAttempted) release();
      });
      if (originalHashes) {
        assert.deepEqual(
          names.map((name) => hash(join(source, name))),
          originalHashes,
        );
        assert.equal(hash(originalContext), contextHash);
        report.originalCredentialsUnchanged = true;
        report.temporaryCredentialsRemoved = true;
      }
    } catch (error) {
      report.status = 'failed';
      report.cleanupError = error instanceof Error ? error.message : 'Cleanup failed';
      process.exitCode = 1;
    } finally {
      report.temporaryCredentialsRemoved = !existsSync(credentialDirectory);
      report.temporaryContextRemoved = !existsSync(localContext);
      report.completedAt = new Date().toISOString();
      save();
    }
  }
  console.log('Single-request grading live audit:', reportPath);
}
