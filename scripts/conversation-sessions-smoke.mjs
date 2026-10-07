import fs from 'node:fs';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';

const evidenceBase = path.resolve('output/playwright/conversation-sessions');
fs.mkdirSync(evidenceBase, { recursive: true });
const root = fs.mkdtempSync(path.join(evidenceBase, 'run-'));
const { local, executablePath: cachedRuntime } = isolatedElectronRuntime('session-check-');
const executable = process.env.CLASS_MANAGER_SESSIONS_EXECUTABLE;
const runtime = executable ?? cachedRuntime;
const data = path.join(local, 'data'),
  temp = path.join(local, 'temp');
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: data, TEMP: temp, TMP: temp };
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  status: 'running',
  root,
  local,
  packaged: !!executable,
  gates: [],
  errors: [],
  externalRequests: 0,
};
let app, page;
const raw = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input });
const call = async (name, input) => {
  const result = await raw(name, input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const button = (name) => page.getByRole('button', { name, exact: true });
const nav = (name) =>
  name === '会话管理'
    ? page.getByRole('button', { name: '查看全部与管理', exact: true })
    : name === '业务对话'
      ? page.getByRole('button', { name: '打开智能对话小窗', exact: true })
      : page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true });
const field = () => page.getByLabel('发送消息', { exact: true });
const catalog = async () =>
  (await call('listConversationHistory', { epoch: (await call('snapshot')).epoch })).items;
const current = async () => {
  const title = await page.locator('[data-conversation-title]').innerText();
  return (await catalog()).find((item) =>
    title === '业务助手' ? item.title === '新会话' : item.title === title,
  );
};
const mode = (value) =>
  app.evaluate((_electron, value) => {
    globalThis.__sessionsAudit.mode = value;
  }, value);
async function launch() {
  app = await electron.launch({
    executablePath: runtime,
    args: executable ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  await app.evaluate(() => {
    globalThis.__sessionsAudit = { mode: 'first', calls: [], externalRequests: 0 };
    globalThis.fetch = async (url, init) => {
      const audit = globalThis.__sessionsAudit;
      if (url !== 'https://api.deepseek.com/chat/completions') {
        audit.externalRequests++;
        throw Error('Unrecognized transport; no network performed');
      }
      audit.calls.push(JSON.parse(init.body));
      const content =
        audit.mode === 'propose'
          ? JSON.stringify({
              formatVersion: 1,
              explanation: '将建立待确认的教学班',
              action: { kind: 'createClass', name: '未授权新班级' },
            })
          : audit.mode === 'second'
            ? '第二段合成答复：值日安排建议。'
            : '第一段合成答复：英语备课建议。';
      return new Response(
        JSON.stringify({
          id: 'synthetic-session-response',
          model: 'synthetic',
          choices: [{ finish_reason: 'stop', message: { content } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      );
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await nav('业务对话').click();
  await field().waitFor();
}
async function closeNormally() {
  const child = app.process();
  report.externalRequests += await app.evaluate(() => globalThis.__sessionsAudit.externalRequests);
  const exited = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => !window.isDestroyed())
      .close(),
  );
  await exited;
  assert.notEqual(child.exitCode, null, 'Owned application exited normally');
  app = undefined;
}
async function send(text, expected = '本轮完成') {
  await field().fill(text);
  await field().press('Enter');
  await page.getByRole('heading', { name: expected, exact: true }).waitFor();
  if (expected === '本轮完成')
    await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
}
async function openManaged(title) {
  await nav('会话管理').click();
  const item = page.getByRole('article', { name: title, exact: true });
  await item.getByRole('button', { name: '继续对话', exact: true }).click();
  await field().waitFor();
}
try {
  await launch();
  const navItems = await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button')
    .allTextContents();
  assert.deepEqual(navItems, ['教师备课', '班主任管理', '系统设置']);
  let snapshot = await call('snapshot');
  snapshot = await call('seedDemo', { epoch: snapshot.epoch });
  await call('saveModelProviderKey', {
    provider: 'deepseek',
    apiKey: 'sk-synthetic-sessions-only',
  });
  await openWorkspacePage(page, '班主任管理', '班级名册');
  await button('重新读取数据').click();
  await nav('业务对话').click();
  await page.getByLabel('对话当前班级', { exact: true }).selectOption(snapshot.classes[0].id);
  const student = snapshot.students.find((item) => item.classId === snapshot.classes[0].id);
  await page.getByLabel('对话当前学生', { exact: true }).selectOption(student.id);
  await send('第一段：英语备课');
  await field().fill('第一段未提交草稿');
  await nav('会话管理').click();
  await page.getByRole('article', { name: '第一段：英语备课', exact: true }).waitFor();
  const first = (await catalog()).find((item) => item.title === '第一段：英语备课');
  assert.ok(first);
  await button('新建会话').click();
  await page.getByRole('heading', { name: '告诉助手，你想完成什么？', exact: true }).waitFor();
  assert.equal(await page.locator('.conversation-message').count(), 0);
  assert.equal(await field().inputValue(), '');
  await mode('second');
  await send('第二段：值日安排');
  await page.waitForFunction(
    () => document.querySelector('[data-conversation-title]').textContent === '第二段：值日安排',
  );
  const second = await current();
  assert.ok(second && second.id !== first.id);
  await field().fill('第二段未提交草稿');
  await openManaged(first.title);
  assert.equal(await field().inputValue(), '第一段未提交草稿');
  assert.equal(await page.getByLabel('对话当前学生', { exact: true }).inputValue(), student.id);
  const text = await page.locator('.conversation-thread').innerText();
  assert.ok(text.includes('第一段合成答复'));
  assert.ok(!text.includes('第二段合成答复'));
  await mode('first');
  await send('继续第一段讨论');
  const body = await app.evaluate(() => globalThis.__sessionsAudit.calls.at(-1));
  assert.ok(JSON.stringify(body).includes('英语备课'));
  assert.ok(!JSON.stringify(body).includes('第二段合成答复'));
  report.gates.push(
    'sidebar entry, separate sessions, switching, draft and selection preservation, no context contamination',
  );
  await nav('会话管理').click();
  await button(`重命名 ${first.title}`).click();
  await page
    .getByRole('dialog', { name: '重命名会话' })
    .getByLabel('会话名称')
    .fill('英语备课记录');
  await button('保存名称').click();
  await page.getByRole('article', { name: '英语备课记录', exact: true }).waitFor();
  await page.getByLabel('搜索会话').fill('英语');
  assert.equal(await page.locator('.session-item').count(), 1);
  await page.getByLabel('搜索会话').fill('');
  await button(`删除 ${second.title}`).click();
  await button('取消').click();
  assert.ok((await catalog()).some((item) => item.id === second.id));
  await button(`删除 ${second.title}`).click();
  await page
    .getByRole('dialog', { name: '删除会话' })
    .getByRole('button', { name: '删除会话', exact: true })
    .click();
  await page
    .getByRole('article', { name: second.title, exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(
    (await catalog()).some((item) => item.id === second.id),
    false,
  );
  report.gates.push('rename, search, delete cancellation and confirmed deletion');
  await page.setViewportSize({ width: 360, height: 900 });
  assert.equal(await button('召唤智能助教').count(), 0);
  await button('重命名 英语备课记录').click();
  await page.getByRole('dialog', { name: '重命名会话' }).waitFor();
  await button('取消').click();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: path.join(root, 'session-list-360.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(root, 'session-list.png'), fullPage: true });
  await page
    .getByRole('article', { name: '英语备课记录', exact: true })
    .getByRole('button', { name: '继续对话', exact: true })
    .click();
  await field().fill('关闭前最后草稿');
  // Real native close path before the 250ms debounce; no renderer-side forced save.
  await closeNormally();
  await launch();
  assert.equal(await field().inputValue(), '关闭前最后草稿');
  assert.ok((await page.locator('.conversation-thread').innerText()).includes('第一段合成答复'));
  const archiveBytes = fs.readFileSync(path.join(data, 'conversation-history', first.id + '.chat'));
  assert.ok(!archiveBytes.includes(Buffer.from('关闭前最后草稿')));
  await send('重启后继续英语备课');
  const restartedBody = await app.evaluate(() => globalThis.__sessionsAudit.calls.at(-1));
  const restored = restartedBody.messages.filter((item) =>
    item.content.includes('historical-chat-not-authorization'),
  );
  assert.ok(restored.length >= 2);
  assert.ok(!JSON.stringify(restored).includes(student.displayName));
  assert.ok(!JSON.stringify(restored).includes(student.studentNumber));
  assert.ok(restored.every((item) => !item.tool_calls && !item.reasoning_content));
  report.gates.push(
    'real native close flushes final draft, safeStorage ciphertext, restart resumes only sanitized historical context',
  );
  await app.evaluate(({ safeStorage }) => {
    globalThis.__sessionsAudit.originalEncrypt = safeStorage.encryptString;
    safeStorage.encryptString = () => {
      throw Error('Synthetic failed archive write');
    };
  });
  await field().fill('保存失败后的最新草稿');
  await page.getByText(/会话尚未保存/).waitFor();
  await field().fill('重试应保存这一份最新草稿');
  // Keep the fault active through the latest draft's 250ms autosave debounce.
  // Otherwise the automatic save can remove the retry button during Playwright's click checks.
  await page.waitForTimeout(400);
  await app.evaluate(({ safeStorage }) => {
    safeStorage.encryptString = globalThis.__sessionsAudit.originalEncrypt;
  });
  await button('重试保存').click();
  await page.getByText(/会话尚未保存/).waitFor({ state: 'detached' });
  const retried = await call('readConversationHistory', { epoch: snapshot.epoch, id: first.id });
  assert.equal(retried.state.draft, '重试应保存这一份最新草稿');
  report.gates.push('failed autosave preserves latest pending content and explicit retry saves it');
  await mode('propose');
  await send('请建立新教学班', '模型提议 · 尚未执行');
  await button('确认正式写入').waitFor();
  assert.equal(await page.getByText('安全脱敏上下文详情', { exact: true }).count(), 0);
  assert.equal(await page.getByText('完整参数与变更详情', { exact: true }).count(), 0);
  assert.equal(await page.locator('.conversation-page pre').count(), 0);
  await page.getByRole('region', { name: '变更预览' }).waitFor();
  await page.screenshot({ path: path.join(root, 'teacher-confirmation.png'), fullPage: true });
  await closeNormally();
  await launch();
  assert.equal(await button('确认正式写入').count(), 0);
  assert.equal(await button('确认执行操作').count(), 0);
  assert.equal((await call('snapshot')).classes.length, snapshot.classes.length);
  await send('之前计划暂时不执行');
  assert.equal((await call('snapshot')).classes.length, snapshot.classes.length);
  report.gates.push(
    'plain business confirmation without technical entrances; pending action never revives or executes after restart',
  );
  // An old epoch is treated like history from a replaced/restored workspace, without touching business data.
  const at = new Date().toISOString();
  const historical = {
    id: randomUUID(),
    epoch: randomUUID(),
    revision: 1,
    title: '恢复前的教学讨论',
    createdAt: at,
    updatedAt: at,
    state: {
      messages: [{ speaker: 'user', text: '恢复前的教学讨论' }],
      draft: '',
      classId: null,
      studentId: null,
    },
  };
  const encrypted = await app.evaluate(
    ({ safeStorage }, record) =>
      safeStorage.encryptString(JSON.stringify(record)).toString('base64'),
    historical,
  );
  fs.writeFileSync(
    path.join(data, 'conversation-history', historical.id + '.chat'),
    Buffer.from(encrypted, 'base64'),
    { flag: 'wx' },
  );
  await closeNormally();
  await launch();
  await nav('会话管理').click();
  await page
    .getByRole('article', { name: historical.title, exact: true })
    .getByRole('button', { name: '查看记录', exact: true })
    .click();
  await page.locator('.conversation-thread').getByText('恢复前的教学讨论').waitFor();
  assert.equal(await field().isDisabled(), true);
  assert.ok((await page.locator('.conversation-thread').innerText()).includes('恢复前的教学讨论'));
  assert.equal(await button('确认正式写入').count(), 0);
  report.gates.push(
    'history from previous workspace epoch remains readable and cannot be resumed for actions',
  );
  assert.deepEqual(report.errors, []);
  assert.equal(report.externalRequests, 0);
  await closeNormally();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (app) await closeAuditApplication(app, () => {});
  writeAuditReport(path.join(root, 'sessions-smoke-report.json'), report);
  if (process.env.CLASS_MANAGER_SESSIONS_REPORT)
    writeAuditReport(process.env.CLASS_MANAGER_SESSIONS_REPORT, report);
  console.log(JSON.stringify(report, null, 2));
}
