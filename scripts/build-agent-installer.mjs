import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isolated = process.argv.includes('--isolated');
const outputArgument = process.argv.indexOf('--output');
if (outputArgument >= 0) assert.ok(process.argv[outputArgument + 1], '--output needs a directory');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestArgument = process.argv.indexOf('--manifest');
if (manifestArgument >= 0) assert.ok(process.argv[manifestArgument + 1], '--manifest needs a file');
const source = JSON.parse(
  readFileSync(
    resolve(
      projectDir,
      manifestArgument >= 0
        ? process.argv[manifestArgument + 1]
        : 'output/18-reviewed-package-manifest.json',
    ),
  ),
);
const releaseLabel = source.releaseLabel ?? 'Agent18';
assert.match(releaseLabel, /^[A-Za-z0-9-]+$/);
const output = resolve(
  projectDir,
  outputArgument >= 0
    ? process.argv[outputArgument + 1]
    : isolated
      ? 'output/installer19-isolated'
      : 'release/ticket19-20261002-agent18-installer',
);
assert.ok(
  !existsSync(output),
  'Choose a new output directory; existing delivery is never overwritten.',
);
mkdirSync(output, { recursive: true });
const payload = join(output, 'payload');
mkdirSync(payload);
for (const file of source.files) {
  const bytes = readFileSync(join(source.source, file.file));
  assert.equal(hash(bytes), file.sha256, 'Source payload changed: ' + file.file);
  const target = join(payload, file.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx' });
}
const noticeRoot = resolve(
  projectDir,
  source.noticesSource ?? 'output/release-audit18-reviewed/third-party-notices-reviewed',
);
const packages = JSON.parse(readFileSync(join(noticeRoot, 'packages.json')));
assert.equal(packages.length, 109);
for (const item of packages)
  for (const notice of item.notices)
    assert.equal(hash(readFileSync(join(noticeRoot, notice.file))), notice.sha256);
function copyNotices(directory, relative = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const from = join(directory, entry.name),
      to = join(relative, entry.name);
    if (entry.isDirectory()) copyNotices(from, to);
    else {
      const target = join(payload, 'third-party-notices', to);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(from, target);
    }
  }
}
copyNotices(noticeRoot);
const filename = isolated
  ? `Class-Manager-${releaseLabel}-Audit-Setup.exe`
  : `Class-Manager-0.1.0-${releaseLabel}-x64-Setup.exe`;
const auditSuffix = hash(Buffer.from(output)).slice(0, 12);
const appId = isolated
  ? 'local.classmanager.installer19.' + auditSuffix
  : 'local.classmanager.desktop';
const isolatedInclude = join(output, 'isolated-installer.nsh');
if (isolated)
  writeFileSync(
    isolatedInclude,
    '\uFEFF' +
      [
        '!macro customInit',
        '  ${If} ${Silent}',
        '    StrCpy $INSTDIR "$LOCALAPPDATA\\ClassManagerInstaller19Audit\\' +
          auditSuffix +
          '\\程序\\Class Manager"',
        '  ${Else}',
        '    StrCpy $INSTDIR "$LOCALAPPDATA\\ClassManagerInstaller19Audit\\' +
          auditSuffix +
          '\\默认目录\\Class Manager"',
        '  ${EndIf}',
        '!macroend',
        '; 复制与卸载前强制核对验收目录，不按镜像名关闭任何用户应用。',
        '!macro customCheckAppRunning',
        '  ${If} $INSTDIR != "$LOCALAPPDATA\\ClassManagerInstaller19Audit\\' +
          auditSuffix +
          '\\程序\\Class Manager"',
        '    Abort "Isolated installation directory was not verified"',
        '  ${EndIf}',
        '!macroend',
        '',
      ].join('\n'),
    { flag: 'wx' },
  );
const configuration = {
  appId,
  productName: 'Class Manager',
  directories: { output },
  win: { target: 'nsis', artifactName: filename, signAndEditExecutable: false },
  nsis: {
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    installerLanguages: ['zh_CN'],
    language: '2052',
    displayLanguageSelector: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: isolated ? 'Class Manager 安装验证19 ' + auditSuffix : 'Class Manager',
    runAfterFinish: !isolated,
    ...(isolated ? { include: isolatedInclude } : {}),
  },
};
writeFileSync(join(output, 'build-config.json'), JSON.stringify(configuration, null, 2), {
  flag: 'wx',
});
await build({
  projectDir,
  prepackaged: payload,
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  config: configuration,
});
for (const file of source.files)
  assert.equal(
    hash(readFileSync(join(payload, file.file))),
    file.sha256,
    'Builder changed frozen payload: ' + file.file,
  );
const installers = [filename, filename + '.blockmap']
  .filter((file) => existsSync(join(output, file)))
  .map((file) => {
    const bytes = readFileSync(join(output, file));
    return { file: join(output, file), bytes: bytes.length, sha256: hash(bytes) };
  });
assert.ok(installers.some((file) => file.file.endsWith('.exe')));
const launcher = readFileSync(join(projectDir, 'scripts/windows-installer.cmd'), 'utf8')
  .replaceAll('__INSTALLER_FILENAME__', filename)
  .replace(/\r?\n/g, '\r\n');
writeFileSync(join(output, 'Install.cmd'), launcher, { flag: 'wx' });
writeFileSync(
  join(output, 'SHA256SUMS.txt'),
  installers.map((file) => file.sha256 + '  ' + file.file.split(/[\\/]/).at(-1)).join('\r\n') +
    '\r\n',
  { flag: 'wx' },
);
const files = [];
function inventory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) inventory(file);
    else {
      const bytes = readFileSync(file);
      files.push({
        file: file.slice(payload.length + 1),
        bytes: bytes.length,
        sha256: hash(bytes),
      });
    }
  }
}
inventory(payload);
const identity = {
  createdAt: new Date().toISOString(),
  output,
  payload,
  appId,
  isolated,
  releaseLabel,
  installers,
  files,
  businessFiles: source.files,
  exeHash: source.exeHash,
  asarHash: source.asarHash,
  configuration,
  notices: { packages: 109, dependencyNotices: 109 },
  limitations: [
    'Product installer has not been installed over the existing user application by this build script.',
  ],
};
writeFileSync(join(output, 'installer-manifest.json'), JSON.stringify(identity, null, 2), {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    output,
    appId,
    installers,
    files: files.length,
    exeHash: source.exeHash,
    asarHash: source.asarHash,
  }),
);
