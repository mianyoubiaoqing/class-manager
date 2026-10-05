import { nodeBundleOptions } from './node-bundle-options.ts';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { build } from 'esbuild';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';

// Full offline UI/preload/Main/SQLite/Office child flow. Only file selection, overwrite response
// and shell-open are captured. No key is configured and all attempted network calls are blocked.
const output = resolve('output/playwright/office');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-'));
const userData = join(root, 'user-data');
await build(
  nodeBundleOptions({
    entryPoints: ['tests/fixtures/office-runtime.ts'],
    outfile: join(root, 'fixture.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
  }),
);
const { seedOfficeWorkspace } = createRequire(import.meta.url)(join(root, 'fixture.cjs'));
const seeded = await seedOfficeWorkspace(join(userData, 'workspace-data'));
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: userData };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CLASS_MANAGER_LESSON_EXECUTABLE) {
  delete env.Path;
  env.PATH = join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
}
const report = { status: 'running', seeded, networkRequests: 0, files: [], errors: [] };
let application;
try {
  application = await electron.launch({
    executablePath: process.env.CLASS_MANAGER_LESSON_EXECUTABLE ?? electronPath,
    args: process.env.CLASS_MANAGER_LESSON_EXECUTABLE ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  await application.evaluate(({ dialog, shell }) => {
    globalThis.__officeAudit = {
      path: null,
      overwrite: false,
      network: 0,
      opened: [],
      selections: 0,
      confirms: 0,
    };
    globalThis.fetch = async () => {
      globalThis.__officeAudit.network++;
      throw new Error('Offline export cannot use network');
    };
    dialog.showSaveDialog = async () => {
      const audit = globalThis.__officeAudit;
      audit.selections++;
      return audit.path ? { canceled: false, filePath: audit.path } : { canceled: true };
    };
    dialog.showMessageBox = async () => {
      const audit = globalThis.__officeAudit;
      audit.confirms++;
      return { response: audit.overwrite ? 1 : 0 };
    };
    shell.openPath = async (path) => {
      globalThis.__officeAudit.opened.push(path);
      return '';
    };
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await button('资料备课').click();
  assert.equal(
    (await page.evaluate(() => window.classManager.getDeepSeekStatus())).value.configured,
    false,
  );
  await page.getByLabel('已保存备课草案', { exact: true }).selectOption(seeded.draftId);
  await button('冻结版 1 · Office 导出合成验收').click();
  await page.getByRole('region', { name: '冻结版本 Office 导出', exact: true }).waitFor();
  assert.equal(await button('保存可编辑 Word 教案').isEnabled(), true);
  assert.equal(await page.getByLabel('明确包含参考答案（课件画布将可见）').isChecked(), false);
  await button('保存可编辑 Word 教案').click();
  await page.getByRole('status').filter({ hasText: '已取消保存' }).waitFor();
  for (const format of ['docx', 'pptx']) {
    const path = join(root, `ui-default.${format}`);
    await application.evaluate((_electron, path) => {
      globalThis.__officeAudit.path = path;
    }, path);
    await button(format === 'docx' ? '保存可编辑 Word 教案' : '保存可编辑 PPTX 课件').click();
    await page
      .getByRole('status')
      .filter({ hasText: `已保存 ui-default.${format}` })
      .waitFor();
    const bytes = readFileSync(path);
    const zip = await JSZip.loadAsync(bytes);
    const xml = (
      await Promise.all(
        Object.keys(zip.files)
          .filter((name) => name.endsWith('.xml'))
          .map((name) => zip.file(name).async('string')),
      )
    ).join('');
    assert.ok(xml.includes(seeded.versionId));
    assert.ok(!xml.includes(seeded.latestVersionId));
    assert.ok(!xml.includes('较新版本标题不得混入首版导出'));
    assert.ok(xml.includes(seeded.contentHash));
    assert.doesNotMatch(xml, /TEACHER_/);
    assert.ok(xml.includes(format === 'docx' ? '<w:tbl>' : '<a:tbl>'));
    report.files.push({
      format,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentHash: seeded.contentHash,
    });
    await button('打开刚保存的文件').click();
    await page.getByRole('status').filter({ hasText: '已请求本机办公软件' }).waitFor();
  }
  const oldPath = join(root, 'preserve.docx');
  writeFileSync(oldPath, 'old teacher file');
  await application.evaluate((_electron, path) => {
    globalThis.__officeAudit.path = path;
  }, oldPath);
  await button('保存可编辑 Word 教案').click();
  await page.getByRole('status').filter({ hasText: '已取消保存' }).waitFor();
  assert.equal(readFileSync(oldPath, 'utf8'), 'old teacher file');
  await application.evaluate(() => {
    globalThis.__officeAudit.overwrite = true;
  });
  await button('保存可编辑 Word 教案').click();
  await page.getByRole('status').filter({ hasText: '已保存 preserve.docx' }).waitFor();
  assert.notEqual(readFileSync(oldPath, 'utf8'), 'old teacher file');
  await page.getByLabel('明确包含参考答案（课件画布将可见）').check();
  await page.getByLabel('明确包含教师私有备注（Word 正文／PPTX 演讲者备注）').check();
  const privatePath = join(root, 'ui-explicit.pptx');
  await application.evaluate((_electron, path) => {
    globalThis.__officeAudit.path = path;
  }, privatePath);
  await button('保存可编辑 PPTX 课件').click();
  await page.getByRole('status').filter({ hasText: '已保存 ui-explicit.pptx' }).waitFor();
  const explicit = await JSZip.loadAsync(readFileSync(privatePath));
  const slides = (
    await Promise.all(
      Object.keys(explicit.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
        .map((name) => explicit.file(name).async('string')),
    )
  ).join('');
  const notes = (
    await Promise.all(
      Object.keys(explicit.files)
        .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name))
        .map((name) => explicit.file(name).async('string')),
    )
  ).join('');
  assert.match(slides, /TEACHER_SLIDE_ANSWER/);
  assert.doesNotMatch(slides, /TEACHER_SLIDE_NOTE/);
  assert.match(notes, /TEACHER_SLIDE_NOTE/);
  await page.screenshot({ path: join(root, 'office-desktop.png'), fullPage: true });
  await page
    .getByRole('region', { name: '冻结版本 Office 导出', exact: true })
    .screenshot({ path: join(root, 'office-export-desktop.png') });
  await page.setViewportSize({ width: 360, height: 760 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.screenshot({ path: join(root, 'office-narrow.png'), fullPage: true });
  await page
    .getByRole('region', { name: '冻结版本 Office 导出', exact: true })
    .screenshot({ path: join(root, 'office-export-narrow.png') });
  const audit = await application.evaluate(() => globalThis.__officeAudit);
  report.networkRequests = audit.network;
  assert.equal(audit.network, 0);
  assert.equal(audit.opened.length, 2);
  assert.equal(audit.confirms, 2);
  const unchanged = await page.evaluate((input) => window.classManager.readLessonVersion(input), {
    epoch: seeded.epoch,
    versionId: seeded.versionId,
  });
  assert.equal(
    createHash('sha256').update(JSON.stringify(unchanged.value.payload.content)).digest('hex'),
    seeded.contentHash,
  );
  assert.equal(
    readdirSync(root).some((name) => name.endsWith('.cmexport-tmp')),
    false,
  );
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errors.push(String(error));
  throw error;
} finally {
  if (application) await application.close();
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }, null, 2));
}
