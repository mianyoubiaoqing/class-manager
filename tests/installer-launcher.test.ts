import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = '0.2.3-test', withInstaller = true) {
  const root = mkdtempSync(join(tmpdir(), 'cm-installer-test-'));
  roots.push(root);
  const project = join(root, 'project with spaces');
  const release = join(project, 'release');
  mkdirSync(release, { recursive: true });
  mkdirSync(join(project, 'scripts'));
  for (const name of ['prepare-windows-installer.mjs', 'windows-installer.cmd']) {
    copyFileSync(resolve('scripts', name), join(project, 'scripts', name));
  }
  writeFileSync(join(project, 'package.json'), JSON.stringify({ version }));
  const installer = join(release, `Class-Manager-${version}-x64-Setup.exe`);
  // Not executable: --check must only copy and compare these synthetic bytes.
  if (withInstaller) writeFileSync(installer, 'synthetic installer fixture');
  const generated = spawnSync(
    process.execPath,
    [join(project, 'scripts/prepare-windows-installer.mjs')],
    { encoding: 'utf8', timeout: 10000 },
  );
  return { root, release, installer, generated, launcher: join(release, 'Install.cmd') };
}

test('installer launcher follows the package version and uses CRLF', () => {
  const result = fixture();
  expect(result.generated.status, result.generated.stderr).toBe(0);
  const launcher = readFileSync(result.launcher, 'utf8');
  expect(launcher).toContain('Class-Manager-0.2.3-test-x64-Setup.exe');
  expect(launcher).not.toContain('__INSTALLER_FILENAME__');
  expect(launcher).not.toMatch(/(?<!\r)\n/);
});

test('missing installer cannot produce a misleading installation entry', () => {
  const result = fixture('0.2.3-test', false);
  expect(result.generated.status).not.toBe(0);
  expect(existsSync(result.launcher)).toBe(false);
});

test('unsafe version text is rejected before generating CMD', () => {
  const result = fixture('0.2.3&whoami', false);
  expect(result.generated.status).not.toBe(0);
  expect(result.generated.stderr).toContain('Invalid package version');
  expect(existsSync(result.launcher)).toBe(false);
});

test.skipIf(process.platform !== 'win32')(
  'Windows preflight copies to an isolated directory without executing the installer',
  () => {
    const result = fixture();
    expect(result.generated.status, result.generated.stderr).toBe(0);
    const local = join(result.root, 'local data');
    mkdirSync(local);
    const env = { ...process.env, LOCALAPPDATA: local };
    const checked = spawnSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `""${result.launcher}" --check"`],
      { env, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 10000 },
    );
    expect(checked.error).toBeUndefined();
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
    expect(checked.stdout).toContain('Installer copy verified.');
    expect(checked.stdout).not.toContain('Starting the installation wizard');
    const stages = readdirSync(join(local, 'ClassManagerSetup'));
    expect(stages).toHaveLength(1);
    const stage = join(local, 'ClassManagerSetup', stages[0]!);
    expect(readFileSync(join(stage, 'Setup.exe'))).toEqual(readFileSync(result.installer));
    expect(existsSync(join(stage, 'temp/write-check.txt'))).toBe(true);
  },
);
