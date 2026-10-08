import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { openDatabase, validateDatabase, SCHEMA_VERSION } from '../src/core/database';
import { teachingSchemaStatements } from '../src/core/teaching-book';
import { orderSeating, unassignSeating } from '../src/core/seating';
const spaces: Workspace[] = [],
  roots: string[] = [];
afterEach(() => {
  spaces.splice(0).forEach((w) => w.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-teaching-'));
  roots.push(root);
  const workspace = new Workspace(root);
  spaces.push(workspace);
  let snapshot = workspace.createClass({ epoch: workspace.snapshot().epoch, name: '合成一班' });
  const classId = snapshot.classes[0]!.id;
  snapshot = workspace.createClass({ epoch: snapshot.epoch, name: '合成二班' });
  snapshot = workspace.saveStudent({
    epoch: snapshot.epoch,
    classId,
    studentNumber: 'S001',
    displayName: '合成学生甲',
  });
  snapshot = workspace.saveStudent({
    epoch: snapshot.epoch,
    classId: snapshot.classes[1]!.id,
    studentNumber: 'S002',
    displayName: '合成学生乙',
  });
  const command = {
    epoch: snapshot.epoch,
    classId,
    kind: 'talk',
    expectedRevision: 0,
    requestId: randomUUID(),
    content: {
      studentId: snapshot.students.find((s) => s.classId === classId)!.id,
      category: '学习跟进',
      date: '2026-10-08',
      content: '合成谈话内容',
      followUp: '下周复查',
    },
  };
  return { workspace, root, snapshot, command, classId };
}
test('teaching records share roster identity, enforce class isolation, revisions and idempotent writes', () => {
  const f = fixture(),
    book = f.workspace.teaching;
  const saved = book.save(f.command);
  expect(book.save(f.command)).toEqual(saved);
  expect(book.list({ epoch: f.snapshot.epoch, classId: f.classId })).toHaveLength(1);
  expect(book.list({ epoch: f.snapshot.epoch, classId: f.snapshot.classes[1]!.id })).toEqual([]);
  expect(() =>
    book.save({ ...f.command, content: { ...f.command.content, content: '其他内容' } }),
  ).toThrow(/请求编号/);
  expect(() =>
    book.save({
      ...f.command,
      requestId: randomUUID(),
      content: {
        ...f.command.content,
        studentId: f.snapshot.students.find((s) => s.classId !== f.classId)!.id,
      },
    }),
  ).toThrow(/当前班级/);
  const edited = book.save({
    ...f.command,
    id: saved.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    content: { ...f.command.content, content: '已跟进' },
  });
  expect(edited.revision).toBe(2);
  expect(() =>
    book.save({ ...f.command, id: saved.id, expectedRevision: 1, requestId: randomUUID() }),
  ).toThrow(/刷新/);
  const deleted = book.remove({
    epoch: f.snapshot.epoch,
    id: saved.id,
    expectedRevision: 2,
    requestId: randomUUID(),
    deleted: true,
  });
  expect(book.list({ epoch: f.snapshot.epoch })).toEqual([]);
  expect(
    book.remove({
      epoch: f.snapshot.epoch,
      id: saved.id,
      expectedRevision: deleted.revision,
      requestId: randomUUID(),
      deleted: false,
    }).revision,
  ).toBe(4);
});
test('all customer record kinds validate content and persist without seeding fake data', () => {
  const f = fixture();
  const s = f.command.content.studentId;
  const examples: Record<string, unknown> = {
    discipline: {
      studentId: s,
      category: '迟到',
      date: '2026-10-08',
      detail: '合成事件',
      handler: '合成老师',
    },
    homework: {
      subject: '数学',
      title: '合成作业',
      due: '2026-10-09',
      submissions: [{ studentId: s, done: false }],
    },
    leave: {
      studentId: s,
      category: '病假',
      reason: '合成事由',
      start: '2026-10-08',
      end: '2026-10-09',
      status: 'pending',
      note: '',
    },
    trace: {
      category: '课堂',
      title: '合成工作',
      date: '2026-10-08',
      content: '合成记录',
      by: '合成老师',
    },
    visit: { studentId: s, date: '2026-10-08', result: '合成家访', note: '' },
    parentMeeting: { title: '合成会议', date: '2026-10-08', attendees: 1, summary: '合成纪要' },
    notice: { title: '合成通知', date: '2026-10-08', content: '仅存草稿' },
    meeting: { theme: '合成班会', date: '2026-10-08', planned: true, record: '合成安排' },
    activity: { name: '合成活动', date: '2026-10-08', description: '合成活动记录', photoIds: [] },
    award: { studentId: s, name: '合成荣誉', category: '学习', date: '2026-10-08' },
    todo: { text: '合成待办', dueAt: '2026-10-08T10:00:00Z', priority: 'high', done: false },
    reminder: { text: '合成提醒', dueAt: '2026-10-08T10:00:00Z', priority: 'low', done: false },
    notes: { title: '合成备忘', content: '合成内容' },
    studentExtra: { studentId: s, idCard: '', height: 165, group: 1, note: '' },
  };
  for (const [kind, content] of Object.entries(examples))
    f.workspace.teaching.save({ ...f.command, kind, content, requestId: randomUUID() });
  expect(f.workspace.teaching.list({ epoch: f.snapshot.epoch })).toHaveLength(14);
  expect(() =>
    f.workspace.teaching.save({
      ...f.command,
      kind: 'notice',
      requestId: randomUUID(),
      content: { ...(examples.notice as object), sent: true },
    }),
  ).toThrow();
  expect(() =>
    f.workspace.teaching.save({
      ...f.command,
      kind: 'homework',
      requestId: randomUUID(),
      content: {
        subject: '数学',
        title: '作业',
        due: '2026-10-09',
        submissions: [
          { studentId: s, done: false },
          { studentId: s, done: true },
        ],
      },
    }),
  ).toThrow(/重复/);
  expect(() =>
    f.workspace.teaching.save({
      ...f.command,
      kind: 'leave',
      requestId: randomUUID(),
      content: { ...(examples.leave as object), end: '2026-10-07' },
    }),
  ).toThrow();
});
test('reminder receipts prevent duplicate notifications and survive backup restoration with preferences', () => {
  const f = fixture(),
    dueAt = new Date().toISOString();
  const reminder = f.workspace.teaching.save({
    ...f.command,
    kind: 'reminder',
    content: { text: '合成提醒', dueAt, priority: 'medium', done: false },
  });
  expect(
    f.workspace.teaching.due({ epoch: f.snapshot.epoch, now: dueAt }).map((r) => r.id),
  ).toEqual([reminder.id]);
  f.workspace.teaching.acknowledge({ epoch: f.snapshot.epoch, id: reminder.id, dueAt });
  f.workspace.teaching.saveSettings({ epoch: f.snapshot.epoch, notifications: true, sound: false });
  expect(f.workspace.teaching.due({ epoch: f.snapshot.epoch, now: dueAt })).toEqual([]);
  const backup = f.workspace.exportBackup({ epoch: f.snapshot.epoch }),
    preview = f.workspace.previewRestore(backup);
  const next = f.workspace.commitRestore({ epoch: f.snapshot.epoch, token: preview.token });
  expect(f.workspace.teaching.list({ epoch: next.epoch })[0]).toEqual(reminder);
  expect(f.workspace.teaching.settings({ epoch: next.epoch })).toEqual({
    notifications: true,
    sound: false,
  });
  expect(f.workspace.teaching.due({ epoch: next.epoch, now: dueAt })).toEqual([]);
  expect(() => f.workspace.teaching.list({ epoch: f.snapshot.epoch })).toThrow(/刷新/);
});
test('v12 migration preserves original roster and validates record payload against SQLite metadata', () => {
  const f = fixture(),
    pointer = JSON.parse(readFileSync(join(f.root, 'current.json'), 'utf8')),
    path = join(f.root, 'workspaces', pointer.workspaceId, 'data.sqlite');
  f.workspace.close();
  spaces.splice(spaces.indexOf(f.workspace), 1);
  const db = openDatabase(path, 'open');
  for (const sql of [...teachingSchemaStatements].reverse()) {
    const name = sql.match(/CREATE (?:TABLE|INDEX) (\w+)/)![1]!;
    db.exec(`DROP ${sql.includes('CREATE INDEX') ? 'INDEX' : 'TABLE'} ${name}`);
  }
  db.exec('PRAGMA user_version=12');
  validateDatabase(db);
  db.close();
  const next = new Workspace(f.root);
  spaces.push(next);
  expect(next.snapshot().students).toEqual(f.snapshot.students);
  expect(next.snapshot().schemaVersion).toBe(SCHEMA_VERSION);
  expect(readdirSync(join(path, '..')).some((n) => n.includes('before-v13'))).toBe(true);
  const record = next.teaching.save({ ...f.command, epoch: next.snapshot().epoch });
  next.close();
  spaces.splice(spaces.indexOf(next), 1);
  const altered = openDatabase(path, 'open');
  altered.prepare('UPDATE teaching_records SET revision=5 WHERE id=?').run(record.id);
  expect(() => validateDatabase(altered)).toThrow(/不一致/);
  altered.close();
});
test('ordered seating preserves locked seats and clearing cannot remove a lock or unknown student', () => {
  const ids = Array.from({ length: 3 }, () => randomUUID());
  const draft = {
    layout: { rows: 2, columns: 2, unavailable: [] },
    members: ids.map((studentId, i) => ({
      studentId,
      studentNumber: `S${i}`,
      displayName: `合成${i}`,
    })),
    assignments: ids.map((studentId, i) => ({
      studentId,
      row: Math.floor(i / 2) + 1,
      column: (i % 2) + 1,
    })),
    lockedStudentIds: [ids[0]!],
  };
  const ordered = orderSeating(draft, [ids[2]!, ids[1]!, ids[0]!]);
  expect(ordered.assignments.find((a) => a.studentId === ids[0])).toMatchObject({
    row: 1,
    column: 1,
  });
  expect(ordered.assignments.find((a) => a.studentId === ids[2])).toMatchObject({
    row: 1,
    column: 2,
  });
  expect(() => unassignSeating(ordered, ids[0]!)).toThrow(/解除/);
  expect(unassignSeating(ordered, ids[1]!).assignments).toHaveLength(2);
  expect(() => orderSeating(draft, [ids[0]!, ids[0]!, ids[2]!])).toThrow(/重复/);
});
