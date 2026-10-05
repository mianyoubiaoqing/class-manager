import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { parseMaterial } from '../src/core/material-parser';
import type { LessonCheckpoint } from '../src/core/lesson-book';
import { lessonFixture, lessonProvider } from './fixtures/lesson-storage';
const roots: string[] = [];
const live: Workspace[] = [];
async function fixture(checkpoint?: LessonCheckpoint) {
  const root = mkdtempSync(join(tmpdir(), 'cm-lesson-book-'));
  roots.push(root);
  const workspace = new Workspace(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checkpoint,
  );
  live.push(workspace);
  const epoch = workspace.snapshot().epoch;
  const parsed = await parseMaterial(Buffer.from('力有大小、方向和作用点。'), 'txt');
  workspace.materials.store({ epoch, requestId: randomUUID(), name: '合成教材.txt', parsed });
  const { request, content } = lessonFixture(parsed.version.id);
  const generation = () => {
    const prepared = workspace.lessons.prepare({ epoch, request });
    const command = {
      epoch,
      token: prepared.token,
      requestId: randomUUID(),
      provider: lessonProvider,
      output: JSON.stringify(content),
    };
    workspace.lessons.claim({ epoch, token: command.token, requestId: command.requestId });
    return command;
  };
  return { workspace, root, epoch, request, content, generation };
}
function reopen(workspace: Workspace, root: string) {
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  const next = new Workspace(root);
  live.push(next);
  return next;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const workspace of live.splice(0)) workspace.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('generation is claimed once and survives durable replay without another model request', async () => {
  const { workspace, root, epoch, generation } = await fixture();
  const command = generation();
  expect(() =>
    workspace.lessons.claim({ epoch, token: command.token, requestId: command.requestId }),
  ).toThrow('已发起');
  const saved = workspace.lessons.complete(command);
  const before = workspace.lessons.read({ epoch, id: saved.id });
  const next = reopen(workspace, root);
  expect(next.lessons.read({ epoch, id: saved.id })).toEqual(before);
  expect(next.lessons.complete(command)).toEqual({ ...saved, replayed: true });
  expect(() => next.lessons.complete({ ...command, output: '{}' })).toThrow('不同');
});

test('local lesson creation is durable, validates sources, freezes and survives backup restoration without fabricated model provenance', async () => {
  const f = await fixture();
  const command = {
    epoch: f.epoch,
    requestId: randomUUID(),
    request: f.request,
    content: f.content,
  };
  const draft = f.workspace.lessons.create(command);
  expect(f.workspace.lessons.create(command)).toEqual({ ...draft, replayed: true });
  expect(() =>
    f.workspace.lessons.create({ ...command, content: { ...f.content, title: '另一内容' } }),
  ).toThrow('不同');
  expect(f.workspace.lessons.read({ epoch: f.epoch, id: draft.id }).payload.provider).toBeNull();
  expect(() =>
    f.workspace.lessons.create({
      ...command,
      requestId: randomUUID(),
      request: { ...f.request, selection: [] },
    }),
  ).toThrow('引用');
  const frozen = f.workspace.lessons.freeze({
    epoch: f.epoch,
    id: draft.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    reason: '确认本地课时',
  });
  const before = f.workspace.lessons.readVersion({ epoch: f.epoch, versionId: frozen.versionId });
  const preview = f.workspace.previewRestore(f.workspace.exportBackup({ epoch: f.epoch }));
  const restored = f.workspace.commitRestore({ epoch: f.epoch, token: preview.token });
  expect(
    f.workspace.lessons.readVersion({ epoch: restored.epoch, versionId: frozen.versionId }),
  ).toEqual(before);
  const next = reopen(f.workspace, f.root);
  expect(next.lessons.readVersion({ epoch: restored.epoch, versionId: frozen.versionId })).toEqual(
    before,
  );
});

test('teacher edits, freezing and explicit revisions preserve immutable content and provider provenance', async () => {
  const { workspace, root, epoch, generation, content } = await fixture();
  const draft = workspace.lessons.complete(generation());
  const original = workspace.lessons.read({ epoch, id: draft.id });
  const edited = { ...content, title: '教师复核标题' };
  const edit = { epoch, id: draft.id, expectedRevision: 1, content: edited };
  expect(workspace.lessons.edit(edit).revision).toBe(2);
  expect(workspace.lessons.edit(edit).replayed).toBe(true);
  expect(() =>
    workspace.lessons.edit({ ...edit, content: { ...edited, title: '旧页面改动' } }),
  ).toThrow('已修改');
  const freeze = {
    epoch,
    id: draft.id,
    expectedRevision: 2,
    requestId: randomUUID(),
    reason: '教师确认',
  };
  const frozen = workspace.lessons.freeze(freeze);
  expect(workspace.lessons.freeze(freeze).replayed).toBe(true);
  const before = workspace.lessons.readVersion({ epoch, versionId: frozen.versionId });
  expect(before.payload.original).toEqual(original.payload.original);
  expect(before.payload.content).toEqual(edited);
  expect(() => workspace.lessons.edit({ ...edit, expectedRevision: 3 })).toThrow('不能编辑');
  const revise = { epoch, versionId: frozen.versionId, requestId: randomUUID() };
  const revision = workspace.lessons.revise(revise);
  expect(workspace.lessons.revise(revise).replayed).toBe(true);
  expect(workspace.lessons.read({ epoch, id: revision.id }).payload).toEqual(before.payload);
  workspace.lessons.edit({
    epoch,
    id: revision.id,
    expectedRevision: 1,
    content: { ...edited, title: '第二版' },
  });
  const nextVersion = workspace.lessons.freeze({
    epoch,
    id: revision.id,
    expectedRevision: 2,
    requestId: randomUUID(),
    reason: '第二版确认',
  });
  expect(nextVersion.revision).toBe(2);
  expect(workspace.lessons.readVersion({ epoch, versionId: frozen.versionId })).toEqual(before);
  expect(workspace.lessons.history({ epoch, id: draft.id }).map((value) => value.revision)).toEqual(
    [2, 1],
  );
  const next = reopen(workspace, root);
  expect(next.lessons.readVersion({ epoch, versionId: frozen.versionId })).toEqual(before);
  expect(() => next.lessons.revise({ ...revise, requestId: randomUUID() })).toThrow('最新');
});

test('two local revision drafts cannot silently overwrite the newer frozen base', async () => {
  const { workspace, epoch, generation } = await fixture();
  const draft = workspace.lessons.complete(generation());
  const base = workspace.lessons.freeze({
    epoch,
    id: draft.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    reason: '初版',
  });
  const first = workspace.lessons.revise({
    epoch,
    versionId: base.versionId,
    requestId: randomUUID(),
  });
  const second = workspace.lessons.revise({
    epoch,
    versionId: base.versionId,
    requestId: randomUUID(),
  });
  workspace.lessons.freeze({
    epoch,
    id: first.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    reason: '更新',
  });
  expect(() =>
    workspace.lessons.freeze({
      epoch,
      id: second.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      reason: '旧来源',
    }),
  ).toThrow('新的冻结');
  expect(workspace.lessons.read({ epoch, id: second.id }).record.status).toBe('draft');
});

test.each(['cancel', 'timeout', 'invalid-prepare', 'invalid-output', 'admission'] as const)(
  '%s cannot save an in-flight draft',
  async (kind) => {
    const { workspace, epoch, generation } = await fixture();
    const command = generation();
    if (kind === 'cancel') workspace.lessons.cancel({ epoch });
    if (kind === 'timeout') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180000);
    if (kind === 'invalid-prepare')
      expect(() => workspace.lessons.prepare({ epoch, request: {} })).toThrow();
    if (kind === 'invalid-output') command.output = '{}';
    expect(() =>
      workspace.lessons.complete(
        command,
        kind === 'admission'
          ? () => {
              throw new Error('cancelled at commit');
            }
          : undefined,
      ),
    ).toThrow();
    expect(workspace.lessons.list({ epoch })).toEqual([]);
  },
);

test.each(['provider', 'original', 'request', 'hash', 'initial-content', 'freeze-hash'] as const)(
  'rehashed revision backup rejects inherited %s tampering',
  async (kind) => {
    const { root, workspace, epoch, generation } = await fixture();
    const initial = workspace.lessons.complete(generation());
    const base = workspace.lessons.freeze({
      epoch,
      id: initial.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      reason: '初版',
    });
    const draft = workspace.lessons.revise({
      epoch,
      versionId: base.versionId,
      requestId: randomUUID(),
    });
    const before = workspace.lessons.read({ epoch, id: draft.id });
    const bundle = JSON.parse(workspace.exportBackup({ epoch }).toString());
    const path = join(root, 'tampered-revision.sqlite');
    writeFileSync(path, Buffer.from(bundle.database.base64, 'base64'));
    const db = new DatabaseSync(path);
    const payload = structuredClone(before.payload);
    if (kind === 'provider' && payload.provider) payload.provider.responseId = 'forged-model';
    if (kind === 'original') payload.original.title = 'forged-original';
    if (kind === 'request') {
      payload.request.instructions = 'forged-instructions';
      const { storedLessonPreparation } = await import('../src/core/lesson-records');
      payload.inputHash = storedLessonPreparation(db, payload.request).fingerprint;
    }
    if (kind === 'initial-content') payload.content.title = 'unversioned-content';
    db.prepare('UPDATE lesson_drafts SET payload=? WHERE id=?').run(
      JSON.stringify(payload),
      draft.id,
    );
    if (kind === 'hash')
      db.prepare('UPDATE lesson_drafts SET generation_hash=? WHERE id=?').run(
        '0'.repeat(64),
        draft.id,
      );
    if (kind === 'freeze-hash')
      db.prepare('UPDATE lesson_versions SET request_hash=?').run('0'.repeat(64));
    db.close();
    const bytes = readFileSync(path);
    bundle.database = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      base64: bytes.toString('base64'),
    };
    expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow();
    expect(workspace.snapshot().epoch).toBe(epoch);
    expect(workspace.lessons.read({ epoch, id: draft.id })).toEqual(before);
  },
);

test.each(['generated', 'committed'] as const)(
  'abrupt lesson exit at %s cannot leave a half draft or trigger a resume',
  async (checkpoint) => {
    const { root, workspace, epoch, request, content } = await fixture();
    const inputPath = join(root, 'input.json');
    const commandPath = join(root, 'command.json');
    writeFileSync(inputPath, JSON.stringify({ epoch, request, content, provider: lessonProvider }));
    const childPath = join(root, 'crash.cjs');
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-material-lesson.ts'],
        outfile: childPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
      }),
    );
    workspace.close();
    live.splice(live.indexOf(workspace), 1);
    const child = spawnSync(
      process.execPath,
      [childPath, 'lesson', root, inputPath, commandPath, checkpoint],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(89);
    const next = new Workspace(root);
    live.push(next);
    const command = JSON.parse(readFileSync(commandPath, 'utf8'));
    expect(next.lessons.list({ epoch })).toHaveLength(checkpoint === 'committed' ? 1 : 0);
    if (checkpoint === 'committed') expect(next.lessons.complete(command).replayed).toBe(true);
    else expect(() => next.lessons.complete(command)).toThrow('失效');
  },
);

test('discard, backup restore and held-book invalidation preserve frozen and closed drafts', async () => {
  const { workspace, epoch, generation } = await fixture();
  const draft = workspace.lessons.complete(generation());
  const book = workspace.lessons;
  const discard = { epoch, id: draft.id, expectedRevision: 1 };
  expect(book.discard(discard).revision).toBe(2);
  expect(book.discard(discard).replayed).toBe(true);
  const before = book.read({ epoch, id: draft.id });
  expect(book.list({ epoch })).toEqual([]);
  const preview = workspace.previewRestore(workspace.exportBackup({ epoch }));
  expect(preview).toMatchObject({
    materialVersionCount: 1,
    lessonDraftCount: 1,
    lessonVersionCount: 0,
  });
  const restored = workspace.commitRestore({ epoch, token: preview.token });
  expect(() => book.list({ epoch: restored.epoch })).toThrow('已切换');
  expect(workspace.lessons.read({ epoch: restored.epoch, id: draft.id })).toEqual(before);
});

test.each(['generated', 'edited', 'discarded', 'frozen', 'revised', 'committed'] as const)(
  'failure at %s rolls back or replays a committed generation',
  async (stage) => {
    let enabled = false;
    const { workspace, root, epoch, generation, content } = await fixture((point) => {
      if (point === stage && enabled) throw new Error('synthetic lesson failure');
    });
    const command = generation();
    if (stage === 'generated' || stage === 'committed') {
      enabled = true;
      expect(() => workspace.lessons.complete(command)).toThrow('synthetic lesson failure');
      expect(workspace.lessons.list({ epoch })).toHaveLength(stage === 'committed' ? 1 : 0);
      enabled = false;
      if (stage === 'committed')
        expect(reopen(workspace, root).lessons.complete(command).replayed).toBe(true);
      else expect(workspace.lessons.complete(command).revision).toBe(1);
      return;
    }
    const draft = workspace.lessons.complete(command);
    if (stage === 'revised') {
      const version = workspace.lessons.freeze({
        epoch,
        id: draft.id,
        expectedRevision: 1,
        requestId: randomUUID(),
        reason: '初版',
      });
      enabled = true;
      expect(() =>
        workspace.lessons.revise({ epoch, versionId: version.versionId, requestId: randomUUID() }),
      ).toThrow('synthetic lesson failure');
      expect(workspace.lessons.list({ epoch, includeClosed: true })).toHaveLength(1);
      return;
    }
    const before = workspace.lessons.read({ epoch, id: draft.id });
    enabled = true;
    const action = () =>
      stage === 'edited'
        ? workspace.lessons.edit({
            epoch,
            id: draft.id,
            expectedRevision: 1,
            content: { ...content, title: '更改' },
          })
        : stage === 'discarded'
          ? workspace.lessons.discard({ epoch, id: draft.id, expectedRevision: 1 })
          : workspace.lessons.freeze({
              epoch,
              id: draft.id,
              expectedRevision: 1,
              requestId: randomUUID(),
              reason: '初版',
            });
    expect(action).toThrow('synthetic lesson failure');
    expect(workspace.lessons.read({ epoch, id: draft.id })).toEqual(before);
    expect(workspace.lessons.history({ epoch, id: draft.id })).toEqual([]);
  },
);

test.each([
  'fingerprint',
  'quote',
  'initial-edit',
  'version-payload',
  'base',
  'timestamp',
] as const)('rehashed lesson backup with invalid %s cannot replace the workspace', async (kind) => {
  const { workspace, root, epoch, generation } = await fixture();
  const draft = workspace.lessons.complete(generation());
  if (kind === 'version-payload' || kind === 'base')
    workspace.lessons.freeze({
      epoch,
      id: draft.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      reason: '初版',
    });
  const before = workspace.lessons.read({ epoch, id: draft.id });
  const bundle = JSON.parse(workspace.exportBackup({ epoch }).toString());
  const path = join(root, 'tampered.sqlite');
  writeFileSync(path, Buffer.from(bundle.database.base64, 'base64'));
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  const payload = structuredClone(before.payload);
  if (kind === 'fingerprint') payload.inputHash = '0'.repeat(64);
  if (kind === 'quote') {
    const block = payload.content.objectives[0]!;
    if (block.kind !== 'paragraph' || block.origin.kind !== 'source')
      throw new Error('Expected source');
    block.origin.citations[0]!.quote = '伪造原文';
  }
  if (kind === 'initial-edit') payload.content.title = '未升版的修改';
  db.prepare('UPDATE lesson_drafts SET payload=?').run(JSON.stringify(payload));
  if (kind === 'version-payload') {
    payload.content.title = '伪造冻结内容';
    db.prepare('UPDATE lesson_versions SET payload=?').run(JSON.stringify(payload));
  }
  if (kind === 'base') db.prepare('UPDATE lesson_drafts SET base_version_id=?').run(randomUUID());
  if (kind === 'timestamp')
    db.exec("UPDATE lesson_drafts SET updated_at='2000-01-01T00:00:00.000Z'");
  db.close();
  const bytes = readFileSync(path);
  bundle.database = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow();
  expect(workspace.snapshot().epoch).toBe(epoch);
  expect(workspace.lessons.read({ epoch, id: draft.id })).toEqual(before);
});
