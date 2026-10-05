import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../shared/contracts';
import {
  profileReadInput,
  profileSaveInput,
  profileRecord,
  profileContent,
  attendanceClassInput,
  attendanceReadInput,
  attendanceSaveInput,
  attendanceRecord,
  type AttendanceRoster,
  type AttendanceRecord,
  type StudentProfile,
  type PupilRevision,
} from '../shared/pupils';
import { transaction } from './database';
import { DomainError } from './errors';
import { pupilHash, PUPIL_RECORD_BYTES } from './pupil-records';

export function attendanceRosterHash(snapshot: Snapshot, classId: string) {
  return pupilHash({
    classroom: snapshot.classes.find((c) => c.id === classId),
    students: snapshot.students
      .filter((s) => s.classId === classId && s.active)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, revision, studentNumber, displayName }) => ({
        id,
        revision,
        studentNumber,
        displayName,
      })),
  });
}
export class PupilBook {
  private alive = true;
  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshot: () => Snapshot,
  ) {}
  dispose() {
    this.alive = false;
  }
  private guard(epoch: string) {
    if (!this.alive || this.snapshot().epoch !== epoch)
      throw new DomainError('STALE_WORKSPACE', '数据已切换，请重新读取点名和学生档案。');
  }
  private student(id: string) {
    const student = this.snapshot().students.find((s) => s.id === id);
    if (!student) throw new DomainError('NOT_FOUND', '学生不存在。');
    return student;
  }
  readProfile(raw: unknown): StudentProfile {
    const input = profileReadInput.parse(raw);
    this.guard(input.epoch);
    this.student(input.studentId);
    const row = this.db
      .prepare('SELECT payload FROM student_profiles WHERE id=?')
      .get(input.studentId);
    return row
      ? profileRecord.parse(JSON.parse(String(row.payload)))
      : {
          id: input.studentId,
          studentId: input.studentId,
          revision: 0,
          content: profileContent.parse({}),
          updatedAt: null,
        };
  }
  private replay(
    table: 'student_profile_revisions' | 'attendance_revisions',
    requestId: string,
    inputHash: string,
  ) {
    const row = this.db
      .prepare(`SELECT id, revision, input_hash AS hash FROM ${table} WHERE request_id=?`)
      .get(requestId);
    if (!row) return;
    if (row.hash !== inputHash)
      throw new DomainError('CONFLICT', '此请求已用于不同内容，请先核对已保存记录。');
    return { id: String(row.id), revision: Number(row.revision), replayed: true };
  }
  private write(
    table: 'student_profiles' | 'attendance_records',
    history: 'student_profile_revisions' | 'attendance_revisions',
    record: StudentProfile | AttendanceRecord,
    requestId: string,
    inputHash: string,
    reason: string,
  ) {
    const payload = JSON.stringify(record);
    if (Buffer.byteLength(payload) > PUPIL_RECORD_BYTES)
      throw new DomainError('STORAGE_LIMIT', '此记录过大，请缩短备注。');
    return transaction(this.db, () => {
      if (Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${history}`).get()?.count) >= 20000)
        throw new DomainError(
          'STORAGE_LIMIT',
          '记录容量已达上限，请备份并联系维护者，原数据保留。',
        );
      if (table === 'student_profiles')
        this.db
          .prepare(
            'INSERT INTO student_profiles VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',
          )
          .run(record.id, record.revision, payload);
      else
        this.db
          .prepare(
            'INSERT INTO attendance_records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',
          )
          .run(record.id, (record as AttendanceRecord).classId, record.revision, payload);
      this.db
        .prepare(`INSERT INTO ${history} VALUES (?,?,?,?,?,?,?)`)
        .run(record.id, record.revision, requestId, inputHash, reason, record.updatedAt, payload);
      return { id: record.id, revision: record.revision, replayed: false };
    });
  }
  saveProfile(raw: unknown) {
    const input = profileSaveInput.parse(raw);
    this.guard(input.epoch);
    const hash = pupilHash(input),
      replay = this.replay('student_profile_revisions', input.requestId, hash);
    if (replay) return replay;
    const student = this.student(input.studentId),
      previous = this.readProfile({ epoch: input.epoch, studentId: input.studentId });
    if (
      student.revision !== input.expectedStudentRevision ||
      previous.revision !== input.expectedRevision
    )
      throw new DomainError('CONFLICT', '学生资料已变化，请重新读取后保存。');
    const record = profileRecord.parse({
      id: student.id,
      studentId: student.id,
      revision: previous.revision + 1,
      content: input.content,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(previous.updatedAt ?? '') || 0),
      ).toISOString(),
    });
    return this.write(
      'student_profiles',
      'student_profile_revisions',
      record,
      input.requestId,
      hash,
      input.reason,
    );
  }
  private history<T>(
    table: 'student_profile_revisions' | 'attendance_revisions',
    id: string,
    parse: (value: unknown) => T,
  ): PupilRevision<T>[] {
    return this.db
      .prepare(`SELECT * FROM ${table} WHERE id=? ORDER BY revision DESC`)
      .all(id)
      .map((row) => ({
        record: parse(JSON.parse(String(row.payload))),
        reason: String(row.reason),
        requestId: String(row.request_id),
        createdAt: String(row.created_at),
      }));
  }
  profileHistory(raw: unknown) {
    const input = profileReadInput.parse(raw);
    this.guard(input.epoch);
    this.student(input.studentId);
    return this.history('student_profile_revisions', input.studentId, (v) =>
      profileRecord.parse(v),
    );
  }
  roster(raw: unknown): AttendanceRoster {
    const input = attendanceClassInput.parse(raw);
    this.guard(input.epoch);
    const snapshot = this.snapshot(),
      classroom = snapshot.classes.find((c) => c.id === input.classId);
    if (!classroom) throw new DomainError('NOT_FOUND', '班级不存在。');
    const students = snapshot.students
      .filter((s) => s.active && s.classId === input.classId)
      .sort((a, b) => a.studentNumber.localeCompare(b.studentNumber));
    if (students.length > 500) throw new DomainError('STORAGE_LIMIT', '点名一次最多支持500人。');
    return {
      classId: classroom.id,
      className: classroom.name,
      rosterHash: attendanceRosterHash(snapshot, classroom.id),
      students: students.map(({ id, studentNumber, displayName }) => ({
        studentId: id,
        studentNumber,
        displayName,
      })),
    };
  }
  readAttendance(raw: unknown): AttendanceRecord {
    const input = attendanceReadInput.parse(raw);
    this.guard(input.epoch);
    const row = this.db.prepare('SELECT payload FROM attendance_records WHERE id=?').get(input.id);
    if (!row) throw new DomainError('NOT_FOUND', '点名记录不存在。');
    return attendanceRecord.parse(JSON.parse(String(row.payload)));
  }
  listAttendance(raw: unknown) {
    const input = attendanceClassInput.parse(raw);
    this.guard(input.epoch);
    return this.db
      .prepare('SELECT payload FROM attendance_records WHERE class_id=? ORDER BY rowid DESC')
      .all(input.classId)
      .map((row) => attendanceRecord.parse(JSON.parse(String(row.payload))));
  }
  attendanceHistory(raw: unknown) {
    const record = this.readAttendance(raw);
    return this.history('attendance_revisions', record.id, (v) => attendanceRecord.parse(v));
  }
  saveAttendance(raw: unknown) {
    const input = attendanceSaveInput.parse(raw);
    this.guard(input.epoch);
    const hash = pupilHash(input),
      replay = this.replay('attendance_revisions', input.requestId, hash);
    if (replay) return replay;
    const previous = input.id
      ? this.readAttendance({ epoch: input.epoch, id: input.id })
      : undefined;
    const roster = previous
      ? {
          classId: previous.classId,
          className: previous.className,
          rosterHash: previous.rosterHash,
          students: previous.rows,
        }
      : this.roster({ epoch: input.epoch, classId: input.classId });
    if (
      (previous?.revision ?? 0) !== input.expectedRevision ||
      roster.classId !== input.classId ||
      roster.rosterHash !== input.expectedRosterHash ||
      (previous && previous.classroomId !== input.classroomId)
    )
      throw new DomainError('CONFLICT', '点名记录或名册已变化，请重新读取，原记录保留。');
    if (
      input.classroomId &&
      !this.db
        .prepare('SELECT id FROM teaching_sessions WHERE id=? AND class_id=?')
        .get(input.classroomId, input.classId)
    )
      throw new DomainError('VALIDATION', '课堂不属于此班级。');
    const marks = new Map(input.marks.map((m) => [m.studentId, m]));
    if (
      marks.size !== input.marks.length ||
      marks.size !== roster.students.length ||
      roster.students.some((s) => !marks.has(s.studentId))
    )
      throw new DomainError(
        'VALIDATION',
        '必须为本次名册每位学生提供一次状态，未核对的学生请标为“未点名”。',
      );
    const now = new Date(
      Math.max(Date.now(), Date.parse(previous?.updatedAt ?? '') || 0),
    ).toISOString();
    const record = attendanceRecord.parse({
      id: previous?.id ?? randomUUID(),
      classId: input.classId,
      className: roster.className,
      revision: (previous?.revision ?? 0) + 1,
      date: input.date,
      title: input.title,
      classroomId: input.classroomId,
      rosterHash: roster.rosterHash,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      rows: roster.students.map((s) => ({
        displayName: s.displayName,
        studentNumber: s.studentNumber,
        ...marks.get(s.studentId)!,
      })),
    });
    return this.write(
      'attendance_records',
      'attendance_revisions',
      record,
      input.requestId,
      hash,
      input.reason,
    );
  }
}
