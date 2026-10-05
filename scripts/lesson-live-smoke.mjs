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
import sharp from 'sharp';
import { closeAuditApplication, reservePaidAudit, writeAuditReport } from './live-audit-guards.ts';

const sample =
  '合成教材：力有大小、方向和作用点。改变其中一个要素，力的作用效果可能改变。图像是合成示意图，不是实际实验照片。';
const instructions =
  '合成接口验收：只生成一个10分钟环节和一张课件，每项内容简短。文字依据可逐字引用；图片仅作示意，不声称完成文字识别。教师备注和参考答案独立填写。';
if (process.argv.includes('--dry-run')) {
  console.log(
    JSON.stringify(
      {
        status: 'dry-run',
        credentialReads: 0,
        externalRequests: 0,
        topic: '合成力的三要素',
        selectedText: sample,
        image: 'one synthetic 320×180 PNG',
        instructions,
        model: 'deepseek-flash',
        maxOutputTokens: 16384,
        deadlineSeconds: 60,
        paidRequests: 1,
        retries: 0,
      },
      null,
      2,
    ),
  );
} else {
  // This opt-in is set only after explicit fresh authorization; never part of npm check.
  assert.ok(
    process.argv.includes('--allow-one-paid-request'),
    'Fresh paid-request authorization required',
  );
  assert.ok(process.env.CLASS_MANAGER_LIVE_CREDENTIALS, 'Explicit credential directory required');
  assert.ok(process.env.CLASS_MANAGER_LESSON_EXECUTABLE, 'Explicit audited executable required');
  const output = resolve('output/live-lesson');
  mkdirSync(output, { recursive: true });
  const release = reservePaidAudit(join(output, 'paid-run.lock'));
  const reportPath = join(output, 'report.json');
  assert.equal(
    existsSync(reportPath),
    false,
    'Preserve prior evidence; any repeat requires new authorization',
  );
  const root = mkdtempSync(join(output, 'isolated-'));
  const source = resolve(process.env.CLASS_MANAGER_LIVE_CREDENTIALS);
  const credentialDirectory = join(root, 'credentials');
  mkdirSync(credentialDirectory);
  const names = ['deepseek.enc', 'deepseek.meta.json'];
  const originalContext = join(source, '..', 'Local State');
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  let originalHashes;
  let contextHash;
  const report = {
    status: 'preparing',
    startedAt: new Date().toISOString(),
    generationAttempted: false,
    requestCount: 0,
    syntheticDataOnly: true,
    dataDirectory: root,
    executablePath: resolve(process.env.CLASS_MANAGER_LESSON_EXECUTABLE),
  };
  const save = () => writeAuditReport(reportPath, report);
  const value = (result) => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
  };
  let application;
  let page;
  try {
    originalHashes = names.map((name) => hash(join(source, name)));
    contextHash = hash(originalContext);
    const context = JSON.parse(readFileSync(originalContext, 'utf8')).os_crypt;
    assert.ok(context?.encrypted_key, 'Missing encryption context');
    writeFileSync(join(root, 'Local State'), JSON.stringify({ os_crypt: context }));
    for (const name of names) copyFileSync(join(source, name), join(credentialDirectory, name));
    const env = { ...process.env, CLASS_MANAGER_DATA_DIR: root };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      executablePath: report.executablePath,
      args: [],
      cwd: process.cwd(),
      env,
      timeout: 45000,
    });
    await application.evaluate(
      (_electron, expected) => {
        const actualFetch = globalThis.fetch;
        globalThis.__lessonLiveRequests = 0;
        globalThis.fetch = async (url, options) => {
          if (String(url) !== 'https://api.deepseek.com/chat/completions')
            throw new Error('Unexpected endpoint');
          const body = JSON.parse(options.body);
          if (
            body.model !== 'deepseek-flash' ||
            body.max_tokens !== 16384 ||
            body.messages.length !== 2 ||
            body.response_format?.type !== 'json_object'
          )
            throw new Error('Unexpected protocol');
          const parts = body.messages[1].content;
          const wire = JSON.parse(parts[0].text);
          const texts = wire.sources.flatMap((source) =>
            source.fragments
              .filter((fragment) => fragment.kind === 'text')
              .map((fragment) => fragment.text),
          );
          if (
            texts.length !== 1 ||
            texts[0] !== expected.sample ||
            wire.request.topic !== '合成力的三要素' ||
            wire.request.instructions !== expected.instructions ||
            wire.request.selection.length !== 2
          )
            throw new Error('Unexpected outbound selection');
          const images = parts.filter((part) => part.type === 'image_url');
          if (
            images.length !== 1 ||
            !/^data:image\/jpeg;base64,/.test(images[0].image_url.url) ||
            images[0].image_url.url.length > 200000
          )
            throw new Error('Unexpected image');
          if (/originalAssetId|sha256|PRIVATE|filename|file:\/\//.test(JSON.stringify(wire)))
            throw new Error('Unexpected private data');
          if (globalThis.__lessonLiveRequests !== 0)
            throw new Error('Only one real request authorized');
          globalThis.__lessonLiveRequests++;
          return actualFetch(url, { ...options, redirect: 'error' });
        };
      },
      { sample, instructions },
    );
    page = await application.firstWindow();
    await page.getByText('本地就绪', { exact: true }).waitFor();
    const snapshot = value(await page.evaluate(() => window.classManager.snapshot()));
    const epoch = snapshot.epoch;
    assert.equal(
      value(await page.evaluate(() => window.classManager.getDeepSeekStatus())).configured,
      true,
    );
    const textPath = join(root, 'synthetic.txt');
    writeFileSync(textPath, sample);
    const imagePath = join(root, 'synthetic.png');
    writeFileSync(
      imagePath,
      await sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="white"/><rect x="40" y="70" width="60" height="60" fill="#224477"/><path d="M100 100 H260 M230 80 L260 100 L230 120" stroke="#cc3344" stroke-width="8" fill="none"/></svg>',
        ),
      )
        .png()
        .toBuffer(),
    );
    const selection = [];
    for (const path of [textPath, imagePath]) {
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, path);
      const preview = value(
        await page.evaluate((input) => window.classManager.previewMaterial(input), { epoch }),
      );
      const stored = value(
        await page.evaluate((input) => window.classManager.confirmMaterial(input), {
          epoch,
          token: preview.token,
          requestId: randomUUID(),
        }),
      );
      selection.push({ sourceVersionId: stored.id, fragmentId: 1 });
    }
    const request = {
      topic: '合成力的三要素',
      subject: '物理',
      grade: '高中',
      durationMinutes: 10,
      instructions,
      acknowledgePartial: false,
      selection,
    };
    const prepared = value(
      await page.evaluate((input) => window.classManager.prepareLesson(input), { epoch, request }),
    );
    report.outbound = {
      request,
      text: sample,
      images: prepared.images,
      textCharacters: prepared.textCharacters,
      inputHash: prepared.inputHash,
    };
    report.generationAttempted = true;
    report.status = 'requesting';
    save(); // Durable ambiguity guard before the IPC which can initiate payment.
    const generated = await page.evaluate((input) => window.classManager.generateLesson(input), {
      epoch,
      token: prepared.token,
    });
    report.requestCount = await application.evaluate(() => globalThis.__lessonLiveRequests);
    report.ledger = value(await page.evaluate(() => window.classManager.getDeepSeekLedger()));
    report.generation = generated;
    save();
    const receipt = value(generated);
    const draft = value(
      await page.evaluate((input) => window.classManager.readLessonDraft(input), {
        epoch,
        id: receipt.id,
      }),
    );
    report.provider = draft.payload.provider;
    report.original = draft.payload.original;
    assert.equal(report.requestCount, 1);
    assert.equal(report.ledger.totalCalls, 1);
    assert.equal(report.ledger.successCalls, 1);
    assert.deepEqual(report.ledger.recentEntries[0].usage, draft.payload.provider.usage);
    assert.equal(report.ledger.recentEntries[0].responseId, draft.payload.provider.responseId);
    await page.getByRole('button', { name: '资料备课', exact: true }).click();
    await page.getByLabel('已保存备课草案').selectOption(receipt.id);
    await page.getByLabel('教案标题', { exact: true }).fill('合成真实生成 · 教师复核');
    await page.getByRole('button', { name: '保存教师修改', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '教师修改已保存' }).waitFor();
    const edited = value(
      await page.evaluate((input) => window.classManager.readLessonDraft(input), {
        epoch,
        id: receipt.id,
      }),
    );
    assert.equal(edited.payload.content.title, '合成真实生成 · 教师复核');
    assert.equal(edited.record.revision, draft.record.revision + 1);
    assert.equal(edited.record.status, 'draft');
    assert.deepEqual(edited.payload.original, draft.payload.original);
    await page.getByRole('button', { name: '冻结备课版本', exact: true }).click();
    await page.getByLabel('冻结原因').fill('合成样本真实接口验证；非正式教学评价');
    await page.getByRole('button', { name: '确认冻结', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '备课版本已冻结' }).waitFor();
    const history = value(
      await page.evaluate((input) => window.classManager.lessonHistory(input), {
        epoch,
        id: receipt.id,
      }),
    );
    const frozenInput = { epoch, versionId: history[0].id };
    const frozen = value(
      await page.evaluate((input) => window.classManager.readLessonVersion(input), frozenInput),
    );
    assert.deepEqual(frozen.payload.original, draft.payload.original);
    assert.deepEqual(frozen.payload.content, edited.payload.content);
    assert.equal(history.length, 1);
    assert.equal(frozen.record.revision, 1);
    const closed = value(
      await page.evaluate((input) => window.classManager.readLessonDraft(input), {
        epoch,
        id: receipt.id,
      }),
    );
    assert.equal(closed.record.status, 'frozen');
    assert.equal(closed.record.revision, edited.record.revision + 1);
    await page.getByLabel('教案标题', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, 'live-draft.png') });
    await closeAuditApplication(application, () => {
      for (const name of names) rmSync(join(credentialDirectory, name), { force: true });
      rmSync(join(root, 'Local State'), { force: true });
    });
    application = undefined;
    application = await electron.launch({
      executablePath: report.executablePath,
      args: [],
      cwd: process.cwd(),
      env,
      timeout: 45000,
    });
    await application.evaluate(() => {
      globalThis.fetch = async () => {
        throw new Error('Reopen forbids all network');
      };
    });
    page = await application.firstWindow();
    await page.getByText('本地就绪', { exact: true }).waitFor();
    assert.equal(
      value(await page.evaluate(() => window.classManager.getDeepSeekStatus())).configured,
      false,
    );
    assert.deepEqual(
      value(
        await page.evaluate((input) => window.classManager.readLessonVersion(input), frozenInput),
      ),
      frozen,
    );
    report.frozenVersionId = history[0].id;
    report.teacherEditSaved = true;
    report.frozenReopenWithoutCredentials = true;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : 'Unknown failure';
    if (application) {
      report.requestCount = Math.max(
        report.requestCount,
        await application
          .evaluate(() => globalThis.__lessonLiveRequests ?? 0)
          .catch(() => report.requestCount),
      );
    }
    process.exitCode = 1;
  } finally {
    try {
      await closeAuditApplication(application, () => {
        for (const name of names) rmSync(join(credentialDirectory, name), { force: true });
        rmSync(join(root, 'Local State'), { force: true });
      });
    } catch {
      report.closeFailed = true;
      report.status = 'failed';
      process.exitCode = 1;
    }
    report.copiedCredentialsRemoved = names.every(
      (name) => !existsSync(join(credentialDirectory, name)),
    );
    report.copiedEncryptionContextRemoved = !existsSync(join(root, 'Local State'));
    try {
      report.originalCredentialsUnchanged =
        originalHashes && contextHash
          ? names.every((name, index) => hash(join(source, name)) === originalHashes[index]) &&
            hash(originalContext) === contextHash
          : null;
    } catch {
      report.originalCredentialsUnchanged = false;
    }
    if (report.originalCredentialsUnchanged === false) {
      report.status = 'failed';
      process.exitCode = 1;
    }
    report.completedAt = new Date().toISOString();
    save();
    if (!report.generationAttempted) release();
  }
  console.log(
    JSON.stringify(
      {
        status: report.status,
        requestCount: report.requestCount,
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
}
