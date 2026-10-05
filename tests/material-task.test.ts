import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import sharp from 'sharp';
import { MaterialTaskRunner } from '../src/main/material-task';
import { syntheticPdf } from './fixtures/material-pdf';

const output = resolve('output/material-task-tests');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-'));
const parserPath = join(root, 'material-process.cjs');
const behaviorPath = join(root, 'material-task-behavior.cjs');
const runners: MaterialTaskRunner[] = [];
function runner(script = parserPath, timeoutMs = 30_000) {
  const result = new MaterialTaskRunner(script, timeoutMs);
  runners.push(result);
  return result;
}
beforeAll(async () => {
  await build(
    nodeBundleOptions({
      entryPoints: ['src/main/material-process.ts', 'tests/fixtures/material-task-behavior.ts'],
      outdir: root,
      outbase: '.',
      entryNames: '[name]',
      outExtension: { '.js': '.cjs' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
    }),
  );
});
afterAll(async () => {
  await Promise.all(runners.map((instance) => instance.close()));
});

test('isolated child returns bounded original bytes and source metadata without creating persistence', async () => {
  const parsed = await runner().parse(Buffer.from('合成资料\n下一行'), 'txt');
  expect(parsed.version.format).toBe('txt');
  expect(parsed.version.fragments[0]).toMatchObject({ kind: 'text', text: '合成资料\n下一行' });
  expect(Buffer.isBuffer(parsed.assets[0]!.bytes)).toBe(true);
});

test('native image decoding works in the spawned process and can run again after it exits', async () => {
  const instance = runner();
  const bytes = await sharp({
    create: { width: 30, height: 20, channels: 3, background: '#80a040' },
  })
    .png()
    .toBuffer();
  const parsed = await instance.parse(bytes, 'png');
  expect(parsed.version.fragments[0]).toMatchObject({ kind: 'image', width: 30, height: 20 });
  expect((await instance.parse(Buffer.from('second'), 'txt')).version.fragments[0]).toMatchObject({
    text: 'second',
  });
});

test('model image conversion runs in the child, bounds dimensions and rejects raw non-PNG input', async () => {
  const instance = runner();
  const png = await sharp({
    create: { width: 3000, height: 2000, channels: 4, background: '#22447780' },
  })
    .png()
    .toBuffer();
  const result = await instance.modelImage(png);
  expect(result).toMatchObject({ width: 2048, height: 1365, mime: 'image/jpeg' });
  expect(result.bytes.length).toBeLessThanOrEqual(1024 * 1024);
  expect(await sharp(result.bytes).metadata()).toMatchObject({ format: 'jpeg', width: 2048 });
  await expect(instance.modelImage(result.bytes)).rejects.toMatchObject({
    code: 'MATERIAL_INVALID',
  });
  expect((await instance.parse(Buffer.from('still reusable'), 'txt')).version.format).toBe('txt');
});

test('model image cancellation uses the same exclusive child lifetime as import parsing', async () => {
  const instance = runner(behaviorPath);
  const controller = new AbortController();
  const pending = instance.modelImage(Buffer.from('hang'), controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'MATERIAL_CANCELLED' });
  await expect(instance.parse(Buffer.from('other'), 'txt')).rejects.toMatchObject({
    code: 'MATERIAL_TASK_BUSY',
  });
  controller.abort();
  await rejected;
  await expect(instance.modelImage(Buffer.from('mismatch'))).rejects.toMatchObject({
    code: 'MATERIAL_TASK_FAILED',
  });
});

test('parser error is propagated without leaking internal stack and leaves the runner reusable', async () => {
  const instance = runner();
  await expect(instance.parse(Buffer.from('bad image'), 'png')).rejects.toMatchObject({
    code: 'MATERIAL_INVALID',
  });
  expect((await instance.parse(Buffer.from('valid'), 'txt')).version.format).toBe('txt');
});

test('PDF decoder and native page canvas run in the same cancellable child boundary', async () => {
  const parsed = await runner().parse(syntheticPdf([{ text: 'Isolated PDF' }]), 'pdf');
  expect(parsed.version.fragments).toMatchObject([
    { kind: 'text', text: 'Isolated PDF' },
    { kind: 'image', width: 270, height: 150 },
  ]);
  expect(parsed.assets).toHaveLength(2);
});

test('cancellation kills child, suppresses concurrent admission and permits the next task only after close', async () => {
  const instance = runner(behaviorPath);
  const controller = new AbortController();
  const pending = instance.parse(Buffer.from('hang'), 'txt', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'MATERIAL_CANCELLED' });
  await expect(instance.parse(Buffer.from('other'), 'txt')).rejects.toMatchObject({
    code: 'MATERIAL_TASK_BUSY',
  });
  controller.abort();
  await rejected;
  expect((await instance.parse(Buffer.from('okay'), 'txt')).version.format).toBe('txt');
});

test('deadline terminates a hung process and shutdown does not leave it running', async () => {
  const instance = runner(behaviorPath, 500);
  await expect(instance.parse(Buffer.from('hang'), 'txt')).rejects.toMatchObject({
    code: 'MATERIAL_TIMEOUT',
  });
  await instance.close();
  await expect(instance.parse(Buffer.from('after-close'), 'txt')).rejects.toMatchObject({
    code: 'MATERIAL_TASK_CLOSED',
  });
});

test('closing active runner cancels and waits for completion', async () => {
  const instance = runner(behaviorPath);
  const pending = instance.parse(Buffer.from('hang'), 'txt');
  const rejected = expect(pending).rejects.toMatchObject({ code: 'MATERIAL_CANCELLED' });
  await instance.close();
  await rejected;
});

test.each(['crash', 'invalid', 'mismatch', 'orphan', 'duplicate', 'original-mime'])(
  'child %s cannot return an accepted result',
  async (mode) => {
    await expect(runner(behaviorPath).parse(Buffer.from(mode), 'txt')).rejects.toMatchObject({
      code: 'MATERIAL_TASK_FAILED',
    });
  },
);

test('unrelated environment secrets are not inherited by a material task', async () => {
  const previous = process.env.MATERIAL_TEST_SECRET;
  process.env.MATERIAL_TEST_SECRET = 'synthetic-not-a-real-key';
  try {
    expect(
      (await runner(behaviorPath).parse(Buffer.from('environment'), 'txt')).version.format,
    ).toBe('txt');
  } finally {
    if (previous === undefined) delete process.env.MATERIAL_TEST_SECRET;
    else process.env.MATERIAL_TEST_SECRET = previous;
  }
});

test('pre-cancelled input and missing process script reject without hanging the runner', async () => {
  await expect(runner().parse(Buffer.from('x'), 'txt', AbortSignal.abort())).rejects.toMatchObject({
    code: 'MATERIAL_CANCELLED',
  });
  await expect(
    runner(join(root, 'missing.cjs')).parse(Buffer.from('x'), 'txt'),
  ).rejects.toMatchObject({ code: 'MATERIAL_TASK_FAILED' });
});
