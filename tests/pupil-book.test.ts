import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { openDatabase, validateDatabase, SCHEMA_VERSION } from '../src/core/database';
import { pupilSchemaStatements } from '../src/core/pupil-records';
import { ConversationPrivacy } from '../src/core/conversation-privacy';
import { ApplicationTools } from '../src/main/application-tools';

const roots: string[] = [],
  spaces: Workspace[] = [];
afterEach(() => {
  for (const w of spaces.splice(0)) w.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-pupils-'));
  roots.push(root);
  const w = new Workspace(root);
  spaces.push(w);
  const snapshot = w.seedDemo({ epoch: w.snapshot().epoch }),
    classroom = snapshot.classes[0]!,
    student = snapshot.students.find((s) => s.classId === classroom.id)!;
  const profile = {
    epoch: snapshot.epoch,
    studentId: student.id,
    expectedRevision: 0,
    expectedStudentRevision: student.revision,
    requestId: randomUUID(),
    content: {
      guardianName: '虚构监护人',
      guardianPhone: '13800000000',
      birthDate: '2010-01-01',
      address: '虚构家庭地址',
      interests: '绘画',
      teacherNotes: '父母离异；数学90分',
    },
    reason: '初始化虚构资料',
  };
  const roster = w.pupils.roster({ epoch: snapshot.epoch, classId: classroom.id });
  const attendance = {
    epoch: snapshot.epoch,
    classId: classroom.id,
    id: null,
    expectedRevision: 0,
    expectedRosterHash: roster.rosterHash,
    requestId: randomUUID(),
    date: '2026-10-04',
    title: '语文课',
    marks: roster.students.map((s, index) => ({
      studentId: s.studentId,
      status:
        index === 0
          ? 'late'
          : index === 1
            ? 'excused'
            : index === 2
              ? 'absent'
              : index === 3
                ? 'unmarked'
                : 'present',
      note: '',
    })),
    reason: '首次点名',
  };
  return { w, root, snapshot, classroom, student, profile, roster, attendance };
}
test('profile saves are idempotent, CAS guarded and retain complete immutable revisions', () => {
  const f = fixture(),
    receipt = f.w.pupils.saveProfile(f.profile);
  expect(f.w.pupils.saveProfile(f.profile)).toMatchObject({ ...receipt, replayed: true });
  expect(() =>
    f.w.pupils.saveProfile({
      ...f.profile,
      content: { teacherNotes: '更改' },
      requestId: f.profile.requestId,
    }),
  ).toThrow(/请求/);
  expect(() => f.w.pupils.saveProfile({ ...f.profile, requestId: randomUUID() })).toThrow(/变化/);
  f.w.pupils.saveProfile({
    ...f.profile,
    expectedRevision: 1,
    requestId: randomUUID(),
    content: { ...f.profile.content, interests: '绘画、音乐' },
    reason: '补充兴趣',
  });
  const versions = f.w.pupils.profileHistory({ epoch: f.snapshot.epoch, studentId: f.student.id });
  expect(versions.map((v) => v.record.revision)).toEqual([2, 1]);
  expect(versions[1]?.record.content.interests).toBe('绘画');
  expect(() => f.w.pupils.readProfile({ epoch: randomUUID(), studentId: f.student.id })).toThrow(
    /切换/,
  );
});
test('attendance records distinguish unmarked from absent and retain the original roster through transfers', () => {
  const f = fixture(),
    saved = f.w.pupils.saveAttendance(f.attendance);
  expect(f.w.pupils.saveAttendance(f.attendance)).toMatchObject({ id: saved.id, replayed: true });
  const first = f.w.pupils.readAttendance({ epoch: f.snapshot.epoch, id: saved.id });
  expect(first.rows.filter((r) => r.status === 'unmarked')).toHaveLength(1);
  f.w.saveStudent({
    epoch: f.snapshot.epoch,
    id: f.student.id,
    expectedRevision: f.student.revision,
    classId: f.snapshot.classes[1]!.id,
    studentNumber: f.student.studentNumber,
    displayName: '更名后的虚构学生',
  });
  f.w.pupils.saveAttendance({
    ...f.attendance,
    id: saved.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    marks: f.attendance.marks.map((m, i) => (i === 0 ? { ...m, status: 'present' } : m)),
    reason: '核实迟到记录',
  });
  const history = f.w.pupils.attendanceHistory({ epoch: f.snapshot.epoch, id: saved.id });
  expect(history[1]?.record).toEqual(first);
  expect(history[0]?.record.rows[0]?.displayName).toBe(first.rows[0]?.displayName);
  expect(() => f.w.pupils.saveAttendance({ ...f.attendance, requestId: randomUUID() })).toThrow(
    /变化/,
  );
  expect(() =>
    f.w.pupils.saveAttendance({
      ...f.attendance,
      id: saved.id,
      expectedRevision: 2,
      requestId: randomUUID(),
      marks: f.attendance.marks.slice(1),
    }),
  ).toThrow(/每位学生/);
});
test('new attendance rejects duplicate members, foreign classrooms and stale rosters without committing', () => {
  const f = fixture();
  expect(() =>
    f.w.pupils.saveAttendance({
      ...f.attendance,
      marks: [...f.attendance.marks, f.attendance.marks[0]],
    }),
  ).toThrow(/每位学生/);
  expect(() => f.w.pupils.saveAttendance({ ...f.attendance, classroomId: randomUUID() })).toThrow(
    /课堂/,
  );
  expect(() =>
    f.w.pupils.saveAttendance({ ...f.attendance, expectedRosterHash: 'a'.repeat(64) }),
  ).toThrow(/变化/);
  expect(f.w.pupils.listAttendance({ epoch: f.snapshot.epoch, classId: f.classroom.id })).toEqual(
    [],
  );
});
test('point-in-time backup restores pupil records and revision chains, old book handles are invalidated', () => {
  const f = fixture();
  f.w.pupils.saveProfile(f.profile);
  const roll = f.w.pupils.saveAttendance(f.attendance);
  const old = f.w.pupils;
  const backup = f.w.exportBackup({ epoch: f.snapshot.epoch }),
    preview = f.w.previewRestore(backup);
  expect(preview).toMatchObject({ attendanceCount: 1, studentProfileCount: 1 });
  const next = f.w.commitRestore({ epoch: f.snapshot.epoch, token: preview.token });
  expect(next.schemaVersion).toBe(SCHEMA_VERSION);
  expect(
    f.w.pupils.readProfile({ epoch: next.epoch, studentId: f.student.id }).content.guardianName,
  ).toBe('虚构监护人');
  expect(f.w.pupils.attendanceHistory({ epoch: next.epoch, id: roll.id })).toHaveLength(1);
  expect(() => old.readProfile({ epoch: f.snapshot.epoch, studentId: f.student.id })).toThrow(
    /切换/,
  );
});
test('v11 migration keeps the original file and roster, adding empty profile and attendance tables', () => {
  const f = fixture(),
    pointer = JSON.parse(readFileSync(join(f.root, 'current.json'), 'utf8')),
    path = join(f.root, 'workspaces', pointer.workspaceId, 'data.sqlite');
  f.w.close();
  spaces.splice(spaces.indexOf(f.w), 1);
  const db = openDatabase(path, 'open');
  for (const sql of [...pupilSchemaStatements].reverse()) {
    const name = sql.match(/CREATE (?:TABLE|INDEX) (\w+)/)![1]!;
    db.exec(`DROP ${sql.includes('CREATE INDEX') ? 'INDEX' : 'TABLE'} ${name}`);
  }
  db.exec('PRAGMA user_version=11');
  validateDatabase(db);
  db.close();
  const next = new Workspace(f.root);
  spaces.push(next);
  expect(next.snapshot().students).toEqual(f.snapshot.students);
  expect(
    next.pupils.readProfile({ epoch: next.snapshot().epoch, studentId: f.student.id }).revision,
  ).toBe(0);
  expect(readdirSync(join(path, '..')).some((n) => n.includes(`before-v${SCHEMA_VERSION}`))).toBe(
    true,
  );
});
test('conversation can read anonymized pupil data and propose changes while preserving private local fields', () => {
  const f = fixture();
  f.w.pupils.saveProfile(f.profile);
  const privacy = new ConversationPrivacy();
  privacy.register(f.snapshot);
  const tools = new ApplicationTools(privacy);
  const current = f.w.pupils.readProfile({ epoch: f.snapshot.epoch, studentId: f.student.id });
  tools.remember('readStudentProfile', current);
  const wire = JSON.stringify(privacy.toolResult(current));
  for (const text of ['13800000000', '2010-01-01', '虚构监护人', '虚构家庭地址', '离异'])
    expect(wire).not.toContain(text);
  expect(wire).toContain('数学90分');
  const input = tools.prepare(
    {
      kind: 'tool',
      tool: 'saveStudentProfile',
      args: {
        studentId: privacy.reference(f.student.id),
        content: { interests: '篮球' },
        reason: '补充兴趣',
      },
    },
    f.snapshot,
  );
  expect(input.input.content).toMatchObject({ interests: '篮球', guardianPhone: '13800000000' });
  expect(input.input.expectedRevision).toBe(1);
  expect(tools.isAutomatic('saveStudentProfile')).toBe(false);
  tools.remember('readAttendanceRoster', f.roster);
  const roll = tools.prepare(
    {
      kind: 'tool',
      tool: 'saveAttendance',
      args: {
        classId: privacy.reference(f.classroom.id),
        date: '2026-10-04',
        title: '语文课',
        marks: f.attendance.marks.map((m) => ({ ...m, studentId: privacy.reference(m.studentId) })),
        reason: '课堂点名',
      },
    },
    f.snapshot,
  );
  expect(roll.input.expectedRosterHash).toBe(f.roster.rosterHash);
  expect(tools.isAutomatic('saveAttendance')).toBe(false);
});
