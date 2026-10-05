import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import JSZip from 'jszip';

const state = JSON.parse(await fs.readFile('output/current-application-tools-release.json'));
const root = state.root;
const source = JSON.parse(await fs.readFile(path.join(root, 'source-manifest.json')));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const item of source.source)
  assert.equal(
    hash(await fs.readFile(item.file)),
    item.sha256,
    'Source changed since verification',
  );
for (const stage of [
  'check',
  'package',
  'verify-package',
  'sessions-desktop',
  'conversation-desktop',
  'general-desktop',
  'actions-desktop',
  'installer',
  'installer-delivery',
])
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, stage + '-result.json'))).exitCode,
    0,
    stage,
  );
const actions = JSON.parse(await fs.readFile(path.join(root, 'actions-smoke-report.json')));
const sessions = JSON.parse(await fs.readFile(path.join(root, 'sessions-smoke-report.json')));
assert.equal(sessions.status, 'passed');
assert.equal(sessions.packaged, true);
assert.equal(sessions.externalRequests, 0);
assert.equal(actions.status, 'passed');
assert.equal(actions.packaged, true);
assert.equal(actions.externalRequests, 0);
const delivery = JSON.parse(
  (await fs.readFile(path.join(root, 'installer-delivery.log'), 'utf8')).trim(),
);
for (const file of delivery.files) assert.equal(hash(await fs.readFile(file.file)), file.sha256);
const checksBase = path.join(process.env.USERPROFILE, 'ClassManagerSetupChecks');
await fs.mkdir(checksBase, { recursive: true });
const checks = await fs.mkdtemp(path.join(checksBase, state.releaseLabel + '-'));
const temp = path.join(checks, 'temp');
await fs.mkdir(temp);
const probe = path.join(checks, 'WizardProbe.exe');
async function run(name, args) {
  const child = spawn('rtk', args, {
    env: { ...process.env, TEMP: temp, TMP: temp },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  await fs.writeFile(path.join(root, name + '.log'), output, { flag: 'wx' });
  assert.equal(exitCode, 0, name + ': ' + output);
}
await run('compile-wizard-probe', [
  'proxy',
  path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  '/nologo',
  '/target:exe',
  '/r:System.Drawing.dll',
  '/r:System.Web.Extensions.dll',
  '/out:' + probe,
  path.resolve('scripts/installer-wizard-probe.cs'),
]);
const wizardDir = path.join(checks, 'wizard');
await run('wizard-bootstrap', [
  'proxy',
  probe,
  delivery.setup,
  path.join(checks, 'not-installed'),
  wizardDir,
  '--bootstrap',
]);
const wizard = JSON.parse(await fs.readFile(path.join(wizardDir, 'wizard-report.json')));
assert.equal(wizard.status, 'bootstrap-passed');
assert.ok(
  wizard.pages.some((page) => page.controls.some((control) => control.Text?.includes('下一步'))),
);
await fs.writeFile(
  path.join(root, 'wizard-bootstrap-report.json'),
  JSON.stringify(wizard, null, 2),
  { flag: 'wx' },
);
const checkLog = await fs.readFile(path.join(root, 'check.log'), 'utf8');
const files = Number(checkLog.match(/Test Files\s+(\d+) passed/)?.[1]);
const count = Number(checkLog.match(/Tests\s+(\d+) passed/)?.[1]);
assert.ok(files && count, 'Test totals missing from actual check log');
const name = path.basename(delivery.setup);
const entries = new Map([
  [name, await fs.readFile(delivery.setup)],
  ['Install.cmd', await fs.readFile(path.join(delivery.output, 'Install.cmd'))],
]);
const addText = (file, value) =>
  entries.set(file, Buffer.from('\uFEFF' + value.replace(/\r?\n/g, '\r\n'), 'utf8'));
addText(
  '安装说明.txt',
  `Class Manager 安装说明
版本：0.1.0 / ${state.releaseLabel}（Windows x64）

1. 将压缩包完整解压到 C 盘普通文件夹。
2. 更新前先在旧应用备份数据，保存并退出 Class Manager。
3. 双击 ${name}，按简体中文向导完成安装。
4. 默认只为当前用户安装，可选择 C 盘安装目录。
5. 从桌面或开始菜单启动。首页为业务对话，模型设置支持 DeepSeek、Kimi、豆包；使用自己的账号和型号。
6. 侧栏“会话管理”可新建、查找、切换、重命名和删除会话；聊天记录与未提交草稿加密保存在本机。

如果遇到 NSIS 临时文件错误，请保持 Install.cmd 和 Setup.exe 在同一文件夹，双击 Install.cmd。它会复制并核对安装器，为本次安装设置独立临时目录；无需修改系统 TEMP 或目录权限。
卸载保留业务资料。压缩包不含账号、密钥、真实学生数据或测试数据库。

可以直接让助手编排座位、值日，创建/修改课时，正式入分、确认总结、冻结、备份恢复、打印导出和控制课堂。正式变更会显示本地真实对象及内容，点击确认按钮即可执行。文件选择与保存位置通过系统对话框完成。
对话支持流式正文、思考状态和工具进度。教学计划可预览并点击“确认计划并继续”；结构化教案和课件可切换查看、翻页并确认保存，无需输入确认文字。计划按钮推进下一步，正式写入仍显示具体内容供确认。
同一轮多个工具调用会按顺序处理，读取自动继续，多份教学文稿可同时显示。每个正式操作单独确认，按钮只确认当前操作；取消或后续失败不会撤销已有成功回执的结果，未开始的后续操作不执行。回包不明时先查原业务，不重复提交。
确认成功后会自动把脱敏回执回传模型并继续原任务，即使之前没有排队操作也会继续规划；下一项正式操作仍单独确认，无需再发送“继续”。
恢复需先选文件并确认预览，再确认覆盖工作区；完成后开启新会话并显示恢复成功，恢复前聊天记录仅供查看。
总结先保存人工复核稿，再确认入档；入分先完成复核和冻结，再确认分数差异。若缺少前置资料，助手会先读取或提出补齐步骤。

SHA256SUMS.txt 包含交付文件校验值；delivery-manifest.json 中均为相对路径。
`,
);
addText(
  '版本与验证说明.txt',
  `Class Manager 工具错误恢复与会话管理
发布标识：${state.releaseLabel}
应用版本：0.1.0，Windows x64
日期：2026-10-04

修复与新增：
- 修复工具参数非法JSON、长度截断或schema不符时整轮中断的问题；模型收到对应错误回执后可修正并继续，原错误调用不执行。
- 自动读取/临时草案失败允许模型重试或改变方法；后续依赖操作重新规划。成功重复读取复用缓存，展示路径修正不重复执行草案修改。
- 正式操作被明确业务校验拒绝时立即重新规划，修正方案仍需新的按钮确认；成功或回执不明的正式写入不重放。
- 工具调用/回执在外发前检查配对；每任务最多4次错误修正，共享16次模型往返预算。界面显示修正进度，达到上限说明暂停原因并保留已完成结果。
- 侧栏新增“会话管理”，位于“业务对话”下方，可新建、搜索、继续、重命名和删除会话。新会话保留旧记录。
- 聊天、教学内容卡片、未提交草稿和班级/学生选择在本机加密保存；重启可继续对话。最多100段会话，每段保留最近60条可见消息。
- 自动保存串行校验版本，保存失败保留最新待存内容供重试；关闭窗口前等待最后保存完成。
- 保存内容仅为可见聊天，不含工具调用、执行令牌或待确认动作；重启不会恢复可执行的确认按钮。恢复工作区前的聊天只读查看。
- 隐藏脱敏上下文、原始参数、工具JSON及技术来源详情入口；以中文展示真实对象与“目前/确认后”变更，重要业务内容仍可核对。
- 对话协议为business-agent-v9，要求使用教师语言，历史聊天只作背景，正式操作仍需当前确认。
- 修复正常功能提问因工具消息超过100条被误报输入无效的问题：容量支持48条旧历史、16次模型往返和每批8项工具的完整预算，最多200条消息。
- 超出消息数量或1MiB上下文时显示明确的容量提示，不再把容量问题描述为用户输入错误。模型往返和业务确认预算不变。
- 修复单项操作确认后停滞的问题：每次成功确认后自动刷新并脱敏上下文，向模型提供回执，继续原任务；队列为空也会重新规划。
- 自动继续时取消或网络失败不撤销已成功操作，也不重放写入；等待刷新期间取消不会被下一次模型请求覆盖。
- 修复模型同轮返回多个工具时被错误判为 INVALID_RESPONSE 的问题；每批最多8个调用，完整校验后按模型顺序处理。
- 多个读取与临时草案自动继续；每个正式操作单独展示并确认，前一步成功后刷新对象版本再准备下一步。
- 同轮多份教学计划/课件方案保留并展示；工具回执成组配对，取消及失败后不会破坏下一轮原生工具历史。
- 已完成操作重复确认返回当前回执，不重复写入；后续取消/失败保留此前成功结果，未知写入不重放，未开始操作不执行。
- 正式操作保留完整业务内容与前后变更预览，较长名单可分组查看。
- 普通正文与Markdown不再必须包装为动作JSON；旧JSON和代码围栏兼容，业务写入参数仍独立校验。
- 三供应商对话使用SSE与原生工具调用，思考上下文留在Main内存；界面展示思考状态、正文和工具进度。
- 教学计划可收起/展开并按钮确认继续，教案/课件共享真实待保存内容，可切换视图和翻页；正式操作一键确认，不再要求复选或手打确认。
- 对话输出预算16384 token、生成超时3分钟；正文达长度上限保留已收到内容，未完整的工具参数绝不执行。
- 新建课时有真实写入接口，支持无需导入资料的结构化教案/课件；来源显示为本地/对话内容，不伪造额外模型生成记录。
- 大型座位、值日和入分预览保留 operationRef；草案可分页续读，后续调整和保存不再丢失操作句柄。
- 明确入分、总结复核/确认、冻结、备份恢复、打印导出、课堂创建/控制/投屏的操作顺序；缺少参数可在调用前修正。
- 单轮最多16次模型往返，正式操作仍需确认，失败网络请求和回包不明的写入不自动重放。
- 接入87个具名工具：40个只读、7个临时草案/预览、40个需确认动作。
- 保持现有首页、侧栏及前端优化；工具结果脱敏后才回传模型。
- 免安装及外部 WPS/Office 功能扩展仅完成调研，本包未新增便携分发、外部直接放映或同步适配器。

验证：
- 全仓检查通过：${files}个测试文件、${count}项测试，格式/类型/静态检查/构建均通过。
- 实际打包程序通过${actions.gates.length}项对话执行检查：已有历史下87项功能查询并超过100条消息完成回复、单项确认后自动规划/读取/下一步独立确认、批量读取/多文稿展示/逐项确认和最新数据回读、新建课时/冻结、课堂控制/进度/展示窗口、成长复核/确认、阅卷复核/冻结/正式入分、400人座位、100日值日、打印预览与真实PDF、真实Word/PPT、完整备份及确认恢复、恢复后重启回读。
- 打印提交使用模拟系统回调，没有使用真实打印机；PDF、Word、PPT和备份文件实际生成。
- 三供应商模拟对话和通用桌面/重启回归通过。
- 会话管理${sessions.gates.length}项实际打包检查通过：会话隔离、重命名/搜索/删除、草稿与选择保留、本机加密、原生关闭前保存、重启脱敏续聊、保存失败重试、旧确认不复活和恢复前记录只读查看。
- 新中文NSIS向导启动验证通过，安装前取消；本轮未覆盖用户已有安装。
- ASAR与构建文件、运行依赖许可、ZIP CRC及各文件SHA256核对通过。

模型传输使用确定性模拟，未调用真实付费账号；这不证明所有自然语言指令在真实模型上都会正确规划。文件导入、图片遮盖、密钥配置及额外专用AI生成仍用各自专用页面。未知自由文本敏感信息无法保证完整识别。
`,
);
const publicManifest = {
  schemaVersion: 1,
  version: '0.1.0',
  releaseLabel: state.releaseLabel,
  platform: 'Windows x64',
  setup: name,
  files: [...entries].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: hash(bytes) })),
};
entries.set('delivery-manifest.json', Buffer.from(JSON.stringify(publicManifest, null, 2) + '\n'));
entries.set(
  'SHA256SUMS.txt',
  Buffer.from([...entries].map(([file, bytes]) => `${hash(bytes)}  ${file}`).join('\r\n') + '\r\n'),
);
const base = path.join(process.env.USERPROFILE, 'ClassManagerDeliveries');
await fs.mkdir(base, { recursive: true });
const directory = await fs.mkdtemp(path.join(base, state.releaseLabel + '-Delivery-'));
const folder = `Class-Manager-0.1.0-${state.releaseLabel}-x64-Delivery`;
const zipFile = path.join(directory, folder + '.zip');
const archive = new JSZip();
for (const [file, bytes] of entries)
  archive.file(`${folder}/${file}`, bytes, {
    compression: file.endsWith('.exe') ? 'STORE' : 'DEFLATE',
  });
await fs.writeFile(
  zipFile,
  await archive.generateAsync({
    type: 'nodebuffer',
    platform: 'DOS',
    compressionOptions: { level: 6 },
  }),
  { flag: 'wx' },
);
const zipBytes = await fs.readFile(zipFile);
const reopened = await JSZip.loadAsync(zipBytes, { checkCRC32: true });
assert.equal(Object.values(reopened.files).filter((entry) => !entry.dir).length, entries.size);
for (const [file, expected] of entries) {
  const actual = await reopened.file(`${folder}/${file}`).async('nodebuffer');
  assert.equal(actual.length, expected.length);
  assert.equal(hash(actual), hash(expected));
}
const sha256 = hash(zipBytes);
await fs.writeFile(zipFile + '.sha256', `${sha256}  ${path.basename(zipFile)}\r\n`, { flag: 'wx' });
const packaged = JSON.parse(await fs.readFile(path.join(root, 'package-manifest.json')));
const final = {
  status: 'passed',
  createdAt: new Date().toISOString(),
  releaseLabel: state.releaseLabel,
  setup: delivery.setup,
  zip: zipFile,
  bytes: zipBytes.length,
  sha256,
  crcVerified: true,
  allFileHashesVerified: true,
  tools: { read: 40, draft: 7, confirm: 40, total: 87 },
  tests: { files, count },
  actionGates: actions.gates,
  sessionGates: sessions.gates,
  asarHash: packaged.asarHash,
  inventory: packaged.inventory,
  validationRoot: root,
  wizardReport: path.join(root, 'wizard-bootstrap-report.json'),
  limits: [
    'Model transport mocked; paid accounts not tested.',
    'OS print submission mocked; actual PDF/Office/backup outputs verified.',
    'Installer bootstrap cancelled before installation; existing installation not upgraded.',
  ],
};
await fs.writeFile(path.join(root, 'final-report.json'), JSON.stringify(final, null, 2), {
  flag: 'wx',
});
console.log(JSON.stringify(final, null, 2));
