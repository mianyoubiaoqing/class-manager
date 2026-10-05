import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MaterialTaskRunner } from '../src/main/material-task';
import { gradingTransformSchema, type GradingTransform } from '../src/shared/grading';
import { gradingOriginalRectangle } from '../src/core/grading';
import { gradingTransformHash } from '../src/core/grading-geometry';

const output = resolve('output/grading-image-tests');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'run-'));
const parserPath = join(root, 'material-process.cjs');
const behaviorPath = join(root, 'material-task-behavior.cjs');
const runners: MaterialTaskRunner[] = [];
function runner(script = parserPath, timeoutMs = 30_000) {
  const value = new MaterialTaskRunner(script, timeoutMs);
  runners.push(value);
  return value;
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
  await Promise.all(runners.map((value) => value.close()));
});

function transform(fields: Partial<GradingTransform['page']> = {}): GradingTransform {
  return gradingTransformSchema.parse({
    width: 120,
    height: 80,
    page: {
      id: randomUUID(),
      role: 'student_answer',
      sourceVersionId: randomUUID(),
      fragmentId: 1,
      rotation: 0,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      redactions: [],
      ...fields,
    },
  });
}
async function quadrants(privateColor = [255, 0, 0]) {
  const bytes = Buffer.alloc(120 * 80 * 3);
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 120; x++) {
      const color =
        y < 40 ? (x < 60 ? privateColor : [0, 0, 255]) : x < 60 ? [0, 255, 0] : [255, 255, 0];
      bytes.set(color, (y * 120 + x) * 3);
    }
  return sharp(bytes, { raw: { width: 120, height: 80, channels: 3 } })
    .png()
    .toBuffer();
}
async function pixel(bytes: Buffer, x: number, y: number) {
  const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const start = (y * decoded.info.width + x) * decoded.info.channels;
  return [...decoded.data.subarray(start, start + 3)];
}
function near(actual: number[], expected: number[]) {
  actual.forEach((channel, index) => expect(Math.abs(channel - expected[index]!)).toBeLessThan(12));
}

test('real child bakes original-coordinate masks before crop and clockwise rotation, preserving exact input binding', async () => {
  const bytes = await quadrants();
  const plan = transform({
    rotation: 90,
    crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    redactions: [{ x: 0.25, y: 0.25, width: 0.25, height: 0.25 }],
  });
  const result = await runner().gradingImage(bytes, plan);
  expect(result).toMatchObject({ width: 40, height: 60, mime: 'image/jpeg', crop: plan.page.crop });
  const digest = createHash('sha256').update(bytes).digest('hex');
  expect(result.inputHash).toBe(digest);
  expect(result.transformHash).toBe(gradingTransformHash(digest, plan));
  near(await pixel(result.bytes, 10, 15), [0, 255, 0]);
  near(await pixel(result.bytes, 30, 15), [0, 0, 0]);
  near(await pixel(result.bytes, 10, 45), [255, 255, 0]);
  near(await pixel(result.bytes, 30, 45), [0, 0, 255]);
  const metadata = await sharp(result.bytes).metadata();
  expect(metadata.format).toBe('jpeg');
  expect(metadata.exif).toBeUndefined();
  expect(metadata.icc).toBeUndefined();
  expect(bytes).toEqual(await quadrants());
});

test('changing hidden original pixels cannot change transmitted bytes; unmasked content is retained', async () => {
  const plan = transform({ redactions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }] });
  const instance = runner();
  const first = await instance.gradingImage(await quadrants(), plan);
  const altered = await instance.gradingImage(await quadrants([255, 255, 255]), plan);
  expect(first.bytes.equals(altered.bytes)).toBe(true);
  expect(first.inputHash).not.toBe(altered.inputHash);
  const unmasked = await instance.gradingImage(await quadrants(), transform());
  expect(first.bytes.equals(unmasked.bytes)).toBe(false);
  near(await pixel(first.bytes, 90, 20), [0, 0, 255]);
});

test.each([0, 90, 180, 270] as const)(
  'rotation %i uses the visible image coordinates and preserves all unmasked quadrants',
  async (rotation) => {
    const plan = transform({ rotation });
    const result = await runner().gradingImage(await quadrants(), plan);
    const expected =
      rotation === 0
        ? [255, 0, 0]
        : rotation === 90
          ? [0, 255, 0]
          : rotation === 180
            ? [255, 255, 0]
            : [0, 0, 255];
    near(await pixel(result.bytes, 15, 15), expected);
    expect(result.width).toBe(rotation % 180 ? 80 : 120);
    expect(result.height).toBe(rotation % 180 ? 120 : 80);
  },
);

test('fractional crop uses actual pixel bounds for both outbound preview and original evidence mapping', async () => {
  const plan = transform({ crop: { x: 0.251, y: 0.251, width: 0.498, height: 0.498 } });
  const result = await runner().gradingImage(await quadrants(), plan);
  expect(result.crop).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  expect(
    gradingOriginalRectangle(
      { ...plan.page, width: plan.width, height: plan.height },
      { x: 0, y: 0, width: 1, height: 1 },
    ),
  ).toEqual(result.crop);
});

test('redaction edge pixels are replaced even for a subpixel private region', async () => {
  const plan = transform({ redactions: [{ x: 0.5001, y: 0.2501, width: 0.0001, height: 0.0001 }] });
  const first = Buffer.alloc(120 * 80 * 3, 255);
  const second = Buffer.from(first);
  second.set([255, 0, 0], (20 * 120 + 60) * 3);
  const encode = (raw: Buffer) =>
    sharp(raw, { raw: { width: 120, height: 80, channels: 3 } })
      .png()
      .toBuffer();
  const instance = runner();
  expect((await instance.gradingImage(await encode(first), plan)).bytes).toEqual(
    (await instance.gradingImage(await encode(second), plan)).bytes,
  );
});

test('invalid dimensions, metadata orientation and noncanonical bytes cannot produce an external copy', async () => {
  const instance = runner();
  const bytes = await quadrants();
  await expect(instance.gradingImage(bytes, { ...transform(), width: 121 })).rejects.toMatchObject({
    code: 'MATERIAL_INVALID',
  });
  const oriented = await sharp(bytes).withMetadata({ orientation: 6 }).png().toBuffer();
  await expect(instance.gradingImage(oriented, transform())).rejects.toMatchObject({
    code: 'MATERIAL_INVALID',
  });
  await expect(instance.gradingImage(Buffer.from('not image'), transform())).rejects.toMatchObject({
    code: 'MATERIAL_INVALID',
  });
  await expect(
    instance.gradingImage(bytes, { ...transform(), width: 20_000, height: 20_000 }),
  ).rejects.toThrow();
  expect((await instance.parse(Buffer.from('still reusable'), 'txt')).version.format).toBe('txt');
});

test('grading image cancellation, process failure and deadline retain exclusive lifetime without a retry', async () => {
  const instance = runner(behaviorPath);
  const controller = new AbortController();
  const task = instance.gradingImage(Buffer.from('hang'), transform(), controller.signal);
  const rejected = expect(task).rejects.toMatchObject({ code: 'MATERIAL_CANCELLED' });
  await expect(instance.modelImage(Buffer.from('other'))).rejects.toMatchObject({
    code: 'MATERIAL_TASK_BUSY',
  });
  controller.abort();
  await rejected;
  await expect(instance.gradingImage(Buffer.from('mismatch'), transform())).rejects.toMatchObject({
    code: 'MATERIAL_TASK_FAILED',
  });
  await expect(
    runner(behaviorPath, 500).gradingImage(Buffer.from('hang'), transform()),
  ).rejects.toMatchObject({ code: 'MATERIAL_TIMEOUT' });
});
