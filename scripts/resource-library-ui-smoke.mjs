import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
const output = resolve('output/playwright/resource-library');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'cm-resource-ui-')),
  runtime = isolatedElectronRuntime('resource-ui-'),
  packaged = process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE;
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'data'),
  TEMP: join(runtime.local, 'temp'),
  TMP: join(runtime.local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
let application, page;
const errors = [],
  checks = [];
async function launch() {
  application = await electron.launch({
    executablePath: packaged ?? runtime.executablePath,
    args: packaged ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
}
const call = (method, input) =>
  page.evaluate(
    async ({ method, input }) => {
      const result = await window.classManager[method](input);
      if (!result.ok) throw Error(result.error.code + ': ' + result.error.message);
      return result.value;
    },
    { method, input },
  );
const chooseFiles = (paths) =>
  application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, paths);
const saveFile = (path) =>
  application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, path);
async function openTeaching() {
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '教师备课', exact: true })
    .click();
  await page.getByRole('region', { name: '学科教学资源库', exact: true }).waitFor();
}
try {
  await launch();
  await openTeaching();
  let library = page.getByRole('region', { name: '学科教学资源库', exact: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: join(output, 'library-home.png'), fullPage: true });
  const disciplines = [
    ['思想政治', '政治认同'],
    ['语文', '语言建构'],
    ['数学', '数学抽象'],
    ['英语', '语言能力'],
    ['历史', '唯物史观'],
    ['地理', '人地协调观'],
    ['物理', '物理观念'],
    ['化学', '宏观辨识'],
    ['生物', '生命观念'],
    ['日语', '日语交流'],
  ];
  for (const [name, expected] of disciplines) {
    await library.getByRole('button', { name, exact: true }).click();
    await library.locator('.rl-book').first().click();
    await library.getByRole('button', { name: '课件', exact: true }).click();
    await library.getByLabel('课件内容', { exact: true }).waitFor();
    await library.getByRole('button', { name: '教学设计', exact: true }).click();
    await library.getByLabel('教学设计内容', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea')?.value.length > 0);
    assert.ok(
      (await library.getByLabel('教学设计内容', { exact: true }).inputValue()).includes(expected),
      name,
    );
    await library.getByRole('button', { name: '复习资料', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('textarea')?.value.includes('自测与答案'),
    );
  }
  checks.push('all ten subjects load subject-specific templates and resource tabs');
  await library.getByRole('button', { name: '数学', exact: true }).click();
  await library.getByLabel('教材版本', { exact: true }).selectOption({ index: 1 });
  await library.getByText('此版本暂沿用客户提供的通用目录', { exact: false }).waitFor();
  await library.getByLabel('教材版本', { exact: true }).selectOption({ index: 0 });
  await library.getByLabel('搜索框题或知识点', { exact: true }).fill('集合');
  await library.locator('.rl-search-results>button').first().click();
  await library.getByRole('button', { name: '教学设计', exact: true }).click();
  const editor = library.getByLabel('教学设计内容', { exact: true }),
    custom = '合成数学教学设计\n观察集合实例，记录学生反馈。';
  await editor.fill(custom);
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '班主任管理', exact: true })
    .click();
  assert.equal(await library.count(), 1);
  await page.getByText('先完成教学资源库中的当前操作', { exact: true }).waitFor();
  await library.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByText('已保存到本机，备份会包含此内容。', { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), custom, 'saved editor must retain custom content');
  checks.push('chapter search and unsaved navigation protection');
  const folder = join(root, '备课 资料');
  mkdirSync(folder);
  mkdirSync(join(folder, '子目录'));
  writeFileSync(join(folder, '集合实例.txt'), '集合示例：自然数集合与学生名单。');
  writeFileSync(join(folder, '子目录', '图表资料.txt'), '合成图表资料');
  writeFileSync(join(folder, '不能执行.js'), 'throw Error("must not run")');
  await chooseFiles([join(folder, '集合实例.txt')]);
  await library.getByRole('button', { name: '添加本地文件', exact: true }).click();
  await library.getByRole('button', { name: '📄 集合实例.txt', exact: true }).waitFor();
  await chooseFiles([folder]);
  await library.getByRole('button', { name: '读取文件夹', exact: true }).click();
  const folderDialog = page.getByRole('dialog', { name: '读取文件夹 · 备课 资料', exact: true });
  await folderDialog.getByLabel('包含子文件夹', { exact: true }).check();
  await folderDialog.getByText('子目录\\图表资料.txt', { exact: false }).waitFor();
  await folderDialog
    .locator('label')
    .filter({ hasText: '图表资料.txt' })
    .getByRole('checkbox')
    .check();
  await folderDialog.getByRole('button', { name: '读取并保存 1 份文件', exact: true }).click();
  await folderDialog.waitFor({ state: 'hidden' });
  assert.equal(await library.locator('.rl-files li').count(), 2);
  checks.push(
    'native file chooser and folder scan copy real files; unsupported scripts cannot be selected',
  );
  await application.evaluate(({ shell }) => {
    globalThis.__resourceOpened = [];
    shell.openPath = async (path) => {
      globalThis.__resourceOpened.push(path);
      return '';
    };
    shell.openExternal = async (url) => {
      globalThis.__resourceOpened.push(url);
    };
  });
  await library.getByRole('button', { name: '📄 集合实例.txt', exact: true }).click();
  for (let i = 0; i < 100; i++) {
    if ((await application.evaluate(() => globalThis.__resourceOpened)).length) break;
    await page.waitForTimeout(50);
  }
  let opened = await application.evaluate(() => globalThis.__resourceOpened);
  assert.equal(readFileSync(opened[0], 'utf8'), '集合示例：自然数集合与学生名单。');
  await library.getByRole('button', { name: '添加链接', exact: true }).click();
  const link = page.getByRole('dialog', { name: '添加网页资料', exact: true });
  await link.getByLabel('资料名称', { exact: true }).fill('合成教材参考');
  await link.getByLabel('HTTPS 地址', { exact: true }).fill('https://www.zxx.edu.cn/');
  await link.getByRole('button', { name: '保存链接', exact: true }).click();
  await link.waitFor({ state: 'hidden' });
  await library.getByRole('button', { name: '🔗 合成教材参考', exact: true }).click();
  for (let i = 0; i < 100; i++) {
    if (
      (await application.evaluate(() => globalThis.__resourceOpened)).includes(
        'https://www.zxx.edu.cn/',
      )
    )
      break;
    await page.waitForTimeout(50);
  }
  opened = await application.evaluate(() => globalThis.__resourceOpened);
  assert.ok(opened.includes('https://www.zxx.edu.cn/'));
  checks.push('open verified file copy and saved HTTPS reference through native handlers');
  const docx = join(root, '集合教学设计.docx');
  await saveFile(docx);
  await library.getByRole('button', { name: '导出 Word（.docx）', exact: true }).click();
  await library.getByText('Word 已导出：', { exact: false }).waitFor();
  const zip = await JSZip.loadAsync(readFileSync(docx)),
    xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('记录学生反馈'));
  assert.ok(!xml.includes('<w:tbl>'));
  checks.push('actual DOCX export contains edited text as paragraphs');
  const previewPromise = application.waitForEvent('window');
  await library.getByRole('button', { name: '打印预览', exact: true }).click();
  const preview = await previewPromise;
  await preview.waitForLoadState();
  assert.ok((await preview.locator('body').innerText()).includes('记录学生反馈'));
  await preview.close();
  checks.push('native script-free print preview shows the current edited resource');
  const backup = join(root, '资源库.cmbackup');
  await saveFile(backup);
  assert.ok(await call('saveBackup', { epoch: (await call('snapshot')).epoch }));
  await editor.fill('合成暂时修改');
  await library.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByText('已保存到本机，备份会包含此内容。', { exact: true }).waitFor();
  await application.close();
  application = undefined;
  await launch();
  await openTeaching();
  library = page.getByRole('region', { name: '学科教学资源库', exact: true });
  await chooseFiles([backup]);
  const restore = await call('previewRestore');
  const old = await call('snapshot');
  await call('commitRestore', { epoch: old.epoch, token: restore.token });
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  await library.getByRole('button', { name: '数学', exact: true }).click();
  await library.getByLabel('搜索框题或知识点', { exact: true }).fill('集合');
  await library.locator('.rl-search-results>button').first().click();
  await library.getByRole('button', { name: '教学设计', exact: true }).click();
  await page.waitForFunction(
    (value) => document.querySelector('textarea')?.value === value,
    custom,
  );
  assert.equal(await library.locator('.rl-files li').count(), 3);
  checks.push('restart and backup restore preserve resource text, files and references');
  await page.screenshot({ path: join(output, 'library-detail.png'), fullPage: true });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.screenshot({ path: join(output, 'library-900.png'), fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
  );
  checks.push('resource library responsive layout');
  assert.deepEqual(errors, []);
  const result = { root, checks, errors, docx };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-8000));
  }
  throw error;
} finally {
  await application
    ?.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows().slice(1)) window.destroy();
    })
    .catch(() => {});
  await application?.close();
}
