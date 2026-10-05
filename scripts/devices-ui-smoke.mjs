import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';

// 实际教师UI、冻结Preload、Main、Worker和SQLite；默认Adapter不被替换。
const parent = resolve('output/playwright/devices');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const executable = process.env.CLASS_MANAGER_DEVICES_EXECUTABLE;
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: join(root, 'user-data') };
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
const value = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.value;
};
const call = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input }).then(value);
const button = (name) => page.getByRole('button', { name, exact: true });
async function launch() {
  app = await electron.launch({
    executablePath: executable ?? electronPath,
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
    globalThis.__deviceUnexpectedFetches = 0;
    globalThis.fetch = async () => {
      globalThis.__deviceUnexpectedFetches++;
      throw new Error('Device audit forbids external requests');
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
}
try {
  await launch();
  await button('班级名册').click();
  await button('载入合成样例').click();
  await button('确认载入').click();
  await page.getByRole('status').filter({ hasText: '合成样例已保存' }).waitFor();
  const snapshot = await call('snapshot');
  const student = snapshot.students.find((s) => s.active && s.classId);
  assert.equal(snapshot.schemaVersion, 11);
  const bridge = await page.evaluate(() => ({
    keys: Object.keys(window.classManager),
    frozen: Object.isFrozen(window.classManager),
    require: typeof window.require,
  }));
  assert.equal(bridge.keys.length, 130);
  assert.equal(bridge.frozen, true);
  assert.equal(bridge.require, 'undefined');
  await button('外设接口').click();
  await page.getByRole('heading', { name: '外设接口', exact: true }).waitFor();
  await page.getByText('状态：未接入', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('状态：未接入', { exact: true }).count(), 2);
  await button('请求一次音量测量').click();
  await page.getByRole('status').filter({ hasText: '不可测量' }).waitFor();
  assert.equal(await page.locator('.device-panel strong').count(), 0);
  assert.equal(await button('确认请求呼叫').isDisabled(), true);
  await page.getByLabel('呼叫目标', { exact: true }).selectOption(student.id);
  await page.getByLabel('呼叫说明', { exact: true }).fill('合成外设验收说明');
  assert.equal(await button('班级名册').isDisabled(), true);
  await page
    .getByRole('checkbox', { name: '确认仅使用合成名册，不发送真实学生信息', exact: true })
    .check();
  assert.equal(await button('确认请求呼叫').isDisabled(), true);
  await page
    .getByRole('checkbox', { name: '已核对目标学生和说明，明确确认本次呼叫请求', exact: true })
    .check();
  await button('确认请求呼叫').click();
  await page.getByText('不可执行，未接入', { exact: true }).waitFor();
  await button('班级名册').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].find((b) => b.textContent.includes('班级名册'))
        .disabled,
  );
  await button('查询原呼叫结果').click();
  await page.getByText('不可执行，未接入', { exact: true }).waitFor();
  const rawRequest = {
    epoch: snapshot.epoch,
    operationId: crypto.randomUUID(),
    studentId: student.id,
    expectedStudentRevision: student.revision,
    reason: '合成IPC幂等验收',
    acknowledgeTeacherReviewed: true,
    acknowledgeSyntheticOnly: true,
  };
  const first = await call('requestStudentCall', rawRequest);
  assert.equal(first.outcome.stage, 'unavailable');
  assert.deepEqual(await call('requestStudentCall', rawRequest), first);
  assert.deepEqual(
    await call('readStudentCall', { epoch: snapshot.epoch, operationId: rawRequest.operationId }),
    first,
  );
  assert.equal(
    (
      await call('cancelDeviceTask', {
        epoch: snapshot.epoch,
        operationId: rawRequest.operationId,
        kind: 'call',
      })
    ).requested,
    false,
  );
  const changed = await page.evaluate((input) => window.classManager.requestStudentCall(input), {
    ...rawRequest,
    reason: 'changed',
  });
  assert.equal(changed.error.code, 'CONFLICT');
  const invalid = await page.evaluate((input) => window.classManager.requestStudentCall(input), {
    ...rawRequest,
    operationId: crypto.randomUUID(),
    acknowledgeTeacherReviewed: false,
  });
  assert.equal(invalid.error.code, 'VALIDATION');
  report.gates.push(
    '130 frozen teacher methods; actual default adapters unavailable with no values/acceptance/delivery',
    'teacher and synthetic confirmation + dirty navigation protection',
    'same ID repeated read/request stable; altered request rejected; cancel never claims retraction',
  );
  await page.getByLabel('呼叫说明', { exact: true }).fill('合成未保存长说明'.repeat(15));
  assert.equal(await button('班级名册').isDisabled(), true);
  await button('清空呼叫输入').click();
  await button('刷新外设状态').click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].find((b) => b.textContent.includes('刷新外设状态'))
        .disabled,
  );
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(root, 'devices-360.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(root, 'devices-desktop.png'), fullPage: true });
  const applicationPath = await app.evaluate(({ app }) => app.getAppPath());
  const display = await app.evaluate(
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
        const surface = await window.webContents.executeJavaScript(
          '({ admin: typeof window.classManager, display: Object.keys(window.classroomDisplay), require: typeof window.require })',
        );
        const denials = [];
        for (const name of [
          'readDeviceStatus',
          'measureNoise',
          'requestStudentCall',
          'readStudentCall',
          'cancelDeviceTask',
        ])
          denials.push(
            await ipcMain._invokeHandlers.get(`cm:${name}`)(
              { sender: window.webContents, senderFrame: window.webContents.mainFrame },
              {},
            ),
          );
        return { surface, denials };
      } finally {
        window.destroy();
      }
    },
    {
      preload: join(applicationPath, 'dist/main/classroom-preload.cjs'),
      html: join(applicationPath, 'dist/renderer/classroom.html'),
    },
  );
  assert.equal(display.surface.admin, 'undefined');
  assert.deepEqual(
    display.surface.display.sort(),
    ['readClock', 'readProjection', 'setFullscreen'].sort(),
  );
  assert.equal(display.surface.require, 'undefined');
  assert.ok(display.denials.every((r) => r.error.code === 'FORBIDDEN'));
  const backup = join(root, 'device-backup.cmbak');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, backup);
  await call('saveBackup', { epoch: snapshot.epoch });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, backup);
  const preview = await call('previewRestore');
  const restored = await call('commitRestore', { epoch: snapshot.epoch, token: preview.token });
  for (const name of [
    'readDeviceStatus',
    'measureNoise',
    'requestStudentCall',
    'readStudentCall',
    'cancelDeviceTask',
  ]) {
    const inputs = {
      readDeviceStatus: { epoch: snapshot.epoch },
      measureNoise: {
        epoch: snapshot.epoch,
        operationId: crypto.randomUUID(),
        purpose: 'reading',
        durationMs: 1000,
      },
      requestStudentCall: rawRequest,
      readStudentCall: { epoch: snapshot.epoch, operationId: rawRequest.operationId },
      cancelDeviceTask: {
        epoch: snapshot.epoch,
        operationId: rawRequest.operationId,
        kind: 'call',
      },
    };
    const result = await page.evaluate(({ name, input }) => window.classManager[name](input), {
      name,
      input: inputs[name],
    });
    assert.equal(result.error.code, 'STALE_WORKSPACE');
  }
  assert.equal(
    (await call('readDeviceStatus', { epoch: restored.epoch })).noise.state,
    'not_connected',
  );
  report.externalRequests += await app.evaluate(() => globalThis.__deviceUnexpectedFetches);
  await closeAuditApplication(app, () => {});
  app = undefined;
  await launch();
  const reopened = await call('snapshot');
  assert.equal(reopened.schemaVersion, 11);
  assert.equal((await call('getDeepSeekStatus')).configured, false);
  assert.equal(
    await call('readStudentCall', { epoch: reopened.epoch, operationId: rawRequest.operationId }),
    null,
  );
  await button('外设接口').click();
  await page.getByText('状态：未接入', { exact: true }).first().waitFor();
  report.externalRequests += await app.evaluate(() => globalThis.__deviceUnexpectedFetches);
  report.gates.push(
    '360px no overflow and visible outcome',
    'actual classroom preload has no devices and Main denies all 5 methods',
    'Schema11 backup/restore invalidates old epoch for all 5 methods',
    'no-credential reopen is offline and does not invent durable disconnected receipt',
  );
  assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
  if (page) {
    try {
      await page.screenshot({ path: join(root, 'failure.png'), fullPage: true });
    } catch {}
  }
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
