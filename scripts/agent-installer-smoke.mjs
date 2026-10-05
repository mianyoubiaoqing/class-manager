import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestArgument = process.argv.indexOf('--manifest');
const manifest = JSON.parse(
  readFileSync(
    manifestArgument >= 0
      ? process.argv[manifestArgument + 1]
      : 'output/installer19-isolated-v8/installer-manifest.json',
  ),
);
assert.match(manifest.appId, /^local\.classmanager\.installer19\.[a-f0-9]{12}$/);
assert.equal(manifest.isolated, true);
assert.equal(manifest.configuration.nsis.runAfterFinish, false);
const include = readFileSync(manifest.configuration.nsis.include, 'utf8');
assert.ok(
  include.includes('!macro customCheckAppRunning') &&
    include.includes('Abort "Isolated installation directory was not verified"'),
  'Only guarded audit installers may be used',
);
const parent = resolve('output/playwright/installer19');
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(join(parent, 'run-'));
const root = join(
  process.env.LOCALAPPDATA,
  'ClassManagerInstaller19Audit',
  manifest.appId.split('.').at(-1),
);
assert.equal(
  existsSync(root),
  false,
  'Use a fresh isolated build namespace for each lifecycle run',
);
mkdirSync(root, { recursive: true });
const install = join(root, '程序', 'Class Manager'),
  data = join(root, '合成 数据'),
  temp = join(root, 'temp');
mkdirSync(temp);
const env = { ...process.env, TEMP: temp, TMP: temp, CLASS_MANAGER_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  status: 'running',
  root,
  output,
  install,
  data,
  externalRequests: 0,
  errors: [],
  gates: [],
};
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
function run(file, args, timeout = 150000) {
  // Windows PowerShell默认输出本地代码页；显式UTF-8，避免中文路径被误解码。
  if (file === powershell && args[1] === '-Command')
    args = [
      args[0],
      args[1],
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' + args[2],
    ];
  const result = spawnSync(file, args, { env, windowsHide: true, encoding: 'utf8', timeout });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
function requireNoApplication() {
  assert.ok(!root.includes("'"));
  run(powershell, [
    '-NoProfile',
    '-Command',
    "try { $ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter \"Name='Class Manager.exe'\" -ErrorAction Stop); foreach($item in $items){ if(!$item.ExecutablePath){exit 13}; if($item.ExecutablePath.StartsWith('" +
      root +
      "\\',[StringComparison]::OrdinalIgnoreCase)){exit 12} } } catch { exit 13 }",
  ]);
}
const existing = join(process.env.LOCALAPPDATA, 'Programs/Class Manager');
function fileIdentity(directory, relative = '') {
  if (!existsSync(directory)) return {};
  const result = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      file = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, fileIdentity(path, file));
    else {
      assert.ok(entry.isFile(), 'Unexpected entry: ' + path);
      result[file] = hash(readFileSync(path));
    }
  }
  return result;
}
const oldHashes = fileIdentity(existing);
report.existingApplicationHashesBefore = oldHashes;
let app, page;
const call = async (name, input) => {
  const result = await page.evaluate(({ name, input }) => window.classManager[name](input), {
    name,
    input,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
async function launch() {
  const clean = { ...env };
  for (const field of Object.keys(clean)) if (field.toLowerCase() === 'path') delete clean[field];
  clean.PATH = join(process.env.SystemRoot, 'System32');
  app = await electron.launch({
    executablePath: join(install, 'Class Manager.exe'),
    args: [],
    env: clean,
    cwd: root,
    timeout: 45000,
  });
  await app.evaluate(() => {
    globalThis.__installerRequests = 0;
    globalThis.fetch = async () => {
      globalThis.__installerRequests++;
      throw Error('No model requests permitted');
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '业务对话', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button').first().innerText(),
    '业务对话',
  );
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), data);
}
async function close() {
  report.externalRequests += await app.evaluate(() => globalThis.__installerRequests);
  await closeAuditApplication(app, () => {});
  app = undefined;
}
function verifyPayload() {
  for (const file of manifest.files)
    assert.equal(hash(readFileSync(join(install, file.file))), file.sha256, file.file);
}
try {
  const installer = manifest.installers.find((file) => file.file.endsWith('.exe'));
  assert.equal(hash(readFileSync(installer.file)), installer.sha256);
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  // H盘仓库EXE继承低完整性；驱动和NSIS必须一起暂存到C盘。
  // 只复制安装器而保留H盘驱动，会把子进程也限制为低完整性，产生错误的验收结论。
  const compiledProbe = join(output, 'InstallerWizardProbe.exe');
  const probe = join(root, 'InstallerWizardProbe.exe');
  run(compiler, [
    '/nologo',
    '/r:System.Drawing.dll',
    '/r:System.Web.Extensions.dll',
    '/out:' + compiledProbe,
    resolve('scripts/installer-wizard-probe.cs'),
  ]);
  copyFileSync(compiledProbe, probe);
  const stagedInstaller = join(root, 'Setup.exe');
  copyFileSync(installer.file, stagedInstaller);
  assert.equal(hash(readFileSync(stagedInstaller)), installer.sha256);
  report.staging = { original: installer.file, stagedInstaller, sha256: installer.sha256 };
  requireNoApplication();
  report.wizardOutput = run(probe, [stagedInstaller, install, output]);
  report.wizard = JSON.parse(readFileSync(join(output, 'wizard-report.json')));
  assert.equal(report.wizard.status, 'passed');
  verifyPayload();
  const shortcut = run(powershell, [
    '-NoProfile',
    '-Command',
    "$ErrorActionPreference='Stop'; $name='" +
      manifest.configuration.nsis.shortcutName +
      ".lnk'; $shell=New-Object -ComObject WScript.Shell; $paths=@((Join-Path ([Environment]::GetFolderPath('Desktop')) $name),(Join-Path ([Environment]::GetFolderPath('StartMenu')) ('Programs\\'+$name))); $result=@(foreach($path in $paths){ if(!(Test-Path -LiteralPath $path)){throw 'Shortcut missing'}; $link=$shell.CreateShortcut($path); [pscustomobject]@{path=$path;target=$link.TargetPath;arguments=$link.Arguments} }); $result | ConvertTo-Json -Compress",
  ]);
  report.shortcuts = JSON.parse(shortcut);
  for (const item of report.shortcuts)
    assert.equal(item.target.toLowerCase(), join(install, 'Class Manager.exe').toLowerCase());
  await launch();
  let snapshot = await call('snapshot');
  assert.equal(snapshot.schemaVersion, 11);
  snapshot = await call('seedDemo', { epoch: snapshot.epoch });
  assert.equal(snapshot.students.length, 100);
  await page.screenshot({ path: join(output, 'installed-conversation.png'), fullPage: true });
  await close();
  report.gates.push(
    'actual Chinese wizard, changed Chinese directory, desktop/Start Menu shortcuts, installed payload identity and default conversation',
  );
  requireNoApplication();
  run(stagedInstaller, ['/S', '/currentuser', '/D=' + install]);
  verifyPayload();
  await launch();
  snapshot = await call('snapshot');
  assert.equal(snapshot.students.length, 100);
  await close();
  report.gates.push(
    'same-version reinstall preserves synthetic100 and default conversation; application runs with System32-only PATH',
  );
  const marker = join(data, 'retention.txt');
  writeFileSync(marker, 'synthetic retention');
  const stored = join(data, 'workspace-data/current.json'),
    digest = hash(readFileSync(stored));
  const database = Object.keys(fileIdentity(data)).find((file) => file.endsWith('data.sqlite'));
  assert.ok(database);
  const attachment = join(dirname(join(data, database)), 'assets', randomUUID() + '.bin');
  writeFileSync(attachment, 'synthetic attachment retention fixture', { flag: 'wx' });
  report.syntheticAttachment = attachment;
  // 关闭程序后冻结整个业务目录，包含实际数据库与附件，而不只检查版本指针。
  const dataBeforeUninstall = fileIdentity(data);
  assert.ok(Object.keys(dataBeforeUninstall).some((file) => file.endsWith('data.sqlite')));
  report.dataBeforeUninstall = dataBeforeUninstall;
  requireNoApplication();
  const uninstaller = join(install, 'Uninstall Class Manager.exe');
  assert.ok(resolve(uninstaller).startsWith(resolve(root) + '\\'));
  run(uninstaller, ['/S', '/currentuser']);
  for (let i = 0; i < 50 && existsSync(join(install, 'Class Manager.exe')); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(join(install, 'Class Manager.exe')), false);
  assert.equal(readFileSync(marker, 'utf8'), 'synthetic retention');
  assert.equal(hash(readFileSync(stored)), digest);
  assert.deepEqual(fileIdentity(data), dataBeforeUninstall);
  assert.deepEqual(fileIdentity(existing), oldHashes);
  report.gates.push(
    'isolated uninstall removes application and preserves data; existing user application stays unchanged',
  );
  assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (app)
    try {
      await close();
    } catch (error) {
      report.status = 'failed';
      report.closeError = String(error);
      process.exitCode = 1;
    }
  writeAuditReport(join(output, 'report.json'), report);
}
console.log(
  JSON.stringify({ status: report.status, output, gates: report.gates, failure: report.failure }),
);
