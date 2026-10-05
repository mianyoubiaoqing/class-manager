import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { WorkerClient } from '../src/main/worker-client';
import type { Result, Snapshot, RestorePreview } from '../src/shared/contracts';
import type {
  DutyPreparation,
  DutyConfirmation,
  DutyVersionView,
  DutyPlanSummary,
} from '../src/shared/duty-records';
import { dutyCalendarDate } from '../src/core/duty-records';
import type { PrintDocument } from '../src/core/print-document';

let source: string;
const roots: string[] = [];
const clients: WorkerClient[] = [];
beforeAll(() => {
  source = buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/worker.ts'],
      write: false,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
    }),
  ).outputFiles[0]!.text;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-duty-worker-'));
  roots.push(root);
  const path = join(root, 'worker.cjs');
  writeFileSync(path, source);
  const client = new WorkerClient(path, root);
  clients.push(client);
  const epoch = value(await client.call<Snapshot>('snapshot')).epoch;
  const classId = value(await client.call<Snapshot>('createClass', { epoch, name: '合成值日班' }))
    .classes[0]!.id;
  for (let number = 1; number <= 4; number++)
    value(
      await client.call('saveStudent', {
        epoch,
        classId,
        studentNumber: `D${number}`,
        displayName: `合成${number}`,
      }),
    );
  const snapshot = value(await client.call<Snapshot>('snapshot'));
  const dates = [1, 2, 3].map((offset) => dutyCalendarDate(Date.now() + offset * 86400000));
  const start = {
    epoch,
    classId,
    expectedRevision: 0,
    source: {
      kind: 'new',
      title: '工作线程合成值日',
      participantIds: snapshot.students.map((student) => student.id),
      dates,
      groupCount: 2,
      posts: [{ id: randomUUID(), name: '清扫', startMinute: 960, endMinute: 980, required: 1 }],
      unavailable: [],
    },
  };
  const prepare = () => client.call<DutyPreparation>('prepareDuty', start);
  const command = (draft: DutyPreparation) => ({
    epoch,
    token: draft.token,
    requestId: randomUUID(),
    expectedRevision: draft.expectedRevision,
    reason: '合成确认',
  });
  return { root, path, client, epoch, classId, dates, start, prepare, command };
}

test('real worker duty preparation, adjustment, confirmation, directory and replay survive reopen', async () => {
  const f = await fixture();
  const prepared = value(await f.prepare());
  const ready = value(
    await f.client.call<DutyPreparation>('adjustDuty', {
      epoch: f.epoch,
      token: prepared.token,
      change: { kind: 'rotate' },
    }),
  );
  const command = f.command(ready);
  const saved = value(await f.client.call<DutyConfirmation>('confirmDuty', command));
  const read = value(
    await f.client.call<DutyVersionView>('readDutyVersion', {
      epoch: f.epoch,
      versionId: saved.versionId,
    }),
  );
  expect(read.payload.arrangement).toEqual(ready.draft);
  const plans = value(
    await f.client.call<DutyPlanSummary[]>('listDutyPlans', { epoch: f.epoch, classId: f.classId }),
  );
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({
    planId: saved.planId,
    title: f.start.source.title,
    latestVersionId: saved.versionId,
  });
  expect(
    value(
      await f.client.call('dutyHistory', {
        epoch: f.epoch,
        classId: f.classId,
        planId: saved.planId,
      }),
    ),
  ).toHaveLength(1);
  await f.client.close();
  clients.splice(clients.indexOf(f.client), 1);
  const reopened = new WorkerClient(f.path, f.root);
  clients.push(reopened);
  expect(value(await reopened.call<DutyConfirmation>('confirmDuty', command))).toEqual({
    ...saved,
    replayed: true,
  });
}, 15000);

test('real worker generates bounded confirmed print batches and rejects forged or stale identities', async () => {
  const f = await fixture();
  const draft = value(await f.prepare());
  const receipt = value(await f.client.call<DutyConfirmation>('confirmDuty', f.command(draft)));
  const input = { epoch: f.epoch, versionId: receipt.versionId, pageOffset: 0 };
  const document = value(await f.client.call<PrintDocument>('readDutyPrintBatch', input));
  expect(document.versionId).toBe(receipt.versionId);
  expect(document.pageOffset).toBe(0);
  expect(document.pageCount).toBeLessThanOrEqual(100);
  expect(document.html).toContain('data-row="slot:');
  expect(await f.client.call('readDutyPrintBatch', { ...input, html: 'forged' })).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION' },
  });
  expect(await f.client.call('readDutyPrintBatch', { ...input, pageOffset: 1 })).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION' },
  });
  expect(
    await f.client.call('readDutyPrintBatch', { ...input, epoch: randomUUID() }),
  ).toMatchObject({ ok: false, error: { code: 'STALE_WORKSPACE' } });
}, 15000);

test('real worker rejects forged dates/snapshots, rotates tokens, cancels without writing', async () => {
  const f = await fixture();
  const initial = value(await f.prepare());
  expect(
    await f.client.call('adjustDuty', {
      epoch: f.epoch,
      token: initial.token,
      protectedDate: '1900-01-01',
      change: { kind: 'rotate' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  expect(
    await f.client.call('prepareDuty', { ...f.start, source: { ...f.start.source, members: [] } }),
  ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  expect(await f.client.call('confirmDuty', f.command(initial))).toMatchObject({
    ok: false,
    error: { code: 'DUTY_DRAFT_EXPIRED' },
  });
  const draft = value(await f.prepare());
  const changed = value(
    await f.client.call<DutyPreparation>('adjustDuty', {
      epoch: f.epoch,
      token: draft.token,
      change: { kind: 'rotate' },
    }),
  );
  expect(await f.client.call('cancelDuty', { epoch: f.epoch, token: draft.token })).toMatchObject({
    ok: false,
    error: { code: 'CONFLICT' },
  });
  value(await f.client.call('cancelDuty', { epoch: f.epoch, token: changed.token }));
  expect(await f.client.call('confirmDuty', f.command(changed))).toMatchObject({
    ok: false,
    error: { code: 'DUTY_DRAFT_EXPIRED' },
  });
  expect(
    value(await f.client.call('listDutyPlans', { epoch: f.epoch, classId: f.classId })),
  ).toEqual([]);
}, 15000);

test('queued roster writes invalidate duty confirmation rather than silently substituting new names', async () => {
  const f = await fixture();
  const prepared = value(await f.prepare());
  const rename = f.client.call('renameClass', {
    epoch: f.epoch,
    id: f.classId,
    expectedRevision: 1,
    name: '更名合成班',
  });
  const confirm = f.client.call('confirmDuty', f.command(prepared));
  expect((await rename).ok).toBe(true);
  expect(await confirm).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
}, 15000);

test('worker restore counts duty versions and invalidates old-epoch commands without losing history', async () => {
  const f = await fixture();
  const ready = value(await f.prepare());
  const receipt = value(await f.client.call<DutyConfirmation>('confirmDuty', f.command(ready)));
  const bytes = value(await f.client.call<Uint8Array>('exportBackup', { epoch: f.epoch }));
  const preview = value(await f.client.call<RestorePreview>('previewRestoreBytes', bytes));
  expect(preview.dutyVersionCount).toBe(1);
  const restored = value(
    await f.client.call<Snapshot>('commitRestore', { epoch: f.epoch, token: preview.token }),
  );
  expect(
    await f.client.call('listDutyPlans', { epoch: f.epoch, classId: f.classId }),
  ).toMatchObject({ ok: false, error: { code: 'STALE_WORKSPACE' } });
  expect(
    value(
      await f.client.call<DutyVersionView>('readDutyVersion', {
        epoch: restored.epoch,
        versionId: receipt.versionId,
      }),
    ).payload.arrangement,
  ).toEqual(ready.draft);
}, 15000);

test('worker serializes competing plans and confirms only one overlapping assignment', async () => {
  const f = await fixture();
  const first = value(await f.prepare());
  value(await f.client.call('confirmDuty', f.command(first)));
  const second = value(await f.prepare());
  expect(await f.client.call('confirmDuty', f.command(second))).toMatchObject({
    ok: false,
    error: { code: 'DUTY_CONFLICT' },
  });
  expect(
    value(await f.client.call('listDutyPlans', { epoch: f.epoch, classId: f.classId })),
  ).toHaveLength(1);
}, 15000);
