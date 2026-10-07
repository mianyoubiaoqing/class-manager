import { _electron as electron } from 'playwright';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';

const output = resolve('output/playwright/conversation-layout');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-'));
const base = join(process.env.USERPROFILE, 'ClassManagerSetupChecks');
mkdirSync(base, { recursive: true });
const previous = readdirSync(base)
  .filter((n) => n.startsWith('conversation-layout-'))
  .map((n) => join(base, n, 'runtime'))
  .find(
    (p) => existsSync(join(p, 'electron.exe')) && existsSync(join(p, 'resources/default_app.asar')),
  );
const local = mkdtempSync(join(base, 'conversation-layout-'));
const runtime = previous ?? join(local, 'runtime');
if (!previous) cpSync(resolve('node_modules/electron/dist'), runtime, { recursive: true });
mkdirSync(join(local, 'temp'));
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(local, 'data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: join(runtime, 'electron.exe'),
  args: ['.'],
  env,
});
const report = { root, status: 'running', checks: [], errors: [] };
try {
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw Error('Offline layout check');
    };
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const api = window.classManager;
    const snapshot = await api.snapshot();
    if (!snapshot.ok) throw Error(snapshot.error.message);
    for (let i = 0; i < 3; i++) {
      const created = await api.createConversationHistory({ epoch: snapshot.value.epoch });
      if (!created.ok) throw Error(created.error.message);
      const renamed = await api.renameConversationHistory({
        epoch: snapshot.value.epoch,
        id: created.value.id,
        expectedRevision: created.value.revision,
        title: `${i}-` + '极长会话标题LongTitle'.repeat(7).slice(0, 78),
      });
      if (!renamed.ok) throw Error(renamed.error.message);
      const saved = await api.saveConversationHistory({
        epoch: snapshot.value.epoch,
        id: renamed.value.id,
        expectedRevision: renamed.value.revision,
        state: {
          messages: [{ speaker: 'assistant', text: 'VeryLongUnbrokenPreview'.repeat(100) }],
          draft: '',
          classId: null,
          studentId: null,
        },
      });
      if (!saved.ok) throw Error(saved.error.message);
    }
  });
  await page.reload();
  if (process.env.LAYOUT_PROBE)
    await page.evaluate(
      (css) => document.styleSheets[0].insertRule(css, document.styleSheets[0].cssRules.length),
      process.env.LAYOUT_PROBE,
    );
  await page.getByRole('button', { name: '查看全部与管理', exact: true }).waitFor();
  await page.screenshot({ path: join(root, 'chat-before.png'), fullPage: true });
  try {
    await page
      .getByRole('button', { name: '查看全部与管理', exact: true })
      .click({ timeout: 3000 });
  } catch {
    report.errors.push('Conversation content blocks the history management button');
    await page
      .getByRole('button', { name: '查看全部与管理', exact: true })
      .evaluate((e) => e.click());
  }
  for (const [width, zoom] of [
    [1440, 1],
    [1280, 1],
    [1024, 1],
    [800, 1],
    [640, 1],
    [360, 1],
    [1440, 1.25],
    [1440, 1.5],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, zoom }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.webContents.setZoomFactor(zoom);
        w.setMinimumSize(320, 500);
        w.setSize(width, 960);
      },
      { width, zoom },
    );
    await page.waitForTimeout(100);
    const result = await page.evaluate(() => {
      const failures = [];
      const styles = [...document.querySelectorAll('.session-item')].slice(0, 1).flatMap((row) =>
        [...row.children].map((e) => {
          const s = getComputedStyle(e),
            r = e.getBoundingClientRect();
          return {
            class: e.className,
            width: r.width,
            minWidth: s.minWidth,
            flex: s.flex,
            display: s.display,
          };
        }),
      );
      const visible = (e) =>
        e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
      const hidden = [...document.querySelectorAll('[hidden]')].filter((e) => visible(e));
      if (hidden.length)
        failures.push(
          `Hidden panels occupy layout: ${hidden.map((e) => e.className || e.tagName).join(',')}`,
        );
      if (document.documentElement.scrollWidth > innerWidth + 1)
        failures.push('Page horizontal overflow');
      for (const row of document.querySelectorAll('.session-item')) {
        if (!visible(row)) continue;
        const a = row.querySelector('.session-description').getBoundingClientRect();
        const b = row.querySelector('.session-item-actions').getBoundingClientRect();
        if (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        )
          failures.push('Session text overlaps action buttons');
        const r = row.getBoundingClientRect();
        for (const el of row.querySelectorAll('h3,p,small,button')) {
          const x = el.getBoundingClientRect();
          if (x.right > r.right + 1 || x.left < r.left - 1)
            failures.push('Session content escapes row');
        }
      }
      return { viewport: innerWidth, failures: [...new Set(failures)], styles };
    });
    report.checks.push({ width, zoom, ...result });
    await page.screenshot({ path: join(root, `sessions-${width}-${zoom}.png`), fullPage: true });
  }
  report.status =
    report.checks.every((c) => c.failures.length === 0) && report.errors.length === 0
      ? 'passed'
      : 'failed';
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.status, 'passed');
} finally {
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  await app.close();
}
