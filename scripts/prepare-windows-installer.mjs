import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(version)) {
  throw new Error('Invalid package version for Windows installer filename');
}
const filename = `Class-Manager-${version}-x64-Setup.exe`;
const release = resolve(root, 'release');
if (!statSync(resolve(release, filename)).isFile()) {
  throw new Error('Build the NSIS installer before preparing the launcher');
}
const template = readFileSync(resolve(root, 'scripts/windows-installer.cmd'), 'utf8');
// CMD files are distributed with CRLF, independent of the source checkout's line endings.
writeFileSync(
  resolve(release, 'Install.cmd'),
  template.replaceAll('__INSTALLER_FILENAME__', filename).replace(/\r?\n/g, '\r\n'),
  'utf8',
);
console.log(`Prepared release/Install.cmd for ${filename}`);
