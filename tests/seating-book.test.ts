import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import type { SeatingCheckpoint } from '../src/core/seating-book';
import type { SeatingPayload, SeatingPreparation } from '../src/shared/seating-records';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { SCHEMA_VERSION, transaction } from '../src/core/database';
import { MAX_SEATING_PAYLOAD_BYTES, MAX_SEATING_VERSIONS } from '../src/core/storage-limits';

const roots: string[] = [];
const open: Workspace[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const workspace of open.splice(0)) workspace.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(checkpoint?: SeatingCheckpoint) {
  const root = mkdtempSync(join(tmpdir(), 'cm-seating-'));
  roots.push(root);
  const workspace = new Workspace(root, undefined, undefined, undefined, checkpoint);
  open.push(workspace);
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成座位班' });
  const classId = workspace.snapshot().classes[0]!.id;
  for (let index = 1; index <= 3; index++)
    workspace.saveStudent({
      epoch,
      classId,
      studentNumber: `S${index}`,
      displayName: `合成 ${index}`,
    });
  const prepare = (expectedRevision = 0) =>
    workspace.seating.prepare({
      epoch,
      classId,
      expectedRevision,
      source: { kind: 'empty', layout: { rows: 2, columns: 2, unavailable: [] } },
    });
  const ready = (expectedRevision = 0) => {
    const initial = prepare(expectedRevision);
    return workspace.seating.adjust({ epoch, token: initial.token, change: { kind: 'randomize' } });
  };
  const command = (prepared: SeatingPreparation) => ({
    epoch,
    token: prepared.token,
    requestId: randomUUID(),
    expectedRevision: prepared.expectedRevision,
    reason: '合成教师确认',
  });
  return { workspace, root, epoch, classId, prepare, ready, command };
}
function reopen(workspace: Workspace, root: string) {
  workspace.close();
  open.splice(open.indexOf(workspace), 1);
  const next = new Workspace(root);
  open.push(next);
  return next;
}

test('prepare uses active class roster and cannot confirm incomplete or empty assignments', () => {
  const { workspace, epoch, classId, prepare, command } = fixture();
  const inactive = workspace.snapshot().students[0]!;
  workspace.setStudentActive({
    epoch,
    id: inactive.id,
    expectedRevision: inactive.revision,
    active: false,
  });
  workspace.createClass({ epoch, name: '其他合成班' });
  const other = workspace.snapshot().classes.find((item) => item.id !== classId)!;
  workspace.saveStudent({
    epoch,
    classId: other.id,
    studentNumber: 'OTHER',
    displayName: '其他学生',
  });
  const draft = prepare();
  expect(draft.draft.members).toHaveLength(2);
  expect(draft.unassignedStudentIds).toHaveLength(2);
  expect(draft.complete).toBe(false);
  expect(() => workspace.seating.confirm(command(draft))).toThrow(/未安排/);
  expect(workspace.seating.history({ epoch, classId })).toEqual([]);
});

test('confirmed snapshot is isolated from caller changes and survives close/reopen', () => {
  const { workspace, root, epoch, classId, ready, command } = fixture();
  const prepared = ready();
  const expected = structuredClone(prepared.draft);
  prepared.draft.members[0]!.displayName = '伪造修改';
  prepared.draft.assignments.length = 0;
  const input = command(prepared);
  const receipt = workspace.seating.confirm(input);
  const view = workspace.seating.read({ epoch, versionId: receipt.versionId });
  expect(view.payload.arrangement).toEqual(expected);
  expect(view).toMatchObject({ stale: false, rosterChanged: false });
  const next = reopen(workspace, root);
  expect(next.seating.read({ epoch, versionId: receipt.versionId })).toEqual(view);
  expect(next.seating.history({ epoch, classId })).toHaveLength(1);
  expect(next.seating.confirm(input)).toMatchObject({
    versionId: receipt.versionId,
    replayed: true,
  });
  expect(() => next.seating.confirm({ ...input, reason: '不同原因' })).toThrow(/同一请求/);
});

test('successful adjustment rotates tokens and rejects late adjustments or cancellation', () => {
  const { workspace, epoch, prepare } = fixture();
  const first = prepare();
  const second = workspace.seating.adjust({
    epoch,
    token: first.token,
    change: { kind: 'randomize' },
  });
  expect(second.token).not.toBe(first.token);
  expect(() =>
    workspace.seating.adjust({ epoch, token: first.token, change: { kind: 'randomize' } }),
  ).toThrow(/失效/);
  expect(() => workspace.seating.cancel({ epoch, token: first.token })).toThrow(/较新/);
  expect(
    workspace.seating.adjust({ epoch, token: second.token, change: { kind: 'randomize' } })
      .complete,
  ).toBe(true);
});

test('rejected layout change retains the token and original private assignments', () => {
  const { workspace, epoch, ready, command } = fixture();
  const initial = ready();
  expect(() =>
    workspace.seating.adjust({
      epoch,
      token: initial.token,
      change: { kind: 'layout', layout: { rows: 1, columns: 1, unavailable: [] } },
    }),
  ).toThrow(/不足/);
  const saved = workspace.seating.confirm(command(initial));
  expect(workspace.seating.read({ epoch, versionId: saved.versionId }).payload.arrangement).toEqual(
    initial.draft,
  );
});

test('starting an invalid new draft revokes the older unconfirmed token', () => {
  const { workspace, epoch, ready, command } = fixture();
  const initial = ready();
  expect(() => workspace.seating.prepare({ epoch, invalid: true })).toThrow();
  expect(() => workspace.seating.confirm(command(initial))).toThrow(/失效/);
});

test.each(['rename', 'transfer', 'deactivate', 'add', 'class-name'] as const)(
  '%s between preparation and confirmation is rejected and leaves history unchanged',
  (change) => {
    const { workspace, epoch, classId, ready, command } = fixture();
    const saved = workspace.seating.confirm(command(ready()));
    const next = ready(1);
    const member = workspace.snapshot().students[0]!;
    if (change === 'rename')
      workspace.saveStudent({
        epoch,
        id: member.id,
        classId,
        studentNumber: member.studentNumber,
        expectedRevision: member.revision,
        displayName: '后来改名',
      });
    if (change === 'transfer') {
      workspace.createClass({ epoch, name: '新班' });
      const other = workspace.snapshot().classes.find((item) => item.id !== classId)!;
      workspace.saveStudent({
        epoch,
        id: member.id,
        expectedRevision: member.revision,
        classId: other.id,
        studentNumber: member.studentNumber,
        displayName: member.displayName,
      });
    }
    if (change === 'deactivate')
      workspace.setStudentActive({
        epoch,
        id: member.id,
        expectedRevision: member.revision,
        active: false,
      });
    if (change === 'add')
      workspace.saveStudent({ epoch, classId, studentNumber: 'NEW', displayName: '新合成学生' });
    if (change === 'class-name')
      workspace.renameClass({ epoch, id: classId, expectedRevision: 1, name: '后来班名' });
    expect(() => workspace.seating.confirm(command(next))).toThrow(/名册或座位版本/);
    expect(workspace.seating.history({ epoch, classId })).toHaveLength(1);
    const old = workspace.seating.read({ epoch, versionId: saved.versionId });
    expect(old.payload.className).toBe('合成座位班');
    expect(old.payload.arrangement.members[0]!.displayName).toBe('合成 1');
    if (change !== 'class-name') expect(old.rosterChanged).toBe(true);
  },
);

test('copy latest preserves locks, layout revisions change only when the layout changes', () => {
  const { workspace, epoch, classId, ready, command } = fixture();
  const initial = ready();
  const studentId = initial.draft.members[0]!.studentId;
  const locked = workspace.seating.adjust({
    epoch,
    token: initial.token,
    change: { kind: 'lock', studentId, locked: true },
  });
  const first = workspace.seating.confirm(command(locked));
  const old = workspace.seating.read({ epoch, versionId: first.versionId });
  const copied = workspace.seating.prepare({
    epoch,
    classId,
    expectedRevision: 1,
    source: { kind: 'latest' },
  });
  const rerandomized = workspace.seating.adjust({
    epoch,
    token: copied.token,
    change: { kind: 'randomize' },
  });
  expect(rerandomized.draft.assignments.find((item) => item.studentId === studentId)).toEqual(
    locked.draft.assignments.find((item) => item.studentId === studentId),
  );
  const second = workspace.seating.confirm(command(rerandomized));
  expect(
    workspace.seating.read({ epoch, versionId: second.versionId }).payload.layoutVersionId,
  ).toBe(old.payload.layoutVersionId);
  const next = workspace.seating.prepare({
    epoch,
    classId,
    expectedRevision: 2,
    source: { kind: 'latest' },
  });
  const expanded = workspace.seating.adjust({
    epoch,
    token: next.token,
    change: { kind: 'layout', layout: { rows: 3, columns: 2, unavailable: [] } },
  });
  const third = workspace.seating.confirm(command(expanded));
  expect(
    workspace.seating.read({ epoch, versionId: third.versionId }).payload.layoutVersionId,
  ).not.toBe(old.payload.layoutVersionId);
  expect(workspace.seating.read({ epoch, versionId: first.versionId })).toMatchObject({
    stale: true,
    payload: old.payload,
  });
  expect(workspace.seating.history({ epoch, classId }).map((item) => item.revision)).toEqual([
    3, 2, 1,
  ]);
});

test('copy latest refuses changed membership; explicit fresh preparation includes current members', () => {
  const { workspace, epoch, classId, ready, command, prepare } = fixture();
  workspace.seating.confirm(command(ready()));
  workspace.saveStudent({ epoch, classId, studentNumber: 'NEW', displayName: '新学生' });
  expect(() =>
    workspace.seating.prepare({ epoch, classId, expectedRevision: 1, source: { kind: 'latest' } }),
  ).toThrow(/当前名册/);
  expect(prepare(1).draft.members).toHaveLength(4);
});

test('cancel and expiration never change confirmed versions', () => {
  const { workspace, epoch, classId, ready, command } = fixture();
  workspace.seating.confirm(command(ready()));
  const pending = ready(1);
  workspace.seating.cancel({ epoch, token: pending.token });
  workspace.seating.cancel({ epoch, token: pending.token });
  expect(() => workspace.seating.confirm(command(pending))).toThrow(/失效/);
  vi.useFakeTimers();
  const expiring = ready(1);
  vi.advanceTimersByTime(15 * 60 * 1000);
  expect(() => workspace.seating.confirm(command(expiring))).toThrow(/失效/);
  expect(workspace.seating.history({ epoch, classId })).toHaveLength(1);
});

test('backup/restore preserves historical snapshots and disposes older draft holders', () => {
  const { workspace, epoch, classId, ready, command } = fixture();
  const receipt = workspace.seating.confirm(command(ready()));
  const original = workspace.seating.read({ epoch, versionId: receipt.versionId });
  const backup = workspace.exportBackup({ epoch });
  expect(JSON.parse(backup.toString()).version).toBe(SCHEMA_VERSION);
  const oldBook = workspace.seating;
  const pending = ready(1);
  const preview = workspace.previewRestore(backup);
  expect(preview.seatingVersionCount).toBe(1);
  const restored = workspace.commitRestore({ epoch, token: preview.token });
  expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
  expect(() => oldBook.confirm(command(pending))).toThrow(/关闭或恢复/);
  expect(() => workspace.seating.history({ epoch, classId })).toThrow(/切换/);
  expect(workspace.seating.read({ epoch: restored.epoch, versionId: receipt.versionId })).toEqual(
    original,
  );
});

test.each(['version-inserted', 'committed'] as const)(
  'failure at %s is rollback or idempotent lost reply',
  (stage) => {
    let armed = true;
    const { workspace, epoch, classId, ready, command } = fixture((current) => {
      if (armed && current === stage) {
        armed = false;
        throw new Error('Synthetic checkpoint');
      }
    });
    const input = command(ready());
    expect(() => workspace.seating.confirm(input)).toThrow('Synthetic checkpoint');
    expect(workspace.seating.history({ epoch, classId })).toHaveLength(
      stage === 'committed' ? 1 : 0,
    );
    const result = workspace.seating.confirm(input);
    expect(result.replayed).toBe(stage === 'committed');
    expect(workspace.seating.history({ epoch, classId })).toHaveLength(1);
  },
);

test('closed handles and foreign epochs cannot mutate drafts', () => {
  const { workspace, epoch, ready, command, root } = fixture();
  const prepared = ready();
  expect(() => workspace.seating.confirm({ ...command(prepared), epoch: randomUUID() })).toThrow(
    /切换/,
  );
  const oldBook = workspace.seating;
  reopen(workspace, root);
  expect(() => oldBook.cancel({ epoch, token: prepared.token })).toThrow(/关闭/);
});

function corruptBackup(
  backup: Buffer,
  mutate: (payload: SeatingPayload, db: DatabaseSync) => void,
): Buffer {
  const bundle = JSON.parse(backup.toString());
  const directory = mkdtempSync(join(tmpdir(), 'cm-seat-corrupt-'));
  roots.push(directory);
  const path = join(directory, 'data.sqlite');
  writeFileSync(path, Buffer.from(bundle.database.base64, 'base64'));
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare('SELECT id, payload FROM seating_versions ORDER BY revision DESC LIMIT 1')
      .get()!;
    const payload: SeatingPayload = JSON.parse(String(row.payload));
    mutate(payload, db);
    db.prepare('UPDATE seating_versions SET payload=? WHERE id=?').run(
      JSON.stringify(payload),
      row.id!,
    );
  } finally {
    db.close();
  }
  const bytes = readFileSync(path);
  bundle.database = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  return Buffer.from(JSON.stringify(bundle));
}

test.each(['unassigned', 'unknown-member', 'class', 'revision', 'layout-identity'] as const)(
  'rehashing a backup cannot bypass %s consistency checks',
  (kind) => {
    const { workspace, epoch, classId, ready, command } = fixture();
    const first = workspace.seating.confirm(command(ready()));
    const copied = workspace.seating.prepare({
      epoch,
      classId,
      expectedRevision: 1,
      source: { kind: 'latest' },
    });
    workspace.seating.confirm(command(copied));
    const before = workspace.seating.read({ epoch, versionId: first.versionId });
    const corrupt = corruptBackup(workspace.exportBackup({ epoch }), (payload, db) => {
      if (kind === 'unassigned') payload.arrangement.assignments.pop();
      if (kind === 'unknown-member') {
        const member = payload.arrangement.members[0]!;
        const assignment = payload.arrangement.assignments.find(
          (item) => item.studentId === member.studentId,
        )!;
        member.studentId = assignment.studentId = randomUUID();
      }
      if (kind === 'class') payload.classId = randomUUID();
      if (kind === 'revision') db.exec('UPDATE seating_versions SET revision=4 WHERE revision=2');
      if (kind === 'layout-identity') payload.arrangement.layout.rows = 3;
    });
    expect(() => workspace.previewRestore(corrupt)).toThrow(/座位版本/);
    expect(workspace.seating.read({ epoch, versionId: first.versionId })).toEqual(before);
  },
);

test.each(['version-inserted', 'committed'] as const)(
  'process exit at %s recovers atomically',
  (checkpoint) => {
    const { workspace, root, epoch, classId } = fixture();
    const entry = join(root, 'crash.cjs');
    const inputPath = join(root, 'input.json');
    const commandPath = join(root, 'command.json');
    writeFileSync(
      inputPath,
      JSON.stringify({
        epoch,
        classId,
        expectedRevision: 0,
        source: { kind: 'empty', layout: { rows: 2, columns: 2, unavailable: [] } },
      }),
    );
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-seating.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: entry,
      }),
    );
    workspace.close();
    open.splice(open.indexOf(workspace), 1);
    const child = spawnSync(process.execPath, [entry, root, inputPath, commandPath, checkpoint], {
      timeout: 15000,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(child.status, child.stderr).toBe(88);
    const restored = new Workspace(root);
    open.push(restored);
    const command = JSON.parse(readFileSync(commandPath, 'utf8'));
    expect(restored.seating.history({ epoch, classId })).toHaveLength(
      checkpoint === 'committed' ? 1 : 0,
    );
    if (checkpoint === 'committed') expect(restored.seating.confirm(command).replayed).toBe(true);
    else expect(() => restored.seating.confirm(command)).toThrow(/失效/);
  },
);

test('version quota refuses a new write without evicting historical plans', () => {
  const { workspace, root, epoch, classId, ready, command } = fixture();
  const first = workspace.seating.confirm(command(ready()));
  const db = new DatabaseSync(join(root, 'workspaces', epoch, 'data.sqlite'));
  try {
    transaction(db, () => {
      const insert = db.prepare(
        `INSERT INTO seating_versions SELECT ?, class_id, ?, ?, request_hash, created_at, reason, payload FROM seating_versions WHERE id=?`,
      );
      for (let revision = 2; revision <= MAX_SEATING_VERSIONS; revision++)
        insert.run(randomUUID(), revision, randomUUID(), first.versionId);
    });
  } finally {
    db.close();
  }
  const next = ready(MAX_SEATING_VERSIONS);
  expect(() => workspace.seating.confirm(command(next))).toThrow(/上限/);
  expect(workspace.seating.history({ epoch, classId })).toHaveLength(MAX_SEATING_VERSIONS);
  const reopened = reopen(workspace, root);
  expect(reopened.seating.history({ epoch, classId })).toHaveLength(MAX_SEATING_VERSIONS);
});

test('another confirmed writer makes the older private draft conflict instead of overwrite', () => {
  const { workspace, root, epoch, classId, ready, command } = fixture();
  const first = ready();
  const other = new Workspace(root);
  open.push(other);
  const second = other.seating.prepare({
    epoch,
    classId,
    expectedRevision: 0,
    source: { kind: 'empty', layout: { rows: 2, columns: 2, unavailable: [] } },
  });
  const secondReady = other.seating.adjust({
    epoch,
    token: second.token,
    change: { kind: 'randomize' },
  });
  const saved = other.seating.confirm(command(secondReady));
  expect(() => workspace.seating.confirm(command(first))).toThrow(/版本已改变/);
  expect(workspace.seating.history({ epoch, classId }).map((item) => item.id)).toEqual([
    saved.versionId,
  ]);
});

test('SQLITE_FULL category after insertion rolls back the uncommitted version', () => {
  let fail = true;
  const { workspace, epoch, classId, ready, command } = fixture((stage) => {
    if (fail && stage === 'version-inserted') {
      fail = false;
      throw Object.assign(new Error('Synthetic SQLite full'), { errcode: 13 });
    }
  });
  const input = command(ready());
  expect(() => workspace.seating.confirm(input)).toThrow(/空间不足/);
  expect(workspace.seating.history({ epoch, classId })).toHaveLength(0);
  expect(workspace.seating.confirm(input).replayed).toBe(false);
});

test('maximum 400-member snapshot fits its payload cap and survives backup restore', () => {
  const { workspace, root, epoch, classId, command } = fixture();
  const db = new DatabaseSync(join(root, 'workspaces', epoch, 'data.sqlite'));
  const createdAt = workspace.snapshot().classes[0]!.createdAt;
  try {
    transaction(db, () => {
      const insertStudent = db.prepare('INSERT INTO students VALUES (?, ?, ?, 1, 1, ?)');
      const insertEnrollment = db.prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, NULL)');
      for (let index = 3; index < 400; index++) {
        const id = randomUUID();
        insertStudent.run(id, String(index).padStart(32, '0'), '合'.repeat(60), createdAt);
        insertEnrollment.run(randomUUID(), id, classId, createdAt);
      }
    });
  } finally {
    db.close();
  }
  const draft = workspace.seating.prepare({
    epoch,
    classId,
    expectedRevision: 0,
    source: { kind: 'empty', layout: { rows: 20, columns: 20, unavailable: [] } },
  });
  const ready = workspace.seating.adjust({
    epoch,
    token: draft.token,
    change: { kind: 'randomize' },
  });
  const saved = workspace.seating.confirm(command(ready));
  const original = workspace.seating.read({ epoch, versionId: saved.versionId });
  expect(original.payload.arrangement.members).toHaveLength(400);
  expect(Buffer.byteLength(JSON.stringify(original.payload))).toBeLessThan(
    MAX_SEATING_PAYLOAD_BYTES,
  );
  const preview = workspace.previewRestore(workspace.exportBackup({ epoch }));
  const restored = workspace.commitRestore({ epoch, token: preview.token });
  expect(workspace.seating.read({ epoch: restored.epoch, versionId: saved.versionId })).toEqual(
    original,
  );
});

test.each(['never', 'future', 'ended'] as const)(
  'backup rejects %s membership even when the student identity exists',
  (kind) => {
    const { workspace, epoch, ready, command } = fixture();
    const receipt = workspace.seating.confirm(command(ready()));
    const corrupt = corruptBackup(workspace.exportBackup({ epoch }), (payload, db) => {
      const studentId = payload.arrangement.members[0]!.studentId;
      if (kind === 'never') {
        const otherClass = randomUUID();
        db.prepare('INSERT INTO classrooms VALUES (?, ?, 1, ?)').run(
          otherClass,
          '从未入原班',
          receipt.createdAt,
        );
        db.prepare('UPDATE enrollments SET class_id=? WHERE student_id=?').run(
          otherClass,
          studentId,
        );
      }
      if (kind === 'future') {
        const future = new Date(Date.parse(receipt.createdAt) + 86400000).toISOString();
        db.prepare('UPDATE enrollments SET valid_from=? WHERE student_id=?').run(future, studentId);
      }
      if (kind === 'ended') {
        const from = new Date(Date.parse(receipt.createdAt) - 86400000 * 2).toISOString();
        const to = new Date(Date.parse(receipt.createdAt) - 86400000).toISOString();
        db.prepare('UPDATE enrollments SET valid_from=?, valid_to=? WHERE student_id=?').run(
          from,
          to,
          studentId,
        );
        db.prepare('UPDATE students SET active=0 WHERE id=?').run(studentId);
      }
    });
    expect(() => workspace.previewRestore(corrupt)).toThrow(/座位版本/);
  },
);

test('later transfers preserve valid historical seat memberships through backup restore', () => {
  const { workspace, epoch, classId, ready, command } = fixture();
  const saved = workspace.seating.confirm(command(ready()));
  const original = workspace.seating.read({ epoch, versionId: saved.versionId }).payload;
  workspace.createClass({ epoch, name: '后来转入班' });
  const other = workspace.snapshot().classes.find((item) => item.id !== classId)!;
  const member = workspace.snapshot().students[0]!;
  workspace.saveStudent({
    epoch,
    id: member.id,
    expectedRevision: member.revision,
    classId: other.id,
    studentNumber: member.studentNumber,
    displayName: '后来改名',
  });
  const preview = workspace.previewRestore(workspace.exportBackup({ epoch }));
  const restored = workspace.commitRestore({ epoch, token: preview.token });
  const history = workspace.seating.read({ epoch: restored.epoch, versionId: saved.versionId });
  expect(history.payload).toEqual(original);
  expect(history.rosterChanged).toBe(true);
});

test('clock rollback cannot timestamp confirmation before a current member joined', () => {
  const { workspace, epoch, classId, ready, command } = fixture();
  vi.useFakeTimers();
  const initialTime = Date.now();
  vi.setSystemTime(initialTime + 3600000);
  workspace.saveStudent({ epoch, classId, studentNumber: 'NEW', displayName: '后来加入' });
  const joinedAt = workspace.snapshot().enrollments.at(-1)!.validFrom;
  vi.setSystemTime(initialTime);
  const saved = workspace.seating.confirm(command(ready()));
  expect(Date.parse(saved.createdAt)).toBeGreaterThanOrEqual(Date.parse(joinedAt));
  expect(() => workspace.exportBackup({ epoch })).not.toThrow();
});

test.each(['transfer', 'deactivate'] as const)(
  'clock rollback before %s preserves already confirmed seat membership',
  (operation) => {
    const { workspace, epoch, classId, ready, command } = fixture();
    vi.useFakeTimers();
    const initialTime = Date.now();
    vi.setSystemTime(initialTime + 3600000);
    const saved = workspace.seating.confirm(command(ready()));
    vi.setSystemTime(initialTime);
    const member = workspace.snapshot().students[0]!;
    if (operation === 'transfer') {
      workspace.createClass({ epoch, name: '回拨后转入班' });
      const other = workspace.snapshot().classes.find((item) => item.id !== classId)!;
      workspace.saveStudent({
        epoch,
        id: member.id,
        expectedRevision: member.revision,
        classId: other.id,
        studentNumber: member.studentNumber,
        displayName: member.displayName,
      });
    } else {
      workspace.setStudentActive({
        epoch,
        id: member.id,
        expectedRevision: member.revision,
        active: false,
      });
    }
    const prior = workspace
      .snapshot()
      .enrollments.find((item) => item.studentId === member.id && item.classId === classId)!;
    expect(Date.parse(prior.validTo!)).toBeGreaterThanOrEqual(Date.parse(saved.createdAt));
    const preview = workspace.previewRestore(workspace.exportBackup({ epoch }));
    expect(preview.seatingVersionCount).toBe(1);
    const restored = workspace.commitRestore({ epoch, token: preview.token });
    expect(
      workspace.seating.read({ epoch: restored.epoch, versionId: saved.versionId }).rosterChanged,
    ).toBe(true);
  },
);
