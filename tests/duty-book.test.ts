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
import type { DutyCheckpoint } from '../src/core/duty-book';
import type { DutyPreparation } from '../src/shared/duty-records';
import { dutyCalendarDate, readDutyDate } from '../src/core/duty-records';
import { SCHEMA_VERSION, openDatabase } from '../src/core/database';
import { MAX_DUTY_VERSIONS } from '../src/core/storage-limits';

const roots: string[] = [];
const workspaces: Workspace[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const workspace of workspaces.splice(0)) workspace.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const now = '2026-09-30T02:00:00.000Z';
const dates = ['2026-09-30', '2026-10-01', '2026-10-02'];
function fixture(checkpoint?: DutyCheckpoint) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  const root = mkdtempSync(join(tmpdir(), 'cm-duty-'));
  roots.push(root);
  const workspace = new Workspace(root, undefined, undefined, undefined, undefined, checkpoint);
  workspaces.push(workspace);
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成值日班' });
  const classId = workspace.snapshot().classes[0]!.id;
  for (let index = 1; index <= 4; index++)
    workspace.saveStudent({
      epoch,
      classId,
      studentNumber: `D${index}`,
      displayName: `合成${index}`,
    });
  const studentIds = workspace.snapshot().students.map((item) => item.id);
  const postId = randomUUID();
  const start = {
    epoch,
    classId,
    expectedRevision: 0,
    source: {
      kind: 'new',
      title: '合成当期值日',
      participantIds: studentIds,
      dates,
      posts: [{ id: postId, name: '清扫', startMinute: 960, endMinute: 980, required: 1 }],
      groupCount: 2,
      unavailable: [],
    },
  };
  const command = (draft: DutyPreparation) => ({
    epoch,
    token: draft.token,
    requestId: randomUUID(),
    expectedRevision: draft.expectedRevision,
    reason: '合成确认',
  });
  return {
    root,
    workspace,
    epoch,
    classId,
    studentIds,
    postId,
    start,
    command,
    path: join(root, 'workspaces', epoch, 'data.sqlite'),
  };
}
function reopen(workspace: Workspace, root: string) {
  workspace.close();
  workspaces.splice(workspaces.indexOf(workspace), 1);
  const next = new Workspace(root);
  workspaces.push(next);
  return next;
}

test('private snapshot, immutable history and exact-request retry survive reopen without models', () => {
  const { workspace, root, epoch, classId, start, command } = fixture();
  const draft = workspace.duties.prepare(start);
  const expected = structuredClone(draft.draft);
  const input = command(draft);
  draft.draft.members[0]!.displayName = '伪造快照';
  draft.draft.days = [];
  const saved = workspace.duties.confirm(input);
  expect(workspace.duties.read({ epoch, versionId: saved.versionId }).payload.arrangement).toEqual(
    expected,
  );
  const next = reopen(workspace, root);
  expect(next.duties.confirm(input)).toEqual({ ...saved, replayed: true });
  expect(next.duties.history({ epoch, classId })).toHaveLength(1);
  expect(() => next.duties.confirm({ ...input, reason: '换原因' })).toThrow(/同一请求/);
});

test('preparation rejects inactive, foreign and duplicate students without trusting caller fields', () => {
  const { workspace, epoch, studentIds, start } = fixture();
  const active = workspace.snapshot().students[0]!;
  workspace.setStudentActive({
    epoch,
    id: active.id,
    expectedRevision: active.revision,
    active: false,
  });
  expect(() => workspace.duties.prepare(start)).toThrow(/停用/);
  expect(() =>
    workspace.duties.prepare({
      ...start,
      source: { ...start.source, participantIds: [studentIds[1], studentIds[1]] },
    }),
  ).toThrow(/重复/);
  expect(() =>
    workspace.duties.prepare({
      ...start,
      source: { ...start.source, participantIds: [randomUUID()] },
    }),
  ).toThrow(/本班/);
  expect(() => workspace.duties.prepare({ ...start, payload: {} })).toThrow();
});

test('shortages remain visible and cannot become confirmed versions', () => {
  const { workspace, epoch, classId, start, command } = fixture();
  const prepared = workspace.duties.prepare({
    ...start,
    source: { ...start.source, groupCount: 4, posts: [{ ...start.source.posts[0], required: 2 }] },
  });
  expect(prepared.complete).toBe(false);
  expect(prepared.shortages).toHaveLength(3);
  expect(() => workspace.duties.confirm(command(prepared))).toThrow(/缺口/);
  expect(workspace.duties.history({ epoch, classId })).toEqual([]);
});

test('tokens rotate, rejected edits preserve drafts, invalid new starts revoke old drafts', () => {
  const { workspace, epoch, start, command } = fixture();
  const original = workspace.duties.prepare(start);
  const changed = workspace.duties.adjust({
    epoch,
    token: original.token,
    change: { kind: 'rotate' },
  });
  expect(changed.token).not.toBe(original.token);
  expect(() => workspace.duties.confirm(command(original))).toThrow(/失效/);
  expect(() => workspace.duties.cancel({ epoch, token: original.token })).toThrow(/较新/);
  expect(() =>
    workspace.duties.adjust({
      epoch,
      token: changed.token,
      change: { kind: 'complete', date: dates[1] },
    }),
  ).toThrow(/未来/);
  const saved = workspace.duties.confirm(command(changed));
  const latest = workspace.duties.prepare({
    ...start,
    expectedRevision: 1,
    source: { kind: 'latest', planId: saved.planId },
  });
  expect(() => workspace.duties.prepare({ epoch, invalid: true })).toThrow();
  expect(() => workspace.duties.confirm(command(latest))).toThrow(/失效/);
});

test('cancel, expiration and stale workspaces do not write plans', () => {
  const { workspace, epoch, classId, start, command } = fixture();
  const draft = workspace.duties.prepare(start);
  workspace.duties.cancel({ epoch, token: draft.token });
  workspace.duties.cancel({ epoch, token: draft.token });
  expect(() => workspace.duties.confirm(command(draft))).toThrow(/失效/);
  const expired = workspace.duties.prepare(start);
  vi.setSystemTime(new Date(Date.parse(now) + 16 * 60_000));
  expect(() => workspace.duties.confirm(command(expired))).toThrow(/失效/);
  expect(() => workspace.duties.history({ epoch: randomUUID(), classId })).toThrow(/切换/);
  expect(workspace.duties.history({ epoch, classId })).toEqual([]);
});

test('roster updates after preparation invalidate confirmation but retain existing history', () => {
  const { workspace, epoch, start, classId, command } = fixture();
  const prepared = workspace.duties.prepare(start);
  workspace.renameClass({ epoch, id: classId, expectedRevision: 1, name: '更名' });
  expect(() => workspace.duties.confirm(command(prepared))).toThrow(/名册/);
});

test('a new period cannot overlap another period but adjacent times and distinct students work', () => {
  const { workspace, epoch, classId, start, studentIds, command } = fixture();
  const first = workspace.duties.confirm(command(workspace.duties.prepare(start)));
  const conflict = workspace.duties.prepare(start);
  expect(() => workspace.duties.confirm(command(conflict))).toThrow(/跨计划/);
  const adjacent = workspace.duties.prepare({
    ...start,
    source: {
      ...start.source,
      posts: [{ ...start.source.posts[0], startMinute: 980, endMinute: 1000 }],
    },
  });
  workspace.duties.confirm(command(adjacent));
  const distinct = workspace.duties.prepare({
    ...start,
    source: {
      ...start.source,
      participantIds: [studentIds[2], studentIds[3]],
      groupCount: 2,
    },
  });
  workspace.duties.confirm(command(distinct));
  expect(workspace.duties.history({ epoch, classId })).toHaveLength(3);
  expect(workspace.duties.read({ epoch, versionId: first.versionId }).payload.title).toBe(
    start.source.title,
  );
});

test('only latest revisions participate in cross-plan checks, historical revisions stay intact', () => {
  const { workspace, epoch, start, postId, studentIds, command } = fixture();
  const first = workspace.duties.confirm(command(workspace.duties.prepare(start)));
  let latest = workspace.duties.prepare({
    ...start,
    expectedRevision: 1,
    source: { kind: 'latest', planId: first.planId },
  });
  for (const [index, date] of dates.entries())
    latest = workspace.duties.adjust({
      epoch,
      token: latest.token,
      change: {
        kind: 'replace',
        date,
        postId,
        slotIndex: 0,
        studentId: studentIds[(index % 2) + 2],
      },
    });
  const revised = workspace.duties.confirm(command(latest));
  workspace.duties.confirm(command(workspace.duties.prepare(start)));
  expect(workspace.duties.read({ epoch, versionId: first.versionId }).stale).toBe(true);
  expect(workspace.duties.read({ epoch, versionId: revised.versionId }).stale).toBe(false);
});

test('midnight rechecks reject new past plans and changed past dates in existing-period drafts', () => {
  const { workspace, epoch, start, postId, studentIds, command } = fixture();
  vi.setSystemTime(new Date('2026-09-30T15:55:00.000Z'));
  const first = workspace.duties.confirm(command(workspace.duties.prepare(start)));
  let latest = workspace.duties.prepare({
    ...start,
    expectedRevision: 1,
    source: { kind: 'latest', planId: first.planId },
  });
  latest = workspace.duties.adjust({
    epoch,
    token: latest.token,
    change: { kind: 'replace', date: dates[0], postId, slotIndex: 0, studentId: studentIds[2] },
  });
  vi.setSystemTime(new Date('2026-09-30T16:01:00.000Z'));
  expect(() => workspace.duties.confirm(command(latest))).toThrow(/过去日期/);
  vi.setSystemTime(new Date('2026-09-30T15:55:00.000Z'));
  expect(() => workspace.duties.prepare(start)).toThrow(/过去日期/);
});

test('durable calendar floor survives failed edits, clock rollback, reopen and old-backup restore', () => {
  const { workspace, epoch, root, start, postId, studentIds, command } = fixture();
  const saved = workspace.duties.confirm(command(workspace.duties.prepare(start)));
  const backup = workspace.exportBackup({ epoch });
  vi.setSystemTime(new Date('2026-10-01T02:00:00.000Z'));
  const copy = workspace.duties.prepare({
    ...start,
    expectedRevision: 1,
    source: { kind: 'latest', planId: saved.planId },
  });
  expect(() =>
    workspace.duties.adjust({
      epoch,
      token: copy.token,
      change: { kind: 'replace', date: dates[0], postId, slotIndex: 0, studentId: studentIds[2] },
    }),
  ).toThrow(/不可修改/);
  vi.setSystemTime(new Date(now));
  const next = reopen(workspace, root);
  const preview = next.previewRestore(backup);
  expect(preview.dutyVersionCount).toBe(1);
  const restored = next.commitRestore({ epoch, token: preview.token });
  const draft = next.duties.prepare({
    ...start,
    epoch: restored.epoch,
    expectedRevision: 1,
    source: { kind: 'latest', planId: saved.planId },
  });
  expect(draft.protectedDate).toBe('2026-10-01');
  expect(() =>
    next.duties.adjust({
      epoch: restored.epoch,
      token: draft.token,
      change: { kind: 'replace', date: dates[0], postId, slotIndex: 0, studentId: studentIds[2] },
    }),
  ).toThrow(/不可修改/);
});

test('participant revisions retain completed history after transfer or deactivation', () => {
  const { workspace, root, epoch, classId, start, studentIds, command } = fixture();
  let prepared = workspace.duties.prepare(start);
  const first = workspace.duties.confirm(command(prepared));
  vi.setSystemTime(new Date('2026-10-01T02:00:00.000Z'));
  const removed = workspace.snapshot().students.find((student) => student.id === studentIds[0])!;
  workspace.setStudentActive({
    epoch,
    id: removed.id,
    expectedRevision: removed.revision,
    active: false,
  });
  workspace.saveStudent({ epoch, classId, studentNumber: 'D5', displayName: '新参与者' });
  const added = workspace.snapshot().students.find((student) => student.studentNumber === 'D5')!;
  prepared = workspace.duties.prepare({
    ...start,
    expectedRevision: 1,
    source: { kind: 'latest', planId: first.planId },
  });
  expect(() => workspace.duties.confirm(command(prepared))).toThrow(/停用/);
  const nextIds = studentIds.filter((id) => id !== removed.id).concat(added.id);
  prepared = workspace.duties.adjust({
    epoch,
    token: prepared.token,
    change: {
      kind: 'participants',
      participantIds: nextIds,
      groups: prepared.draft.groups.map((group) => ({
        ...group,
        studentIds: group.studentIds.map((id) => (id === removed.id ? added.id : id)),
      })),
    },
  });
  const saved = workspace.duties.confirm(command(prepared));
  const next = reopen(workspace, root);
  const old = next.duties.read({ epoch, versionId: first.versionId });
  const revised = next.duties.read({ epoch, versionId: saved.versionId });
  expect(revised.payload.arrangement.days[0]).toEqual(old.payload.arrangement.days[0]);
  expect(revised.payload.arrangement.participantIds).not.toContain(removed.id);
  expect(
    revised.payload.arrangement.members.some((member) => member.studentId === removed.id),
  ).toBe(true);
});

test.each(['version-inserted', 'committed'] as const)(
  'interruption at %s rolls back or replays exactly',
  (target) => {
    let fail = true;
    const { workspace, root, epoch, classId, start, command } = fixture((stage) => {
      if (fail && stage === target) throw new Error('Synthetic interruption');
    });
    const input = command(workspace.duties.prepare(start));
    expect(() => workspace.duties.confirm(input)).toThrow(/Synthetic/);
    fail = false;
    if (target === 'version-inserted') {
      expect(workspace.duties.history({ epoch, classId })).toEqual([]);
      expect(workspace.duties.confirm(input).replayed).toBe(false);
    } else {
      const next = reopen(workspace, root);
      expect(next.duties.confirm(input).replayed).toBe(true);
      expect(next.duties.history({ epoch, classId })).toHaveLength(1);
    }
  },
);

test('restore invalidates old book references and tokens, preserving versions and protocol counts', () => {
  const { workspace, epoch, start, command } = fixture();
  const saved = workspace.duties.confirm(command(workspace.duties.prepare(start)));
  const oldBook = workspace.duties;
  const backup = workspace.exportBackup({ epoch });
  expect(JSON.parse(backup.toString()).version).toBe(SCHEMA_VERSION);
  const preview = workspace.previewRestore(backup);
  const restored = workspace.commitRestore({ epoch, token: preview.token });
  expect(() => oldBook.read({ epoch, versionId: saved.versionId })).toThrow(/关闭或恢复/);
  expect(
    workspace.duties.read({ epoch: restored.epoch, versionId: saved.versionId }).record.id,
  ).toBe(saved.versionId);
});

test('clock rollback before deactivation does not invalidate already confirmed duty membership', () => {
  const { workspace, root, epoch, start, command } = fixture();
  vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'));
  const saved = workspace.duties.confirm(command(workspace.duties.prepare(start)));
  vi.setSystemTime(new Date(now));
  const student = workspace.snapshot().students[0]!;
  workspace.setStudentActive({
    epoch,
    id: student.id,
    expectedRevision: student.revision,
    active: false,
  });
  const next = reopen(workspace, root);
  expect(next.duties.read({ epoch, versionId: saved.versionId }).record.id).toBe(saved.versionId);
});

test.each(['chain', 'date', 'clock', 'member'] as const)(
  'tampered %s data rejects open without clearing source',
  (kind) => {
    const { workspace, root, epoch, start, command, path } = fixture();
    workspace.duties.confirm(command(workspace.duties.prepare(start)));
    workspace.close();
    workspaces.splice(workspaces.indexOf(workspace), 1);
    const db = new DatabaseSync(path);
    if (kind === 'chain') db.exec('UPDATE duty_versions SET revision=2');
    if (kind === 'date') db.exec("UPDATE duty_versions SET protected_date='2026-10-01'");
    if (kind === 'clock') db.exec("UPDATE duty_clock SET protected_date='2026-09-01'");
    if (kind === 'member') db.exec("UPDATE enrollments SET valid_from='2026-10-01T02:00:00.000Z'");
    db.close();
    const before = readFileSync(path);
    expect(() => new Workspace(root)).toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')).workspaceId).toBe(epoch);
  },
);

test('valid-hash backup with corrupted duty clock is rejected before publication', () => {
  const { workspace, epoch, root, start, command } = fixture();
  workspace.duties.confirm(command(workspace.duties.prepare(start)));
  const bundle = JSON.parse(workspace.exportBackup({ epoch }).toString());
  const path = join(root, 'damaged.sqlite');
  writeFileSync(path, Buffer.from(bundle.database.base64, 'base64'));
  const db = new DatabaseSync(path);
  db.exec('DELETE FROM duty_clock');
  db.close();
  const bytes = readFileSync(path);
  bundle.database = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow(/校验失败/);
  expect(workspace.snapshot().epoch).toBe(epoch);
});

test('version chronology compares instants even when ISO fractional precision differs', () => {
  const { workspace, root, start, command, path } = fixture();
  vi.setSystemTime(new Date(Date.parse(now) + 500));
  workspace.duties.confirm(command(workspace.duties.prepare(start)));
  workspace.close();
  workspaces.splice(workspaces.indexOf(workspace), 1);
  const db = new DatabaseSync(path);
  const prior = db.prepare('SELECT * FROM duty_versions').get()!;
  db.prepare('INSERT INTO duty_versions VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?)').run(
    randomUUID(),
    prior.plan_id!,
    prior.class_id!,
    randomUUID(),
    'b'.repeat(64),
    now.replace('.000Z', 'Z'),
    prior.protected_date!,
    '合成倒退时刻',
    prior.payload!,
  );
  db.close();
  const before = readFileSync(path);
  expect(() => new Workspace(root)).toThrow(/校验失败/);
  expect(readFileSync(path)).toEqual(before);
});

test('version quota refuses new confirmation while history remains reopenable', () => {
  const { workspace, epoch, root, start, command, path } = fixture();
  const saved = workspace.duties.confirm(command(workspace.duties.prepare(start)));
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT * FROM duty_versions').get()!;
  db.exec('BEGIN');
  for (let revision = 2; revision <= MAX_DUTY_VERSIONS; revision++)
    db.prepare('INSERT INTO duty_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      row.plan_id!,
      row.class_id!,
      revision,
      randomUUID(),
      'a'.repeat(64),
      row.created_at!,
      row.protected_date!,
      '合成容量',
      row.payload!,
    );
  db.exec('COMMIT');
  db.close();
  const prepared = workspace.duties.prepare({
    ...start,
    expectedRevision: MAX_DUTY_VERSIONS,
    source: { kind: 'latest', planId: saved.planId },
  });
  expect(() => workspace.duties.confirm(command(prepared))).toThrow(/上限/);
  const next = reopen(workspace, root);
  expect(next.duties.history({ epoch, classId: start.classId })).toHaveLength(MAX_DUTY_VERSIONS);
});

test('read-only inspection never advances calendar metadata or rewrites bytes', () => {
  const { path } = fixture();
  const before = readFileSync(path);
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  const db = openDatabase(path, 'readonly');
  expect(readDutyDate(db)).toBe('2026-09-30');
  db.close();
  expect(readFileSync(path)).toEqual(before);
  expect(dutyCalendarDate(Date.parse('2026-09-30T16:00:00.000Z'))).toBe('2026-10-01');
});

test('plan directory returns detached latest summaries, not full schedules or duplicate revisions', () => {
  const { workspace, epoch, start, command, classId, path } = fixture();
  const first = workspace.duties.confirm(command(workspace.duties.prepare(start)));
  const draft = workspace.duties.prepare({
    ...start,
    expectedRevision: 1,
    source: { kind: 'latest', planId: first.planId },
  });
  const before = readFileSync(path);
  const listed = workspace.duties.list({ epoch, classId });
  expect(readFileSync(path)).toEqual(before);
  expect(listed).toEqual([
    {
      planId: first.planId,
      classId,
      title: start.source.title,
      latestVersionId: first.versionId,
      revision: 1,
      firstDate: dates[0],
      lastDate: dates[2],
      participantCount: 4,
      updatedAt: first.createdAt,
    },
  ]);
  listed[0]!.title = '本地伪造修改';
  const second = workspace.duties.confirm(command(draft));
  workspace.duties.confirm(
    command(
      workspace.duties.prepare({
        ...start,
        source: { ...start.source, title: '另一期', dates: ['2026-10-06'] },
      }),
    ),
  );
  const current = workspace.duties.list({ epoch, classId });
  expect(current).toHaveLength(2);
  expect(current.find((item) => item.planId === first.planId)).toMatchObject({
    title: start.source.title,
    revision: 2,
    latestVersionId: second.versionId,
  });
  expect(() => workspace.duties.list({ epoch, classId, arbitrary: true })).toThrow();
  expect(() => workspace.duties.list({ epoch: randomUUID(), classId })).toThrow(/切换/);
});

test.each(['version-inserted', 'committed'] as const)(
  'process exit at %s leaves a recoverable database',
  (checkpoint) => {
    const { workspace, root, epoch, classId, start } = fixture();
    // Both test processes use one calendar; production time behavior stays unchanged.
    const date = dutyCalendarDate(Date.now() + 30 * 86400000);
    const input = { ...start, source: { ...start.source, dates: [date] } };
    workspace.close();
    workspaces.splice(workspaces.indexOf(workspace), 1);
    const runner = join(root, 'crash-duty.cjs');
    const inputPath = join(root, 'input.json');
    const commandPath = join(root, 'command.json');
    writeFileSync(inputPath, JSON.stringify(input));
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-duty.ts'],
        outfile: runner,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
      }),
    );
    const result = spawnSync(
      process.execPath,
      [runner, root, inputPath, commandPath, checkpoint, now],
      {
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    expect(result.status, result.stderr).toBe(88);
    const next = new Workspace(root);
    workspaces.push(next);
    const command = JSON.parse(readFileSync(commandPath, 'utf8'));
    if (checkpoint === 'committed') {
      expect(next.duties.confirm(command).replayed).toBe(true);
      expect(next.duties.history({ epoch, classId })).toHaveLength(1);
    } else {
      expect(next.duties.history({ epoch, classId })).toEqual([]);
      expect(() => next.duties.confirm(command)).toThrow(/失效/);
    }
  },
);
