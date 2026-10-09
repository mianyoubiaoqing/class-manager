import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import sharp from 'sharp';
const output = resolve('output/playwright/teaching');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'cm-teaching-ui-'));
const runtime = isolatedElectronRuntime('teaching-ui-');
const packaged = process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE;
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'data'),
  TEMP: join(runtime.local, 'temp'),
  TMP: join(runtime.local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
const checks = [];
try {
  application = await electron.launch({
    executablePath: packaged ?? runtime.executablePath,
    args: packaged ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  const page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setTitle('班主任工作台 · 隔离测试'),
  );
  const call = async (method, input) =>
    page.evaluate(
      async ({ method, input }) => {
        const r = await window.classManager[method](input);
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
        return r.value;
      },
      { method, input },
    );
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  await nav.getByRole('button', { name: '教师备课', exact: true }).click();
  await page.getByRole('region', { name: '学科教学资源库', exact: true }).waitFor();
  checks.push('teaching opens the customer resource library directly');
  const teachingTools = page.getByRole('navigation', { name: '教师备课功能', exact: true });
  for (const [label, heading] of [
    ['资源平台', '资源平台'],
    ['本地备课', '从手边资料，开始一节课'],
    ['课堂与倒计时', '课堂与倒计时'],
    ['答卷建议与复核', '答卷建议与复核'],
  ]) {
    await teachingTools.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
  }
  await nav.getByRole('button', { name: '班主任管理', exact: true }).click();
  const workbench = page.getByRole('region', { name: '班主任工作台', exact: true });
  await workbench.getByRole('heading', { name: '从创建一个班级开始' }).waitFor();
  const services = workbench.getByRole('region', { name: '江西班务平台', exact: true });
  await services.getByText('江西省高中生综合素质评价', { exact: true }).waitFor();
  await services.getByText('江西省教育考试院', { exact: true }).waitFor();
  await application.evaluate(({ shell }) => {
    globalThis.__cmExternalUrls = [];
    shell.openExternal = async (url) => {
      globalThis.__cmExternalUrls.push(url);
    };
  });
  for (const label of ['江西省高中生综合素质评价', '江西省教育考试院'])
    await services
      .locator('.external-resource')
      .filter({ hasText: label })
      .getByRole('button', { name: '打开官网' })
      .click();
  assert.deepEqual(await application.evaluate(() => globalThis.__cmExternalUrls), [
    'https://gzzs.jxedu.gov.cn/login',
    'https://www.jxeea.cn/',
  ]);
  checks.push(
    'Jiangxi services appear at the dashboard bottom without requiring a class and open the correct URLs',
  );
  assert.equal(await workbench.getByRole('button', { name: '工作台首页', exact: true }).count(), 0);
  checks.push('original full workbench moved to homeroom; no duplicate homepage');
  await workbench.getByRole('button', { name: '创建班级', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新建班级', exact: true });
  await dialog.getByLabel('班级名称').fill('合成教学测试班');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const go = async (name) => {
    await workbench
      .getByRole('navigation', { name: '班主任工作台功能', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
    await workbench.getByRole('heading', { name, exact: true, level: 2 }).waitFor();
  };
  await go('学生管理');
  await workbench.getByRole('button', { name: '新增学生', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新增学生', exact: true });
  await dialog.getByLabel('姓名', { exact: true }).fill('合成学生甲');
  await dialog.getByLabel('学生编号', { exact: true }).fill('T001');
  await dialog.getByRole('button', { name: '保存学生', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await workbench.getByRole('button', { name: '合成学生甲', exact: true }).waitFor();
  let snapshot = await call('snapshot');
  const classId = snapshot.classes[0].id;
  const csv = join(root, 'roster.csv');
  writeFileSync(csv, '学生编号,姓名\r\nT001,合成学生甲\r\nT002,合成学生乙\r\nT003,合成学生丙\r\n');
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, csv);
  await workbench.getByRole('button', { name: '批量导入', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '把学生名单导入班级' });
  await dialog.getByRole('button', { name: '选择名单文件', exact: true }).click();
  await dialog.getByRole('button', { name: '确认导入 2 人', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '确认导入 2 人', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  snapshot = await call('snapshot');
  assert.equal(snapshot.students.length, 3);
  checks.push('roster import deduplicates');
  await workbench.getByRole('button', { name: '合成学生甲', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '合成学生甲 · 学生档案' });
  await dialog.getByLabel('家长姓名', { exact: true }).fill('合成家长甲');
  await dialog.getByLabel('联系电话', { exact: true }).fill('13800000000');
  await dialog.getByLabel('身高（厘米）', { exact: true }).fill('162');
  await dialog.getByRole('button', { name: '保存资料', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    (
      await call('readStudentProfile', {
        epoch: snapshot.epoch,
        studentId: snapshot.students.find((s) => s.studentNumber === 'T001').id,
      })
    ).content.guardianName,
    '合成家长甲',
  );
  checks.push('student profile');
  const addRecord = async (module, button, title, fields) => {
    await go(module);
    await workbench.getByRole('button', { name: button, exact: true }).click();
    const d = page.getByRole('dialog', { name: title, exact: true });
    for (const [label, value] of Object.entries(fields)) {
      const control = d.getByLabel(label, { exact: true });
      await control.fill(value);
    }
    await d.getByRole('button', { name: '保存', exact: true }).click();
    await d.waitFor({ state: 'hidden' });
  };
  await addRecord('违纪统计', '新增违纪记录', '新增违纪记录', {
    类型: '迟到',
    具体情况与处理: '合成测试：提醒按时到校',
    处理人: '合成老师',
  });
  checks.push('discipline');
  await addRecord('作业管理', '新增作业', '新增作业', { 科目: '数学', 作业内容: '合成练习1–3题' });
  await workbench.getByRole('button', { name: '编辑 合成练习1–3题', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑作业' });
  await dialog.getByRole('button', { name: '全部标记已交' }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  checks.push('homework submissions');
  await addRecord('请假管理', '新增请假', '新增请假', { 类型: '事假', 请假事由: '合成测试事由' });
  checks.push('leave registration');
  await addRecord('工作留痕', '新增工作留痕', '新增工作留痕', {
    类型: '课堂',
    工作标题: '合成教学记录',
    工作内容: '合成课堂跟进',
    记录人: '合成老师',
  });
  checks.push('trace');
  await addRecord('谈话记录', '新增谈话', '新增谈话', {
    类型: '学习',
    谈话内容: '合成谈话跟进',
    '后续跟进（可选）': '下周检查',
  });
  checks.push('talks');
  await go('成绩分析');
  await workbench.getByRole('button', { name: '新增考试与录入' }).click();
  dialog = page.getByRole('dialog', { name: '新增考试与录入' });
  await dialog.getByLabel('考试名称', { exact: true }).fill('合成考试一');
  for (const s of snapshot.students)
    for (const sub of ['语文', '数学', '英语'])
      await dialog
        .getByLabel(`${s.displayName} ${sub}`, { exact: true })
        .fill(s.studentNumber === 'T001' ? '88' : '75');
  await dialog.getByRole('button', { name: '确认保存全部成绩' }).click();
  await dialog.waitFor({ state: 'hidden' });
  let exams = await call('listExams', { epoch: snapshot.epoch, classId });
  assert.equal(exams.length, 1);
  checks.push('manual exam / statistics');
  await go('学生管理');
  await workbench.getByRole('button', { name: '合成学生甲', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '合成学生甲 · 学生档案' });
  await dialog.getByText('合成考试一', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('profile aggregates scores and records');
  await go('排座位');
  await workbench.getByRole('button', { name: '开始编排' }).click();
  await workbench.getByRole('button', { name: '随机编排' }).click();
  await workbench.getByRole('button', { name: '确认保存', exact: true }).click();
  await workbench.getByRole('button', { name: '调整座位', exact: true }).waitFor();
  assert.equal((await call('seatingHistory', { epoch: snapshot.epoch, classId })).length, 1);
  checks.push('seating confirmation');
  await go('家校沟通');
  await workbench.getByText('合成家长甲', { exact: true }).waitFor();
  await workbench.getByRole('button', { name: '家访记录', exact: true }).click();
  await workbench.getByRole('button', { name: '新增家访', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新增家访' });
  await dialog.getByLabel('家访情况', { exact: true }).fill('合成家访记录');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  checks.push('parent ledger / visits');
  await workbench.getByRole('button', { name: '家长会', exact: true }).click();
  await workbench.getByRole('button', { name: '新增家长会', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新增家长会' });
  await dialog.getByLabel('会议主题').fill('合成家长会');
  await dialog.getByLabel('参加人数').fill('3');
  await dialog.getByLabel('会议纪要').fill('合成纪要');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await workbench.getByRole('button', { name: '群通知', exact: true }).click();
  await workbench.getByRole('button', { name: '新增群通知草稿' }).click();
  dialog = page.getByRole('dialog', { name: '新增群通知草稿' });
  await dialog.getByLabel('通知标题').fill('合成群通知');
  await dialog.getByLabel('通知正文').fill('此为草稿，不实际发送');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  checks.push('meeting / notice drafts');
  await go('班级活动');
  await workbench.getByRole('button', { name: '新增主题班会' }).click();
  dialog = page.getByRole('dialog', { name: '新增主题班会' });
  await dialog.getByLabel('班会主题').fill('合成班会');
  await dialog.getByLabel('班会安排与记录').fill('合成安排');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await workbench.getByRole('button', { name: '活动档案', exact: true }).click();
  await workbench.getByRole('button', { name: '新增班级活动' }).click();
  dialog = page.getByRole('dialog', { name: '新增班级活动' });
  await dialog.getByLabel('活动名称').fill('合成活动');
  await dialog.getByLabel('活动记录').fill('合成活动记录');
  const photo = join(root, 'photo.png');
  const invalidPhoto = join(root, 'invalid-photo.png');
  writeFileSync(invalidPhoto, 'invalid photo content');
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, invalidPhoto);
  await dialog.getByRole('button', { name: '添加照片' }).click();
  await dialog.getByRole('alert').filter({ hasText: '照片无法读取' }).waitFor();
  writeFileSync(
    photo,
    await sharp({ create: { width: 32, height: 24, channels: 3, background: '#c2e6da' } })
      .png()
      .toBuffer(),
  );
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, photo);
  await dialog.getByRole('button', { name: '添加照片' }).click();
  await dialog.getByAltText('活动照片').waitFor();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  checks.push('activity photos');
  await workbench.getByRole('button', { name: '荣誉记录', exact: true }).click();
  await workbench.getByRole('button', { name: '新增荣誉' }).click();
  dialog = page.getByRole('dialog', { name: '新增荣誉' });
  await dialog.getByLabel('荣誉名称').fill('合成荣誉');
  await dialog.getByLabel('类型').fill('学习');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  checks.push('class meetings / awards');
  await go('待办备忘');
  await workbench.getByRole('button', { name: '新增待办' }).click();
  dialog = page.getByRole('dialog', { name: '新增待办' });
  await dialog.getByLabel('待办事项').fill('合成待办事项');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await workbench.getByRole('checkbox', { name: '完成 合成待办事项' }).check();
  await workbench.getByRole('button', { name: '班级备忘', exact: true }).click();
  await workbench.getByRole('button', { name: '新增班级备忘' }).click();
  dialog = page.getByRole('dialog', { name: '新增班级备忘' });
  await dialog.getByLabel('备忘标题').fill('合成备忘');
  await dialog.getByLabel('备忘内容（可选）').fill('合成备忘内容');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  checks.push('todos / notes');
  const files = [];
  await application.evaluate(({ dialog }, root) => {
    globalThis.__cmTeachingExports = [];
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      const path = root + '/' + options.defaultPath.split(/[\\/]/).at(-1);
      globalThis.__cmTeachingExports.push(path);
      return { canceled: false, filePath: path };
    };
  }, root);
  for (const [kind, format] of [
    ['roster', 'xlsx'],
    ['profile', 'docx'],
    ['scores', 'xlsx'],
    ['leave', 'docx'],
    ['trace', 'docx'],
    ['talk', 'docx'],
  ]) {
    const r = await call('exportTeachingReport', {
      epoch: snapshot.epoch,
      classId,
      kind,
      format,
      ...(kind === 'profile' ? { studentId: snapshot.students[0].id } : {}),
    });
    assert.ok(readFileSync(r.path).length > 500);
    files.push(r.path);
  }
  const seating = (await call('seatingHistory', { epoch: snapshot.epoch, classId }))[0];
  const image = await call('exportTeachingSeatingImage', {
    epoch: snapshot.epoch,
    versionId: seating.id,
  });
  assert.equal(readFileSync(image.path).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  checks.push('Word / Excel / PNG exports');
  const workBuddyHome = join(root, 'workbuddy-home');
  const install = join(root, 'custom apps', '教师助手');
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, 'WorkBuddy.exe'), 'synthetic executable');
  mkdirSync(join(workBuddyHome, '.workbuddy'), { recursive: true });
  const originalConfiguration = '{"mcpServers":{"other":{"command":"synthetic-other"}}}';
  writeFileSync(join(workBuddyHome, '.workbuddy', 'mcp.json'), originalConfiguration);
  await application.evaluate(
    ({ app, shell, dialog }, { path, executable }) => {
      app.setPath('home', path);
      for (const key of ['SystemRoot', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'])
        process.env[key] = path;
      globalThis.__cmWorkBuddySelections = 0;
      dialog.showOpenDialog = async () => {
        globalThis.__cmWorkBuddySelections++;
        if (globalThis.__cmWorkBuddySelections === 1) return { canceled: true, filePaths: [] };
        return { canceled: false, filePaths: [executable] };
      };
      globalThis.__cmWorkBuddyLaunches = [];
      shell.openPath = async (executable) => {
        globalThis.__cmWorkBuddyLaunches.push(executable);
        return '';
      };
    },
    { path: workBuddyHome, executable: join(install, 'WorkBuddy.exe') },
  );
  await workbench.getByRole('button', { name: '开始连接', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'WorkBuddy 桥接与确认' });
  await dialog.getByText('未检测到 WorkBuddy 桌面端', { exact: true }).waitFor();
  assert.equal(
    readFileSync(join(workBuddyHome, '.workbuddy', 'mcp.json'), 'utf8'),
    originalConfiguration,
  );
  await dialog.getByRole('button', { name: '开始连接', exact: true }).click();
  await dialog.getByText('本机 MCP 已注册，等待 WorkBuddy 连接', { exact: true }).waitFor();
  const configPath = join(workBuddyHome, '.workbuddy', 'mcp.json');
  const registeredBytes = readFileSync(configPath, 'utf8');
  const registeredConfiguration = JSON.parse(registeredBytes);
  assert.deepEqual(registeredConfiguration.mcpServers.other, { command: 'synthetic-other' });
  assert.equal(await application.evaluate(() => globalThis.__cmWorkBuddyLaunches.length), 1);
  await dialog.getByRole('button', { name: '重新检测并注册', exact: true }).click();
  await dialog.getByText('本机 MCP 已注册，等待 WorkBuddy 连接', { exact: true }).waitFor();
  assert.equal(readFileSync(configPath, 'utf8'), registeredBytes);
  assert.equal(await application.evaluate(() => globalThis.__cmWorkBuddySelections), 2);
  const connection = await call('workBuddyConnection');
  const config = registeredConfiguration.mcpServers['class-manager'];
  assert.deepEqual(config, JSON.parse(connection.configuration).mcpServers['class-manager']);
  checks.push('one-click IPC registration preserves other services and is idempotent');
  checks.push('cancelled installation chooser leaves existing MCP configuration untouched');
  checks.push(
    'custom WorkBuddy installation selection is remembered; subsequent registration needs no chooser',
  );
  const child = spawn(config.command, config.args, {
    env: { ...env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = [],
    waiters = [];
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    const r = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(r);
    else replies.push(r);
  });
  const next = () =>
    replies.length
      ? Promise.resolve(replies.shift())
      : new Promise((resolve) => waiters.push(resolve));
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'portable-smoke', version: '1' },
      },
    }) + '\n',
  );
  assert.ok((await next()).result);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await dialog.getByText('已检测到本地连接', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  checks.push('connection status updates from actual MCP traffic');
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'propose_teaching_record',
        arguments: {
          classId,
          kind: 'notes',
          expectedRevision: 0,
          content: { title: 'MCP合成方案', content: '须本地确认' },
        },
      },
    }) + '\n',
  );
  assert.ok((await next()).result);
  assert.ok(
    !(await call('listTeachingRecords', { epoch: snapshot.epoch, classId })).some(
      (r) => r.content.title === 'MCP合成方案',
    ),
  );
  await workbench.getByRole('button', { name: '待确认方案 1', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'WorkBuddy 桥接与确认' });
  await dialog.getByText('MCP合成方案', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
  await dialog.getByText('已处理方案', { exact: true }).click();
  await dialog.getByText('已执行', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  assert.ok(
    (await call('listTeachingRecords', { epoch: snapshot.epoch, classId })).some(
      (r) => r.content.title === 'MCP合成方案',
    ),
  );
  child.kill();
  reader.close();
  checks.push('packaged runtime MCP / local UI approval');
  if (packaged) {
    await application.evaluate(({ Notification, BrowserWindow }) => {
      globalThis.__cmNotificationResults = [];
      const show = Notification.prototype.show;
      Notification.prototype.show = function () {
        this.on('show', () =>
          globalThis.__cmNotificationResults.push({ status: 'shown', silent: this.silent }),
        );
        this.on('failed', (_event, message) =>
          globalThis.__cmNotificationResults.push({ status: 'failed', message }),
        );
        return show.call(this);
      };
      BrowserWindow.getAllWindows()[0].minimize();
    });
    await call('saveTeachingRecord', {
      epoch: snapshot.epoch,
      classId,
      kind: 'reminder',
      expectedRevision: 0,
      requestId: randomUUID(),
      content: {
        text: '合成系统提醒测试',
        dueAt: new Date(Date.now() + 6000).toISOString(),
        priority: 'medium',
        done: false,
      },
    });
    const deadline = Date.now() + 20000;
    let notifications = [];
    while (Date.now() < deadline && !notifications.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      notifications = await application.evaluate(() => globalThis.__cmNotificationResults);
    }
    assert.ok(
      notifications.some((n) => n.status === 'shown' && n.silent === false),
      JSON.stringify(notifications),
    );
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    checks.push('Windows notification / sound enabled / minimized');
  }
  await go('仪表盘');
  await page.screenshot({ path: join(output, 'dashboard.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'mobile.png'), fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
  );
  await page.setViewportSize({ width: 1366, height: 900 });
  checks.push('responsive layout');
  assert.deepEqual(errors, []);
  const result = { root, dataDirectory: env.CLASS_MANAGER_DATA_DIR, checks, files, errors };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes('--keep-open')) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.detach();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1366, 950),
    );
    await new Promise(() => {});
  }
} catch (error) {
  if (application) {
    const page = await application.firstWindow();
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
    console.error((await page.locator('body').innerText()).slice(-16000));
  }
  throw error;
} finally {
  await application?.close();
}
