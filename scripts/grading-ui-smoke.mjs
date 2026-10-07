import { nodeBundleOptions } from './node-bundle-options.ts';
import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { build } from 'esbuild';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

// Actual Electron, preload, handlers, SQLite worker and image child. Only dialogs
// and provider transport are synthetic; this script never uses an existing credential.
const output = resolve('output/playwright/grading');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-')),
  userData = join(root, 'user-data');
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
const seed = await seedGradingWorkspace(join(userData, 'workspace-data'), root);
const { local, executablePath } = isolatedElectronRuntime('grading-audit-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: userData,
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.CLASS_MANAGER_GRADING_EXECUTABLE;
if (executable) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`;
}
const report = {
  status: 'running',
  externalRequests: 0,
  syntheticCalls: 0,
  gates: [],
  errors: [],
  runtime: null,
};
let application, page, draftId, frozen, revisionId;
const button = (name) => page.getByRole('button', { name, exact: true });
const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor();
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const call = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input }).then(value);
const read = () => call('readGrading', { epoch: seed.epoch, id: draftId });
const snapshot = async (name) =>
  writeFileSync(join(root, `${name}.yml`), await page.locator('.grading-workspace').ariaSnapshot());
const screenshot = async (name) =>
  page.screenshot({ path: join(root, `${name}.png`), fullPage: true });
const launch = async () => {
  application = await electron.launch({
    executablePath: executable ?? executablePath,
    args: executable ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  report.runtime = await application.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node,
    executablePath: process.execPath,
  }));
  await application.evaluate(() => {
    globalThis.__gradingSmoke = { calls: 0, mode: 'success', wires: [] };
    globalThis.fetch = async (_url, init) => {
      const fixture = globalThis.__gradingSmoke;
      fixture.calls++;
      const body = JSON.parse(init.body);
      fixture.wires.push(body);
      if (fixture.mode === 'offline') throw new TypeError('Synthetic offline provider');
      const wire = JSON.parse(body.messages[1].content[0].text);
      const answers = [
        'B',
        'A',
        'true',
        'Newton',
        'magnitude, direction, point of application',
        '',
      ];
      const assessments = wire.questions.map((q) => {
        const n = Number(q.label.match(/\d+/)[0]) - 1;
        const answerPage = wire.pages.find((p) => p.role === 'student_answer');
        const evidence =
          q.kind === 'manual'
            ? []
            : [
                {
                  pageId: answerPage.pageId,
                  rectangle: { x: 0.08, y: 0.22 + (n % 3) * 0.23, width: 0.85, height: 0.06 },
                },
              ];
        return {
          questionId: q.id,
          state: q.kind === 'manual' ? 'unsupported' : 'readable',
          answer: q.kind === 'manual' ? null : answers[n],
          suggestedHundredths: q.kind === 'short_text' ? 300 : null,
          reason: q.kind === 'manual' ? '合成公式须人工补评' : '合成可核对作答',
          evidence,
          confidence: null,
        };
      });
      const response = new Response(
        JSON.stringify({
          id: 'synthetic-grading-ui',
          model: 'synthetic',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify(
                  fixture.mode === 'invalid' ? {} : { formatVersion: 1, assessments },
                ),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
      if (fixture.mode === 'pending')
        return new Promise((resolve) => {
          fixture.release = () => resolve(response);
        });
      return response;
    };
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await button('答卷建议与复核').click();
  await button('刷新目录').waitFor();
};
const importPage = async (file) => {
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await button('导入合成图像 / PDF').click();
  await button('确认保存材料').waitFor();
  await button('确认保存材料').click();
  await status('合成材料已保存');
  await button('加入答卷').click();
  await snapshot(`page-${file.endsWith('1.png') ? 1 : 2}-added`);
  await button('读取原图').click();
  await page.getByRole('img', { name: '当前答卷原图预览', exact: true }).waitFor();
  await page
    .getByRole('img', { name: '原图遮盖', exact: true })
    .waitFor({ state: 'attached' })
    .catch(() => {});
  const details = page
    .locator('.grading-page-transform details')
    .filter({ hasText: '遮盖身份信息' });
  if (!(await details.evaluate((element) => element.open)))
    await details.locator('summary').click();
  await details.getByRole('spinbutton', { name: '原图遮盖height', exact: true }).fill('7');
  await details.getByRole('button', { name: '使用此区域', exact: true }).click();
  await page.getByText('遮盖身份信息（1 个区域）', { exact: true }).waitFor();
};
const prepare = async () => {
  await button('准备本批实际外发预览').click();
  await page.getByRole('heading', { name: /实际外发范围/ }).waitFor();
  await snapshot('outbound');
  assert.equal(await button('生成本批建议一次').isDisabled(), true);
  return page
    .locator('.grading-outbound img')
    .evaluateAll((images) => images.map((image) => image.src));
};
const generate = async () => {
  const images = await prepare();
  await page
    .getByRole('checkbox', {
      name: '已核对实际外发图和细则，同意本次云处理（可能计费）',
      exact: true,
    })
    .check();
  await button('生成本批建议一次').click();
  return images;
};
const reviewRow = async (index) => {
  const row = page.locator('.grading-table-wrap tbody tr').nth(index);
  await row.getByRole('button', { name: '核对 / 补评', exact: true }).click();
  await snapshot(`review-${index + 1}`);
  if (index === 5)
    await page.getByRole('combobox', { name: '依据页面', exact: true }).selectOption({ index: 1 });
  await button('对照原图').click();
  await button('读取处理后图像 / 定位依据').click();
  await page.getByRole('img', { name: '作答依据', exact: true }).waitFor();
  const editor = page.locator('.grading-question-editor');
  if (index === 5) {
    await page.getByRole('spinbutton', { name: '作答依据y', exact: true }).fill('65');
    await page.getByRole('spinbutton', { name: '作答依据height', exact: true }).fill('10');
    await page.getByRole('spinbutton', { name: '作答依据width', exact: true }).fill('90');
    await editor.getByRole('button', { name: '使用此区域', exact: true }).click();
  }
  await page
    .getByRole('textbox', { name: '核对后的作答', exact: true })
    .fill(seed.gold.answers[index]);
  await page
    .getByRole('textbox', { name: '教师评分', exact: true })
    .fill(String(seed.gold.scores[index]));
  await page
    .getByRole('textbox', { name: '可核对的评分依据', exact: true })
    .fill(`合成人工依据：第 ${index + 1} 题，对照自制答卷及评分细则。`);
  const check = page.getByRole('checkbox', {
    name: '已对照原图核对本题作答、对应关系、分值和依据',
    exact: true,
  });
  await check.check();
  if (index === 0) {
    await page
      .getByRole('textbox', { name: '可核对的评分依据', exact: true })
      .fill('第 1 题原图为 B，与细则一致。');
    assert.equal(await check.isChecked(), false);
    assert.equal(await button('保存本题复核').isDisabled(), true);
    await check.check();
    report.gates.push('editing resets teacher acknowledgement');
  }
  await button('保存本题复核').click();
  await status('本题人工复核已保存');
  assert.equal((await read()).payload.rows[index].reviewed, true);
};
try {
  await launch();
  assert.equal((await call('getDeepSeekStatus')).configured, false);
  await page.getByRole('combobox', { name: '考试', exact: true }).selectOption(seed.score.examId);
  await page.getByRole('combobox', { name: '科目', exact: true }).selectOption(seed.subjectId);
  await page.getByRole('combobox', { name: '学生', exact: true }).selectOption(seed.studentId);
  await snapshot('binding');
  await button('新建细则版本').click();
  const types = ['single_choice', 'multiple_choice', 'judgement', 'blank', 'short_text', 'manual'];
  const points = [1, 2, 1, 2, 3, 1];
  for (let i = 0; i < 6; i++) {
    if (i) await button('添加评分条目').click();
    const field = page.locator('.grading-rule').nth(i);
    await field.getByRole('textbox', { name: '显示题号', exact: true }).fill(`第 ${i + 1} 题`);
    await field.getByRole('combobox', { name: '题型', exact: true }).selectOption(types[i]);
    await field.getByRole('textbox', { name: '满分', exact: true }).fill(String(points[i]));
    await field
      .getByRole('textbox', { name: '题干 / 对应内容', exact: true })
      .fill(`Q${i + 1}：自制答卷普通题型，依人工评分细则核对。`);
    if (i === 0)
      await field.getByRole('textbox', { name: '正确选项（多选每行一个）', exact: true }).fill('B');
    if (i === 1) {
      await field
        .getByRole('textbox', { name: '正确选项（多选每行一个）', exact: true })
        .fill('A\nC');
      await field
        .getByRole('combobox', { name: '无错漏选规则', exact: true })
        .selectOption('per_correct');
    }
    if (i === 2) {
      await field
        .getByRole('textbox', { name: '正确作答形式（每行一个）', exact: true })
        .fill('true');
      await field
        .getByRole('textbox', { name: '错误作答形式（每行一个）', exact: true })
        .fill('false');
    }
    if (i === 3) {
      await field
        .getByRole('textbox', { name: '可接受答案（每行一个）', exact: true })
        .fill('Newton\nN');
      await field.getByRole('checkbox', { name: '忽略大小写', exact: true }).check();
    }
    if (i === 4)
      await field
        .getByRole('textbox', { name: '评分要点', exact: true })
        .fill('magnitude, direction, point of application; each element 1 point.');
    if (i === 5)
      await field
        .getByRole('textbox', { name: '人工评分要求 / 不支持原因', exact: true })
        .fill('手写公式超出普通题型范围，教师对照原图补评。');
  }
  await screenshot('rubric');
  await button('保存细则版本').click();
  await status('评分细则已保存为新版本');
  await importPage(seed.imageFiles[0]);
  await importPage(seed.imageFiles[1]);
  await page.getByRole('spinbutton', { name: '预计学生答卷页数', exact: true }).fill('2');
  await page.getByRole('checkbox', { name: '确认仅为合成材料', exact: true }).check();
  await page
    .getByRole('checkbox', { name: '已核对考试、科目、学生、角色、页序和细则版本', exact: true })
    .check();
  await button('保存答卷输入').click();
  await status('答卷输入已保存');
  const directory = await call('listGradings', { epoch: seed.epoch, examId: seed.score.examId });
  draftId = directory[0].record.id;
  const initial = await read();
  assert.equal(initial.payload.rows.length, 6);
  assert.equal(
    initial.payload.rows.every((r) => r.scoreHundredths === null),
    true,
  );
  assert.equal(await button('确认冻结复核').isDisabled(), true);
  await call('saveDeepSeekKey', { apiKey: 'sk-synthetic-grading-ui-key' });
  for (let i = 3; i < 6; i++) await page.locator('.grading-questions input').nth(i).uncheck();
  await page.locator('.grading-page-list input[type=checkbox]').nth(1).uncheck();
  const firstImages = await generate();
  await status('本批建议已保存');
  let wires = await application.evaluate(() => globalThis.__gradingSmoke.wires);
  const firstWire = JSON.parse(wires[0].messages[1].content[0].text);
  assert.equal(firstWire.questions.length, 3);
  assert.equal(firstWire.pages.length, 1);
  assert.deepEqual(
    wires[0].messages[1].content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url),
    firstImages,
  );
  assert.doesNotMatch(
    JSON.stringify(wires),
    /PRIVATE_SYNTHETIC|SYNTHETIC_GOLD|合成阅卷甲|sourceVersionId|originalAssetId/,
  );
  const jpeg = Buffer.from(firstImages[0].split(',')[1], 'base64');
  const pixel = await sharp(jpeg)
    .extract({ left: 400, top: 20, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.equal(
    [...pixel].every((channel) => channel < 10),
    true,
    'identity area must actually be black',
  );
  assert.deepEqual(
    (await read()).payload.rows.slice(0, 3).map((r) => r.scoreHundredths),
    [100, 100, 100],
  );
  assert.equal(
    (await read()).payload.rows.slice(3).every((r) => r.scoreHundredths === null),
    true,
  );
  await reviewRow(0);
  await reviewRow(1);
  await reviewRow(2);
  report.gates.push(
    'complete rubric via teacher forms',
    'real pixels redacted',
    'preview bytes equal synthetic transport',
    'local objective scoring and pending peer questions',
  );
  for (let i = 0; i < 3; i++) await page.locator('.grading-questions input').nth(i).uncheck();
  for (let i = 3; i < 6; i++) await page.locator('.grading-questions input').nth(i).check();
  await page.locator('.grading-page-list input[type=checkbox]').nth(0).uncheck();
  await page.locator('.grading-page-list input[type=checkbox]').nth(1).check();
  await generate();
  await status('本批建议已保存');
  assert.equal(
    (await read()).payload.rows.slice(0, 3).every((r) => r.reviewed),
    true,
  );
  assert.equal((await read()).payload.rows[5].scoreHundredths, null);
  assert.equal(await button('确认冻结复核').isDisabled(), true);
  await reviewRow(3);
  await reviewRow(4);
  await reviewRow(5);
  await snapshot('all-reviewed');
  await screenshot('all-reviewed');
  await page.getByRole('textbox', { name: '复核说明', exact: true }).fill('合成人工金标准完整复核');
  await page
    .getByRole('checkbox', { name: '已核对完整答卷及逐题分数，同意冻结本次复核', exact: true })
    .check();
  await button('确认冻结复核').click();
  await status('完整复核已冻结');
  frozen = await read();
  assert.equal(frozen.record.status, 'frozen');
  assert.deepEqual(
    frozen.payload.rows.map((r) => r.scoreHundredths),
    seed.gold.scores.map((n) => n * 100),
  );
  assert.equal(
    frozen.payload.rows.reduce((sum, r) => sum + r.scoreHundredths, 0),
    seed.gold.total * 100,
  );
  await screenshot('frozen');
  await button('查看原图依据').first().click();
  await button('对照原图').click();
  await button('读取处理后图像 / 定位依据').click();
  await page.getByRole('img', { name: '作答依据', exact: true }).waitFor();
  await screenshot('frozen-evidence');
  await button('关闭依据查看').click();
  await page.getByRole('button', { name: /修订 \d+ · 冻结复核/ }).click();
  await page.getByText(/以下作答与图像均来自此修订/).waitFor();
  await button('查看原图依据').first().click();
  await button('对照原图').click();
  await button('读取处理后图像 / 定位依据').click();
  await page.getByRole('img', { name: '作答依据', exact: true }).waitFor();
  await page
    .locator('.grading-question-editor')
    .screenshot({ path: join(root, 'history-evidence.png') });
  assert.equal(await page.getByRole('textbox', { name: '教师评分', exact: true }).count(), 0);
  await button('关闭依据查看').click();
  await button('返回当前答卷').click();
  await button('从此冻结复核创建修订草案').click();
  await status('已准备修订答卷设置');
  await page.getByRole('checkbox', { name: '确认仅为合成材料', exact: true }).check();
  await page
    .getByRole('checkbox', { name: '已核对考试、科目、学生、角色、页序和细则版本', exact: true })
    .check();
  await button('保存答卷输入').click();
  await status('答卷输入已保存');
  const revisionDirectory = await call('listGradings', {
    epoch: seed.epoch,
    examId: seed.score.examId,
  });
  revisionId = revisionDirectory[0].record.id;
  assert.notEqual(revisionId, draftId);
  const originalId = draftId;
  draftId = revisionId;
  assert.equal((await read()).record.baseReviewId, frozen.reviewId);
  assert.deepEqual(await call('readGrading', { epoch: seed.epoch, id: originalId }), frozen);
  report.gates.push(
    'all six questions manually reviewed',
    'freeze matches human gold',
    'frozen image evidence remains readable',
    'revision preserves immutable parent',
  );
  // A failed related read must not switch the visible draft or discard its context.
  await application.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers,
      original = handlers.get('cm:readRubric');
    handlers.set('cm:readRubric', async () => {
      handlers.set('cm:readRubric', original);
      return {
        ok: false,
        error: {
          code: 'GRADING_INVALID',
          message: '合成历史细则读取失败',
          operationId: 'synthetic-read-failure',
        },
      };
    });
  });
  await page.getByRole('button', { name: /合成阅卷甲.*已冻结复核/ }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '合成历史细则读取失败（GRADING_INVALID · synthetic-read-failure）' })
    .waitFor();
  await page.getByRole('heading', { name: '逐题建议与人工复核', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '已冻结复核', exact: true }).count(), 0);
  report.gates.push('failed related read preserves prior draft and structured error');
  await page.setViewportSize({ width: 360, height: 800 });
  await snapshot('narrow');
  await screenshot('narrow');
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('.grading-workspace *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 25)
      .map((el) => ({
        tag: el.tagName,
        className: el.className,
        text: el.textContent.slice(0, 60),
        right: el.getBoundingClientRect().right,
      })),
  }));
  writeFileSync(join(root, 'narrow-layout.json'), JSON.stringify(layout, null, 2));
  assert.equal(layout.scroll <= layout.width, true, 'grading UI overflows at 360px');
  await page.setViewportSize({ width: 1240, height: 820 });
  await prepare();
  await application.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers,
      original = handlers.get('cm:cancelGrading');
    handlers.set('cm:cancelGrading', async () => {
      handlers.set('cm:cancelGrading', original);
      throw Error('Synthetic IPC rejection');
    });
  });
  await button('放弃本次外发').click();
  await page.getByRole('alert').filter({ hasText: '取消响应中断' }).waitFor();
  report.gates.push('IPC cancellation rejection is handled without unhandled promise');
  const preservedRevisionRows = (await read()).payload.rows;
  assert.equal(
    preservedRevisionRows.every((row) => !row.reviewed),
    true,
    'revision must clear all review acknowledgements',
  );
  for (const mode of ['offline', 'invalid', 'pending']) {
    await application.evaluate((_electron, mode) => {
      globalThis.__gradingSmoke.mode = mode;
    }, mode);
    await generate();
    if (mode === 'pending') {
      await application.evaluate(async () => {
        const deadline = Date.now() + 5000;
        while (!globalThis.__gradingSmoke.release) {
          if (Date.now() > deadline) throw Error('pending transport not started');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });
      await button('取消准备或生成').click();
      await application.evaluate(() => globalThis.__gradingSmoke.release());
    }
    await page.getByRole('alert').waitFor();
    await button('重新读取答卷与尝试').click();
    await button('重新读取答卷与尝试').waitFor({ state: 'visible' });
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent.trim() === '重新读取答卷与尝试',
        ).disabled,
    );
    assert.deepEqual((await read()).payload.rows, preservedRevisionRows);
    assert.equal((await read()).record.status, 'draft');
  }
  report.syntheticCalls = await application.evaluate(() => globalThis.__gradingSmoke.calls);
  assert.equal(report.syntheticCalls, 5);
  const attempts = await call('gradingAttempts', { epoch: seed.epoch, id: revisionId });
  assert.deepEqual(attempts.map((a) => a.record.status).sort(), ['cancelled', 'failed', 'failed']);
  report.gates.push(
    'narrow viewport 360px',
    'offline and invalid output preserve input',
    'cancel rejects late success and does not retry',
  );
  // Exercise persisted transforms and source invalidation through actual controls,
  // without another provider call. The frozen parent must keep its original evidence.
  await page
    .locator('.grading-page-list li')
    .first()
    .getByRole('button', { name: /^第 1 页/ })
    .click();
  await button('读取原图').click();
  const cropDetails = page
    .locator('.grading-page-transform details')
    .filter({ hasText: '裁剪范围' });
  if (!(await cropDetails.evaluate((element) => element.open)))
    await cropDetails.locator('summary').click();
  await cropDetails.getByRole('spinbutton', { name: '原图裁剪width', exact: true }).fill('80');
  await cropDetails.getByRole('spinbutton', { name: '原图裁剪height', exact: true }).fill('90');
  await cropDetails.getByRole('button', { name: '使用此区域', exact: true }).click();
  await page.getByRole('combobox', { name: '顺时针旋转', exact: true }).selectOption('90');
  await page
    .getByRole('combobox', { name: '第1页角色', exact: true })
    .selectOption('question_material');
  await page
    .locator('.grading-page-list li')
    .first()
    .getByRole('button', { name: '下移', exact: true })
    .click();
  await page.getByRole('spinbutton', { name: '预计学生答卷页数', exact: true }).fill('1');
  await page.getByRole('checkbox', { name: '确认仅为合成材料', exact: true }).check();
  await page
    .getByRole('checkbox', { name: '已核对考试、科目、学生、角色、页序和细则版本', exact: true })
    .check();
  await button('确认重新绑定（变化将清除审核）').click();
  await status('答卷依据已重新绑定');
  const transformed = await read();
  assert.deepEqual(
    transformed.payload.request.pages.map((p) => p.sourceVersionId),
    [...initial.payload.request.pages].reverse().map((p) => p.sourceVersionId),
  );
  assert.equal(transformed.payload.request.pages[1].role, 'question_material');
  assert.equal(transformed.payload.request.pages[1].rotation, 90);
  assert.deepEqual(transformed.payload.request.pages[1].crop, {
    x: 0,
    y: 0,
    width: 0.8,
    height: 0.9,
  });
  assert.equal(
    transformed.payload.rows.every((row) => row.scoreHundredths === null && !row.reviewed),
    true,
  );
  for (const input of await page.locator('.grading-page-list input[type=checkbox]').all())
    await input.check();
  const transformedImages = await prepare();
  const metadata = await sharp(
    Buffer.from(transformedImages[1].split(',')[1], 'base64'),
  ).metadata();
  assert.deepEqual([metadata.width, metadata.height], [900, 640]);
  await page
    .locator('.grading-outbound')
    .screenshot({ path: join(root, 'transformed-outbound.png') });
  await button('放弃本次外发').click();
  await status('已请求取消');
  assert.deepEqual(await call('readGrading', { epoch: seed.epoch, id: originalId }), frozen);
  assert.equal(await application.evaluate(() => globalThis.__gradingSmoke.calls), 5);
  report.gates.push(
    'UI crop rotation role order persist and reset suggestions without changing frozen parent',
  );
  await call('deleteDeepSeekKey');
  await application.close();
  application = undefined;
  await launch();
  assert.equal((await call('getDeepSeekStatus')).configured, false);
  await page.getByRole('combobox', { name: '考试', exact: true }).selectOption(seed.score.examId);
  await page.getByRole('button', { name: /合成阅卷甲.*已冻结复核/ }).click();
  await page.getByText(/冻结复核总分 9/).waitFor();
  assert.deepEqual(await call('readGrading', { epoch: seed.epoch, id: originalId }), frozen);
  assert.equal(await application.evaluate(() => globalThis.__gradingSmoke.calls), 0);
  const currentScores = await call('readScoreVersion', {
    epoch: seed.epoch,
    versionId: seed.score.versionId,
  });
  assert.equal(currentScores.stale, false);
  report.gates.push(
    'reopen without credentials preserves frozen review',
    'no formal score version created',
  );
  const backupPath = join(root, 'synthetic-grading.cmbackup');
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, backupPath);
  await call('saveBackup', { epoch: seed.epoch });
  const restore = await call('previewRestore');
  assert.equal(restore.gradingDraftCount, 2);
  assert.equal(restore.gradingReviewCount, 1);
  assert.equal(restore.gradingAttemptCount, 5);
  const oldEpoch = seed.epoch;
  seed.epoch = (await call('commitRestore', { epoch: oldEpoch, token: restore.token })).epoch;
  assert.notEqual(seed.epoch, oldEpoch);
  const stale = await page.evaluate((input) => window.classManager.readGrading(input), {
    epoch: oldEpoch,
    id: originalId,
  });
  assert.equal(stale.ok, false);
  assert.deepEqual(await call('readGrading', { epoch: seed.epoch, id: originalId }), frozen);
  await application.close();
  application = undefined;
  await launch();
  await page.getByRole('combobox', { name: '考试', exact: true }).selectOption(seed.score.examId);
  await page.getByRole('button', { name: /合成阅卷甲.*已冻结复核/ }).click();
  await page.getByText(/冻结复核总分 9/).waitFor();
  report.gates.push(
    'actual current-schema backup restore preserves all reviews, attempts and history',
    'restore rejects old epoch and reopens current UI',
  );
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
  console.log('Grading Electron UI passed:', root);
} catch (error) {
  report.status = 'failed';
  report.failure = String(error?.stack ?? error);
  throw error;
} finally {
  if (application && page) {
    if (report.status === 'failed')
      report.syntheticCalls = await application
        .evaluate(() => globalThis.__gradingSmoke.calls)
        .catch(() => report.syntheticCalls);
    await snapshot('final').catch(() => {});
    await screenshot('final').catch(() => {});
    console.log(
      'Final grading notices:',
      await page
        .getByRole('alert')
        .allTextContents()
        .catch(() => []),
    );
  }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  await application?.close();
}
