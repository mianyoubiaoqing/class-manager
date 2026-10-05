import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { assertLocalScorePath } from '../src/main/local-score-path';
import { readScoreFile } from '../src/main/score-files';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('rejects shared and device paths before drive or file access', async () => {
  const classify = vi.fn(async () => 'Fixed');
  for (const path of [
    '\\\\server\\share\\scores.csv',
    '//server/share/scores.csv',
    '\\\\?\\C:\\scores.csv',
    'scores.csv',
    'C:scores.csv',
  ]) {
    await expect(assertLocalScorePath(path, classify)).rejects.toMatchObject({
      code: 'SCORE_LOCAL_FILE',
    });
  }
  expect(classify).not.toHaveBeenCalled();
});

test('mapped or unclassifiable drives fail closed without touching nonexistent parents', async () => {
  for (const type of ['Network', 'Unknown', 'NoRootDirectory', '']) {
    await expect(
      assertLocalScorePath('Z:\\does-not-exist\\scores.csv', async () => type),
    ).rejects.toMatchObject({ code: 'SCORE_LOCAL_FILE' });
  }
  await expect(
    assertLocalScorePath('Z:\\does-not-exist\\scores.csv', async () => {
      throw new Error('drive query timed out');
    }),
  ).rejects.toMatchObject({ code: 'SCORE_LOCAL_FILE' });
});

test('rejects parent junctions but reads a real local file through the native drive check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-score-file-'));
  roots.push(root);
  const directory = join(root, 'ordinary');
  mkdirSync(directory);
  const file = join(directory, 'scores.csv');
  writeFileSync(file, 'synthetic');
  const link = join(root, 'linked');
  symlinkSync(directory, link, 'junction');
  await expect(
    assertLocalScorePath(join(link, 'scores.csv'), async () => 'Fixed'),
  ).rejects.toMatchObject({ code: 'SCORE_LOCAL_FILE' });
  const result = await readScoreFile(file, 'synthetic-epoch');
  expect(result.name).toBe('scores.csv');
  expect(Buffer.from(result.bytes).toString()).toBe('synthetic');
});
