import { afterEach, expect, test } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  closeAuditApplication,
  reservePaidAudit,
  writeAuditReport,
} from '../scripts/live-audit-guards';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function lockPath() {
  const directory = mkdtempSync(join(tmpdir(), 'class-manager-audit-guard-'));
  directories.push(directory);
  return join(directory, 'paid-run.lock');
}

test('exclusive reservation admits exactly one independent process and persists after exit', async () => {
  const path = lockPath();
  const moduleUrl = pathToFileURL(resolve('scripts/live-audit-guards.ts')).href;
  const code = `import {reservePaidAudit} from ${JSON.stringify(moduleUrl)}; reservePaidAudit(${JSON.stringify(path)});`;
  const run = promisify(execFile);
  const results = await Promise.allSettled([
    run(process.execPath, ['--input-type=module', '-e', code]),
    run(process.execPath, ['--input-type=module', '-e', code]),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
  expect(() => reservePaidAudit(path)).toThrow();
});

test('explicit preflight release is idempotent and allows a later reservation', () => {
  const path = lockPath();
  const release = reservePaidAudit(path);
  release();
  release();
  reservePaidAudit(path)();
  expect(existsSync(path)).toBe(false);
});

test.each(['flush', 'rename'] as const)(
  'failed report %s preserves the previous attempted marker',
  (kind) => {
    const path = lockPath();
    writeAuditReport(path, { generationAttempted: true });
    const fail = () => {
      throw new Error('Synthetic publish failure');
    };
    expect(() =>
      writeAuditReport(
        path,
        { generationAttempted: false },
        kind === 'flush' ? { sync: fail } : { rename: fail },
      ),
    ).toThrow('Synthetic publish failure');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ generationAttempted: true });
    expect(readdirSync(join(path, '..'))).toEqual(['paid-run.lock']);
  },
);

test('close rejection terminates owned child and still cleans up', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  let cleaned = false;
  await expect(
    closeAuditApplication(
      {
        close: async () => {
          throw new Error('Synthetic close rejection');
        },
        process: () => child,
      },
      () => {
        cleaned = true;
      },
    ),
  ).rejects.toThrow('Synthetic close rejection');
  expect(cleaned).toBe(true);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test('cleanup also runs when launch failed before creating an application', async () => {
  let cleaned = false;
  await closeAuditApplication(undefined, () => {
    cleaned = true;
  });
  expect(cleaned).toBe(true);
});
