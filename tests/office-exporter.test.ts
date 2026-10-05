import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { OfficeExporter } from '../src/main/office-exporter';
import { officeRuntimeFixture } from './fixtures/office-runtime';
import type { Result } from '../src/shared/contracts';
import type { WorkerClient } from '../src/main/worker-client';

async function fixture() {
  const { snapshot, options } = await officeRuntimeFixture(false);
  const bytes = Buffer.from('synthetic complete document');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const call: WorkerClient['call'] = async <T>(operation: Parameters<WorkerClient['call']>[0]) =>
    ({
      ok: true,
      value: operation === 'snapshot' ? { epoch: options.epoch } : snapshot,
    }) as Result<T>;
  let published = 0;
  let confirms = 0;
  let opened = 0;
  const generator = { generate: async () => ({ bytes, pages: null }) };
  const dialogs = {
    choose: async () => 'lesson.docx',
    validateDestination: async () => {},
    confirmOverwrite: async () => {
      confirms++;
      return true;
    },
  };
  const files = {
    stamp: async () => (published ? `stamp:${hash}` : null),
    save: async () => {
      published++;
    },
  };
  const exporter = new OfficeExporter({ call }, generator, files);
  return {
    exporter,
    options,
    dialogs,
    files,
    counts: () => ({ published, confirms, opened }),
    open: async () => {
      opened++;
      return '';
    },
  };
}

test('save dialog cancel and declined explicit overwrite preserve the target without publication', async () => {
  const f = await fixture();
  expect(await f.exporter.export(f.options, { ...f.dialogs, choose: async () => null })).toBeNull();
  f.files.stamp = async () => 'existing';
  expect(
    await f.exporter.export(f.options, { ...f.dialogs, confirmOverwrite: async () => false }),
  ).toBeNull();
  expect(f.counts().published).toBe(0);
});

test.each(['read-failure', 'changed-hash'])(
  'post-publication %s returns success with a warning and grants no open capability',
  async (mode) => {
    const f = await fixture();
    f.files.stamp = async () => {
      if (!f.counts().published) return null;
      if (mode === 'read-failure')
        throw Object.assign(new Error('locked after commit'), { code: 'EACCES' });
      return `stamp:${'a'.repeat(64)}`;
    };
    const receipt = await f.exporter.export(f.options, f.dialogs);
    expect(f.counts().published).toBe(1);
    expect(receipt).toMatchObject({ openAvailable: false });
    expect(receipt!.warning).toMatch(/已保存/);
    await expect(
      f.exporter.open({ epoch: f.options.epoch, token: receipt!.token }, f.open),
    ).rejects.toMatchObject({ code: 'EXPORT_EXPIRED' });
    expect(f.counts().opened).toBe(0);
  },
);

test('open only accepts a completed matching file token, and invalidation revokes it', async () => {
  const f = await fixture();
  const receipt = await f.exporter.export(f.options, f.dialogs);
  expect(receipt).toMatchObject({ openAvailable: true, versionId: f.options.versionId });
  await f.exporter.open({ epoch: f.options.epoch, token: receipt!.token }, f.open);
  expect(f.counts().opened).toBe(1);
  f.exporter.invalidate();
  await expect(
    f.exporter.open({ epoch: f.options.epoch, token: receipt!.token }, f.open),
  ).rejects.toMatchObject({ code: 'EXPORT_EXPIRED' });
});

test('a cancelled generation or save selection never publishes and releases the lifetime', async () => {
  const f = await fixture();
  const dialogs = {
    ...f.dialogs,
    choose: async () => {
      f.exporter.cancel({ epoch: f.options.epoch });
      return 'lesson.docx';
    },
  };
  await expect(f.exporter.export(f.options, dialogs)).rejects.toMatchObject({
    code: 'EXPORT_CANCELLED',
  });
  expect(f.counts().published).toBe(0);
  expect(await f.exporter.export(f.options, f.dialogs)).not.toBeNull();
});
