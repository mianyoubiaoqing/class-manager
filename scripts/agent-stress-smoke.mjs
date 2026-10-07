import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';

const output = resolve('output/playwright/agent-stress');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-'));
const { local, executablePath } = isolatedElectronRuntime('agent-stress-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(local, 'data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = { status: 'running', root, local, checks: [], timings: {}, errors: [], requests: 0 };
let app, page;
const raw = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input });
const call = async (name, input) => {
  const r = await raw(name, input);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.value;
};
const measure = async (name, work) => {
  const t = performance.now();
  const value = await work();
  report.timings[name] = Math.round(performance.now() - t);
  return value;
};
async function launch() {
  app = await electron.launch({ executablePath, args: ['.'], env, timeout: 45000 });
  await app.evaluate(() => {
    globalThis.__stressRequests = 0;
    globalThis.fetch = async () => {
      globalThis.__stressRequests++;
      throw Error('Offline stress run');
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await page.getByLabel('发送消息', { exact: true }).waitFor();
}
async function closeNormally() {
  report.requests += await app.evaluate(() => globalThis.__stressRequests);
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  app = undefined;
}
try {
  await launch();
  const { epoch } = await call('snapshot');
  const beforeRapid = (await call('listConversationHistory', { epoch })).items;
  await page.getByRole('button', { name: '开启新对话', exact: true }).evaluate((el) => {
    for (let i = 0; i < 20; i++) el.click();
  });
  await page.waitForFunction(
    async ({ epoch, count }) => {
      const r = await window.classManager.listConversationHistory({ epoch });
      return r.ok && r.value.items.length > count;
    },
    { epoch, count: beforeRapid.length },
  );
  await page.waitForFunction(
    () => !document.querySelector('.conversation-history-rail > button').disabled,
  );
  const afterRapid = (await call('listConversationHistory', { epoch })).items;
  assert.equal(
    afterRapid.length,
    beforeRapid.length + 1,
    'Rapid clicks must create only one new session',
  );
  for (const item of afterRapid.filter((item) => !beforeRapid.some((old) => old.id === item.id))) {
    await call('deleteConversationHistory', {
      epoch,
      id: item.id,
      expectedRevision: item.revision,
    });
  }
  await page.reload();
  await page.getByLabel('发送消息', { exact: true }).waitFor();
  report.checks.push('20 rapid clicks create one session without consuming extra history slots');
  const records = await measure('create99HistoriesMs', () =>
    page.evaluate(async (epoch) => {
      const a = window.classManager,
        records = [];
      for (let i = 0; i < 99; i++) {
        const c = await a.createConversationHistory({ epoch });
        if (!c.ok) throw Error(c.error.message);
        const r = await a.renameConversationHistory({
          epoch,
          id: c.value.id,
          expectedRevision: c.value.revision,
          title: `压力测试-${String(i).padStart(3, '0')}-` + '长标题'.repeat(20),
        });
        if (!r.ok) throw Error(r.error.message);
        const saved = await a.saveConversationHistory({
          epoch,
          id: r.value.id,
          expectedRevision: r.value.revision,
          state: {
            messages: [
              { speaker: 'user', text: `合成任务 ${i}` },
              { speaker: 'assistant', text: '无空格的长文本LongUnbrokenText'.repeat(200) },
            ],
            draft: `未提交草稿-${i}`,
            classId: null,
            studentId: null,
          },
        });
        if (!saved.ok) throw Error(saved.error.message);
        records.push({
          id: saved.value.id,
          title: saved.value.title,
          revision: saved.value.revision,
        });
      }
      return records;
    }, epoch),
  );
  const listed = await measure('list100HistoriesMs', () =>
    call('listConversationHistory', { epoch }),
  );
  assert.equal(listed.items.length, 100);
  const capped = await raw('createConversationHistory', { epoch });
  assert.equal(capped.ok, false);
  assert.equal(capped.error.code, 'HISTORY_LIMIT');
  report.checks.push(
    '100-session limit rejects the 101st session without changing existing history',
  );
  const last = records.at(-1);
  const large = await call('saveConversationHistory', {
    epoch,
    id: last.id,
    expectedRevision: last.revision,
    state: {
      messages: Array.from({ length: 60 }, (_, i) => ({
        speaker: i % 2 ? 'assistant' : 'user',
        text: `消息${i}:` + 'LongParagraph '.repeat(1400),
      })),
      draft: '大记录草稿',
      classId: null,
      studentId: null,
    },
  });
  await page.reload();
  await page.getByLabel('发送消息', { exact: true }).waitFor();
  assert.equal(await page.locator('.conversation-message').count(), 60);
  assert.equal(await page.locator('.conversation-context').count(), 0);
  const boxes = await page.evaluate(() => {
    const rail = document.querySelector('.conversation-history-rail').getBoundingClientRect(),
      thread = document.querySelector('.conversation-thread').getBoundingClientRect(),
      composer = document.querySelector('.conversation-composer').getBoundingClientRect();
    return {
      separate: rail.right <= thread.left && thread.bottom <= composer.top,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      font: getComputedStyle(document.body).fontFamily,
    };
  });
  assert.equal(boxes.separate, true);
  assert.equal(boxes.overflow, false);
  report.font = boxes.font;
  await page.screenshot({ path: join(root, 'long-conversation.png') });
  const tooLarge = await raw('saveConversationHistory', {
    epoch,
    id: last.id,
    expectedRevision: large.revision,
    state: {
      ...large.state,
      messages: Array.from({ length: 60 }, () => ({
        speaker: 'assistant',
        text: '超大'.repeat(25000),
      })),
    },
  });
  assert.equal(tooLarge.ok, false);
  assert.ok(['HISTORY_LIMIT', 'VALIDATION'].includes(tooLarge.error.code));
  assert.equal(
    (await call('readConversationHistory', { epoch, id: last.id })).revision,
    large.revision,
  );
  report.checks.push(
    '60 long messages stay inside the message scroller; oversized saves preserve the previous archive',
  );
  const batch = await measure('200ConcurrentSnapshotsMs', () =>
    page.evaluate(async () =>
      Promise.all(Array.from({ length: 200 }, () => window.classManager.snapshot())),
    ),
  );
  assert.equal(
    batch.every((r) => r.ok && r.value.epoch === epoch),
    true,
  );
  report.checks.push('200 simultaneous read requests return the same intact workspace');
  await page.getByRole('button', { name: '查看全部与管理', exact: true }).click();
  assert.equal(await page.locator('.session-item').count(), 50);
  await page.getByRole('button', { name: /显示更多会话/ }).click();
  assert.equal(await page.locator('.session-item').count(), 99);
  await page.getByLabel('搜索会话', { exact: true }).fill('压力测试-050');
  assert.equal(await page.locator('.session-item').count(), 1);
  await page.getByLabel('搜索会话', { exact: true }).fill('');
  for (let i = 0; i < 30; i++) {
    await page
      .getByLabel('搜索会话', { exact: true })
      .fill(`压力测试-${String(i).padStart(3, '0')}`);
    const row = page.getByRole('article', { name: records[i].title, exact: true });
    await row.getByRole('button', { name: '继续对话', exact: true }).click();
    await page.getByLabel('发送消息', { exact: true }).fill(`快速切换草稿-${i}`);
    await page.getByRole('button', { name: '查看全部与管理', exact: true }).click();
    assert.equal(
      (await call('readConversationHistory', { epoch, id: records[i].id })).state.draft,
      `快速切换草稿-${i}`,
    );
  }
  report.checks.push(
    '30 switches before the autosave debounce preserve each session draft without cross-contamination',
  );
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByRole('alert').getByText(/100段/).waitFor();
  await page.getByRole('button', { name: '返回智能对话', exact: true }).click();
  assert.equal(await page.getByLabel('发送消息', { exact: true }).inputValue(), '快速切换草稿-29');
  await page.getByRole('button', { name: '开启新对话', exact: true }).evaluate((el) => {
    for (let i = 0; i < 20; i++) el.click();
  });
  await page.getByRole('alert').getByText(/100段/).waitFor();
  assert.equal((await call('listConversationHistory', { epoch })).items.length, 100);
  report.checks.push(
    'Repeated creation at the capacity limit leaves the current transcript and draft usable',
  );
  for (let i = 0; i < 3; i++) {
    await page.getByLabel('发送消息', { exact: true }).fill(`原生关闭草稿-${i}`);
    await closeNormally();
    await launch();
    assert.equal(
      await page.getByLabel('发送消息', { exact: true }).inputValue(),
      `原生关闭草稿-${i}`,
    );
  }
  report.checks.push('Three native close/reopen cycles flush the final keystrokes before debounce');
  const file = join(local, 'data/conversation-history', records[0].id + '.chat');
  const original = readFileSync(file);
  writeFileSync(file, Buffer.from('synthetic corrupted archive'));
  const damaged = await raw('readConversationHistory', { epoch, id: records[0].id });
  assert.equal(damaged.ok, false);
  assert.equal(damaged.error.code, 'DATA_CORRUPTED');
  const healthy = await raw('listConversationHistory', { epoch });
  report.corruptionResult = { ok: healthy.ok, code: healthy.ok ? undefined : healthy.error.code };
  try {
    assert.equal(healthy.ok, true, 'One damaged record must not hide all healthy sessions');
    assert.equal(healthy.value.unreadableCount, 1);
    assert.equal(healthy.value.items.length, 99);
    await page.reload();
    await page
      .getByRole('status')
      .filter({ hasText: /有\s*1\s*段会话无法读取/ })
      .waitFor();
    await page.getByRole('button', { name: '查看全部与管理', exact: true }).click();
    await page.getByLabel('搜索会话', { exact: true }).fill('压力测试-050');
    assert.equal(await page.locator('.session-item').count(), 1);
    await page.getByRole('button', { name: '继续对话', exact: true }).click();
    await page.getByLabel('发送消息', { exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => document.querySelector('#conversation-input').value === '未提交草稿-50',
    );
    assert.equal(await page.getByLabel('发送消息', { exact: true }).inputValue(), '未提交草稿-50');
    assert.deepEqual(readFileSync(file), Buffer.from('synthetic corrupted archive'));
  } finally {
    writeFileSync(file, original);
  }
  report.checks.push(
    'A damaged encrypted archive is isolated and the other histories remain available',
  );
  assert.deepEqual(report.errors, []);
  assert.equal(report.requests, 0);
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.failure = String(e);
  await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {});
  throw e;
} finally {
  if (app) await app.close();
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
