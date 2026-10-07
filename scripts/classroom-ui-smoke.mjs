import { nodeBundleOptions } from './node-bundle-options.ts';
import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';
import { build } from 'esbuild';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

// Actual renderer/preload/Main/Worker/SQLite and display windows, with synthetic offline data.
const output = resolve('output/playwright/classroom');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-')),
  userData = join(root, 'user-data');
await build(
  nodeBundleOptions({
    entryPoints: ['tests/fixtures/classroom-runtime.ts'],
    outfile: join(root, 'fixture.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
  }),
);
const { seedClassroomWorkspace } = createRequire(import.meta.url)(join(root, 'fixture.cjs'));
const longTitles = process.argv.includes('--long-titles');
const seeded = await seedClassroomWorkspace(join(userData, 'workspace-data'), longTitles);
const { local, executablePath } = isolatedElectronRuntime('classroom-modern-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: userData,
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CLASS_MANAGER_LESSON_EXECUTABLE) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`;
}
const report = {
  status: 'running',
  runtime: null,
  networkRequests: 0,
  errors: [],
  seeded: {
    epoch: seeded.epoch,
    versionId: seeded.versionId,
    versionRevision: seeded.versionRevision,
  },
};
let application, page, display, sessionId;
const launch = async () => {
  application = await electron.launch({
    executablePath: process.env.CLASS_MANAGER_LESSON_EXECUTABLE ?? executablePath,
    args: process.env.CLASS_MANAGER_LESSON_EXECUTABLE ? [] : ['.'],
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
    globalThis.__classroomAudit = { network: 0 };
    globalThis.fetch = async () => {
      globalThis.__classroomAudit.network++;
      throw new Error('Offline classroom cannot use network');
    };
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
};
const button = (name) => page.getByRole('button', { name, exact: true });
const readSession = async () => {
  const result = await page.evaluate((input) => window.classManager.readClassroom(input), {
    epoch: seeded.epoch,
    id: sessionId,
  });
  assert.equal(result.ok, true);
  return result.value;
};
try {
  await launch();
  assert.equal(
    (await page.evaluate(() => window.classManager.getDeepSeekStatus())).value.configured,
    false,
  );
  if (!longTitles) {
    await application.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('cm:readCountdown');
      globalThis.__classroomAudit.releaseInitial = null;
      const held = new Promise((resolve) => {
        globalThis.__classroomAudit.releaseInitial = resolve;
      });
      handlers.set('cm:readCountdown', async (...args) => {
        await held;
        return original(...args);
      });
      globalThis.__classroomAudit.restoreInitial = () => handlers.set('cm:readCountdown', original);
    });
  }
  await openWorkspacePage(page, '教师备课', '课堂与倒计时');
  await page.getByText('设置考试日期与名称', { exact: true }).click();
  if (!longTitles) {
    assert.equal(await page.getByLabel('倒计时名称', { exact: true }).isDisabled(), true);
    assert.equal(await button('保存倒计时').isDisabled(), true);
    await application.evaluate(() => {
      globalThis.__classroomAudit.restoreInitial();
      globalThis.__classroomAudit.releaseInitial();
    });
    await page.waitForFunction(() => !document.querySelector('input[maxlength="80"]').disabled);
    await page.getByLabel('倒计时名称', { exact: true }).fill('初始加载后的教师修改');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      await page.getByLabel('倒计时名称', { exact: true }).inputValue(),
      '初始加载后的教师修改',
    );
    report.initialReadGuard = true;
  }
  await button('选择课件').click();
  await page.getByLabel('备课主题', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('具体冻结版本', { exact: true }).selectOption(seeded.versionId);
  assert.equal(await button('确认此版范围并创建课堂').isDisabled(), true);
  await page.getByLabel('我已核对班级、冻结版和所选范围，开始时不展示答案').check();
  await button('确认此版范围并创建课堂').click();
  await page.getByRole('status').filter({ hasText: '课堂已创建' }).waitFor();
  sessionId = (
    await page.evaluate((epoch) => window.classManager.listClassrooms({ epoch }), seeded.epoch)
  ).value.items[0].record.id;
  if (!longTitles) {
    await application.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('cm:readClassroom');
      handlers.set('cm:readClassroom', async () => {
        handlers.set('cm:readClassroom', original);
        return {
          ok: false,
          error: {
            code: 'STORAGE_ERROR',
            message: '合成进度回读失败',
            operationId: 'classroom-audit-failure',
          },
        };
      });
    });
  }
  const waiting = application.waitForEvent('window');
  await button('打开全屏课堂展示').click();
  display = await waiting;
  display.on('pageerror', (error) => report.errors.push(error.message));
  await display
    .getByRole('heading', { name: seeded.content.slides[0].title, exact: true })
    .waitFor();
  if (!longTitles) {
    await page.getByRole('alert').filter({ hasText: '展示已打开，但进度回读失败' }).waitFor();
    assert.equal(await button('下一页').count(), 0);
    assert.equal(
      await page.getByRole('status').filter({ hasText: '已打开独立课堂展示' }).count(),
      0,
    );
    await page.getByText('继续已保存课堂', { exact: true }).click();
    await page.getByLabel('课堂进度', { exact: true }).selectOption(sessionId);
    await page.getByLabel('课堂课件页', { exact: true }).waitFor();
    report.postOpenReadFailureGuard = true;
  }
  if (longTitles) {
    await display.getByRole('button', { name: '退出全屏', exact: true }).click();
    await display.setViewportSize({ width: 360, height: 760 });
    const mainHeight = await display.locator('main').evaluate((element) => element.clientHeight);
    assert.ok(mainHeight > 200, `Long titles left only ${mainHeight}px of readable content`);
    await display.screenshot({ path: join(root, 'display-long-titles.png'), fullPage: true });
    await display.getByText('正文末尾可见标记', { exact: false }).scrollIntoViewIfNeeded();
    await display.locator('main').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const endVisible = await display
      .getByText('正文末尾可见标记', { exact: false })
      .evaluate((element) => {
        const main = element.closest('main').getBoundingClientRect();
        const text = element.firstChild;
        const range = document.createRange();
        range.setStart(text, text.textContent.length - 9);
        range.setEnd(text, text.textContent.length);
        const end = range.getBoundingClientRect();
        return end.bottom <= main.bottom && end.top >= main.top;
      });
    assert.equal(endVisible, true);
    await display.screenshot({ path: join(root, 'display-long-content-end.png'), fullPage: true });
    report.longTitles = { mainHeight, endVisible };
    report.networkRequests += await application.evaluate(() => globalThis.__classroomAudit.network);
    assert.equal(report.networkRequests, 0);
    assert.deepEqual(report.errors, []);
    report.status = 'passed';
  } else {
    const capabilities = await display.evaluate(() => ({
      keys: Object.keys(window.classroomDisplay).sort(),
      frozen: Object.isFrozen(window.classroomDisplay),
      admin: typeof window.classManager,
      node: typeof window.require,
      process: typeof window.process,
    }));
    assert.deepEqual(capabilities, {
      keys: ['readClock', 'readProjection', 'setFullscreen'],
      frozen: true,
      admin: 'undefined',
      node: 'undefined',
      process: 'undefined',
    });
    const projection = await display.evaluate(() => window.classroomDisplay.readProjection({}));
    assert.equal(projection.ok, true);
    assert.doesNotMatch(
      JSON.stringify(projection.value.view),
      /teacherNotes|origin|quote|className|classId|student|TEACHER_|CLASSROOM_PRIVATE_/,
    );
    assert.equal(
      (
        await display.evaluate(
          (revision) => window.classroomDisplay.readProjection({ knownRevision: revision }),
          projection.value.revision,
        )
      ).value.view,
      null,
    );
    const hostile = await display.evaluate(() =>
      window.classroomDisplay.readProjection({
        knownRevision: 1,
        path: 'C:/outside',
        id: 'unapproved',
      }),
    );
    assert.equal(hostile.ok, false);
    const permission = await application.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === '课堂展示',
      );
      const handler = ipcMain._invokeHandlers.get('cm:snapshot');
      return handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    });
    assert.equal(permission.ok, false);
    assert.equal(permission.error.code, 'FORBIDDEN');
    report.displayCapabilities = capabilities;
    report.adminDenied = true;
    await display.getByRole('button', { name: '退出全屏', exact: true }).click();
    await display.screenshot({ path: join(root, 'display-default.png'), fullPage: true });
    await button('下一页').click();
    await display
      .getByRole('heading', { name: seeded.content.slides[1].title, exact: true })
      .waitFor();
    assert.doesNotMatch(await display.locator('body').innerText(), /TEACHER_|CLASSROOM_PRIVATE_/);
    await page.getByLabel('明确在展示窗口显示当前页参考答案').click();
    await display.getByText('TEACHER_SLIDE_ANSWER', { exact: false }).waitFor();
    await display.getByText('TEACHER_SLIDE_ANSWER', { exact: false }).scrollIntoViewIfNeeded();
    await display.screenshot({ path: join(root, 'display-explicit-answer.png'), fullPage: true });
    await button('下一页').click();
    await display.getByRole('heading', { name: '练习公开题目', exact: true }).waitFor();
    assert.doesNotMatch(
      await display.locator('body').innerText(),
      /TEACHER_|CLASSROOM_PRIVATE_|CLASSROOM_EXPLICIT_ANSWER/,
    );
    await page.getByLabel('明确在展示窗口显示当前环节问题').click();
    await display
      .getByText('CLASSROOM_QUESTION_PROMPT：请说明力的三个要素。', { exact: true })
      .waitFor();
    await display.screenshot({ path: join(root, 'display-question.png'), fullPage: true });
    await button('开始或恢复计时').click();
    const before = (await display.evaluate(() => window.classroomDisplay.readClock())).value
      .elapsedMs;
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === '课堂展示')
        .hide(),
    );
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === '课堂展示')
        .show(),
    );
    const after = (await display.evaluate(() => window.classroomDisplay.readClock())).value
      .elapsedMs;
    assert.ok(after - before >= 2100 && after - before < 5000);
    report.hiddenTimerDeltaMs = after - before;
    await button('保存进度并暂停').click();
    const paused = await readSession();
    assert.equal(paused.record.status, 'paused');
    assert.ok(paused.record.elapsedMs >= 2100);
    const revised = await page.evaluate(
      async ({ epoch, versionId }) => {
        const draft = await window.classManager.reviseLessonVersion({
          epoch,
          versionId,
          requestId: crypto.randomUUID(),
        });
        if (!draft.ok) throw new Error(draft.error.message);
        const read = await window.classManager.readLessonDraft({ epoch, id: draft.value.id });
        if (!read.ok) throw new Error(read.error.message);
        const edited = await window.classManager.editLessonDraft({
          epoch,
          id: draft.value.id,
          expectedRevision: 1,
          content: { ...read.value.payload.content, title: '课堂开始后新稿不得自动替换' },
        });
        if (!edited.ok) throw new Error(edited.error.message);
        return window.classManager.freezeLessonDraft({
          epoch,
          id: draft.value.id,
          expectedRevision: 2,
          requestId: crypto.randomUUID(),
          reason: '课堂运行后的新版本',
        });
      },
      { epoch: seeded.epoch, versionId: seeded.versionId },
    );
    assert.equal(revised.ok, true);
    assert.equal((await readSession()).record.versionId, seeded.versionId);
    assert.ok((await display.locator('body').innerText()).includes('课堂离线合成版本'));
    assert.doesNotMatch(await display.locator('body').innerText(), /课堂开始后新稿不得自动替换/);
    await page.getByLabel('倒计时名称', { exact: true }).fill('自主高考目标');
    await page.getByLabel('目标日期', { exact: true }).fill('2031-06-07');
    await button('保存倒计时').click();
    await page.getByRole('status').filter({ hasText: '倒计时已保存' }).waitFor();
    await openWorkspacePage(page, '班主任管理', '班级名册');
    await page.getByLabel('首页高考倒计时').filter({ hasText: '自主高考目标' }).waitFor();
    await openWorkspacePage(page, '教师备课', '课堂与倒计时');
    await page.getByText('继续已保存课堂', { exact: true }).click();
    await page.getByLabel('课堂进度', { exact: true }).selectOption(sessionId);
    assert.equal(await page.getByLabel('首页高考倒计时', { exact: true }).count(), 1);
    await page.getByLabel('课堂课件页', { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel('课堂课件页', { exact: true }).inputValue(),
      'practice-slide',
    );
    await page.screenshot({ path: join(root, 'teacher-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 360, height: 760 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: join(root, 'teacher-narrow.png'), fullPage: true });
    await display.setViewportSize({ width: 360, height: 760 });
    assert.equal(
      await display.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await display.screenshot({ path: join(root, 'display-narrow.png'), fullPage: true });
    await button('开始或恢复计时').click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    report.networkRequests += await application.evaluate(() => globalThis.__classroomAudit.network);
    await application.close();
    application = null;
    await launch();
    await openWorkspacePage(page, '教师备课', '课堂与倒计时');
    await page.getByText('继续已保存课堂', { exact: true }).click();
    await page.getByLabel('课堂进度', { exact: true }).selectOption(sessionId);
    const reopened = await readSession();
    assert.equal(reopened.record.status, 'paused');
    assert.equal(reopened.record.payload.index, 2);
    assert.ok(reopened.record.elapsedMs >= paused.record.elapsedMs + 1100);
    assert.equal(reopened.record.interrupted, false);
    assert.equal(reopened.record.versionId, seeded.versionId);
    const date = await page.evaluate(
      (epoch) => window.classManager.readCountdown({ epoch }),
      seeded.epoch,
    );
    assert.equal(date.value.setting.targetDate, '2031-06-07');
    report.reopened = true;
    report.normalExitSavedRunningTimer = true;
    await page.getByLabel('课堂课件页', { exact: true }).waitFor();
    await button('开始或恢复计时').click();
    let checkpoint;
    for (let attempt = 0; attempt < 80; attempt++) {
      const db = new DatabaseSync(
        join(userData, 'workspace-data', 'workspaces', seeded.epoch, 'data.sqlite'),
        { readOnly: true },
      );
      try {
        checkpoint = db
          .prepare('SELECT elapsed_ms AS elapsedMs,status FROM teaching_sessions WHERE id=?')
          .get(sessionId);
      } finally {
        db.close();
      }
      if (checkpoint.elapsedMs >= reopened.record.elapsedMs + 500) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(checkpoint.status, 'running');
    assert.ok(checkpoint.elapsedMs >= reopened.record.elapsedMs + 500);
    report.networkRequests += await application.evaluate(() => globalThis.__classroomAudit.network);
    const ownProcess = await application.evaluate(({ app }) => ({
      pid: process.pid,
      userData: app.getPath('userData'),
    }));
    assert.equal(resolve(ownProcess.userData), resolve(userData));
    const auditProcess = application.process();
    const exited = new Promise((resolve) => auditProcess.once('exit', resolve));
    // Only this isolated audit application and its children are terminated.
    execFileSync('taskkill.exe', ['/PID', String(ownProcess.pid), '/T', '/F'], {
      windowsHide: true,
    });
    await exited;
    application = null;
    // Checkpoint writes can advance before taskkill; inspect the last durable value
    // after the process exits, without requesting a graceful application close.
    const crashedDatabase = new DatabaseSync(
      join(userData, 'workspace-data', 'workspaces', seeded.epoch, 'data.sqlite'),
      { readOnly: true },
    );
    try {
      const last = crashedDatabase
        .prepare('SELECT elapsed_ms AS elapsedMs,status FROM teaching_sessions WHERE id=?')
        .get(sessionId);
      assert.equal(last.status, 'running');
      assert.ok(last.elapsedMs >= checkpoint.elapsedMs);
      checkpoint = last;
    } finally {
      crashedDatabase.close();
    }
    await launch();
    await openWorkspacePage(page, '教师备课', '课堂与倒计时');
    await page.getByText('继续已保存课堂', { exact: true }).click();
    await page.getByLabel('课堂进度', { exact: true }).selectOption(sessionId);
    const recovered = await readSession();
    assert.equal(recovered.record.elapsedMs, checkpoint.elapsedMs);
    assert.equal(recovered.record.status, 'paused');
    assert.equal(recovered.record.interrupted, true);
    await page.getByText('上次计时未正常结束', { exact: false }).waitFor();
    report.crashRecovered = {
      checkpointElapsedMs: checkpoint.elapsedMs,
      status: recovered.record.status,
      interrupted: recovered.record.interrupted,
    };
    await page.getByLabel('课堂课件页', { exact: true }).waitFor();
    const restoredDisplay = application.waitForEvent('window');
    await button('打开全屏课堂展示').click();
    display = await restoredDisplay;
    await display.getByRole('heading', { name: '练习公开题目', exact: true }).waitFor();
    await button('开始或恢复计时').click();
    await button('保存进度并暂停').click({ trial: true });
    const backupPath = join(root, 'classroom-running.cmbackup');
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, backupPath);
    const restored = await page.evaluate(
      async ({ epoch, id }) => {
        const saved = await window.classManager.saveBackup({ epoch });
        if (!saved.ok) throw new Error(saved.error.message);
        const preview = await window.classManager.previewRestore();
        if (!preview.ok || !preview.value) throw new Error('Backup preview failed');
        const committed = await window.classManager.commitRestore({
          epoch,
          token: preview.value.token,
        });
        if (!committed.ok) throw new Error(committed.error.message);
        const current = await window.classManager.readClassroom({
          epoch: committed.value.epoch,
          id,
        });
        const old = await window.classManager.readClassroom({ epoch, id });
        const date = await window.classManager.readCountdown({ epoch: committed.value.epoch });
        return { preview: preview.value, current, old, date, epoch: committed.value.epoch };
      },
      { epoch: seeded.epoch, id: sessionId },
    );
    assert.equal(restored.preview.teachingSessionCount, 1);
    assert.equal(restored.preview.countdownCount, 1);
    assert.equal(restored.current.ok, true);
    assert.equal(restored.current.value.record.status, 'paused');
    assert.equal(restored.current.value.record.interrupted, true);
    assert.equal(restored.current.value.record.versionId, seeded.versionId);
    assert.equal(restored.old.ok, false);
    assert.equal(restored.old.error.code, 'STALE_WORKSPACE');
    assert.equal(restored.date.value.setting.targetDate, '2031-06-07');
    assert.notEqual(restored.epoch, seeded.epoch);
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.getTitle() === '课堂展示'),
      ),
      false,
    );
    report.restoreClosedDisplay = {
      oldEpochRejected: true,
      progressPaused: true,
      countdownRestored: true,
    };
    report.networkRequests += await application.evaluate(() => globalThis.__classroomAudit.network);
    assert.equal(report.networkRequests, 0);
    assert.deepEqual(report.errors, []);
    report.status = 'passed';
  }
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(
      join(root, 'failure-body.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  report.status = 'failed';
  report.errors.push(String(error));
  throw error;
} finally {
  try {
    if (application) await application.close();
  } catch (error) {
    report.status = 'failed';
    report.errors.push(`Application cleanup failed: ${error}`);
    throw error;
  } finally {
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ root, ...report }, null, 2));
  }
}
