import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import JSZip from 'jszip';
import { OfficeTaskRunner } from '../src/main/office-task';
import { officeRuntimeFixture } from './fixtures/office-runtime';

const parent = resolve('output/office-task-tests');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const instances: OfficeTaskRunner[] = [];
const runner = (behavior = false, deadline = 60000) => {
  const instance = new OfficeTaskRunner(
    join(root, behavior ? 'office-task-behavior.cjs' : 'office-process.cjs'),
    deadline,
  );
  instances.push(instance);
  return instance;
};
const modeFixture = async (mode: string) => {
  const fixture = await officeRuntimeFixture(false);
  fixture.snapshot.content.title = mode;
  fixture.snapshot.contentHash = createHash('sha256')
    .update(JSON.stringify(fixture.snapshot.content))
    .digest('hex');
  return fixture;
};
beforeAll(async () => {
  await build(
    nodeBundleOptions({
      entryPoints: ['src/main/office-process.ts', 'tests/fixtures/office-task-behavior.ts'],
      outdir: root,
      entryNames: '[name]',
      outExtension: { '.js': '.cjs' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['sharp'],
    }),
  );
});
afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.close()));
});

test('actual isolated export process emits DOCX/PPTX without Office COM and can be reused after close', async () => {
  const { snapshot, options } = await officeRuntimeFixture(false);
  const instance = runner();
  const word = await instance.generate(snapshot, options);
  expect(word.pages).toBeNull();
  expect((await JSZip.loadAsync(word.bytes)).file('word/document.xml')).not.toBeNull();
  const deck = await instance.generate(snapshot, { ...options, format: 'pptx' });
  expect(deck.pages).toBeGreaterThanOrEqual(snapshot.content.slides.length);
  expect((await JSZip.loadAsync(deck.bytes)).file('ppt/presentation.xml')).not.toBeNull();
});

test('teaching reports generate actual DOCX and XLSX in the bounded Office child', async () => {
  const instance = runner();
  const report = {
    title: '合成班级资料',
    rows: [
      ['学生', '记录'],
      ['合成学生', '第一行\n第二行'],
    ],
  };
  const word = await instance.generateTeachingReport({ ...report, format: 'docx' });
  expect((await JSZip.loadAsync(word.bytes)).file('word/document.xml')).not.toBeNull();
  const sheet = await instance.generateTeachingReport({ ...report, format: 'xlsx' });
  expect((await JSZip.loadAsync(sheet.bytes)).file('xl/worksheets/sheet1.xml')).not.toBeNull();
  await expect(
    instance.generateTeachingReport({ ...report, rows: [['x'.repeat(10001)]], format: 'docx' }),
  ).rejects.toThrow();
});

test('legal long teaching content survives DOCX and XLSX export without truncation', async () => {
  const instance = runner();
  const content = '长记录'.repeat(2000);
  for (const format of ['docx', 'xlsx'] as const) {
    const result = await instance.generateTeachingReport({
      title: '长记录',
      rows: [['内容', content]],
      format,
    });
    const zip = await JSZip.loadAsync(result.bytes);
    const xml = await zip
      .file(format === 'docx' ? 'word/document.xml' : 'xl/sharedStrings.xml')!
      .async('string');
    expect(xml).toContain(content);
  }
});

test('cancel waits for child closure, prevents concurrent admission and allows a subsequent task', async () => {
  const { snapshot, options } = await modeFixture('hang');
  const instance = runner(true);
  const controller = new AbortController();
  const pending = instance.generate(snapshot, options, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'EXPORT_CANCELLED' });
  await expect(instance.generate(snapshot, options)).rejects.toMatchObject({ code: 'BUSY' });
  controller.abort();
  await rejected;
  const next = await modeFixture('okay');
  expect((await instance.generate(next.snapshot, next.options)).bytes.length).toBe(5);
});

test.each(['crash', 'invalid', 'mismatch', 'duplicate'])(
  'child %s rejects rather than admitting a file',
  async (mode) => {
    const { snapshot, options } = await modeFixture(mode);
    await expect(runner(true).generate(snapshot, options)).rejects.toMatchObject({
      code: 'EXPORT_FAILED',
    });
  },
);

test('deadline and explicit shutdown terminate a hung task without automatic retry', async () => {
  const { snapshot, options } = await modeFixture('hang');
  const instance = runner(true, 300);
  await expect(instance.generate(snapshot, options)).rejects.toMatchObject({
    code: 'EXPORT_TIMEOUT',
  });
  const active = runner(true);
  const pending = active.generate(snapshot, options);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'EXPORT_CANCELLED' });
  await active.close();
  await rejected;
  await expect(active.generate(snapshot, options)).rejects.toMatchObject({ code: 'EXPORT_CLOSED' });
});

test('unrelated environment credentials are not inherited and pre-cancelled tasks do not spawn', async () => {
  const previous = process.env.OFFICE_TEST_SECRET;
  process.env.OFFICE_TEST_SECRET = 'synthetic-not-a-key';
  try {
    const { snapshot, options } = await modeFixture('environment');
    expect((await runner(true).generate(snapshot, options)).bytes.length).toBe(5);
    await expect(runner().generate(snapshot, options, AbortSignal.abort())).rejects.toMatchObject({
      code: 'EXPORT_CANCELLED',
    });
  } finally {
    if (previous === undefined) delete process.env.OFFICE_TEST_SECRET;
    else process.env.OFFICE_TEST_SECRET = previous;
  }
});
