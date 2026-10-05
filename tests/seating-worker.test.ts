import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSync } from 'esbuild';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { WorkerClient } from '../src/main/worker-client';
import type { Result, Snapshot, RestorePreview } from '../src/shared/contracts';
import type {
  SeatingPreparation,
  SeatingConfirmation,
  SeatingVersion,
  SeatingVersionView,
} from '../src/shared/seating-records';

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
  const root = mkdtempSync(join(tmpdir(), 'cm-seating-worker-'));
  roots.push(root);
  const path = join(root, 'worker.cjs');
  writeFileSync(path, source);
  const client = new WorkerClient(path, root);
  clients.push(client);
  const epoch = value(await client.call<Snapshot>('snapshot')).epoch;
  const classId = value(await client.call<Snapshot>('createClass', { epoch, name: '合成座位班' }))
    .classes[0]!.id;
  for (let number = 1; number <= 3; number++)
    value(
      await client.call('saveStudent', {
        epoch,
        classId,
        studentNumber: `S${number}`,
        displayName: `合成${number}`,
      }),
    );
  const prepare = () =>
    client.call<SeatingPreparation>('prepareSeating', {
      epoch,
      classId,
      expectedRevision: 0,
      source: {
        kind: 'empty',
        layout: { rows: 2, columns: 2, unavailable: [{ row: 2, column: 2 }] },
      },
    });
  const randomize = (draft: SeatingPreparation) =>
    client.call<SeatingPreparation>('adjustSeating', {
      epoch,
      token: draft.token,
      change: { kind: 'randomize' },
    });
  const command = (draft: SeatingPreparation) => ({
    epoch,
    token: draft.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '合成确认',
  });
  return { root, path, client, epoch, classId, prepare, randomize, command };
}

test('real worker prepares, adjusts, confirms and replays seating after reopening', async () => {
  const f = await fixture();
  const draft = value(await f.prepare());
  expect(draft.complete).toBe(false);
  const ready = value(await f.randomize(draft));
  expect(ready.complete).toBe(true);
  expect(ready.draft.assignments).toHaveLength(3);
  const command = f.command(ready);
  const receipt = value(await f.client.call<SeatingConfirmation>('confirmSeating', command));
  const saved = value(
    await f.client.call<SeatingVersionView>('readSeatingVersion', {
      epoch: f.epoch,
      versionId: receipt.versionId,
    }),
  );
  expect(saved.payload.arrangement).toEqual(ready.draft);
  expect(
    value(
      await f.client.call<SeatingVersion[]>('seatingHistory', {
        epoch: f.epoch,
        classId: f.classId,
      }),
    ),
  ).toHaveLength(1);
  await f.client.close();
  clients.splice(clients.indexOf(f.client), 1);
  const reopened = new WorkerClient(f.path, f.root);
  clients.push(reopened);
  expect(value(await reopened.call<SeatingConfirmation>('confirmSeating', command))).toEqual({
    ...receipt,
    replayed: true,
  });
}, 15000);

test('worker rejects forged snapshots, old tokens and conflicts without poisoning the queue', async () => {
  const f = await fixture();
  const draft = value(await f.prepare());
  expect(
    await f.client.call('adjustSeating', {
      epoch: f.epoch,
      token: draft.token,
      change: { kind: 'randomize' },
      members: [],
    }),
  ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  const ready = value(await f.randomize(draft));
  expect(await f.randomize(draft)).toMatchObject({
    ok: false,
    error: { code: 'SEATING_DRAFT_EXPIRED' },
  });
  const studentId = ready.draft.members[0]!.studentId;
  const locked = value(
    await f.client.call<SeatingPreparation>('adjustSeating', {
      epoch: f.epoch,
      token: ready.token,
      change: { kind: 'lock', studentId, locked: true },
    }),
  );
  expect(
    await f.client.call('adjustSeating', {
      epoch: f.epoch,
      token: locked.token,
      change: { kind: 'move', studentId, target: { row: 2, column: 2 } },
    }),
  ).toMatchObject({ ok: false });
  value(await f.client.call('cancelSeating', { epoch: f.epoch, token: locked.token }));
  expect(await f.client.call('confirmSeating', f.command(locked))).toMatchObject({
    ok: false,
    error: { code: 'SEATING_DRAFT_EXPIRED' },
  });
  expect(
    value(await f.client.call('seatingHistory', { epoch: f.epoch, classId: f.classId })),
  ).toEqual([]);
}, 15000);

test('roster write queued before confirmation invalidates a prepared seating snapshot', async () => {
  const f = await fixture();
  const ready = value(await f.randomize(value(await f.prepare())));
  const rename = f.client.call('renameClass', {
    epoch: f.epoch,
    id: f.classId,
    expectedRevision: 1,
    name: '变更班名',
  });
  const confirmation = f.client.call('confirmSeating', f.command(ready));
  expect((await rename).ok).toBe(true);
  expect(await confirmation).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
}, 15000);

test('worker backup restores confirmed seats and invalidates earlier workspace drafts', async () => {
  const f = await fixture();
  const ready = value(await f.randomize(value(await f.prepare())));
  const saved = value(await f.client.call<SeatingConfirmation>('confirmSeating', f.command(ready)));
  const pending = value(
    await f.client.call<SeatingPreparation>('prepareSeating', {
      epoch: f.epoch,
      classId: f.classId,
      expectedRevision: 1,
      source: { kind: 'latest' },
    }),
  );
  const bytes = value(await f.client.call<Uint8Array>('exportBackup', { epoch: f.epoch }));
  const preview = value(await f.client.call<RestorePreview>('previewRestoreBytes', bytes));
  expect(preview.seatingVersionCount).toBe(1);
  const snapshot = value(
    await f.client.call<Snapshot>('commitRestore', { epoch: f.epoch, token: preview.token }),
  );
  expect(
    await f.client.call('cancelSeating', { epoch: f.epoch, token: pending.token }),
  ).toMatchObject({ ok: false, error: { code: 'STALE_WORKSPACE' } });
  const read = value(
    await f.client.call<SeatingVersionView>('readSeatingVersion', {
      epoch: snapshot.epoch,
      versionId: saved.versionId,
    }),
  );
  expect(read.payload.arrangement).toEqual(ready.draft);
}, 15000);
