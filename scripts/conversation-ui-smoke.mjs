import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

const parent = resolve('output/playwright/conversation18');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const executable = process.env.CLASS_MANAGER_CONVERSATION_EXECUTABLE;
const { local, executablePath } = isolatedElectronRuntime('conversation-ui-');
const runtime = executable ?? executablePath;
const temp = join(local, 'temp');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(local, 'user-data'),
  TEMP: temp,
  TMP: temp,
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
const unwrap = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const raw = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input });
const call = async (name, input) => unwrap(await raw(name, input));
const button = (name) =>
  page.getByRole('button', {
    name: name === '业务对话' ? '打开智能对话小窗' : name,
    exact: true,
  });
const heading = (name) => page.getByRole('heading', { name, exact: true });
const field = () => page.getByLabel('发送消息', { exact: true });
const calls = () => app.evaluate(() => globalThis.__conversationAudit.calls);
async function fixture(action, mode = 'success') {
  await app.evaluate((_electron, input) => Object.assign(globalThis.__conversationAudit, input), {
    action,
    mode,
    recoveryStep: 0,
  });
}
async function send(text, expected = '本轮完成') {
  await field().fill(text);
  await field().press('Enter');
  await page.waitForFunction(() => document.querySelector('#conversation-input').value === '');
  await heading(expected).waitFor();
  await button('发送').waitFor({ state: 'visible' });
  if (expected === '本轮完成')
    await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
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
    globalThis.__conversationAudit = {
      calls: [],
      externalRequests: 0,
      mode: 'success',
      action: { kind: 'reply', text: '你好，我可以帮你处理班级业务。' },
    };
    globalThis.fetch = async (url, init) => {
      const audit = globalThis.__conversationAudit,
        body = JSON.parse(init.body);
      const provider = url.startsWith('https://api.moonshot.cn/')
        ? 'kimi'
        : url.startsWith('https://ark.cn-beijing.volces.com/')
          ? 'doubao'
          : url === 'https://api.deepseek.com/chat/completions'
            ? 'deepseek'
            : undefined;
      if (
        !provider ||
        init.headers.Authorization !== `Bearer sk-synthetic-${provider}-conversation-only`
      ) {
        audit.externalRequests++;
        throw Error('Unexpected transport; no external request performed');
      }
      audit.calls.push({ provider, url, body: init.body });
      if (audit.mode === 'pending') return new Promise(() => {});
      if (audit.mode === 'server') return new Response('{}', { status: 503 });
      if (audit.mode === 'invalid') return new Response('{invalid');
      if (audit.mode === 'recovery') {
        const step = ++audit.recoveryStep;
        const message =
          step === 4
            ? { content: '已完成教学流程准备，可以继续上课。' }
            : {
                content: step === 2 ? '正在安排后续课堂步骤。' : '',
                reasoning_content: '先读取业务状态，再准备操作。',
                tool_calls: [
                  {
                    id: `recovery-${step}`,
                    type: 'function',
                    function: {
                      name: 'business_action',
                      arguments:
                        step === 2
                          ? '{"action":'
                          : JSON.stringify({
                              action:
                                step === 1
                                  ? { kind: 'query', query: 'capabilities' }
                                  : audit.action,
                            }),
                    },
                  },
                ],
              };
        const delta = message.tool_calls
          ? {
              ...message,
              tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })),
            }
          : message;
        const frame = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
        return new Response(
          frame({
            id: 'synthetic-recovery',
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: null }],
          }) +
            frame({
              id: 'synthetic-recovery',
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: step === 4 ? 'stop' : 'tool_calls' }],
            }) +
            'data: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      const last = JSON.parse(body.messages.at(-1).content);
      const action =
        last.toolResult || last.confirmedToolResult
          ? { kind: 'reply', text: '已按脱敏名册核对：50位学生在籍，可继续提问。' }
          : audit.action;
      return new Response(
        JSON.stringify({
          id: 'synthetic-conversation18-response',
          model: body.model,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  formatVersion: 1,
                  explanation: '合成业务助手回复，正式写入需确认。',
                  action,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
        }),
      );
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await button('业务对话').click();
  await field().waitFor();
  assert.equal(
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button').first().innerText(),
    '教师备课',
  );
  assert.equal(
    await page
      .getByRole('button', { name: '收起智能对话小窗', exact: true })
      .getAttribute('aria-expanded'),
    'true',
  );
}
try {
  await launch();
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('.conversation-thread').getBoundingClientRect().bottom <=
        document.querySelector('.conversation-composer').getBoundingClientRect().top,
    ),
    true,
  );
  await page.screenshot({ path: join(root, 'homepage.png'), fullPage: true });
  report.gates.push(
    'capsule opens the persistent floating conversation; sidebar starts with teaching and has no chat entry',
  );
  await openWorkspacePage(page, '班主任管理', '班级名册');
  await button('载入合成样例').click();
  await button('确认载入').click();
  await page.waitForFunction(async () => {
    const result = await window.classManager.snapshot();
    return result.ok && result.value.students.length === 100;
  });
  const snapshot = await call('snapshot'),
    classroom = snapshot.classes[0],
    student = snapshot.students.find((value) => value.classId === classroom.id);
  const surface = await page.evaluate(() => ({
    keys: Object.keys(window.classManager),
    frozen: Object.isFrozen(window.classManager),
    node: typeof window.require,
  }));
  assert.equal(surface.keys.length, 157);
  assert.equal(surface.frozen, true);
  assert.equal(surface.node, 'undefined');
  for (const provider of ['deepseek', 'kimi', 'doubao']) {
    let settings = await call('readModelSettings');
    if (provider === 'doubao')
      settings = await call('configureModelProvider', {
        provider,
        expectedRevision: settings.revision,
        textModel: 'ep-synthetic-agent18',
        visionModel: '',
      });
    settings = await call('selectModelProvider', { provider, expectedRevision: settings.revision });
    await call('saveModelProviderKey', {
      provider,
      apiKey: `sk-synthetic-${provider}-conversation-only`,
    });
    await openWorkspacePage(page, '系统设置', '模型设置');
    await button('业务对话').click();
    await page.waitForFunction(
      (provider) =>
        document.querySelector('.conversation-model-name')?.textContent?.includes(provider),
      provider === 'deepseek' ? 'DeepSeek' : provider === 'kimi' ? 'Kimi' : '豆包',
    );
    await page.getByLabel('对话当前班级', { exact: true }).selectOption(classroom.id);
    await page.getByLabel('对话当前学生', { exact: true }).selectOption(student.id);
    await fixture({ kind: 'query', query: 'roster' });
    const before = (await calls()).length;
    await send(`查看${student.displayName}所在班级的名册`);
    const captured = (await calls()).slice(before);
    assert.equal(captured.length, 2);
    assert.equal(captured[0].provider, provider);
    for (const identity of snapshot.students)
      for (const sensitive of [identity.id, identity.studentNumber, identity.displayName])
        assert.equal(captured[1].body.includes(sensitive), false, sensitive);
    assert.equal(
      JSON.parse(captured[1].body).messages.some(
        (message) => message.role === 'user' && JSON.parse(message.content).toolResult,
      ),
      true,
    );
    assert.equal(await page.getByRole('checkbox').count(), 0);
    await fixture({ kind: 'reply', text: '结合刚才的名册，可以继续分析。' });
    await send('那他们的在籍人数是多少？');
    const continued = (await calls()).at(-1);
    assert.equal(
      JSON.parse(continued.body).messages.some(
        (message) => message.role === 'user' && JSON.parse(message.content).toolResult,
      ),
      true,
    );
    assert.equal(continued.body.includes('那他们的在籍人数是多少'), true);
    const conversation = await page.getByRole('log').innerText();
    await openWorkspacePage(page, '班主任管理', '成绩管理');
    await button('业务对话').click();
    assert.equal(await page.getByRole('log').innerText(), conversation);
    await button('新对话').click();
    await heading('告诉助手，你想完成什么？').waitFor();
    await send('你好');
    assert.equal(JSON.parse((await calls()).at(-1).body).messages.length, 2);
    await fixture({ kind: 'createClass', name: `恢复流程演示-${provider}` }, 'recovery');
    const beforeRecovery = (await calls()).length;
    await send('帮我走一遍上课流程，先准备演示班级', '模型提议 · 尚未执行');
    assert.equal((await calls()).length - beforeRecovery, 3);
    assert.equal(
      (await call('snapshot')).classes.some((item) => item.name === `恢复流程演示-${provider}`),
      false,
    );
    const repaired = JSON.parse((await calls()).at(-1).body).messages;
    assert.equal(JSON.parse(repaired.at(-1).content).toolResult.executed, false);
    assert.equal(repaired.at(-1).tool_call_id, 'recovery-2');
    await button('确认正式写入').click();
    await heading('本轮完成').waitFor();
    await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
    assert.equal((await calls()).length - beforeRecovery, 4);
    assert.equal(
      (await call('snapshot')).classes.filter((item) => item.name === `恢复流程演示-${provider}`)
        .length,
      1,
    );
    const rendered = await page.getByRole('log').innerText();
    assert.equal(rendered.includes('已完成教学流程准备'), true);
    assert.equal(rendered.includes('完整JSON'), false);
    assert.equal(rendered.includes('脱敏上下文'), false);
    report.gates.push(
      `${provider}: SSE malformed arguments self-correct, fresh write confirmation and automatic continuation without another teacher message`,
    );
    report.gates.push(
      `${provider}: direct send, automatic redacted tools, follow-up memory, sidebar return and new conversation`,
    );
  }
  await fixture({ kind: 'query', query: 'capabilities' });
  await send('查看整个应用的功能与工具目录');
  let feedback = JSON.parse(
    JSON.parse((await calls()).at(-1).body).messages.at(-1).content,
  ).toolResult;
  assert.equal(feedback.data.features.length, 14);
  for (const tool of [
    'readStudentProfile',
    'readAttendanceRoster',
    'saveStudentProfile',
    'saveAttendance',
  ])
    assert.equal(
      feedback.data.tools.some((entry) => entry.tool === tool),
      true,
      tool,
    );
  assert.equal(
    feedback.data.tools.some((tool) => tool.tool === 'readScoreVersion' && tool.mode === 'read'),
    true,
  );
  assert.equal(
    feedback.data.tools.some((tool) => tool.tool === 'controlClassroom' && tool.mode === 'confirm'),
    true,
  );
  await fixture({
    kind: 'tool',
    tool: 'snapshot',
    args: {},
    result: { path: ['students'], offset: 90, limit: 10 },
  });
  await send('读取名册后续页');
  const parsed = JSON.parse(
    JSON.parse((await calls()).at(-1).body).messages.at(-1).content,
  ).toolResult;
  feedback = parsed.cachedResult?.toolResult ?? parsed;
  assert.equal(feedback.data.total, 100);
  assert.equal(feedback.data.items.length, 10);
  assert.equal(feedback.data.nextOffset, null);
  for (const identity of snapshot.students)
    for (const sensitive of [identity.id, identity.studentNumber, identity.displayName])
      assert.equal((await calls()).at(-1).body.includes(sensitive), false);
  await fixture({
    kind: 'tool',
    tool: 'saveStudent',
    args: { classId: '[班级1]', studentNumber: 'SYN-TOOLS', displayName: '工具新增合成学生' },
  });
  await field().fill('新增工具测试合成学生');
  await button('发送').click();
  await heading('模型提议 · 尚未执行').waitFor();
  assert.equal(await button('确认执行操作').isDisabled(), false);
  assert.equal(
    (await call('snapshot')).students.some((item) => item.studentNumber === 'SYN-TOOLS'),
    false,
  );
  assert.equal((await page.getByRole('log').innerText()).includes(classroom.name), true);
  await page.setViewportSize({ width: 360, height: 780 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({
    path: join(root, 'application-tool-confirmation-360.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  assert.equal(await page.getByRole('checkbox').count(), 0);
  await button('确认执行操作').click();
  await heading('本轮完成').waitFor();
  assert.equal(
    (await call('snapshot')).students.some((item) => item.studentNumber === 'SYN-TOOLS'),
    true,
  );
  await button('查看任务进展').click();
  await heading('本轮完成').waitFor();
  assert.equal(
    (await call('snapshot')).students.filter((item) => item.studentNumber === 'SYN-TOOLS').length,
    1,
  );
  await fixture({ kind: 'reply', text: '已收到新增合成学生的业务回执。' });
  await send('确认刚才操作结果');
  assert.equal((await calls()).at(-1).body.includes('SYN-TOOLS'), false);
  report.gates.push(
    'full application capability discovery, later roster page, generic tool write confirmation, real SQLite receipt, repeat receipt and newly recognized identity redaction',
  );
  await fixture({ kind: 'setStudentActive', active: false });
  await page.getByLabel('对话当前班级', { exact: true }).selectOption(classroom.id);
  await page.getByLabel('对话当前学生', { exact: true }).selectOption(student.id);
  await field().fill('停用当前学生');
  await button('发送').click();
  await heading('模型提议 · 尚未执行').waitFor();
  assert.equal(
    (await call('snapshot')).students.find((value) => value.id === student.id).active,
    true,
  );
  assert.equal(await button('确认正式写入').isDisabled(), false);
  assert.equal(
    await page
      .getByRole('log')
      .innerText()
      .then((text) => text.includes(student.displayName)),
    true,
  );
  await page.screenshot({ path: join(root, 'write-confirmation.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: join(root, 'write-confirmation-360.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  assert.equal(await page.getByRole('checkbox').count(), 0);
  await button('确认正式写入').click();
  await heading('本轮完成').waitFor();
  assert.equal(
    (await call('snapshot')).students.find((value) => value.id === student.id).active,
    false,
  );
  await button('查看任务进展').click();
  await heading('本轮完成').waitFor();
  report.gates.push(
    'explicit real-object write confirmation, actual Worker/SQLite receipt and narrow layout',
  );
  // Main真正完成生成，仅丢弃返回Renderer的回包；回读必须显示答复且不再收费。
  for (const loseRead of [false, true]) {
    await fixture({ kind: 'reply', text: `丢回包后恢复的答复${loseRead}` });
    const count = (await calls()).length;
    await app.evaluate(({ ipcMain }, loseRead) => {
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('cm:generateConversation');
      handlers.set('cm:generateConversation', async (...args) => {
        handlers.set('cm:generateConversation', original);
        const result = await original(...args);
        if (!result.ok || result.value.status !== 'completed') throw Error('Main did not complete');
        throw Error('Synthetic lost generation reply');
      });
      if (loseRead) {
        const read = handlers.get('cm:readConversation');
        handlers.set('cm:readConversation', async () => {
          handlers.set('cm:readConversation', read);
          throw Error('Synthetic lost first recovery reply');
        });
      }
    }, loseRead);
    await field().fill(`合成丢回包验证${loseRead}`);
    await button('发送').click();
    await page.getByRole('alert').waitFor();
    await page.waitForFunction(
      () => !document.querySelector('.conversation-actions button:last-child').disabled,
    );
    if (loseRead) await button('查看任务进展').click();
    await heading('本轮完成').waitFor();
    assert.equal(
      await page
        .locator('.conversation-message.assistant')
        .filter({ hasText: `丢回包后恢复的答复${loseRead}` })
        .count(),
      1,
    );
    await button('查看任务进展').click();
    await page.waitForFunction(
      () => !document.querySelector('.conversation-actions button:last-child').disabled,
    );
    assert.equal(
      await page
        .locator('.conversation-message.assistant')
        .filter({ hasText: `丢回包后恢复的答复${loseRead}` })
        .count(),
      1,
    );
    assert.equal((await calls()).length, count + 1);
  }
  report.gates.push(
    'lost generation reply recovered automatically or by read, answer displayed once without another model request',
  );
  await fixture({ kind: 'createClass', name: '不应自动创建' });
  await field().fill('创建一个班级');
  await button('发送').click();
  await heading('模型提议 · 尚未执行').waitFor();
  await button('取消当前任务').click();
  await heading('已取消').waitFor();
  assert.equal(
    (await call('snapshot')).classes.some((value) => value.name === '不应自动创建'),
    false,
  );
  await fixture({ kind: 'query', query: 'roster' }, 'pending');
  await field().fill('查看名册');
  await button('发送').click();
  await heading('理解需求中').waitFor();
  await page.waitForFunction(
    () => globalThis === window && !document.querySelector('.conversation-actions button').disabled,
  );
  await button('取消当前任务').click();
  await heading('已取消').waitFor();
  await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
  for (const mode of ['server', 'invalid']) {
    await fixture({ kind: 'query', query: 'roster' }, mode);
    const count = (await calls()).length;
    await send('合成错误场景', '本轮暂停 · 查看原因');
    assert.equal((await calls()).length, count + (mode === 'invalid' ? 6 : 1));
  }
  report.gates.push(
    'Cancelled writes do not execute; HTTP errors stop after one request; invalid model responses stop after the initial request and five retries',
  );
  await fixture({ kind: 'reply', text: '最终合成对话截图。' });
  await send('请继续正常对话');
  const layout = await page.evaluate(() => ({
    composerBottom: document.querySelector('.conversation-composer').getBoundingClientRect().bottom,
    viewport: innerHeight,
  }));
  assert.ok(
    layout.composerBottom <= layout.viewport + 1,
    'Global notices must not push the composer outside the viewport',
  );
  await page.screenshot({ path: join(root, 'final-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: join(root, 'final-360.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  report.calls = await calls();
  report.externalRequests = await app.evaluate(
    () => globalThis.__conversationAudit.externalRequests,
  );
  assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.errors, []);
  writeFileSync(join(root, 'final-ui.yml'), await page.locator('body').ariaSnapshot());
  await closeAuditApplication(app, () => {});
  app = undefined;
  report.shutdownVerified = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (app)
    try {
      await closeAuditApplication(app, () => {});
    } catch (error) {
      report.closeError = String(error);
      report.status = 'failed';
      process.exitCode = 1;
    }
  writeAuditReport(join(root, 'report.json'), report);
}
console.log(
  JSON.stringify({
    status: report.status,
    root,
    packaged: report.packaged,
    gates: report.gates,
    failure: report.failure,
  }),
);
