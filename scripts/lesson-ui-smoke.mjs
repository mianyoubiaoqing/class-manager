import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { syntheticPdf } from '../tests/fixtures/material-pdf.ts';
import { recordAuditIpcResults } from './ipc-receipt-probe.mjs';

// Real Electron, preload, handlers, decoder child and database. Only native file selection
// and provider transport are synthetic; no request can reach the provider.
const output = resolve('output/playwright/lessons');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-'));
const { local, executablePath } = isolatedElectronRuntime('lesson-ui-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'user-data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
let application;
let page;
let calls = 0;
let epoch;
let versionId;
const options = {
  executablePath: process.env.CLASS_MANAGER_LESSON_EXECUTABLE ?? executablePath,
  args: process.env.CLASS_MANAGER_LESSON_EXECUTABLE ? [] : ['.'],
  cwd: process.cwd(),
  env,
  timeout: 45000,
};
const launch = async () => {
  application = await electron.launch(options);
  await application.evaluate(() => {
    globalThis.__lessonSmoke = { calls: 0, mode: 'success', wires: [] };
    globalThis.fetch = async (_url, init) => {
      const fixture = globalThis.__lessonSmoke;
      fixture.calls++;
      const body = JSON.parse(init.body);
      fixture.wires.push(body);
      if (fixture.mode === 'offline') throw new TypeError('Synthetic offline transport');
      const wire = JSON.parse(body.messages[1].content[0].text);
      const textSource = wire.sources.find((source) =>
        source.fragments.some((fragment) => fragment.kind === 'text'),
      );
      const ref = {
        sourceVersionId: textSource.sourceVersionId,
        fragmentId: textSource.fragments.find((fragment) => fragment.kind === 'text').id,
      };
      const block = {
        kind: 'paragraph',
        text: '力有大小、方向和作用点。',
        origin: { kind: 'source', citations: [{ ...ref, quote: '力有大小、方向和作用点。' }] },
      };
      const answer = { kind: 'paragraph', text: 'PRIVATE_ANSWER', origin: { kind: 'supplement' } };
      const content = {
        formatVersion: 1,
        title: wire.request.topic,
        objectives: [block],
        keyPoints: [block],
        difficulties: [block],
        sections: [
          {
            id: 'intro',
            title: '引入',
            durationMinutes: wire.request.durationMinutes,
            content: [block],
            questions: [],
            answers: [answer],
            teacherNotes: 'PRIVATE_NOTE',
          },
        ],
        slides: [
          {
            id: 'slide1',
            sectionId: 'intro',
            title: wire.request.topic,
            content: [block],
            answers: [answer],
            teacherNotes: 'PRIVATE_SLIDE_NOTE',
          },
        ],
      };
      const response = new Response(
        JSON.stringify({
          id: 'synthetic-lesson-ui',
          model: 'synthetic',
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify(fixture.mode === 'invalid' ? {} : content) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
        { status: 200 },
      );
      if (fixture.mode === 'pending')
        return new Promise((resolve) => {
          fixture.release = () => resolve(response);
        });
      return response;
    };
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await openWorkspacePage(page, '教师备课', '资料备课');
};
const button = (name) => page.getByRole('button', { name, exact: true });
const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor();
const importFile = async (name, bytes) => {
  const path = join(root, name);
  writeFileSync(path, bytes);
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, path);
  await page.getByRole('button', { name: '选择资料文件', exact: true }).click();
  try {
    await button('确认保存资料').waitFor();
  } catch (error) {
    console.log('Import failed:', name, await page.locator('.lesson-page').innerText());
    throw error;
  }
  if (name.endsWith('.pdf')) await page.locator('.lesson-page').getByText(/PDF/).first().waitFor();
  assert.equal(await application.evaluate(() => globalThis.__lessonSmoke.calls), 0);
  await button('确认保存资料').click();
  await status('资料版本已保存');
};
const prepare = async () => {
  await button('准备并核对外发范围').click();
  await page.getByText('确认一次模型生成', { exact: true }).waitFor();
};
const generate = async () => {
  await prepare();
  await page
    .getByLabel('我确认以上合成资料范围，并同意本次调用产生费用。', { exact: true })
    .check();
  await button('确认付费生成草案').click();
};
try {
  await launch();
  const snapshot = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(snapshot.ok, true);
  epoch = snapshot.value.epoch;
  await importFile(
    'PRIVATE_SOURCE.txt',
    Buffer.from('力有大小、方向和作用点。'.padEnd(8000, 'x') + '\nUNSELECTED_PRIVATE_TEXT'),
  );
  const materials = await page.evaluate((input) => window.classManager.listMaterials(input), {
    epoch,
  });
  const txtId = materials.value[0].record.id;
  const zip = new JSZip();
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成 DOCX</w:t></w:r></w:p></w:body></w:document>',
  );
  await importFile('synthetic.docx', await zip.generateAsync({ type: 'nodebuffer' }));
  await importFile('synthetic.pdf', syntheticPdf([{ text: 'Synthetic PDF' }]));
  await page.locator('.lesson-comparison img').waitFor();
  await page.screenshot({ path: join(root, 'pdf-comparison-desktop.png'), fullPage: true });
  const png = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: '#224477' },
  })
    .png()
    .toBuffer();
  await importFile('synthetic.png', png);
  await page.locator('.lesson-fragment-list input').first().check();
  await importFile('synthetic.jpg', await sharp(png).jpeg().toBuffer());
  await page.getByLabel('已保存资料', { exact: true }).selectOption(txtId);
  await page.locator('.lesson-fragment-list input').first().check();
  await button('新建备课任务').click();
  await page.getByLabel('课题', { exact: true }).fill('力的三要素');
  assert.equal(
    (
      await page.evaluate((input) => window.classManager.saveDeepSeekKey(input), {
        apiKey: 'synthetic-lesson-ui-key',
      })
    ).ok,
    true,
  );
  await prepare();
  assert.equal(await button('确认付费生成草案').isDisabled(), true);
  await button('取消范围准备').click();
  await generate();
  await status('备课草案已保存');
  assert.equal(await page.getByLabel('教案标题', { exact: true }).inputValue(), '力的三要素');
  assert.equal(
    await page
      .locator('section.lesson-history')
      .evaluate((el) => getComputedStyle(el).display === 'flex'),
    false,
    'Lesson history must stack its editor and exports, not wrap whole sections into a toolbar',
  );
  const wires = await application.evaluate(() => globalThis.__lessonSmoke.wires);
  assert.doesNotMatch(
    JSON.stringify(wires),
    /UNSELECTED_PRIVATE_TEXT|PRIVATE_SOURCE|PRIVATE_NOTE|originalAssetId|sha256/,
  );
  assert.equal(wires[0].messages[1].content.filter((part) => part.type === 'image_url').length, 1);
  await prepare();
  assert.equal(await page.getByLabel('教案标题', { exact: true }).isDisabled(), true);
  await button('取消范围准备').click();
  await page.getByLabel('教案标题', { exact: true }).fill('教师修订标题');
  assert.equal(await button('冻结备课版本').isDisabled(), true);
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '班主任管理', exact: true })
    .click();
  await page.locator('.navigation-feedback').waitFor();
  assert.equal(await page.getByLabel('教案标题', { exact: true }).inputValue(), '教师修订标题');
  // Hold the actual Main readback after a successful save, then verify the editor stays locked.
  await application.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('cm:readLessonDraft');
    globalThis.__lessonReadback = { original, started: false, release: null };
    ipcMain.removeHandler('cm:readLessonDraft');
    ipcMain.handle('cm:readLessonDraft', async (event, input) => {
      const result = await original(event, input);
      globalThis.__lessonReadback.started = true;
      await new Promise((resolve) => {
        globalThis.__lessonReadback.release = resolve;
      });
      return result;
    });
  });
  await button('保存教师修改').click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="教案标题"]').matches(':disabled'),
  );
  await application.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!globalThis.__lessonReadback.started) {
      if (Date.now() > deadline) throw new Error('readback not started');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  assert.equal(await button('保存教师修改').isDisabled(), true);
  await application.evaluate(({ ipcMain }) => {
    const fixture = globalThis.__lessonReadback;
    ipcMain.removeHandler('cm:readLessonDraft');
    ipcMain.handle('cm:readLessonDraft', fixture.original);
    fixture.release();
  });
  await status('教师修改已保存');
  assert.equal(await page.getByLabel('教案标题', { exact: true }).inputValue(), '教师修订标题');
  await button('冻结备课版本').click();
  assert.equal(await page.getByLabel('教案标题', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('已保存备课草案').isDisabled(), true);
  await page.getByLabel('冻结原因').fill('合成教师复核通过');
  await button('确认冻结').click();
  await status('备课版本已冻结');
  const drafts = await page.evaluate((input) => window.classManager.listLessonDrafts(input), {
    epoch,
    includeClosed: true,
  });
  const id = drafts.value[0].record.id;
  const history = await page.evaluate((input) => window.classManager.lessonHistory(input), {
    epoch,
    id,
  });
  versionId = history.value[0].id;
  const frozen = await page.evaluate((input) => window.classManager.readLessonVersion(input), {
    epoch,
    versionId,
  });
  assert.equal(frozen.value.payload.content.title, '教师修订标题');
  await button('冻结版 1 · 合成教师复核通过').click();
  await button('基于此冻结版创建修订草案').click();
  await status('已创建本地修订草案');
  assert.equal(await application.evaluate(() => globalThis.__lessonSmoke.calls), 1);
  await page.getByLabel('教案标题', { exact: true }).fill('第二版教师修订');
  await button('保存教师修改').click();
  await status('教师修改已保存');
  await page.screenshot({ path: join(root, 'lesson-editor-desktop.png'), fullPage: true });
  await page.getByLabel('教案标题', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, 'lesson-editor-desktop-viewport.png') });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: join(root, 'lesson-editor-360.png'), fullPage: true });
  await page.getByLabel('教案标题', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, 'lesson-editor-360-viewport.png') });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'lesson page overflows at 360px',
  );
  await page.setViewportSize({ width: 1240, height: 820 });
  await application.evaluate(() => {
    globalThis.__lessonSmoke.mode = 'offline';
  });
  await generate();
  await page
    .getByRole('alert')
    .filter({ hasText: /连接失败/ })
    .waitFor();
  assert.equal(await page.getByLabel('教案标题', { exact: true }).inputValue(), '第二版教师修订');
  assert.equal(await application.evaluate(() => globalThis.__lessonSmoke.calls), 2);
  await application.evaluate(() => {
    globalThis.__lessonSmoke.mode = 'invalid';
  });
  await generate();
  await page
    .getByRole('alert')
    .filter({ hasText: /格式|结构|输入不符合要求/ })
    .waitFor();
  assert.equal(await page.getByLabel('教案标题', { exact: true }).inputValue(), '第二版教师修订');
  await application.evaluate(() => {
    globalThis.__lessonSmoke.mode = 'pending';
  });
  await recordAuditIpcResults(application, '__lessonCancellationResults', [
    'generateLesson',
    'cancelLesson',
  ]);
  await generate();
  await application.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!globalThis.__lessonSmoke.release) {
      if (Date.now() > deadline) throw new Error('pending transport not started');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  await button('取消当前解析或生成').click();
  await application.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (
      !globalThis.__lessonCancellationResults.some((r) => r.method === 'cancelLesson' && r.ok)
    ) {
      if (Date.now() > deadline) throw Error('Main cancellation did not complete');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  await application.evaluate(() => globalThis.__lessonSmoke.release());
  await button('取消当前解析或生成').waitFor({ state: 'detached' });
  const cancellation = await application.evaluate(() => globalThis.__lessonCancellationResults);
  console.log(
    JSON.stringify({
      cancellation,
      notices: await page.locator('[role="alert"], [role="status"]').allTextContents(),
    }),
  );
  assert.ok(
    cancellation.some((r) => r.method === 'generateLesson' && !r.ok && r.code === 'ABORTED'),
  );
  assert.match((await page.locator('.lesson-page > .notice').allTextContents()).join(' '), /取消/);
  assert.equal(await page.getByLabel('教案标题', { exact: true }).inputValue(), '第二版教师修订');
  calls = await application.evaluate(() => globalThis.__lessonSmoke.calls);
  assert.equal(calls, 4);
  await page.evaluate(() => window.classManager.deleteDeepSeekKey());
  await application.close();
  application = undefined;
  await launch();
  const after = await page.evaluate((input) => window.classManager.readLessonVersion(input), {
    epoch,
    versionId,
  });
  assert.deepEqual(after, frozen);
  const reopened = await page.evaluate((input) => window.classManager.listLessonDrafts(input), {
    epoch,
    includeClosed: true,
  });
  assert.equal(reopened.value.length, 2);
  const revisionDraft = reopened.value.find((value) => value.record.status === 'draft');
  await page.getByLabel('已保存备课草案').selectOption(revisionDraft.record.id);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="教案标题"]')?.value === '第二版教师修订',
  );
  assert.equal(await application.evaluate(() => globalThis.__lessonSmoke.calls), 0);
  assert.deepEqual(errors, []);
  writeFileSync(
    join(root, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        formats: ['txt', 'docx', 'pdf', 'png', 'jpg'],
        provider: 'synthetic transport',
        externalRequests: 0,
        syntheticCalls: calls,
        runtime: await application.evaluate(() => ({
          electron: process.versions.electron,
          node: process.versions.node,
          executablePath: process.execPath,
        })),
        cancelledLateOutput: true,
        readbackLock: true,
        confirmationLock: true,
        modelPreparationLock: true,
        frozenReopen: true,
        narrowViewport: 360,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Lesson Electron UI passed:', root);
} finally {
  if (application && page) {
    console.log('Final UI notices:', await page.getByRole('alert').allTextContents());
    await page.screenshot({ path: join(root, 'final-state.png'), fullPage: true }).catch(() => {});
  }
  await application?.close();
}
