import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { gradingStorageFixture } from './fixtures/grading-storage';
import type { PublicationCheckpoint } from '../src/core/score-publication';

const roots: string[] = [],
  live: Workspace[] = [];
async function fixture(checkpoint?: PublicationCheckpoint, initialScore = '未录入') {
  const root = mkdtempSync(join(tmpdir(), 'cm-publication-'));
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
    undefined,
    checkpoint,
  );
  live.push(workspace);
  const f = await gradingStorageFixture(workspace, { initialScore, additionalStudentScore: '7' });
  const freeze = () => {
    const current = workspace.grading.read({ epoch: f.epoch, id: f.draft.id });
    const edited = workspace.grading.edit({
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: current.record.revision,
      edits: f.edits,
    });
    return workspace.grading.freeze({
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: edited.revision,
      requestId: randomUUID(),
      reason: '完整人工复核',
      acknowledgeComplete: true,
    });
  };
  return { ...f, root, workspace, freeze };
}
function command(f: Awaited<ReturnType<typeof fixture>>, reviewId: string) {
  const preview = f.workspace.scores.publication.prepare({ epoch: f.epoch, reviewId });
  return {
    epoch: f.epoch,
    reviewId,
    token: preview.token!,
    expectedVersionId: preview.expectedVersionId,
    reason: '合成复核入分',
    acknowledgePublish: true as const,
    acknowledgeReplacement: true,
  };
}
function reopen(workspace: Workspace, root: string) {
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  const next = new Workspace(root);
  live.push(next);
  return next;
}
afterEach(() => {
  for (const w of live.splice(0)) w.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

test.each(['score-inserted', 'publication-inserted', 'committed'] as const)(
  'actual child process exits at %s and reopen proves committed or not committed',
  async (stage) => {
    const f = await fixture(),
      review = f.freeze();
    f.workspace.close();
    live.splice(live.indexOf(f.workspace), 1);
    const inputPath = join(f.root, 'input.json'),
      commandPath = join(f.root, 'command.json'),
      script = join(f.root, 'crash.cjs');
    writeFileSync(inputPath, JSON.stringify({ epoch: f.epoch, reviewId: review.reviewId }));
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-publication.ts'],
        outfile: script,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
      }),
    );
    const child = spawnSync(process.execPath, [script, f.root, inputPath, stage, commandPath], {
      timeout: 20000,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(child.status, child.stderr).toBe(81);
    const next = new Workspace(f.root);
    live.push(next);
    const receipt = next.scores.publication.status({ epoch: f.epoch, reviewId: review.reviewId });
    expect(receipt !== null).toBe(stage === 'committed');
    expect(next.scores.history({ epoch: f.epoch, examId: f.score.examId })).toHaveLength(
      stage === 'committed' ? 2 : 1,
    );
    const command = JSON.parse(readFileSync(commandPath, 'utf8'));
    if (receipt) expect(next.scores.publication.confirm(command)).toEqual(receipt);
    else expect(() => next.scores.publication.confirm(command)).toThrow('预览已失效');
  },
);

test('complete immutable review publishes once, preserves other students and updates statistics with traceable parent', async () => {
  const f = await fixture();
  expect(() =>
    f.workspace.scores.publication.prepare({ epoch: f.epoch, reviewId: f.draft.id }),
  ).toThrow('冻结');
  const review = f.freeze(),
    input = command(f, review.reviewId);
  const original = f.workspace.scores.read({ epoch: f.epoch, versionId: f.score.versionId });
  const receipt = f.workspace.scores.publication.confirm(input);
  expect(receipt).toMatchObject({
    reviewId: review.reviewId,
    previousVersionId: f.score.versionId,
    revision: 2,
    replayed: false,
  });
  const result = f.workspace.scores.read({ epoch: f.epoch, versionId: receipt.versionId });
  expect(
    result.payload.analysis.entries.find((e) => e.studentId === f.request.studentId)?.score,
  ).toEqual({ status: 'valid', hundredths: 1000 });
  expect(
    result.payload.analysis.entries.filter((e) => e.studentId !== f.request.studentId),
  ).toEqual(original.payload.analysis.entries.filter((e) => e.studentId !== f.request.studentId));
  expect(result.payload.publication).toEqual({
    reviewId: review.reviewId,
    previousVersionId: f.score.versionId,
  });
  expect(result.statistics.subjects[0]?.validCount).toBe(2);
  expect(f.workspace.scores.read({ epoch: f.epoch, versionId: f.score.versionId }).stale).toBe(
    true,
  );
  expect(f.workspace.scores.publication.confirm(input)).toEqual({ ...receipt, replayed: true });
  const next = reopen(f.workspace, f.root);
  expect(next.scores.publication.confirm(input)).toEqual({ ...receipt, replayed: true });
  expect(next.scores.history({ epoch: f.epoch, examId: f.score.examId })).toHaveLength(2);
  expect(
    next.scores.publication.prepare({ epoch: f.epoch, reviewId: review.reviewId }),
  ).toMatchObject({ token: null, receipt: { versionId: receipt.versionId } });
});

test('existing valid or absent score requires explicit replacement after difference preview', async () => {
  const f = await fixture(undefined, '0');
  const review = f.freeze();
  const preview = f.workspace.scores.publication.prepare({
    epoch: f.epoch,
    reviewId: review.reviewId,
  });
  expect(preview).toMatchObject({
    before: { status: 'valid', hundredths: 0 },
    after: { status: 'valid', hundredths: 1000 },
    replacesExisting: true,
  });
  const input = {
    epoch: f.epoch,
    reviewId: review.reviewId,
    token: preview.token!,
    expectedVersionId: preview.expectedVersionId,
    reason: '明确更正零分',
    acknowledgePublish: true,
    acknowledgeReplacement: false,
  };
  expect(() => f.workspace.scores.publication.confirm(input)).toThrow('明确确认');
  expect(
    f.workspace.scores.publication.status({ epoch: f.epoch, reviewId: review.reviewId }),
  ).toBeNull();
  expect(
    f.workspace.scores.publication.confirm({ ...input, acknowledgeReplacement: true }).revision,
  ).toBe(2);
});

test('stale rubric, wrong expected score version and changed roster block application writes', async () => {
  const f = await fixture();
  const review = f.freeze(),
    input = command(f, review.reviewId);
  expect(() =>
    f.workspace.scores.publication.confirm({ ...input, expectedVersionId: randomUUID() }),
  ).toThrow('版本');
  f.workspace.saveStudent({
    epoch: f.epoch,
    id: f.request.studentId,
    classId: f.scoreInput.classId,
    studentNumber: 'SYNTHETIC_1',
    displayName: '更正合成甲',
    expectedRevision: f.workspace.snapshot().students[0]!.revision,
  });
  expect(() => f.workspace.scores.publication.confirm(input)).toThrow('名册');
  f.workspace.grading.createRubric({
    ...f.rubricInput,
    requestId: randomUUID(),
    definition: { ...f.definition, title: '新细则' },
  });
  expect(() =>
    f.workspace.scores.publication.prepare({ epoch: f.epoch, reviewId: review.reviewId }),
  ).toThrow('新版本');
  expect(f.workspace.scores.history({ epoch: f.epoch, examId: f.score.examId })).toHaveLength(1);
});

test('expired publication preview cannot write and a fresh preview requires a new confirmation', async () => {
  const f = await fixture(),
    review = f.freeze(),
    input = command(f, review.reviewId);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
  try {
    expect(() => f.workspace.scores.publication.confirm(input)).toThrow('预览已失效');
    expect(
      f.workspace.scores.publication.status({ epoch: f.epoch, reviewId: review.reviewId }),
    ).toBeNull();
    expect(f.workspace.scores.history({ epoch: f.epoch, examId: f.score.examId })).toHaveLength(1);
    const next = command(f, review.reviewId);
    expect(next.token).not.toBe(input.token);
    expect(f.workspace.scores.publication.confirm(next).revision).toBe(2);
  } finally {
    clock.mockRestore();
  }
});

test('another score import committed after publication preview prevents overwriting that version', async () => {
  const f = await fixture(),
    review = f.freeze(),
    input = command(f, review.reviewId);
  const imported = await f.workspace.scores.preview(
    Buffer.from('学生编号,合成学科\nSYNTHETIC_1,3\nSYNTHETIC_2,8'),
    { ...f.scoreInput, examId: f.score.examId, expectedRevision: 1 },
  );
  const correction = f.workspace.scores.confirm({
    epoch: f.epoch,
    token: imported.token,
    requestId: randomUUID(),
    expectedRevision: 1,
    reason: '另一窗口确认合成更正',
  });
  expect(() => f.workspace.scores.publication.confirm(input)).toThrow('变化');
  expect(
    f.workspace.scores.publication.status({ epoch: f.epoch, reviewId: review.reviewId }),
  ).toBeNull();
  const current = f.workspace.scores.read({ epoch: f.epoch, versionId: correction.versionId });
  expect(current.payload.analysis.entries.map((e) => e.score)).toEqual([
    { status: 'valid', hundredths: 300 },
    { status: 'valid', hundredths: 800 },
  ]);
  expect(f.workspace.scores.history({ epoch: f.epoch, examId: f.score.examId })).toHaveLength(2);
});

test.each(['score-inserted', 'publication-inserted'] as const)(
  'transaction fault at %s rolls back score and publication together',
  async (stage) => {
    let armed = false;
    const f = await fixture((point) => {
      if (armed && point === stage) throw Error('Synthetic rollback');
    });
    const review = f.freeze(),
      input = command(f, review.reviewId);
    armed = true;
    expect(() => f.workspace.scores.publication.confirm(input)).toThrow('Synthetic rollback');
    expect(
      f.workspace.scores.publication.status({ epoch: f.epoch, reviewId: review.reviewId }),
    ).toBeNull();
    expect(f.workspace.scores.history({ epoch: f.epoch, examId: f.score.examId })).toHaveLength(1);
    armed = false;
    expect(f.workspace.scores.publication.confirm(input).revision).toBe(2);
  },
);

test('commit followed by lost response is resolved offline without publishing or grading twice', async () => {
  let armed = false;
  const f = await fixture((stage) => {
    if (armed && stage === 'committed') throw Error('Lost response');
  });
  const review = f.freeze(),
    input = command(f, review.reviewId);
  armed = true;
  expect(() => f.workspace.scores.publication.confirm(input)).toThrow('Lost response');
  const next = reopen(f.workspace, f.root);
  const receipt = next.scores.publication.status({ epoch: f.epoch, reviewId: review.reviewId });
  expect(receipt?.revision).toBe(2);
  expect(next.scores.publication.confirm(input)).toEqual(receipt);
  expect(next.grading.attempts({ epoch: f.epoch, id: f.draft.id })).toHaveLength(0);
});

test('backup/restore carries publication provenance, invalidates old preview and accepts only restored epoch replay', async () => {
  const f = await fixture(),
    review = f.freeze(),
    input = command(f, review.reviewId);
  const receipt = f.workspace.scores.publication.confirm(input);
  const preview = f.workspace.previewRestore(f.workspace.exportBackup({ epoch: f.epoch }));
  const restored = f.workspace.commitRestore({
    epoch: f.epoch,
    token: preview.token,
  });
  expect(() => f.workspace.scores.publication.confirm(input)).toThrow('切换');
  expect(f.workspace.scores.publication.confirm({ ...input, epoch: restored.epoch })).toEqual({
    ...receipt,
    replayed: true,
  });
});

test.each(['missing-record', 'wrong-parent', 'other-student', 'missing-source'] as const)(
  'correctly rehashed backup rejects corrupt publication: %s',
  async (kind) => {
    const f = await fixture(),
      review = f.freeze();
    const receipt = f.workspace.scores.publication.confirm(command(f, review.reviewId));
    const bundle = JSON.parse(f.workspace.exportBackup({ epoch: f.epoch }).toString('utf8'));
    const file = join(f.root, 'tampered.sqlite');
    writeFileSync(file, Buffer.from(bundle.database.base64, 'base64'));
    const db = new DatabaseSync(file);
    if (kind === 'missing-record') db.exec('DELETE FROM grading_publications');
    else if (kind === 'wrong-parent')
      db.prepare('UPDATE grading_publications SET previous_version_id=?').run(receipt.versionId);
    else {
      const payload = JSON.parse(
        String(
          db.prepare('SELECT payload FROM score_versions WHERE id=?').get(receipt.versionId)
            ?.payload,
        ),
      );
      if (kind === 'missing-source') delete payload.publication;
      else
        payload.analysis.entries.find(
          (e: { studentId: string }) => e.studentId !== f.request.studentId,
        ).score.hundredths = 800;
      db.prepare('UPDATE score_versions SET payload=? WHERE id=?').run(
        JSON.stringify(payload),
        receipt.versionId,
      );
    }
    db.close();
    const bytes = readFileSync(file);
    bundle.database = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      base64: bytes.toString('base64'),
    };
    expect(() => f.workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow('入分');
    expect(f.workspace.snapshot().epoch).toBe(f.epoch);
  },
);
