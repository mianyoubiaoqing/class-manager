import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import JSZip from 'jszip';

const state = JSON.parse(await fs.readFile('output/current-application-tools-release.json'));
const root = state.root;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(await fs.readFile(path.join(root, 'source-manifest.json')));
for (const item of source.source)
  assert.equal(hash(await fs.readFile(item.file)), item.sha256, 'Source changed: ' + item.file);
for (const stage of [
  'check',
  'package',
  'verify-package',
  'sessions-desktop',
  'conversation-desktop',
  'general-desktop',
  'actions-desktop',
  'pupils-desktop',
  'providers-desktop',
  'installer',
  'installer-delivery',
])
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, stage + '-result.json'))).exitCode,
    0,
    stage,
  );
const reports = {};
for (const [name, file] of [
  ['actions', 'actions-smoke-report.json'],
  ['sessions', 'sessions-smoke-report.json'],
  ['pupils', 'pupil-smoke-report.json'],
  ['providers', 'providers-smoke-report.json'],
]) {
  const report = JSON.parse(await fs.readFile(path.join(root, file)));
  assert.equal(report.status, 'passed');
  assert.equal(report.packaged, true);
  assert.equal(report.externalRequests, 0);
  reports[name] = report;
}
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
assert.ok(files && count, 'Actual test totals missing');
const name = path.basename(delivery.setup);
const entries = new Map([
  [name, await fs.readFile(delivery.setup)],
  ['Install.cmd', await fs.readFile(path.join(delivery.output, 'Install.cmd'))],
]);
const addText = (file, text) =>
  entries.set(file, Buffer.from('\uFEFF' + text.replace(/\r?\n/g, '\r\n'), 'utf8'));
addText(
  '安装说明.txt',
  `Class Manager 0.1.0 / ${state.releaseLabel}，Windows x64
1. 将压缩包完整解压到 C 盘普通文件夹。
2. 更新前在旧应用备份数据，保存并退出 Class Manager。
3. 双击 ${name}，按中文向导选择安装目录并安装。
4. 如遇 NSIS 临时文件错误，保留 Install.cmd 与安装器在同一文件夹，双击 Install.cmd。
5. 首页面为业务对话。侧栏新增上课点名和学生资料，正式操作核对后点击确认。
6. 模型设置支持 DeepSeek、Kimi、豆包；填写自己的账号和真实型号。豆包实际窗口须按所用 Endpoint 配置。
数据库升级至 Schema 12，迁移前自动保存 before-v12 SQLite 副本；升级后不能直接用旧程序打开。卸载保留业务数据。
压缩包不含账号、密钥、真实学生数据或测试数据库。本次没有自动更新当前安装版。
`,
);
addText('功能与版本说明.md', await fs.readFile('docs/handoff/context-pupils-update.md', 'utf8'));
addText(
  '版本与验证说明.txt',
  `发布标识：${state.releaseLabel}
应用版本：0.1.0 / Windows x64
生成时间：${new Date().toISOString()}
全仓检查：${files} 个测试文件、${count} 项测试通过；格式、类型、静态检查及构建通过。
打包程序检查：${reports.actions.gates.length} 项业务操作、${reports.sessions.gates.length} 项会话管理、${reports.pupils.gates.length} 项点名/资料、${reports.providers.gates.length} 项供应商检查通过；通用桌面和三供应商模拟对话通过。
上下文上限 300K，实际供应商窗口较小时取较小值，90% 自动压缩。每逻辑工具操作最多 5 次重试，无整轮累计参数错误上限。
现代分栏、下拉弹层、点名进度与状态标签已接入；高级设置和快捷查询按需展开，减少同屏信息。分栏保留编辑并支持键盘操作，窄窗口布局已验证。
已核实的隐私外发、暂存目录恢复及长文本性能问题修复；完整说明见功能与版本说明.md。
安装向导启动验证通过，在安装前取消。ASAR/许可库存、ZIP CRC 和交付文件 SHA256 均核对。
模型传输使用模拟，未测试真实付费账号；打印提交使用模拟，PDF、Word、PPT 和备份文件实际生成。词法脱敏不能保证任意自由文本完整匿名。
未覆盖用户当前安装或数据库。免安装及外接 WPS/Office 扩展仍为调研范围。
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
for (const [file, expected] of entries)
  assert.equal(hash(await reopened.file(`${folder}/${file}`).async('nodebuffer')), hash(expected));
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
  tools: { read: 46, draft: 7, confirm: 42, total: 95 },
  tests: { files, count },
  actionGates: reports.actions.gates,
  sessionGates: reports.sessions.gates,
  pupilGates: reports.pupils.gates,
  providerGates: reports.providers.gates,
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
