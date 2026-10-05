import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import {
  createPrintPreviewFile,
  countPrintPreviewResidues,
  recoverPrintPreviews,
  removePrintPreview,
} from '../src/main/print-preview-files';

const roots: string[] = [];
function root() {
  const value = mkdtempSync(join(tmpdir(), 'cm-print-cache-'));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

test('interrupted preview is marked before labels and recovered on the next startup', async () => {
  const directory = root();
  const file = await createPrintPreviewFile(directory, '合成学生资料');
  expect(readFileSync(file.path, 'utf8')).toBe('合成学生资料');
  expect(countPrintPreviewResidues(directory)).toBe(1);
  expect(await recoverPrintPreviews(directory)).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});

test('temporary file locks are retried a bounded number of times', async () => {
  const directory = root();
  await createPrintPreviewFile(directory, 'synthetic');
  const name = readdirSync(directory)[0]!;
  let attempts = 0;
  const removed = await removePrintPreview(directory, name, (path) => {
    if (path.endsWith('preview.html') && ++attempts < 3) throw new Error('Synthetic file busy');
    unlinkSync(path);
  });
  expect(removed).toBe(true);
  expect(attempts).toBe(3);
  expect(readdirSync(directory)).toEqual([]);
});

test('persistent lock leaves a recognized residue that later recovery can remove', async () => {
  const directory = root();
  const file = await createPrintPreviewFile(directory, 'synthetic');
  const name = readdirSync(directory)[0]!;
  let attempts = 0;
  expect(
    await removePrintPreview(directory, name, () => {
      attempts++;
      throw new Error('busy');
    }),
  ).toBe(false);
  expect(attempts).toBe(3);
  expect(countPrintPreviewResidues(directory)).toBe(1);
  expect(readFileSync(file.path, 'utf8')).toBe('synthetic');
  expect(await recoverPrintPreviews(directory)).toBe(0);
});

test('unknown files, unmarked directories and traversal names are never removed', async () => {
  const directory = root();
  const file = await createPrintPreviewFile(directory, 'synthetic');
  writeFileSync(join(file.directory, 'keep.txt'), 'caller owned');
  const foreign = join(directory, 'preview-10000000-0000-4000-8000-000000000001');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'preview.html'), 'not marked');
  expect(await recoverPrintPreviews(directory)).toBe(1);
  expect(
    await removePrintPreview(directory, '../preview-10000000-0000-4000-8000-000000000001'),
  ).toBe(false);
  expect(readFileSync(join(file.directory, 'keep.txt'), 'utf8')).toBe('caller owned');
  expect(readFileSync(join(foreign, 'preview.html'), 'utf8')).toBe('not marked');
});

test.each([false, true])(
  'final directory lock preserves recovery marker (persistent=%s)',
  async (persistent) => {
    const directory = root();
    await createPrintPreviewFile(directory, 'synthetic');
    const name = readdirSync(directory)[0]!;
    let attempts = 0;
    const removed = await removePrintPreview(directory, name, unlinkSync, (path) => {
      attempts++;
      if (persistent || attempts < 3) throw new Error('Synthetic directory busy');
      rmdirSync(path);
    });
    expect(attempts).toBe(3);
    expect(removed).toBe(!persistent);
    expect(countPrintPreviewResidues(directory)).toBe(persistent ? 1 : 0);
    if (persistent) expect(readdirSync(join(directory, name))).toEqual(['owner.txt']);
    expect(await recoverPrintPreviews(directory)).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  },
);
