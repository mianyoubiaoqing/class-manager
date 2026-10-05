import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// One-off release verification: never rebuild or install the application, and never read user data.
const root = resolve('output/release-audit07/win-unpacked');
const release = resolve('release/ticket07-20260930');
const filename = 'Class-Manager-0.1.0-ticket07-x64-Setup.exe';
const installer = join(release, filename);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const identities = {
  'Class Manager.exe': 'fbdcb7945e6a1efa799a48939f9b1dbca8d25776d85246dbf08fe04e28bcd424',
  'resources/app.asar': '074c37386d82243dff51ddb91184d9fadc82430a753d6a41dd8c50d0f36286b3',
};
for (const [file, expected] of Object.entries(identities))
  assert.equal(hash(join(root, file)), expected);
assert.ok(statSync(installer).size > 100_000_000, 'Installer is not a finished NSIS distribution');
const scratch = mkdtempSync(resolve('output/frozen07-verify-'));
const zip = resolve('node_modules/electron-winstaller/vendor/7z-x64.exe');
function unpack(file, output, ...members) {
  const result = spawnSync(zip, ['x', file, `-o${output}`, '-y', ...members], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
unpack(installer, join(scratch, 'installer'), '$PLUGINSDIR\\app-64.7z');
const payload = join(scratch, 'installer', '$PLUGINSDIR', 'app-64.7z');
assert.ok(existsSync(payload), 'NSIS payload missing');
unpack(payload, join(scratch, 'application'));
const files = [];
function compare(relative = '') {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const file = join(relative, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'Unexpected link in frozen source');
    if (entry.isDirectory()) compare(file);
    else {
      const expected = hash(join(root, file));
      assert.equal(
        hash(join(scratch, 'application', file)),
        expected,
        `Installer payload mismatch: ${file}`,
      );
      files.push({ path: file.replaceAll('\\', '/'), sha256: expected });
    }
  }
}
compare();
const template = readFileSync('scripts/windows-installer.cmd', 'utf8');
assert.ok(template.includes('__INSTALLER_FILENAME__'));
writeFileSync(
  join(release, 'Install.cmd'),
  template.replaceAll('__INSTALLER_FILENAME__', filename).replace(/\r?\n/g, '\r\n'),
  'utf8',
);
const manifest = {
  frozenTicket: '07',
  appVersion: '0.1.0',
  schemaVersion: 5,
  at: new Date().toISOString(),
  source: root,
  installer: { filename, bytes: statSync(installer).size, sha256: hash(installer) },
  launcher: { filename: 'Install.cmd', sha256: hash(join(release, 'Install.cmd')) },
  payloadFilesCompared: files.length,
  files,
  verifiedPayloadPath: join(scratch, 'application'),
  applicationInstalled: false,
  targetMachineInstallVerified: false,
  signed: false,
  includesTicket08: false,
};
writeFileSync(join(release, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(
  join(release, 'SHA256SUMS.txt'),
  `${manifest.installer.sha256}  ${filename}\r\n${manifest.launcher.sha256}  Install.cmd\r\n`,
);
copyFileSync(
  join(release, 'manifest.json'),
  'docs/handoff/evidence/07-frozen-release-manifest.json',
);
console.log(
  JSON.stringify({
    installer: manifest.installer,
    launcher: join(release, 'Install.cmd'),
    payloadFilesCompared: files.length,
    verifiedPayloadPath: manifest.verifiedPayloadPath,
  }),
);
