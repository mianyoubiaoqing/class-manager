import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import type { ExplanationCheckpoint } from '../src/core/explanation-book';
import type { ExplanationPacket } from '../src/shared/score-explanation';
import type { ExplanationProvider } from '../src/shared/explanation-drafts';
import { DatabaseSync } from 'node:sqlite';
import { createExplanationPreparer } from '../src/core/score-explanation';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const live: Workspace[] = [];
const subjectId = '30000000-0000-4000-8000-000000000001';
const groupId = '40000000-0000-4000-8000-000000000001';
afterEach(() => {
  vi.useRealTimers();
  for (const workspace of live.splice(0)) workspace.close();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const provider: ExplanationProvider = {
  provider: 'deepseek',
  requestModel: 'synthetic-model',
  responseModel: 'synthetic-model',
  responseId: 'synthetic-response',
  generatedAt: '2026-09-30T00:00:00.000Z',
  durationMs: 10,
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
};
const selection = {
  subjectIds: [subjectId],
  metrics: ['fullScore', 'validCount', 'mean'],
  scope: { kind: 'class' },
};
function output(packet: ExplanationPacket) {
  return JSON.stringify({
    formatVersion: 1,
    observations: packet.wire.facts.map(({ id, value }) => ({ factId: id, value })),
    interpretations: [{ text: '合成解释', evidenceIds: ['F001'], uncertainty: '尚需教师核实' }],
    questions: [],
    actions: [],
    limitations: ['无题目级数据，无法判断知识点掌握。'],
  });
}
async function fixture(checkpoint?: ExplanationCheckpoint) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-explanation-'));
  roots.push(directory);
  const workspace = new Workspace(directory, undefined, undefined, checkpoint);
  live.push(workspace);
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成班' });
  const classId = workspace.snapshot().classes[0]!.id;
  workspace.saveStudent({ epoch, classId, studentNumber: '0001', displayName: '合成甲' });
  const studentId = workspace.snapshot().students[0]!.id;
  const input = {
    epoch,
    classId,
    expectedRevision: 0,
    definition: {
      name: '合成月考',
      date: '2026-09-30',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 as const }],
    groups: [{ id: groupId, name: '数学组', subjectIds: [subjectId] }],
    assignments: [{ studentId, groupId }],
    scoreBasis: 'raw' as const,
    format: 'csv' as const,
    fileName: 'synthetic.csv',
  };
  const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input);
  const score = workspace.scores.confirm({
    epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  const prepare = () =>
    workspace.explanations.prepare({ epoch, sourceVersionId: score.versionId, selection });
  const generation = () => {
    const prepared = prepare();
    const requestId = randomUUID();
    workspace.explanations.claim({ epoch, token: prepared.token, requestId });
    return { epoch, token: prepared.token, requestId, provider, output: output(prepared.packet) };
  };
  const correct = async () => {
    const changed = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,100'), {
      ...input,
      examId: score.examId,
      expectedRevision: 1,
    });
    return workspace.scores.confirm({
      epoch,
      token: changed.token,
      requestId: randomUUID(),
      expectedRevision: 1,
      reason: '更正成绩',
    });
  };
  return { workspace, directory, epoch, score, prepare, generation, correct };
}
function reopen(workspace: Workspace, directory: string) {
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  const next = new Workspace(directory);
  live.push(next);
  return next;
}

test('preparation writes nothing and caller mutation cannot change the claimed packet', async () => {
  const { workspace, epoch, prepare } = await fixture();
  const prepared = prepare();
  const original = structuredClone(prepared.packet);
  prepared.packet.wire.facts[0]!.value = '999';
  prepared.packet.selection.metrics.length = 0;
  expect(workspace.explanations.list({ epoch })).toEqual([]);
  const requestId = randomUUID();
  const claimed = workspace.explanations.claim({ epoch, token: prepared.token, requestId });
  expect(claimed).toEqual(original);
  expect(() => workspace.explanations.claim({ epoch, token: prepared.token, requestId })).toThrow(
    '不能重复',
  );
});

test('complete requires the claimed request and rejects invalid output without saving', async () => {
  const { workspace, epoch, prepare } = await fixture();
  const prepared = prepare();
  const command = {
    epoch,
    token: prepared.token,
    requestId: randomUUID(),
    provider,
    output: output(prepared.packet),
  };
  expect(() => workspace.explanations.complete(command)).toThrow('不属于');
  workspace.explanations.claim(commandToken(command));
  expect(() => workspace.explanations.complete({ ...command, output: '{}' })).toThrow('格式');
  expect(workspace.explanations.list({ epoch })).toEqual([]);
  expect(workspace.explanations.complete(command).revision).toBe(1);
});
function commandToken(command: { epoch: string; token: string; requestId: string }) {
  return { epoch: command.epoch, token: command.token, requestId: command.requestId };
}

test('saved drafts and generation retry survive reopening without duplicating records', async () => {
  const { workspace, directory, epoch, generation } = await fixture();
  const command = generation();
  const receipt = workspace.explanations.complete(command);
  const before = workspace.explanations.read({ epoch, id: receipt.id });
  const next = reopen(workspace, directory);
  expect(next.explanations.read({ epoch, id: receipt.id })).toEqual(before);
  expect(next.explanations.complete(command)).toEqual({ ...receipt, replayed: true });
  expect(() => next.explanations.complete({ ...command, output: '{}' })).toThrow('不同内容');
  expect(next.explanations.list({ epoch })).toHaveLength(1);
});

test('teacher edits preserve original model provenance and scores; discard is durable', async () => {
  const { workspace, directory, epoch, score, generation } = await fixture();
  const scoresBefore = workspace.scores.read({ epoch, versionId: score.versionId });
  const receipt = workspace.explanations.complete(generation());
  const original = workspace.explanations.read({ epoch, id: receipt.id });
  const command = {
    epoch,
    id: receipt.id,
    expectedRevision: 1,
    content: { ...original.payload.content, teacherNotes: '教师复核记录' },
  };
  expect(workspace.explanations.edit(command).revision).toBe(2);
  expect(workspace.explanations.edit(command)).toMatchObject({ revision: 2, replayed: true });
  expect(() =>
    workspace.explanations.edit({
      ...command,
      content: { ...command.content, teacherNotes: '旧页面更改' },
    }),
  ).toThrow('已修改');
  const edited = workspace.explanations.read({ epoch, id: receipt.id });
  expect(edited.payload).toEqual({ ...original.payload, content: command.content });
  expect(workspace.scores.read({ epoch, versionId: score.versionId })).toEqual(scoresBefore);
  const discard = { epoch, id: receipt.id, expectedRevision: 2 };
  expect(workspace.explanations.discard(discard).revision).toBe(3);
  expect(workspace.explanations.discard(discard).replayed).toBe(true);
  expect(workspace.explanations.list({ epoch })).toEqual([]);
  expect(workspace.explanations.list({ epoch, includeDiscarded: true })).toHaveLength(1);
  expect(() => workspace.explanations.edit({ ...command, expectedRevision: 3 })).toThrow(
    '不能编辑',
  );
  const next = reopen(workspace, directory);
  expect(next.explanations.read({ epoch, id: receipt.id }).record.status).toBe('discarded');
});

test('correction marks old drafts stale and rejects in-flight output; regeneration is a new draft', async () => {
  const { workspace, epoch, generation, correct } = await fixture();
  const receipt = workspace.explanations.complete(generation());
  const inFlight = generation();
  const changed = await correct();
  expect(() => workspace.explanations.complete(inFlight)).toThrow('已更正');
  const old = workspace.explanations.read({ epoch, id: receipt.id });
  expect(old.stale).toBe(true);
  expect(old.latestSourceVersionId).toBe(changed.versionId);
  expect(old.packet.facts.find((fact) => fact.metric === 'mean')?.value).toBe('99.00');
  const prepared = workspace.explanations.prepare({
    epoch,
    sourceVersionId: changed.versionId,
    selection,
  });
  const command = {
    epoch,
    token: prepared.token,
    requestId: randomUUID(),
    provider,
    output: output(prepared.packet),
  };
  workspace.explanations.claim(commandToken(command));
  expect(workspace.explanations.complete(command).id).not.toBe(receipt.id);
  expect(workspace.explanations.list({ epoch })).toHaveLength(2);
});

test.each(['cancel', 'timeout', 'invalid-prepare'] as const)(
  '%s invalidates a prepared generation',
  async (kind) => {
    const { workspace, epoch, score, generation } = await fixture();
    const command = generation();
    if (kind === 'cancel') workspace.explanations.cancel({ epoch });
    if (kind === 'timeout') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180000);
    if (kind === 'invalid-prepare')
      expect(() =>
        workspace.explanations.prepare({ epoch, sourceVersionId: score.versionId, selection: {} }),
      ).toThrow();
    expect(() => workspace.explanations.complete(command)).toThrow('失效');
    expect(workspace.explanations.list({ epoch })).toEqual([]);
  },
);

test('backup restores edited/discarded drafts and invalidates held books and old epochs', async () => {
  const { workspace, epoch, generation } = await fixture();
  const receipt = workspace.explanations.complete(generation());
  const book = workspace.explanations;
  book.discard({ epoch, id: receipt.id, expectedRevision: 1 });
  const before = book.read({ epoch, id: receipt.id });
  const preview = workspace.previewRestore(workspace.exportBackup({ epoch }));
  expect(preview.explanationDraftCount).toBe(1);
  const restored = workspace.commitRestore({ epoch, token: preview.token });
  expect(() => book.list({ epoch })).toThrow('已切换');
  expect(() => workspace.explanations.list({ epoch })).toThrow('已切换');
  expect(workspace.explanations.read({ epoch: restored.epoch, id: receipt.id })).toEqual(before);
});

test.each(['generated', 'edited', 'discarded'] as const)(
  'exception at %s rolls back the whole write',
  async (stage) => {
    let enabled = false;
    const { workspace, epoch, generation } = await fixture((point) => {
      if (enabled && stage === point) throw new Error('synthetic write failure');
    });
    const command = generation();
    if (stage === 'generated') {
      enabled = true;
      expect(() => workspace.explanations.complete(command)).toThrow('synthetic write failure');
      expect(workspace.explanations.list({ epoch })).toEqual([]);
      enabled = false;
      expect(workspace.explanations.complete(command).revision).toBe(1);
    } else {
      const receipt = workspace.explanations.complete(command);
      const before = workspace.explanations.read({ epoch, id: receipt.id });
      enabled = true;
      const action = () =>
        stage === 'edited'
          ? workspace.explanations.edit({
              epoch,
              id: receipt.id,
              expectedRevision: 1,
              content: { ...before.payload.content, teacherNotes: '更改' },
            })
          : workspace.explanations.discard({ epoch, id: receipt.id, expectedRevision: 1 });
      expect(action).toThrow('synthetic write failure');
      expect(workspace.explanations.read({ epoch, id: receipt.id })).toEqual(before);
    }
  },
);

test('lost completion acknowledgement can be retried after reopen', async () => {
  const { workspace, directory, epoch, generation } = await fixture((stage) => {
    if (stage === 'committed') throw new Error('lost acknowledgement');
  });
  const command = generation();
  expect(() => workspace.explanations.complete(command)).toThrow('lost acknowledgement');
  const next = reopen(workspace, directory);
  expect(next.explanations.complete(command).replayed).toBe(true);
  expect(next.explanations.list({ epoch })).toHaveLength(1);
});

test('student draft labels use the source roster even after the live student is renamed', async () => {
  const { workspace, epoch, score } = await fixture();
  const student = workspace.snapshot().students[0]!;
  const prepared = workspace.explanations.prepare({
    epoch,
    sourceVersionId: score.versionId,
    selection: {
      subjectIds: [subjectId],
      metrics: ['fullScore', 'studentStatus', 'studentScore'],
      scope: { kind: 'student', studentId: student.id },
    },
  });
  const command = {
    epoch,
    token: prepared.token,
    requestId: randomUUID(),
    provider,
    output: output(prepared.packet),
  };
  workspace.explanations.claim(commandToken(command));
  const receipt = workspace.explanations.complete(command);
  workspace.saveStudent({
    epoch,
    id: student.id,
    expectedRevision: student.revision,
    classId: student.classId,
    studentNumber: student.studentNumber,
    displayName: '合成新名',
  });
  expect(workspace.explanations.read({ epoch, id: receipt.id }).scopeLabel).toBe('0001 合成甲');
  expect(workspace.explanations.list({ epoch })[0]?.scopeLabel).toBe('0001 合成甲');
  expect(JSON.stringify(prepared.packet.wire)).not.toContain('合成甲');
});

test('reusable fact preparation snapshots entries and isolates returned packets', async () => {
  const { workspace, epoch, score } = await fixture();
  const source = workspace.scores.read({ epoch, versionId: score.versionId });
  const prepare = createExplanationPreparer(source);
  const first = prepare(selection);
  source.payload.analysis.entries[0]!.score = { status: 'valid', hundredths: 1 };
  source.statistics.subjects[0]!.mean = 'wrong';
  first.facts[0]!.value = 'wrong';
  first.selection.metrics.length = 0;
  const second = prepare(selection);
  expect(second.facts.find((fact) => fact.metric === 'mean')?.value).toBe('99.00');
  expect(second.facts[0]!.value).toBe('150');
});

test.each([
  'hash',
  'fact',
  'source',
  'discard-date',
  'initial-edit',
  'timestamp',
  'unknown-field',
] as const)(
  'a rehashed backup with corrupt explanation %s is rejected without replacing the workspace',
  async (kind) => {
    const { workspace, directory, epoch, generation } = await fixture();
    const receipt = workspace.explanations.complete(generation());
    const saved = workspace.explanations.read({ epoch, id: receipt.id });
    const bundle = JSON.parse(workspace.exportBackup({ epoch }).toString('utf8'));
    const path = join(directory, 'tampered.sqlite');
    writeFileSync(path, Buffer.from(bundle.database.base64, 'base64'));
    // Deliberately forge an invalid source reference; production connections keep FK checks on.
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    try {
      const payload = structuredClone(saved.payload);
      if (kind === 'hash') payload.inputHash = '0'.repeat(64);
      if (kind === 'fact') payload.original.observations[0]!.value = '999';
      if (kind === 'initial-edit') payload.content.teacherNotes = 'unversioned edit';
      if (kind === 'unknown-field') Object.assign(payload, { unexpected: true });
      db.prepare('UPDATE explanation_drafts SET payload=?').run(JSON.stringify(payload));
      if (kind === 'source')
        db.prepare('UPDATE explanation_drafts SET source_version_id=?').run(randomUUID());
      if (kind === 'discard-date')
        db.exec("UPDATE explanation_drafts SET status='discarded', revision=2");
      if (kind === 'timestamp')
        db.exec("UPDATE explanation_drafts SET updated_at='2000-01-01T00:00:00.000Z'");
    } finally {
      db.close();
    }
    const bytes = readFileSync(path);
    bundle.database = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      base64: bytes.toString('base64'),
    };
    expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow();
    expect(workspace.snapshot().epoch).toBe(epoch);
    expect(workspace.explanations.read({ epoch, id: receipt.id })).toEqual(saved);
  },
);

test.each(['generated', 'committed'] as const)(
  'abrupt exit at %s leaves an atomic generation',
  async (checkpoint) => {
    const { workspace, directory, epoch, score } = await fixture();
    workspace.close();
    live.splice(live.indexOf(workspace), 1);
    const inputPath = join(directory, 'generation-input.json');
    const commandPath = join(directory, 'generation-command.json');
    const childPath = join(directory, 'crash-explanation.cjs');
    writeFileSync(
      inputPath,
      JSON.stringify({ epoch, sourceVersionId: score.versionId, selection, provider }),
    );
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-explanation.ts'],
        outfile: childPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
      }),
    );
    const child = spawnSync(
      process.execPath,
      [childPath, directory, inputPath, commandPath, checkpoint],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(87);
    const next = new Workspace(directory);
    live.push(next);
    const command = JSON.parse(readFileSync(commandPath, 'utf8'));
    if (checkpoint === 'generated') {
      expect(next.explanations.list({ epoch })).toEqual([]);
      expect(() => next.explanations.complete(command)).toThrow('失效');
    } else {
      expect(next.explanations.list({ epoch })).toHaveLength(1);
      expect(next.explanations.complete(command).replayed).toBe(true);
    }
    expect(
      next.scores.read({ epoch, versionId: score.versionId }).statistics.subjects[0]?.mean,
    ).toBe('99.00');
  },
);
