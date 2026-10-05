import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeAuditApplication } from './live-audit-guards.ts';

// NSIS 使用独立注册命名空间，不能卸载既有用户应用；旧07与当前程序均先核验身份。
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'class-manager-lifecycle15-'));
const install = join(root, '程序'),
  data = join(root, '合成 数据'),
  temp = join(root, 'temp');
mkdirSync(temp);
const output = resolve(
  process.env.CLASS_MANAGER_INSTALLATION_AUDIT_OUTPUT ?? 'output/playwright/installation15',
);
mkdirSync(output, { recursive: true });
const reportFile = join(output, `report-${root.split(/[\\/]/).at(-1)}.json`);
const env = { ...process.env, TEMP: temp, TMP: temp, CLASS_MANAGER_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`;
const manifest = JSON.parse(
  readFileSync(
    process.env.CLASS_MANAGER_RELEASE_MANIFEST ?? 'output/15-package-manifest.json',
    'utf8',
  ),
);
const old = JSON.parse(readFileSync('release/ticket07-20260930/manifest.json', 'utf8'));
const legacyInstall = join(process.env.LOCALAPPDATA, 'Programs/Class Manager');
const existingHashes = Object.fromEntries(
  ['Class Manager.exe', 'resources/app.asar'].map((file) => [
    file,
    hash(readFileSync(join(legacyInstall, file))),
  ]),
);
const report = {
  status: 'running',
  root,
  install,
  data,
  startedAt: new Date().toISOString(),
  ordinaryUser: true,
  externalRequests: 0,
  errors: [],
  gates: [],
  filesMatched: [],
  installerNamespace: 'local.classmanager.acceptance15',
  limitations: [
    'Lifecycle installer uses a separate appId and no shortcuts; runtime payload matches final candidate.',
    'Current computer has development tools; application PATH contains only Windows System32.',
    'Silent NSIS CLI lifecycle, not a human installation-wizard walk-through.',
  ],
};
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2));
const run = (command, args, timeout = 120000) => {
  const r = spawnSync(command, args, { env, windowsHide: true, encoding: 'utf8', timeout });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return r;
};
const stage = (source, name) => {
  const target = join(root, `${name}.exe`);
  copyFileSync(source, target);
  assert.equal(hash(readFileSync(target)), hash(readFileSync(source)));
  return target;
};
function requireNoRunningApplication() {
  // NSIS 可能按镜像名关闭进程；有任一应用运行或查询失败时，必须拒绝启动安装器。
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  run(powershell, [
    '-NoProfile',
    '-Command',
    "try { $ErrorActionPreference='Stop'; if (@(Get-CimInstance Win32_Process -Filter \"Name='Class Manager.exe'\" -ErrorAction Stop).Count -ne 0) { Write-Output 'Close Class Manager instances before lifecycle acceptance'; exit 12 } } catch { Write-Output ('Application process query refused: ' + $_.Exception.Message); exit 13 }",
  ]);
}
function verify(files, label) {
  for (const file of files) {
    const name = file.path ?? file.file;
    assert.equal(hash(readFileSync(join(install, name))), file.sha256, name);
  }
  report.filesMatched.push({ label, files: files.length });
  save();
}
let app, page;
const value = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.value;
};
const call = (name, input) =>
  page.evaluate(({ name, input }) => window.classManager[name](input), { name, input }).then(value);
async function launch() {
  app = await electron.launch({
    executablePath: join(install, 'Class Manager.exe'),
    args: [],
    env,
    cwd: root,
    timeout: 45000,
  });
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw Error('Installation acceptance forbids external requests');
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
}
async function close() {
  await closeAuditApplication(app, () => {});
  app = undefined;
}
try {
  save();
  for (const file of old.files)
    assert.equal(
      hash(readFileSync(join(old.source, file.path))),
      file.sha256,
      'Frozen07 source changed',
    );
  const oldInstaller = stage(
    resolve('output/release-audit15-old-isolated/Class-Manager-0.1.0-x64-Setup.exe'),
    'Old-acceptance',
  );
  report.oldInstallerHash = hash(readFileSync(oldInstaller));
  requireNoRunningApplication();
  run(oldInstaller, ['/S', '/currentuser', `/D=${install}`]);
  verify(old.files, 'installed-frozen07');
  await launch();
  let snapshot = await call('snapshot');
  assert.equal(snapshot.schemaVersion, 5);
  await call('seedDemo', { epoch: snapshot.epoch });
  await call('addSyntheticAsset', { epoch: snapshot.epoch });
  snapshot = await call('snapshot');
  assert.equal(snapshot.students.length, 100);
  const before = {
    classIds: snapshot.classes.map((c) => c.id).sort(),
    students: snapshot.students
      .map((s) => ({
        id: s.id,
        revision: s.revision,
        studentNumber: s.studentNumber,
        classId: s.classId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    assets: snapshot.assets,
  };
  const backup5 = join(root, '旧版合成.cmbackup');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, backup5);
  await call('saveBackup', { epoch: snapshot.epoch });
  assert.equal(JSON.parse(readFileSync(backup5, 'utf8')).version, 5);
  await page.screenshot({ path: join(output, 'old-installed.png') });
  await close();
  report.gates.push(
    'Ordinary-user silent installation: verified frozen07 payload, Chinese installation/data paths, independent synthetic100 and attachment, old v5 backup',
  );
  const newInstaller = stage(manifest.isolatedInstaller.file, 'Current-acceptance');
  assert.equal(hash(readFileSync(newInstaller)), manifest.isolatedInstaller.sha256);
  requireNoRunningApplication();
  run(newInstaller, ['/S', '/currentuser', `/D=${install}`]);
  verify(manifest.packageFiles, 'installed-current');
  await launch();
  snapshot = await call('snapshot');
  assert.equal(snapshot.schemaVersion, 11);
  assert.deepEqual(snapshot.classes.map((c) => c.id).sort(), before.classIds);
  assert.deepEqual(
    snapshot.students
      .map((s) => ({
        id: s.id,
        revision: s.revision,
        studentNumber: s.studentNumber,
        classId: s.classId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    before.students,
  );
  assert.deepEqual(snapshot.assets, before.assets);
  const backup11 = join(root, '新版合成.cmbackup');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, backup11);
  await call('saveBackup', { epoch: snapshot.epoch });
  assert.equal(JSON.parse(readFileSync(backup11, 'utf8')).version, 11);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, backup5);
  const preview = await call('previewRestore', { epoch: snapshot.epoch });
  await call('commitRestore', { epoch: snapshot.epoch, token: preview.token });
  snapshot = await call('snapshot');
  assert.equal(snapshot.schemaVersion, 11);
  assert.equal(snapshot.students.length, 100);
  assert.deepEqual(snapshot.assets, before.assets);
  await page.screenshot({ path: join(output, 'current-migrated-restored.png') });
  await close();
  report.gates.push(
    'NSIS replacement upgrade, actual v5→v11 startup migration preserving100 identities/attachment, new backup, old v5 backup restore to current schema',
  );
  const dataMarker = join(data, 'uninstall-retention-check.txt');
  writeFileSync(dataMarker, 'synthetic retention probe');
  const dataHash = hash(readFileSync(join(data, 'workspace-data/current.json')));
  const uninstaller = join(install, 'Uninstall Class Manager.exe');
  assert.ok(resolve(uninstaller).startsWith(resolve(root) + '\\'));
  requireNoRunningApplication();
  run(uninstaller, ['/S', '/currentuser']);
  for (let n = 0; n < 50 && existsSync(join(install, 'Class Manager.exe')); n++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(join(install, 'Class Manager.exe')), false);
  assert.equal(readFileSync(dataMarker, 'utf8'), 'synthetic retention probe');
  assert.equal(hash(readFileSync(join(data, 'workspace-data/current.json'))), dataHash);
  for (const [file, digest] of Object.entries(existingHashes))
    assert.equal(
      hash(readFileSync(join(legacyInstall, file))),
      digest,
      'Existing application identity changed',
    );
  report.gates.push(
    'Actual acceptance-namespace uninstall removes application, retains synthetic data and backup; pre-existing registered application EXE/ASAR unchanged',
  );
  assert.equal(report.errors.length, 0);
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ status: report.status, reportFile, root, gates: report.gates }));
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  report.completedAt = new Date().toISOString();
  save();
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await close();
}
