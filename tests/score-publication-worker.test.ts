import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSync } from 'esbuild';
import { afterEach, expect, test } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { WorkerClient } from '../src/main/worker-client';
import type { Result } from '../src/shared/contracts';
import type {
  ScorePublicationPreview,
  ScorePublicationReceipt,
} from '../src/shared/score-publication';
import { gradingStorageFixture } from './fixtures/grading-storage';

const roots: string[] = [],
  clients: WorkerClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
test('actual worker validates publication inputs, expires old preview and replays one persisted publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-pub-worker-'));
  roots.push(root);
  const workspace = new Workspace(root);
  const f = await gradingStorageFixture(workspace);
  const edited = workspace.grading.edit({
    epoch: f.epoch,
    id: f.draft.id,
    expectedRevision: 1,
    edits: f.edits,
  });
  const review = workspace.grading.freeze({
    epoch: f.epoch,
    id: f.draft.id,
    expectedRevision: edited.revision,
    requestId: randomUUID(),
    reason: '完整复核',
    acknowledgeComplete: true,
  });
  workspace.close();
  const file = join(root, 'worker.cjs');
  buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/worker.ts'],
      outfile: file,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
    }),
  );
  const client = new WorkerClient(file, root);
  clients.push(client);
  const read = { epoch: f.epoch, reviewId: review.reviewId };
  expect(await client.call('readScorePublication', { ...read, score: 999 })).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION' },
  });
  const first = value(await client.call<ScorePublicationPreview>('prepareScorePublication', read));
  const second = value(await client.call<ScorePublicationPreview>('prepareScorePublication', read));
  const command = {
    ...read,
    token: first.token!,
    expectedVersionId: first.expectedVersionId,
    reason: '具名接口合成入分',
    acknowledgePublish: true,
    acknowledgeReplacement: false,
  };
  expect(await client.call('confirmScorePublication', command)).toMatchObject({
    ok: false,
    error: { code: 'SCORE_PREVIEW_EXPIRED' },
  });
  const input = { ...command, token: second.token! };
  expect(
    await client.call('confirmScorePublication', { ...input, acknowledgePublish: false }),
  ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  const receipt = value(
    await client.call<ScorePublicationReceipt>('confirmScorePublication', input),
  );
  expect(receipt.replayed).toBe(false);
  expect(value(await client.call('confirmScorePublication', input))).toEqual({
    ...receipt,
    replayed: true,
  });
  expect(value(await client.call('readScorePublication', read))).toEqual({
    ...receipt,
    replayed: true,
  });
});
