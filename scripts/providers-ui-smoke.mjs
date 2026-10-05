import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

const parent = resolve('output/playwright/providers');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const executable = process.env.CLASS_MANAGER_PROVIDERS_EXECUTABLE;
const localBase = join(process.env.USERPROFILE, 'ClassManagerSetupChecks');
mkdirSync(localBase, { recursive: true });
const local = mkdtempSync(join(localBase, 'providers-modern-'));
mkdirSync(join(local, 'temp'));
const runtime = executable ?? join(local, 'runtime', 'electron.exe');
if (!executable) cpSync(resolve(electronPath, '..'), join(local, 'runtime'), { recursive: true });
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'user-data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
if (executable) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`;
}
const report = {
  status: 'running',
  root,
  packaged: !!executable,
  externalRequests: 0,
  errors: [],
  gates: [],
};
let app, page;
const unwrap = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.value;
};
const raw = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input });
const call = (name, input) => raw(name, input).then(unwrap);
const button = (name) => page.getByRole('button', { name, exact: true });
const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor();
async function assertUnsavedNavigationProtected() {
  const destination = page.getByRole('navigation', { name: '主导航' }).getByRole('button', {
    name: '班主任管理',
    exact: true,
  });
  assert.equal(await destination.isDisabled(), false);
  await destination.click();
  await page.locator('.navigation-feedback').waitFor();
  assert.equal(await page.locator('h1').innerText(), '模型设置');
}
async function settled() {
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].find((b) => b.textContent === '刷新模型设置')
        ?.disabled,
  );
}
async function launch() {
  app = await electron.launch({
    executablePath: runtime,
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
    globalThis.__providerAudit = { calls: [], mode: 'success', externalRequests: 0 };
    globalThis.fetch = async (url, init) => {
      const fixture = globalThis.__providerAudit;
      const body = JSON.parse(init.body);
      const provider = url.startsWith('https://api.moonshot.cn/')
        ? 'kimi'
        : url.startsWith('https://ark.cn-beijing.volces.com/')
          ? 'doubao'
          : url === 'https://api.deepseek.com/chat/completions'
            ? 'deepseek'
            : undefined;
      if (
        !provider ||
        init.headers.Authorization !== `Bearer sk-synthetic-${provider}-audit-only`
      ) {
        fixture.externalRequests++;
        throw Error('Unexpected fixture endpoint or credential');
      }
      fixture.calls.push({ provider, body: init.body, url });
      if (fixture.mode === 'pending') return new Promise(() => {});
      if (fixture.mode === 'invalid') return new Response('{invalid');
      if (fixture.mode === 'server') return new Response('{}', { status: 503 });
      return new Response(
        JSON.stringify({
          id: 'synthetic-check',
          model: body.model,
          choices: [{ message: { content: 'Synthetic fixture success' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
        }),
      );
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
}
try {
  await launch();
  await openWorkspacePage(page, '班主任管理', '班级名册');
  await button('载入合成样例').click();
  await button('确认载入').click();
  await status('合成样例已保存');
  const snapshot = await call('snapshot');
  assert.equal(snapshot.schemaVersion, 12);
  const surface = await page.evaluate(() => ({
    keys: Object.keys(window.classManager),
    frozen: Object.isFrozen(window.classManager),
    require: typeof window.require,
    process: typeof window.process,
  }));
  assert.equal(surface.keys.length, 148);
  assert.equal(surface.frozen, true);
  assert.equal(surface.require, 'undefined');
  assert.equal(surface.process, 'undefined');
  await openWorkspacePage(page, '系统设置', '模型设置');
  await settled();
  await page.getByText('高级模型设置', { exact: true }).click();
  const selection = page.getByLabel('编辑供应商', { exact: true });
  const key = page.getByLabel('供应商 API Key', { exact: true });
  const textModel = page.getByLabel('文本模型 / Endpoint ID', { exact: true });
  const visionModel = page.getByLabel('图像模型 / Endpoint ID', { exact: true });
  for (const provider of ['kimi', 'doubao', 'deepseek']) {
    await page.getByRole('tab', { name: '账号与模型', exact: true }).click();
    await selection.selectOption(provider);
    if (provider === 'doubao') {
      await textModel.fill('ep-synthetic-text');
      await assertUnsavedNavigationProtected();
      await visionModel.fill('ep-synthetic-vision');
      await button('保存供应商型号').click();
      await status('供应商型号已本地保存');
    }
    await key.fill(`sk-synthetic-${provider}-audit-only`);
    await assertUnsavedNavigationProtected();
    await button('保存供应商Key').click();
    await status('供应商Key已本地加密保存');
    await button('使用此供应商').click();
    await status('当前模型供应商已切换');
    assert.equal((await call('readModelSettings')).selectedProvider, provider);
    await page.getByRole('tab', { name: '连接检查', exact: true }).click();
    for (const type of ['text', 'vision']) {
      const before = await app.evaluate(() => globalThis.__providerAudit.calls.length);
      await button(type === 'text' ? '预览文本检查外发' : '预览图像检查外发').click();
      await button('确认本次检查外发').waitFor();
      assert.equal(await button('确认本次检查外发').isDisabled(), true);
      assert.equal(await app.evaluate(() => globalThis.__providerAudit.calls.length), before);
      const body = await page.locator('pre').innerText();
      assert.doesNotMatch(body, /sk-synthetic/);
      await page
        .getByRole('checkbox', {
          name: '我已核对实际外发内容，明确确认本次可能付费检查',
          exact: true,
        })
        .check();
      await button('确认本次检查外发').click();
      await status('接口连通性检查完成。');
      assert.equal(await app.evaluate(() => globalThis.__providerAudit.calls.length), before + 1);
      assert.equal(await app.evaluate(() => globalThis.__providerAudit.calls.at(-1).body), body);
    }
    await page.getByRole('tab', { name: '用量记录', exact: true }).click();
    await button('读取此供应商用量').click();
    await page
      .getByText(`${provider} · 调用 2 · 已知Token 20（缺失用量不计入合计）`, { exact: true })
      .waitFor();
  }
  report.gates.push(
    '3 providers save/select without automatic fetch; exact confirmed text/vision preview once; 3 encrypted keys and isolated ledgers',
  );
  await page.getByRole('tab', { name: '账号与模型', exact: true }).click();
  await selection.selectOption('kimi');
  await button('使用此供应商').click();
  await status('当前模型供应商已切换');
  const settings = await call('readModelSettings');
  const prepared = await call('prepareModelCheck', {
    type: 'text',
    expectedRevision: settings.revision,
  });
  const rejected = await raw('checkModelProvider', {
    token: prepared.token,
    revision: prepared.revision,
    wireHash: prepared.wireHash,
    acknowledgeOutboundPreview: false,
  });
  assert.equal(rejected.error.code, 'VALIDATION');
  await call('cancelModelCheck');
  await page.getByRole('tab', { name: '连接检查', exact: true }).click();
  for (const mode of ['server', 'invalid', 'pending']) {
    await app.evaluate((_electron, mode) => {
      globalThis.__providerAudit.mode = mode;
    }, mode);
    await button('预览文本检查外发').click();
    await page
      .getByRole('checkbox', {
        name: '我已核对实际外发内容，明确确认本次可能付费检查',
        exact: true,
      })
      .check();
    await button('确认本次检查外发').click();
    if (mode === 'pending') {
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent === '取消检查或准备'),
      );
      await button('取消检查或准备').click();
      await status('ABORTED');
    } else await status(mode === 'server' ? 'SERVER_ERROR' : 'INVALID_RESPONSE');
    await settled();
  }
  await app.evaluate(() => {
    globalThis.__providerAudit.mode = 'success';
  });
  assert.equal((await call('readModelLedger', { provider: 'kimi' })).summary.totalCalls, 5);
  assert.equal((await call('readModelLedger', { provider: 'deepseek' })).summary.totalCalls, 2);
  report.gates.push(
    'false confirmation blocks; 503/malformed JSON/cancel remain single calls and release busy slot with unknown usage',
  );
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(root, 'providers-360.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(root, 'providers-desktop.png'), fullPage: true });
  const applicationPath = await app.evaluate(({ app }) => app.getAppPath());
  const classroom = await app.evaluate(
    async ({ BrowserWindow, ipcMain }, paths) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: paths.preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      try {
        await window.loadFile(paths.html);
        const admin = await window.webContents.executeJavaScript('typeof window.classManager');
        const denials = [];
        for (const name of [
          'readModelSettings',
          'configureModelProvider',
          'selectModelProvider',
          'saveModelProviderKey',
          'deleteModelProviderKey',
          'prepareModelCheck',
          'checkModelProvider',
          'cancelModelCheck',
          'readModelLedger',
        ])
          denials.push(
            await ipcMain._invokeHandlers.get(`cm:${name}`)(
              { sender: window.webContents, senderFrame: window.webContents.mainFrame },
              {},
            ),
          );
        return { admin, denials };
      } finally {
        window.destroy();
      }
    },
    {
      preload: join(applicationPath, 'dist/main/classroom-preload.cjs'),
      html: join(applicationPath, 'dist/renderer/classroom.html'),
    },
  );
  assert.equal(classroom.admin, 'undefined');
  assert.ok(classroom.denials.every((r) => r.error.code === 'FORBIDDEN'));
  const backup = join(root, 'synthetic.cmbak');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, backup);
  await call('saveBackup', { epoch: snapshot.epoch });
  const bundle = readFileSync(backup, 'utf8');
  assert.equal(JSON.parse(bundle).version, 12);
  assert.doesNotMatch(bundle, /sk-synthetic|model-providers|kimi-ledger|doubao-ledger/);
  const beforeRestore = await call('readModelSettings');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, backup);
  const preview = await call('previewRestore');
  await call('commitRestore', { epoch: snapshot.epoch, token: preview.token });
  assert.deepEqual(await call('readModelSettings'), beforeRestore);
  const ledger = await call('readModelLedger', { provider: 'kimi' });
  report.externalRequests += await app.evaluate(() => globalThis.__providerAudit.externalRequests);
  await closeAuditApplication(app, () => {});
  app = undefined;
  await launch();
  assert.deepEqual(await call('readModelSettings'), beforeRestore);
  assert.deepEqual(await call('readModelLedger', { provider: 'kimi' }), ledger);
  assert.equal(await app.evaluate(() => globalThis.__providerAudit.calls.length), 0);
  await openWorkspacePage(page, '系统设置', '模型设置');
  await settled();
  await button('删除此供应商Key').click();
  await status('供应商Key已删除');
  assert.equal(
    (await call('readModelSettings')).providers.find((p) => p.provider === 'kimi').credentials
      .configured,
    false,
  );
  assert.equal(
    (await call('readModelSettings')).providers.find((p) => p.provider === 'doubao').credentials
      .configured,
    true,
  );
  assert.deepEqual(await call('readModelLedger', { provider: 'kimi' }), ledger);
  report.externalRequests += await app.evaluate(() => globalThis.__providerAudit.externalRequests);
  report.gates.push(
    '360px/desktop screenshots; actual classroom denies all 9 methods; Schema12 backup excludes config/key/ledger; restore/reopen retains provider state without network; isolated deletion retains usage',
  );
  assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  try {
    await closeAuditApplication(app, () => {});
  } catch (error) {
    report.status = 'failed';
    report.closeError = String(error);
    process.exitCode = 1;
  }
  writeAuditReport(join(root, 'report.json'), report);
  if (process.env.CLASS_MANAGER_PROVIDERS_REPORT)
    writeAuditReport(process.env.CLASS_MANAGER_PROVIDERS_REPORT, report);
}
console.log(JSON.stringify(report));
