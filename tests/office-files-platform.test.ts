import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { officeTargetStamp, saveOfficeFile } from '../src/main/office-files';

async function withGuard(path: string, mode: 'lock' | 'permission', run: () => Promise<void>) {
  const source = await readFile('tests/fixtures/office-file-guard.ps1', 'utf8');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLASS_MANAGER_OFFICE_GUARD_PATH: path,
      CLASS_MANAGER_OFFICE_GUARD_MODE: mode,
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const done = new Promise<number | null>((resolveDone, reject) => {
    child.once('close', resolveDone);
    child.once('error', reject);
  });
  try {
    await new Promise<void>((ready, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error('File guard readiness timed out')), 5000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes('READY')) {
          clearTimeout(timer);
          ready();
        }
      });
      void done.then(() => {
        clearTimeout(timer);
        reject(new Error(`Guard exited early: ${stderr}`));
      }, reject);
    });
    await run();
  } finally {
    // Ask this owned helper to release/restore first; never kill a helper while it owns the ACL.
    child.stdin.end('\n');
    expect(await done, stderr).toBe(0);
  }
}

test.runIf(process.platform === 'win32')(
  'real Windows exclusive lock and denied directory creation preserve the old file',
  async () => {
    const parent = resolve('output/office-platform-tests');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'run-'));
    const path = join(root, 'lesson.docx');
    await writeFile(path, 'previous file');
    const stamp = await officeTargetStamp(path);
    await withGuard(path, 'lock', async () => {
      await expect(
        saveOfficeFile(path, Buffer.from('new file'), 'docx', stamp),
      ).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EBUSY|EPERM/u) });
    });
    expect(await readFile(path, 'utf8')).toBe('previous file');
    expect(await readdir(root)).toEqual(['lesson.docx']);
    await withGuard(root, 'permission', async () => {
      await expect(
        saveOfficeFile(path, Buffer.from('new file'), 'docx', stamp),
      ).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/u) });
    });
    expect(await readFile(path, 'utf8')).toBe('previous file');
    expect(await readdir(root)).toEqual(['lesson.docx']);
    await saveOfficeFile(path, Buffer.from('valid retry'), 'docx', await officeTargetStamp(path));
    expect(await readFile(path, 'utf8')).toBe('valid retry');
  },
);
