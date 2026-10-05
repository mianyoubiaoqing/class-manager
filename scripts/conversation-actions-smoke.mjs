import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { buildSync } from 'esbuild';
import { _electron as electron } from 'playwright';
import { closeAuditApplication } from './live-audit-guards.ts';
import { nodeBundleOptions } from './node-bundle-options.ts';
import { applicationToolNames } from '../src/shared/application-tools.ts';

const stateFile = process.env.CLASS_MANAGER_ACTION_RELEASE;
const state = stateFile ? JSON.parse(fs.readFileSync(stateFile)) : null;
const root = state ? state.root : fs.mkdtempSync(path.resolve('output', 'agent-actions-'));
const manifest = state
  ? JSON.parse(fs.readFileSync(path.join(root, 'package-manifest.json')))
  : null;
const data = fs.mkdtempSync(path.join(root, 'actions-data-'));
const fixturePath = path.join(root, 'actions-fixture.json');
const fixtureScript = path.join(root, 'actions-fixture.cjs');
const exportBase = path.join(process.env.USERPROFILE, 'ClassManagerTestExports');
fs.mkdirSync(exportBase, { recursive: true });
const exports = fs.mkdtempSync(path.join(exportBase, 'agent-actions-'));
const runtime = manifest ? manifest.executable : path.join(exports, 'runtime', 'electron.exe');
if (!manifest)
  fs.cpSync(path.resolve('node_modules/electron/dist'), path.dirname(runtime), { recursive: true });
buildSync(
  nodeBundleOptions({
    entryPoints: ['tests/fixtures/conversation-actions.ts'],
    outfile: fixtureScript,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'external',
  }),
);
const temp = path.join(root, 'check-temp');
fs.mkdirSync(temp, { recursive: true });
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: data, TEMP: temp, TMP: temp };
delete env.ELECTRON_RUN_AS_NODE;
const seeded = spawnSync('rtk', ['proxy', 'node', fixtureScript, data, fixturePath], {
  env,
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(seeded.status, 0, seeded.stderr);
const fixture = JSON.parse(fs.readFileSync(fixturePath));
const report = {
  status: 'running',
  packaged: !!manifest,
  externalRequests: 0,
  gates: [],
  exports,
  errors: [],
};
let app, page;
const unwrap = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const call = async (name, input) =>
  unwrap(
    await page.evaluate(({ name, input }) => window.classManager[name](input), { name, input }),
  );
const tool = (name, args = {}, result) => ({
  kind: 'tool',
  tool: name,
  args,
  ...(result ? { result } : {}),
});
const query = (query, tool) => ({ kind: 'query', query, ...(tool ? { tool } : {}) });
const ref = (tool, property) => `$read:${tool}.${property}`;
const button = (name) => page.getByRole('button', { name, exact: true });
async function launch() {
  app = await electron.launch({
    executablePath: runtime,
    args: manifest ? [] : [path.resolve('.')],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  await app.evaluate(({ dialog, Menu }) => {
    globalThis.__actionsAudit = {
      step: 0,
      plan: [],
      results: {},
      requests: [],
      externalRequests: 0,
      savePath: null,
      openPath: null,
      printMenu: null,
      printCalls: 0,
    };
    const buildMenu = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = buildMenu(template);
      globalThis.__actionsAudit.printMenu = menu;
      return menu;
    };
    dialog.showSaveDialog = async () => ({
      canceled: !globalThis.__actionsAudit.savePath,
      filePath: globalThis.__actionsAudit.savePath ?? undefined,
    });
    dialog.showOpenDialog = async () => ({
      canceled: !globalThis.__actionsAudit.openPath,
      filePaths: globalThis.__actionsAudit.openPath ? [globalThis.__actionsAudit.openPath] : [],
    });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    globalThis.fetch = async (url, init) => {
      const audit = globalThis.__actionsAudit;
      if (
        url !== 'https://api.deepseek.com/chat/completions' ||
        init.headers.Authorization !== 'Bearer sk-synthetic-actions-only'
      ) {
        audit.externalRequests++;
        throw Error('External transport prohibited');
      }
      const body = JSON.parse(init.body);
      audit.requests.push(body);
      for (const message of body.messages) {
        let item;
        try {
          item = JSON.parse(message.content);
        } catch {
          continue;
        }
        if (item.toolResult)
          audit.results[item.toolResult.tool ?? item.toolResult.query] = item.toolResult.data;
        if (item.confirmedToolResult) {
          const name = item.confirmedToolResult.message.match(/已获得 (\w+) 的业务回执/)?.[1];
          if (name) audit.results[name] = item.confirmedToolResult.data;
        }
      }
      const resolve = (value) => {
        if (typeof value === 'string' && value.startsWith('$read:')) {
          const [name, ...parts] = value.slice(6).split('.');
          let current = audit.results[name];
          for (const part of parts) current = current?.[part];
          if (current === undefined) throw Error('Missing synthetic reference: ' + value);
          return current;
        }
        if (Array.isArray(value)) return value.map(resolve);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, resolve(item)]),
          );
        return value;
      };
      const next =
        audit.plan[audit.step++] ??
        (JSON.parse(body.messages.at(-1).content).confirmedToolResult
          ? { kind: 'reply', text: '已核对成功回执，本轮操作完成。' }
          : undefined);
      if (!next)
        throw Error('Synthetic plan exhausted; last feedback: ' + JSON.stringify(audit.results));
      const action = resolve(next);
      if (action.kind === 'streamed-prose') {
        audit.streamBody = action.text;
        return new Response(
          new ReadableStream({
            start(controller) {
              audit.streamController = controller;
              const frame = (delta, finish_reason = null) =>
                new TextEncoder().encode(
                  'data: ' +
                    JSON.stringify({
                      id: 'synthetic-live-plan',
                      model: body.model,
                      choices: [{ index: 0, delta, finish_reason }],
                    }) +
                    '\n\n',
                );
              controller.enqueue(frame({ reasoning_content: '读取教师需求并组织教学步骤。' }));
              controller.enqueue(frame({ content: action.text }));
              audit.finishStream = () => {
                controller.enqueue(frame({}, 'stop'));
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                controller.close();
              };
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'synthetic-actions-response',
          model: body.model,
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: '',
                reasoning_content: '读取所需参数，按顺序处理业务；正式操作等待教师确认。',
                tool_calls: (action.kind === 'native-batch' ? action.actions : [action]).map(
                  (item, index) => ({
                    id: 'synthetic-native-' + audit.requests.length + '-' + index,
                    type: 'function',
                    function: {
                      name: item.kind === 'document' ? 'present_document' : 'business_action',
                      arguments: JSON.stringify(
                        item.kind === 'document'
                          ? item.document
                          : {
                              explanation: '合成业务操作，核对后确认执行。',
                              action: item,
                            },
                      ),
                    },
                  }),
                ),
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
        }),
      );
    };
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
}
async function propose(name, plan, savePath = null, openPath = null) {
  await app.evaluate(
    (_electron, options) => Object.assign(globalThis.__actionsAudit, { ...options, step: 0 }),
    { plan, savePath, openPath },
  );
  await page.getByLabel('发送消息', { exact: true }).fill(name);
  await button('发送').click();
  await page.getByRole('heading', { name: '模型提议 · 尚未执行', exact: true }).waitFor();
  assert.equal(await button('确认执行操作').isDisabled(), false);
  await page.getByRole('region', { name: '变更预览' }).waitFor();
  assert.equal(await page.getByText('安全脱敏上下文详情', { exact: true }).count(), 0);
  assert.equal(await page.getByText('完整参数与变更详情', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 360, height: 780 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    name + ' confirmation overflow',
  );
  await page.screenshot({
    path: path.join(root, `actions-${report.gates.length}-confirmation.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
}
async function confirm(name) {
  assert.equal(await page.getByRole('checkbox').count(), 0);
  await button('确认执行操作').click();
  if (name.startsWith('restore:'))
    await page.getByText('工作区已恢复，旧对话上下文已清空。', { exact: true }).waitFor();
  else await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('#conversation-input');
    return input && !input.disabled;
  });
  report.gates.push(name);
}
async function print(name, versionRef, destination) {
  await propose(name, [tool(name, { versionId: versionRef })], destination);
  assert.equal(await page.getByRole('checkbox').count(), 0);
  const opening = app.waitForEvent('window');
  await button('确认执行操作').click();
  const preview = await opening;
  await preview.locator('.sheet').first().waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const owned = BrowserWindow.getAllWindows().find((window) =>
      window.getTitle().includes('打印预览'),
    );
    if (!owned) throw Error('Owned print preview missing');
    owned.webContents.print = (_options, done) => {
      globalThis.__actionsAudit.printCalls++;
      done(true);
    };
    globalThis.__actionsAudit.printMenu.items[0].submenu.items[1].click();
  });
  await page.waitForTimeout(100);
  await app.evaluate(async () => {
    for (let i = 0; i < 300; i++) {
      if (globalThis.__actionsAudit.printMenu.items[0].submenu.items[0].enabled) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error('PDF export did not finish');
  });
  assert.equal(fs.existsSync(destination), true);
  assert.equal(fs.readFileSync(destination).subarray(0, 4).toString(), '%PDF');
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__actionsAudit.printMenu.items[0].submenu.items[0].click();
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle().includes('打印预览'))
      .close();
  });
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
  report.gates.push(name + ': actual PDF export and simulated OS print acknowledgment');
}
try {
  await launch();
  await call('saveModelProviderKey', { provider: 'deepseek', apiKey: 'sk-synthetic-actions-only' });
  await button('模型设置').first().click();
  await button('业务对话').click();
  const snapshotBeforeCapabilities = await call('snapshot');
  await app.evaluate(() =>
    Object.assign(globalThis.__actionsAudit, {
      step: 0,
      plan: [{ kind: 'reply', text: '你好，可以继续提问。' }],
    }),
  );
  await page.getByLabel('发送消息', { exact: true }).fill('你好');
  await button('发送').click();
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
  const capabilitiesPlan = [];
  for (let offset = 0; offset < applicationToolNames.length; offset += 8)
    capabilitiesPlan.push({
      kind: 'native-batch',
      actions: applicationToolNames
        .slice(offset, offset + 8)
        .map((name) => query('capabilities', name)),
    });
  capabilitiesPlan.push({ kind: 'reply', text: '已核对全部功能，可以继续提出业务需求。' });
  await app.evaluate(
    (_electron, plan) => Object.assign(globalThis.__actionsAudit, { step: 0, plan }),
    capabilitiesPlan,
  );
  await page.getByLabel('发送消息', { exact: true }).fill('你还有什么功能？');
  await button('发送').click();
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
  await page
    .getByText('已核对全部功能，可以继续提出业务需求。', { exact: true })
    .filter({ visible: true })
    .waitFor();
  assert.ok(
    (await app.evaluate(() =>
      Math.max(...globalThis.__actionsAudit.requests.map((item) => item.messages.length)),
    )) > 100,
  );
  const snapshotAfterCapabilities = await call('snapshot');
  assert.deepEqual(snapshotAfterCapabilities.classes, snapshotBeforeCapabilities.classes);
  assert.deepEqual(snapshotAfterCapabilities.students, snapshotBeforeCapabilities.students);
  report.gates.push(
    `capability question with prior history: ${applicationToolNames.length} metadata reads exceed 100 messages and still complete without business writes`,
  );
  await page.getByLabel('对话当前班级').selectOption(fixture.classId);
  await page.getByLabel('对话当前学生').selectOption(fixture.studentId);
  await app.evaluate(
    (_electron, options) => Object.assign(globalThis.__actionsAudit, { step: 0, plan: options }),
    [
      {
        kind: 'streamed-prose',
        text:
          '# 力的三要素教学计划\n\n' +
          '1. 导入：用生活中的推拉实例引出力。\n2. 探究：比较大小、方向和作用点。\n3. 练习与反馈：画受力示意图并解释。\n'.repeat(
            12,
          ),
      },
    ],
  );
  await page.getByLabel('发送消息', { exact: true }).fill('制定力的三要素教学计划');
  await button('发送').click();
  await page.getByLabel('流式回复').getByText('力的三要素教学计划', { exact: true }).waitFor();
  assert.equal((await call('listLessonDrafts', { epoch: fixture.epoch })).length, 0);
  await app.evaluate(() => globalThis.__actionsAudit.finishStream());
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
  await page.getByRole('article', { name: '教学计划预览', exact: true }).waitFor();
  await button('收起计划').click();
  await button('展开计划').click();
  report.gates.push(
    'actual renderer receives streamed prose before EOF and displays an interactive teaching plan',
  );
  await app.evaluate(
    (_electron, options) => Object.assign(globalThis.__actionsAudit, { step: 0, plan: options }),
    [query('capabilities', 'createLessonDraft'), tool('createLessonDraft', fixture.lesson)],
  );
  await button('确认计划并继续').click();
  await page.getByRole('heading', { name: '模型提议 · 尚未执行', exact: true }).waitFor();
  assert.equal(await button('确认执行操作').isDisabled(), false);
  await page.getByRole('article', { name: '教案与课件预览', exact: true }).waitFor();
  await page.getByRole('tab', { name: '课件预览', exact: true }).click();
  await button('下一页').click();
  await button('上一页').click();
  await page.setViewportSize({ width: 360, height: 780 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({
    path: path.join(root, 'stream-plan-courseware-360.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  report.gates.push(
    'plan confirmation button launches native thinking tool workflow and interactive paged courseware without typed confirmation',
  );
  assert.equal((await call('listLessonDrafts', { epoch: fixture.epoch })).length, 0);
  await confirm('create lesson: exact content saved after UI confirmation');
  const draft = (await call('listLessonDrafts', { epoch: fixture.epoch }))[0];
  assert.equal(
    (await call('readLessonDraft', { epoch: fixture.epoch, id: draft.record.id })).payload.provider,
    null,
  );
  await app.evaluate(
    (_electron, plan) => Object.assign(globalThis.__actionsAudit, { step: 0, plan }),
    [
      {
        kind: 'native-batch',
        actions: [
          query('classes'),
          query('roster'),
          {
            kind: 'document',
            document: { kind: 'teaching-plan', title: '批量教学计划', body: '先演示再分组探究。' },
          },
          {
            kind: 'document',
            document: {
              kind: 'courseware',
              title: '批量课件方案',
              body: '第一页：问题；第二页：实践。',
            },
          },
        ],
      },
    ],
  );
  await page.getByLabel('发送消息', { exact: true }).fill('读取班级和名册，展示教学计划与课件方案');
  await button('发送').click();
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#conversation-input').disabled);
  await page.getByRole('heading', { name: '批量教学计划', exact: true }).waitFor();
  await page.getByRole('heading', { name: '批量课件方案', exact: true }).waitFor();
  report.gates.push('native batch: ordered reads and both document cards displayed');
  const snapshotBeforeBatch = await call('snapshot');
  // Use an unrelated synthetic member so grading/growth source revisions stay valid.
  const batchStudentIndex = snapshotBeforeBatch.students.findIndex(
    (item) => item.id !== fixture.studentId,
  );
  const batchStudentId = snapshotBeforeBatch.students[batchStudentIndex].id;
  const studentRef = `[学生${batchStudentIndex + 1}]`;
  const studentBefore = snapshotBeforeBatch.students[batchStudentIndex];
  assert.equal(studentBefore.active, true);
  await propose('分两步修改在籍状态，每一步单独确认', [
    {
      kind: 'native-batch',
      actions: [
        tool('setStudentActive', { id: studentRef, active: false }),
        tool('setStudentActive', { id: studentRef, active: true }),
        query('roster'),
      ],
    },
    { kind: 'reply', text: '两次确认已完成，已读取最新名册。' },
  ]);
  assert.equal(
    (await call('snapshot')).students.find((item) => item.id === batchStudentId).revision,
    studentBefore.revision,
  );
  await button('确认执行操作').click();
  await page.getByRole('heading', { name: '模型提议 · 尚未执行', exact: true }).waitFor();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('button')).some(
      (item) => item.textContent === '确认执行操作' && !item.disabled,
    ),
  );
  const studentAfterFirst = (await call('snapshot')).students.find(
    (item) => item.id === batchStudentId,
  );
  assert.equal(studentAfterFirst.active, false);
  assert.equal(studentAfterFirst.revision, studentBefore.revision + 1);
  report.gates.push('native batch: first confirmation commits only the first operation');
  await confirm(
    'native batch: second confirmation commits the next operation and reads updated data',
  );
  const studentAfterSecond = (await call('snapshot')).students.find(
    (item) => item.id === batchStudentId,
  );
  assert.equal(studentAfterSecond.active, true);
  assert.equal(studentAfterSecond.revision, studentBefore.revision + 2);
  const batchHistory = await app.evaluate(() => globalThis.__actionsAudit.requests.at(-1).messages);
  const batchMessages = batchHistory.filter((message) => message.tool_calls?.length > 1);
  // Long-context history also retains earlier capability batches.
  assert.ok(batchMessages.length >= 2);
  assert.equal(batchMessages.at(-1).tool_calls.length, 3);
  for (const assistant of batchMessages) {
    const index = batchHistory.indexOf(assistant);
    assert.deepEqual(
      batchHistory
        .slice(index + 1, index + 1 + assistant.tool_calls.length)
        .map((message) => ({ role: message.role, id: message.tool_call_id })),
      assistant.tool_calls.map((call) => ({ role: 'tool', id: call.id })),
    );
  }
  const requestsBeforeContinuation = await app.evaluate(
    () => globalThis.__actionsAudit.requests.length,
  );
  await propose('修改在籍状态后读取名册，再提出下一步恢复，逐项确认', [
    tool('setStudentActive', { id: studentRef, active: false }),
    query('roster'),
    tool('setStudentActive', { id: studentRef, active: true }),
    { kind: 'reply', text: '两步操作已完成，最新名册已核对。' },
  ]);
  await button('确认执行操作').click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('button')).some(
      (item) => item.textContent === '确认执行操作' && !item.disabled,
    ),
  );
  const studentAfterContinuation = (await call('snapshot')).students.find(
    (item) => item.id === batchStudentId,
  );
  assert.equal(studentAfterContinuation.active, false);
  assert.equal(studentAfterContinuation.revision, studentAfterSecond.revision + 1);
  assert.equal(
    await app.evaluate(() => globalThis.__actionsAudit.requests.length),
    requestsBeforeContinuation + 3,
  );
  assert.equal(await page.getByLabel('发送消息', { exact: true }).inputValue(), '');
  report.gates.push(
    'single confirmation: empty queue automatically replans, reads roster and proposes next write without a user message',
  );
  await confirm('single confirmation: next write requires its own confirmation and then finishes');
  const studentAfterContinuationFinished = (await call('snapshot')).students.find(
    (item) => item.id === batchStudentId,
  );
  assert.equal(studentAfterContinuationFinished.active, true);
  assert.equal(studentAfterContinuationFinished.revision, studentAfterSecond.revision + 2);
  assert.equal(
    await app.evaluate(() => globalThis.__actionsAudit.requests.length),
    requestsBeforeContinuation + 4,
  );
  await propose('冻结这个课时', [
    query('lessons'),
    tool('readLessonDraft', { id: ref('lessons', '0.record.id') }),
    tool('freezeLessonDraft', { id: ref('readLessonDraft', 'record.id'), reason: '确认课时' }),
  ]);
  await confirm('freeze lesson: actual immutable version');
  const version = (await call('lessonHistory', { epoch: fixture.epoch, id: draft.record.id }))[0];
  await propose('创建课堂', [
    tool('readLessonVersion', { versionId: ref('freezeLessonDraft', 'versionId') }),
    tool('createClassroom', {
      versionId: ref('readLessonVersion', 'record.id'),
      classId: '[班级1]',
      slideIds: [
        ref('readLessonVersion', 'payload.content.slides.0.id'),
        ref('readLessonVersion', 'payload.content.slides.1.id'),
      ],
      acknowledgeScope: true,
    }),
  ]);
  await confirm('create classroom: bound to saved lesson version');
  await propose('显示答案', [
    query('classroom'),
    tool('readClassroom', { id: ref('classroom', 'items.0.record.id') }),
    tool('controlClassroom', {
      id: ref('readClassroom', 'record.id'),
      action: 'answers',
      visible: true,
    }),
  ]);
  await confirm('control classroom: answers visibility persisted');
  const classroom = (await call('listClassrooms', { epoch: fixture.epoch })).items[0];
  assert.equal(classroom.record.payload.answersVisible, true);
  await propose('切换下一张课件', [
    tool('readClassroom', { id: ref('readClassroom', 'record.id') }),
    tool('controlClassroom', { id: ref('readClassroom', 'record.id'), action: 'next' }),
  ]);
  await confirm('classroom next: real persisted slide progress');
  assert.equal(
    (await call('readClassroom', { epoch: fixture.epoch, id: classroom.record.id })).record.payload
      .index,
    1,
  );
  await propose('打开课堂展示', [
    tool('openClassroomDisplay', { id: ref('readClassroom', 'record.id') }),
  ]);
  await confirm('open classroom display: actual separate window');
  assert.equal(app.windows().length, 2);
  await propose('关闭课堂展示', [tool('closeClassroomDisplay')]);
  await confirm('close classroom display');
  await propose('确认成长总结', [
    query('growth'),
    tool('readGrowthSummary', { id: ref('growth', 'summaries.0.record.id') }),
    tool('editGrowthSummary', {
      id: ref('readGrowthSummary', 'record.id'),
      content: '已完成课堂任务；继续观察学习情况。',
    }),
  ]);
  await confirm('summary review: confirmed draft edit');
  await propose('将复核总结正式确认', [
    tool('readGrowthSummary', { id: ref('editGrowthSummary', 'id') }),
    tool('confirmGrowthSummary', {
      id: ref('readGrowthSummary', 'record.id'),
      reason: '确认阶段事实',
      acknowledgeReviewed: true,
      acknowledgeSources: true,
    }),
  ]);
  await confirm('confirm summary: formal growth entry');
  assert.ok(
    (await call('readGrowthSummary', { epoch: fixture.epoch, id: fixture.summaryId })).entryId,
  );
  const edits = fixture.edits.map((edit) => ({
    ...edit,
    evidence: edit.evidence.map((item) => ({
      ...item,
      pageId: ref('readGrading', 'payload.request.pages.0.id'),
    })),
  }));
  await propose('保存答卷人工复核', [
    query('grading'),
    tool('readGrading', { id: ref('grading', '0.gradings.0.record.id') }),
    tool('editGrading', { id: ref('readGrading', 'record.id'), edits }),
  ]);
  await confirm('grading review: actual source and score edits');
  await propose('冻结人工复核', [
    tool('readGrading', { id: ref('editGrading', 'id') }),
    tool('freezeGrading', {
      id: ref('readGrading', 'record.id'),
      reason: '完整复核',
      acknowledgeComplete: true,
    }),
  ]);
  await confirm('freeze grading: immutable reviewed result');
  await propose('正式入分', [
    tool('readGradingReview', { id: ref('freezeGrading', 'reviewId') }),
    tool('prepareScorePublication', { reviewId: ref('readGradingReview', 'record.id') }),
    tool('confirmScorePublication', {
      reviewId: ref('prepareScorePublication', 'reviewId'),
      operationRef: ref('prepareScorePublication', 'operationRef'),
      reason: '确认正式入分',
      acknowledgePublish: true,
      acknowledgeReplacement: true,
    }),
  ]);
  assert.equal(
    (await call('scoreHistory', { epoch: fixture.epoch, examId: fixture.examId })).length,
    1,
  );
  await confirm('score publication: second formal score version');
  const scores = await call('scoreHistory', { epoch: fixture.epoch, examId: fixture.examId });
  assert.equal(scores.length, 2);
  assert.equal(
    (
      await call('readScoreVersion', { epoch: fixture.epoch, versionId: scores[0].id })
    ).payload.analysis.entries.find((entry) => entry.studentId === fixture.studentId).score
      .hundredths,
    1000,
  );
  await propose('编排四百人座位', [
    tool('prepareSeating', {
      classId: '[班级1]',
      source: { kind: 'empty', layout: { rows: 20, columns: 20, unavailable: [] } },
    }),
    tool('adjustSeating', {
      operationRef: ref('prepareSeating', 'operationRef'),
      change: { kind: 'randomize' },
    }),
    tool(
      'readSeatingDraft',
      { operationRef: ref('adjustSeating', 'operationRef') },
      { path: ['draft', 'assignments'], offset: 390, limit: 10 },
    ),
    tool('confirmSeating', {
      operationRef: ref('adjustSeating', 'operationRef'),
      reason: '确认四百人编排',
    }),
  ]);
  assert.equal(
    (await call('seatingHistory', { epoch: fixture.epoch, classId: fixture.classId })).length,
    0,
  );
  await confirm('large seating: prepare, adjust, read later draft page and confirm 400 positions');
  const seat = (
    await call('seatingHistory', { epoch: fixture.epoch, classId: fixture.classId })
  )[0];
  const positions = (await call('readSeatingVersion', { epoch: fixture.epoch, versionId: seat.id }))
    .payload.arrangement.assignments;
  assert.equal(positions.length, 400);
  assert.equal(new Set(positions.map((item) => `${item.row}:${item.column}`)).size, 400);
  const dates = Array.from({ length: 100 }, (_, i) =>
    new Date(Date.now() + (i + 1) * 86400000).toISOString().slice(0, 10),
  );
  await propose('准备百日值日轮换', [
    tool('snapshot', {}, { path: ['students'], limit: 50 }),
    tool('prepareDuty', {
      classId: '[班级1]',
      source: {
        kind: 'new',
        title: '百日合成值日',
        participantIds: Array.from({ length: 50 }, (_, i) => ref('snapshot', `items.${i}.id`)),
        groupCount: 5,
        dates,
        posts: [{ id: '$new', name: '教室清扫', startMinute: 960, endMinute: 990, required: 5 }],
        unavailable: [],
      },
    }),
    tool('adjustDuty', {
      operationRef: ref('prepareDuty', 'operationRef'),
      change: { kind: 'rotate' },
    }),
    tool(
      'readDutyDraft',
      { operationRef: ref('adjustDuty', 'operationRef') },
      { path: ['draft', 'days'], offset: 90, limit: 10 },
    ),
    tool('confirmDuty', {
      operationRef: ref('adjustDuty', 'operationRef'),
      reason: '确认百日轮换',
    }),
  ]);
  await confirm('large duty: rotate, read later draft days and save 100 dates');
  const duty = (await call('listDutyPlans', { epoch: fixture.epoch, classId: fixture.classId }))[0];
  assert.equal(
    (await call('readDutyVersion', { epoch: fixture.epoch, versionId: duty.latestVersionId }))
      .payload.arrangement.days.length,
    100,
  );
  await print(
    'previewSeatingPrint',
    ref('confirmSeating', 'versionId'),
    path.join(exports, 'seating.pdf'),
  );
  await print('previewDutyPrint', ref('confirmDuty', 'versionId'), path.join(exports, 'duty.pdf'));
  for (const format of ['docx', 'pptx']) {
    const destination = path.join(exports, 'lesson.' + format);
    await propose(
      '导出' + format,
      [
        tool('exportLessonOffice', {
          versionId: ref('freezeLessonDraft', 'versionId'),
          format,
          includeAnswers: true,
          includeTeacherNotes: false,
        }),
      ],
      destination,
    );
    await confirm('actual Office export: ' + format);
    assert.equal(fs.readFileSync(destination).subarray(0, 2).toString(), 'PK');
  }
  const backup = path.join(exports, 'verified.cmbackup');
  const expectedClassroom = await call('readClassroom', {
    epoch: fixture.epoch,
    id: classroom.record.id,
  });
  await propose('备份当前工作区', [tool('saveBackup')], backup);
  assert.equal(fs.existsSync(backup), false);
  await confirm('backup: actual complete file');
  await propose('新增临时班以验证恢复', [tool('createClass', { name: '恢复后应消失' })]);
  await confirm('temporary class for restore regression');
  await propose('选择刚才的备份', [tool('previewRestore')], null, backup);
  await confirm('restore preview: selected backup, validated counts, no restore yet');
  assert.equal((await call('snapshot')).classes.length, 2);
  await propose('确认恢复到备份', [
    tool('commitRestore', { operationRef: ref('previewRestore', 'operationRef') }),
  ]);
  await confirm('restore: confirmed actual workspace replacement');
  const restored = await call('snapshot');
  assert.notEqual(restored.epoch, fixture.epoch);
  assert.equal(restored.classes.length, 1);
  report.externalRequests = await app.evaluate(() => globalThis.__actionsAudit.externalRequests);
  report.modelCalls = await app.evaluate(() => globalThis.__actionsAudit.requests.length);
  report.printCalls = await app.evaluate(() => globalThis.__actionsAudit.printCalls);
  assert.equal(report.externalRequests, 0);
  assert.equal(report.printCalls, 2);
  assert.deepEqual(report.errors, []);
  await closeAuditApplication(app, () => {});
  app = undefined;
  await launch();
  const reopened = await call('snapshot');
  assert.equal(reopened.epoch, restored.epoch);
  assert.equal(
    (await call('seatingHistory', { epoch: reopened.epoch, classId: fixture.classId })).length,
    1,
  );
  assert.equal(
    (await call('listDutyPlans', { epoch: reopened.epoch, classId: fixture.classId })).length,
    1,
  );
  assert.equal(
    (await call('lessonHistory', { epoch: reopened.epoch, id: draft.record.id })).length,
    1,
  );
  assert.equal(
    (await call('scoreHistory', { epoch: reopened.epoch, examId: fixture.examId })).length,
    2,
  );
  assert.ok(
    (await call('readGrowthSummary', { epoch: reopened.epoch, id: fixture.summaryId })).entryId,
  );
  const reopenedClassroom = await call('readClassroom', {
    epoch: reopened.epoch,
    id: classroom.record.id,
  });
  assert.equal(reopenedClassroom.record.versionId, version.id);
  assert.deepEqual(reopenedClassroom.record.payload, expectedClassroom.record.payload);
  assert.equal(
    (await call('readLessonVersion', { epoch: reopened.epoch, versionId: version.id })).payload
      .content.title,
    fixture.lesson.content.title,
  );
  report.gates.push(
    'restart after restoration: all formal lesson, classroom, score, summary, seating and duty data retained',
  );
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(root, 'actions-failure.png') }).catch(() => {});
} finally {
  if (app)
    try {
      await closeAuditApplication(app, () => {});
    } catch (error) {
      report.status = 'failed';
      report.closeError = String(error);
      process.exitCode = 1;
    }
  fs.writeFileSync(path.join(root, 'actions-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
