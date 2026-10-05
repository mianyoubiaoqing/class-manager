import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterEach, expect, test } from 'vitest';
import { Workspace } from '../src/core/workspace';
import type { GradingCheckpoint } from '../src/core/grading-book';
import { gradingStorageFixture } from './fixtures/grading-storage';
import { SCHEMA_VERSION, openDatabase } from '../src/core/database';

const roots: string[] = [],
  live: Workspace[] = [];
async function fixture(checkpoint?: GradingCheckpoint) {
  const root = mkdtempSync(join(tmpdir(), 'cm-grading-'));
  roots.push(root);
  const workspace = new Workspace(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checkpoint,
  );
  live.push(workspace);
  return { workspace, root, ...(await gradingStorageFixture(workspace)) };
}
function reopen(workspace: Workspace, root: string) {
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  const next = new Workspace(root);
  live.push(next);
  return next;
}
afterEach(() => {
  for (const workspace of live.splice(0)) workspace.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('immutable rubrics and explicit answer creation are idempotent and preserve formal scores', async () => {
  const f = await fixture();
  const before = f.workspace.scores.read({ epoch: f.epoch, versionId: f.score.versionId });
  expect(f.workspace.grading.createRubric(f.rubricInput)).toEqual({ ...f.rubric, replayed: true });
  expect(f.workspace.grading.create(f.createInput)).toEqual({ ...f.draft, replayed: true });
  expect(() =>
    f.workspace.grading.createRubric({
      ...f.rubricInput,
      definition: { ...f.definition, title: 'different' },
    }),
  ).toThrow('其他内容');
  expect(() =>
    f.workspace.grading.create({
      ...f.createInput,
      request: { ...f.request, expectedAnswerPages: 2 },
    }),
  ).toThrow('其他内容');
  expect(
    f.workspace.grading
      .read({ epoch: f.epoch, id: f.draft.id })
      .payload.rows.map((row) => row.scoreHundredths),
  ).toEqual([null, null]);
  const next = reopen(f.workspace, f.root);
  expect(next.grading.list({ epoch: f.epoch, examId: f.score.examId })).toHaveLength(1);
  expect(next.scores.read({ epoch: f.epoch, versionId: f.score.versionId })).toEqual(before);
});

test('batch generation preserves unselected manual review, stores each attempt and replays a committed result without a network request', async () => {
  const f = await fixture();
  f.workspace.grading.edit({
    epoch: f.epoch,
    id: f.draft.id,
    expectedRevision: 1,
    edits: [f.edits[1]],
  });
  const command = f.generation();
  expect(() => f.workspace.grading.claim(command)).toThrow();
  expect(() =>
    f.workspace.grading.edit({
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 2,
      edits: f.edits,
    }),
  ).toThrow('尚未结束');
  const saved = f.workspace.grading.complete(command);
  const view = f.workspace.grading.read({ epoch: f.epoch, id: f.draft.id });
  expect(view.payload.rows.map((row) => [row.scoreHundredths, row.reviewed])).toEqual([
    [500, false],
    [500, true],
  ]);
  expect(f.workspace.grading.attempts({ epoch: f.epoch, id: f.draft.id })[0]?.record.status).toBe(
    'succeeded',
  );
  const next = reopen(f.workspace, f.root);
  expect(next.grading.complete(command)).toEqual({ ...saved, replayed: true });
  expect(() => next.grading.complete({ ...command, output: '{}' })).toThrow('不同');
  expect(next.grading.read({ epoch: f.epoch, id: f.draft.id })).toEqual(view);
});

test('teacher review freezes one immutable version; corrections require a new draft and new explicit review', async () => {
  const f = await fixture();
  expect(() =>
    f.workspace.grading.freeze({
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      reason: '未复核',
      acknowledgeComplete: true,
    }),
  ).toThrow('未决');
  const edit = { epoch: f.epoch, id: f.draft.id, expectedRevision: 1, edits: f.edits };
  expect(f.workspace.grading.edit(edit).revision).toBe(2);
  expect(f.workspace.grading.edit(edit).replayed).toBe(true);
  expect(
    f.workspace.grading
      .history({ epoch: f.epoch, id: f.draft.id })
      .map((item) => item.record.operation),
  ).toEqual(['edited', 'created']);
  const freeze = {
    epoch: f.epoch,
    id: f.draft.id,
    expectedRevision: 2,
    requestId: randomUUID(),
    reason: '教师完整复核',
    acknowledgeComplete: true,
  };
  const review = f.workspace.grading.freeze(freeze);
  expect(review.totalHundredths).toBe(1000);
  expect(f.workspace.grading.freeze(freeze).replayed).toBe(true);
  const original = f.workspace.grading.readReview({ epoch: f.epoch, id: review.reviewId });
  expect(() => f.workspace.grading.edit({ ...edit, expectedRevision: 3 })).toThrow('冻结');
  const revised = f.workspace.grading.create({
    epoch: f.epoch,
    requestId: randomUUID(),
    request: f.request,
    baseReviewId: review.reviewId,
  });
  expect(
    f.workspace.grading
      .read({ epoch: f.epoch, id: revised.id })
      .payload.rows.every((row) => !row.reviewed),
  ).toBe(true);
  expect(() =>
    f.workspace.grading.freeze({
      ...freeze,
      id: revised.id,
      expectedRevision: 1,
      requestId: randomUUID(),
    }),
  ).toThrow('未复核');
  expect(f.workspace.grading.readReview({ epoch: f.epoch, id: review.reviewId })).toEqual(original);
  expect(f.workspace.grading.history({ epoch: f.epoch, id: f.draft.id })[0]?.record.operation).toBe(
    'frozen',
  );
  const next = reopen(f.workspace, f.root);
  expect(next.grading.readReview({ epoch: f.epoch, id: review.reviewId })).toEqual(original);
});

test('new rubric invalidates old drafts and explicit rebinding clears all old review; score corrections also mark stale', async () => {
  const f = await fixture();
  f.workspace.grading.edit({ epoch: f.epoch, id: f.draft.id, expectedRevision: 1, edits: f.edits });
  const nextRubric = f.workspace.grading.createRubric({
    ...f.rubricInput,
    requestId: randomUUID(),
    definition: {
      ...f.definition,
      questions: f.definition.questions.map((q) =>
        q.kind === 'single_choice' ? { ...q, correct: 'A' } : q,
      ),
    },
  });
  expect(f.workspace.grading.read({ epoch: f.epoch, id: f.draft.id }).stale).toBe(true);
  expect(() =>
    f.workspace.grading.edit({
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 2,
      edits: f.edits,
    }),
  ).toThrow('新版本');
  const rebind = {
    epoch: f.epoch,
    id: f.draft.id,
    expectedRevision: 2,
    request: { ...f.request, rubricVersionId: nextRubric.id },
  };
  expect(f.workspace.grading.rebind(rebind).revision).toBe(3);
  expect(f.workspace.grading.rebind(rebind).replayed).toBe(true);
  expect(
    f.workspace.grading
      .read({ epoch: f.epoch, id: f.draft.id })
      .payload.rows.every((row) => row.status === 'pending' && !row.reviewed),
  ).toBe(true);
  const preview = await f.workspace.scores.preview(
    Buffer.from('学生编号,合成学科\nSYNTHETIC_1,1'),
    { ...f.scoreInput, examId: f.score.examId, expectedRevision: 1 },
  );
  f.workspace.scores.confirm({
    epoch: f.epoch,
    token: preview.token,
    expectedRevision: 1,
    requestId: randomUUID(),
    reason: '合成成绩更正',
  });
  expect(f.workspace.grading.read({ epoch: f.epoch, id: f.draft.id }).stale).toBe(true);
});

test.each(['cancel', 'invalid', 'admission'] as const)(
  '%s keeps confirmed inputs and progress without a late commit',
  async (kind) => {
    const f = await fixture();
    const before = f.workspace.grading.read({ epoch: f.epoch, id: f.draft.id });
    const command = f.generation();
    if (kind === 'cancel') f.workspace.grading.cancel({ epoch: f.epoch });
    const complete = kind === 'invalid' ? { ...command, output: '{}' } : command;
    expect(() =>
      f.workspace.grading.complete(
        complete,
        kind === 'admission'
          ? () => {
              throw new Error('cancelled before commit');
            }
          : undefined,
      ),
    ).toThrow();
    if (kind !== 'cancel')
      f.workspace.grading.end({
        epoch: f.epoch,
        requestId: command.requestId,
        status: 'failed',
        errorCode: 'GRADING_INVALID',
      });
    expect(f.workspace.grading.read({ epoch: f.epoch, id: f.draft.id })).toEqual(before);
    expect(() => f.workspace.grading.complete(command)).toThrow();
    expect(f.workspace.grading.attempts({ epoch: f.epoch, id: f.draft.id })[0]?.record.status).toBe(
      kind === 'cancel' ? 'cancelled' : 'failed',
    );
  },
);

test('restart interrupts running attempts and never allows an old completion to resume', async () => {
  const f = await fixture();
  const command = f.generation();
  const next = reopen(f.workspace, f.root);
  expect(next.grading.attempts({ epoch: f.epoch, id: f.draft.id })[0]?.record).toMatchObject({
    status: 'interrupted',
    errorCode: 'GRADING_INTERRUPTED',
  });
  expect(() => next.grading.complete(command)).toThrow();
  expect(next.grading.read({ epoch: f.epoch, id: f.draft.id }).record.revision).toBe(1);
});

test('backup restore includes images, rubric, reviews and attempts and invalidates old epoch commands', async () => {
  const f = await fixture();
  f.workspace.grading.complete(f.generation());
  f.workspace.grading.edit({ epoch: f.epoch, id: f.draft.id, expectedRevision: 2, edits: f.edits });
  const review = f.workspace.grading.freeze({
    epoch: f.epoch,
    id: f.draft.id,
    expectedRevision: 3,
    requestId: randomUUID(),
    reason: '合成完整复核',
    acknowledgeComplete: true,
  });
  const before = f.workspace.grading.readReview({ epoch: f.epoch, id: review.reviewId });
  const exported = f.workspace.exportBackup({ epoch: f.epoch });
  expect(JSON.parse(exported.toString()).version).toBe(SCHEMA_VERSION);
  const preview = f.workspace.previewRestore(exported);
  expect(preview).toMatchObject({
    rubricVersionCount: 1,
    gradingDraftCount: 1,
    gradingReviewCount: 1,
    gradingAttemptCount: 1,
    gradingRevisionCount: 4,
  });
  const old = f.workspace.grading;
  const restored = f.workspace.commitRestore({ epoch: f.epoch, token: preview.token });
  expect(() => old.read({ epoch: f.epoch, id: f.draft.id })).toThrow('已切换');
  expect(f.workspace.grading.readReview({ epoch: restored.epoch, id: review.reviewId })).toEqual(
    before,
  );
});

test.each([
  'basis',
  'rubric-hash',
  'frozen-total',
  'attempt-state',
  'history-gap',
  'history-edit',
] as const)('rehashed backup rejects %s tampering and retains active data', async (kind) => {
  const f = await fixture();
  f.workspace.grading.complete(f.generation());
  f.workspace.grading.edit({
    epoch: f.epoch,
    id: f.draft.id,
    expectedRevision: 2,
    edits: f.edits,
  });
  f.workspace.grading.freeze({
    epoch: f.epoch,
    id: f.draft.id,
    expectedRevision: 3,
    requestId: randomUUID(),
    reason: '教师完整复核',
    acknowledgeComplete: true,
  });
  const bundle = JSON.parse(f.workspace.exportBackup({ epoch: f.epoch }).toString());
  const path = join(f.root, 'tampered.sqlite');
  writeFileSync(path, Buffer.from(bundle.database.base64, 'base64'));
  const db = new DatabaseSync(path);
  if (kind === 'basis') {
    const row = db.prepare('SELECT payload FROM grading_drafts WHERE id=?').get(f.draft.id)!;
    const payload = JSON.parse(String(row.payload));
    payload.rows[0].basisHash = '0'.repeat(64);
    db.prepare('UPDATE grading_drafts SET payload=? WHERE id=?').run(
      JSON.stringify(payload),
      f.draft.id,
    );
  }
  if (kind === 'rubric-hash')
    db.exec("UPDATE rubric_versions SET request_hash='" + '0'.repeat(64) + "'");
  if (kind === 'frozen-total') db.exec('UPDATE grading_reviews SET total_hundredths=0');
  if (kind === 'attempt-state') db.exec("UPDATE grading_attempts SET status='running'");
  if (kind === 'history-gap') db.exec('DELETE FROM grading_revisions WHERE revision=2');
  if (kind === 'history-edit')
    db.exec("UPDATE grading_revisions SET operation='rebound' WHERE revision=3");
  db.close();
  const bytes = readFileSync(path);
  bundle.database = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  expect(() => f.workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow();
  expect(f.workspace.snapshot().epoch).toBe(f.epoch);
});

test('migration opens an independently frozen Schema 7 structure without changing old records or backup limits', async () => {
  const f = await fixture();
  // 固定 10 的建表器生成并冻结此合成夹具；不从 v8 反推 v7，也不依赖忽略的 output 目录。
  const historical = readFileSync(new URL('./fixtures/frozen-v7.sqlite', import.meta.url));
  expect(createHash('sha256').update(historical).digest('hex')).toBe(
    '39eb00bac2199c49a5b49f033866b6e673cd998445104057535ac8cf647d3e5e',
  );
  const path = join(f.root, 'v7.sqlite');
  writeFileSync(path, historical);
  const old = openDatabase(path, 'readonly');
  expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
  old.close();
  const next = openDatabase(path, 'open');
  expect(next.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  expect(next.prepare('SELECT COUNT(*) AS count FROM grading_drafts').get()?.count).toBe(0);
  expect(next.prepare('SELECT name FROM classrooms').get()?.name).toBe('合成冻结 v7 班级');
  next.close();
  expect(readdirSync(f.root).some((name) => name.includes(`before-v${SCHEMA_VERSION}`))).toBe(true);
  const rollback = join(f.root, 'rollback-v7.sqlite');
  writeFileSync(rollback, historical);
  expect(() =>
    openDatabase(rollback, 'open', {
      migrationCheckpoint: (stage) => {
        if (stage === 'upgraded') throw new Error('interrupt migration before commit');
      },
    }),
  ).toThrow('interrupt migration');
  const preserved = openDatabase(rollback, 'readonly');
  expect(preserved.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
  expect(preserved.prepare('SELECT name FROM classrooms').get()?.name).toBe('合成冻结 v7 班级');
  preserved.close();
  const bundle = {
    format: 'class-manager-backup',
    version: 7,
    createdAt: '2026-10-01T00:00:00.000Z',
    database: {
      bytes: historical.length,
      sha256: createHash('sha256').update(historical).digest('hex'),
      base64: historical.toString('base64'),
    },
    assets: [],
  };
  const preview = f.workspace.previewRestore(Buffer.from(JSON.stringify(bundle)));
  expect(preview.rubricVersionCount).toBe(0);
  const restored = f.workspace.commitRestore({ epoch: f.epoch, token: preview.token });
  expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
  expect(restored.classes[0]?.name).toBe('合成冻结 v7 班级');
});

test.each([
  ['freeze', 'frozen'],
  ['freeze', 'committed'],
  ['complete', 'attempt-completed'],
  ['complete', 'committed'],
] as const)(
  'abrupt %s exit at %s preserves exactly pre-commit or committed state',
  async (kind, checkpoint) => {
    const f = await fixture();
    f.workspace.grading.edit({
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 1,
      edits: f.edits,
    });
    const inputPath = join(f.root, 'crash-input.json'),
      script = join(f.root, 'crash.cjs'),
      commandPath = join(f.root, 'crash-command.json');
    const freeze = {
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 2,
      requestId: randomUUID(),
      reason: '教师完整复核',
      acknowledgeComplete: true,
    };
    const input =
      kind === 'freeze'
        ? { kind, command: freeze }
        : {
            kind,
            prepare: {
              epoch: f.epoch,
              id: f.draft.id,
              expectedRevision: 2,
              selectedPageIds: [f.page.id],
              selectedQuestionIds: ['choice'],
              acknowledgeReplaceReviewed: true,
            },
            requestId: randomUUID(),
            provider: f.provider,
            output: f.output,
          };
    writeFileSync(inputPath, JSON.stringify(input));
    const built = buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-grading.ts'],
        outfile: script,
        write: false,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
      }),
    );
    writeFileSync(script, built.outputFiles[0]!.contents);
    f.workspace.close();
    live.splice(live.indexOf(f.workspace), 1);
    const process = spawnSync(
      globalThis.process.execPath,
      [script, f.root, inputPath, checkpoint, commandPath],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    expect(process.status, process.stderr).toBe(80);
    const next = new Workspace(f.root);
    live.push(next);
    const view = next.grading.read({ epoch: f.epoch, id: f.draft.id });
    expect(view.record.revision).toBe(checkpoint === 'committed' ? 3 : 2);
    expect(next.grading.history({ epoch: f.epoch, id: f.draft.id })).toHaveLength(
      checkpoint === 'committed' ? 3 : 2,
    );
    if (kind === 'freeze') {
      expect(view.record.status).toBe(checkpoint === 'committed' ? 'frozen' : 'draft');
      expect(next.grading.freeze(freeze).replayed).toBe(checkpoint === 'committed');
    } else {
      const command = JSON.parse(readFileSync(commandPath, 'utf8'));
      expect(next.grading.attempts({ epoch: f.epoch, id: f.draft.id })[0]?.record.status).toBe(
        checkpoint === 'committed' ? 'succeeded' : 'interrupted',
      );
      if (checkpoint === 'committed') expect(next.grading.complete(command).replayed).toBe(true);
      else expect(() => next.grading.complete(command)).toThrow();
    }
  },
);
