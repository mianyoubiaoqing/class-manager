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
  PendingScoreView,
  ScoreConfirmation,
  ScoreVersionView,
} from '../src/shared/score-commands';

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
  const root = mkdtempSync(join(tmpdir(), 'cm-score-worker-'));
  roots.push(root);
  const path = join(root, 'worker.cjs');
  writeFileSync(path, source);
  const client = new WorkerClient(path, root);
  clients.push(client);
  const epoch = value(await client.call<Snapshot>('snapshot')).epoch;
  const classroom = value(await client.call<Snapshot>('createClass', { epoch, name: '合成班' }))
    .classes[0]!;
  const roster = value(
    await client.call<Snapshot>('saveStudent', {
      epoch,
      classId: classroom.id,
      studentNumber: '0001',
      displayName: '合成甲',
    }),
  ).students;
  const subjectId = randomUUID();
  const groupId = randomUUID();
  const templateInput = {
    epoch,
    classId: classroom.id,
    expectedRevision: 0,
    definition: {
      name: '合成考试',
      date: '2026-09-30',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 }],
    groups: [{ id: groupId, name: '数学组', subjectIds: [subjectId] }],
    assignments: roster.map((student) => ({ studentId: student.id, groupId })),
    scoreBasis: 'raw',
    format: 'xlsx',
  };
  const configuration = { ...templateInput, fileName: 'synthetic.xlsx' };
  return { client, epoch, root, path, classroom, configuration, templateInput };
}

test('actual worker exports both template formats and confirms a cloneable score preview', async () => {
  const { client, epoch, root, path, configuration, templateInput } = await fixture();
  const csv = value(
    await client.call<Uint8Array>('exportScoreTemplate', { ...templateInput, format: 'csv' }),
  );
  expect(Buffer.from(csv).toString('utf8')).toContain('"0001","合成甲","合成班",""');
  const xlsx = value(await client.call<Uint8Array>('exportScoreTemplate', templateInput));
  expect(Buffer.from(xlsx).subarray(0, 2).toString()).toBe('PK');
  const blank = value(
    await client.call<PendingScoreView>('previewScoreBytes', { bytes: xlsx, configuration }),
  );
  expect(blank.canConfirm).toBe(true);
  expect(blank.entries[0]?.score.status).toBe('missing');
  const preview = value(
    await client.call<PendingScoreView>('previewScoreBytes', {
      bytes: Buffer.from('学生编号,数学\n0001,99'),
      configuration: { ...configuration, format: 'csv', fileName: 'synthetic.csv' },
    }),
  );
  const command = {
    epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '合成确认',
  };
  const receipt = value(await client.call<ScoreConfirmation>('confirmScores', command));
  const read = value(
    await client.call<ScoreVersionView>('readScoreVersion', {
      epoch,
      versionId: receipt.versionId,
    }),
  );
  expect(read.statistics.subjects[0]?.mean).toBe('99.00');
  await client.close();
  clients.splice(clients.indexOf(client), 1);
  const reopened = new WorkerClient(path, root);
  clients.push(reopened);
  expect(value(await reopened.call<ScoreConfirmation>('confirmScores', command))).toEqual({
    ...receipt,
    replayed: true,
  });
}, 15000);

test('worker awaits XLSX parsing before later roster writes and refuses stale confirmation', async () => {
  const { client, epoch, classroom, configuration, templateInput } = await fixture();
  const bytes = value(await client.call<Uint8Array>('exportScoreTemplate', templateInput));
  const parsing = client.call<PendingScoreView>('previewScoreBytes', { bytes, configuration });
  const change = client.call<Snapshot>('renameClass', {
    epoch,
    id: classroom.id,
    expectedRevision: 1,
    name: '合成新名',
  });
  const preview = value(await parsing);
  expect(preview.canConfirm).toBe(true);
  expect(value(await change).classes[0]?.name).toBe('合成新名');
  expect(
    await client.call('confirmScores', {
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '陈旧确认',
    }),
  ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
}, 15000);

test('restore and cancellation are serialized after asynchronous preview instead of racing it', async () => {
  const { client, epoch, configuration, templateInput } = await fixture();
  const bytes = value(await client.call<Uint8Array>('exportScoreTemplate', templateInput));
  const first = client.call<PendingScoreView>('previewScoreBytes', { bytes, configuration });
  const cancelled = client.call('cancelScorePreview', { epoch });
  const preview = value(await first);
  expect((await cancelled).ok).toBe(true);
  expect(
    await client.call('confirmScores', {
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '已取消',
    }),
  ).toMatchObject({ ok: false, error: { code: 'SCORE_PREVIEW_EXPIRED' } });
  const backup = value(await client.call<Uint8Array>('exportBackup', { epoch }));
  const restore = value(await client.call<RestorePreview>('previewRestoreBytes', backup));
  const parsing = client.call<PendingScoreView>('previewScoreBytes', { bytes, configuration });
  const restoring = client.call<Snapshot>('commitRestore', { epoch, token: restore.token });
  expect(value(await parsing).canConfirm).toBe(true);
  const changed = value(await restoring);
  expect(changed.epoch).not.toBe(epoch);
  expect(await client.call('listExams', { epoch })).toMatchObject({
    ok: false,
    error: { code: 'STALE_WORKSPACE' },
  });
  expect(value(await client.call('listExams', { epoch: changed.epoch }))).toEqual([]);
}, 15000);

test('a rejected async operation does not poison subsequent worker requests', async () => {
  const { client, epoch, configuration } = await fixture();
  expect(
    (await client.call('previewScoreBytes', { bytes: Buffer.from('invalid-xlsx'), configuration }))
      .ok,
  ).toBe(false);
  expect(value(await client.call('listExams', { epoch }))).toEqual([]);
  expect(value(await client.call<Snapshot>('snapshot')).students).toHaveLength(1);
}, 15000);
