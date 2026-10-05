import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { attendanceRecord, profileRecord } from '../shared/pupils';
import { DomainError } from './errors';

export const pupilHash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
export const PUPIL_RECORD_BYTES = 512 * 1024;
export const pupilSchemaStatements = [
  `CREATE TABLE student_profiles (id TEXT PRIMARY KEY REFERENCES students(id), revision INTEGER NOT NULL CHECK(revision > 0), payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${PUPIL_RECORD_BYTES}))`,
  `CREATE TABLE student_profile_revisions (id TEXT NOT NULL REFERENCES student_profiles(id), revision INTEGER NOT NULL CHECK(revision > 0), request_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${PUPIL_RECORD_BYTES}), PRIMARY KEY(id, revision))`,
  `CREATE TABLE attendance_records (id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classrooms(id), revision INTEGER NOT NULL CHECK(revision > 0), payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${PUPIL_RECORD_BYTES}))`,
  `CREATE TABLE attendance_revisions (id TEXT NOT NULL REFERENCES attendance_records(id), revision INTEGER NOT NULL CHECK(revision > 0), request_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${PUPIL_RECORD_BYTES}), PRIMARY KEY(id, revision))`,
  `CREATE INDEX attendance_class ON attendance_records(class_id)`,
];

/** Backup/startup validation includes immutable revision chains, not just table structure. */
export function validatePupilRecords(db: DatabaseSync) {
  const requireValid = (valid: unknown) => {
    if (!valid) throw new DomainError('BACKUP_INVALID', '点名或学生档案记录损坏，请保留原数据。');
  };
  for (const [table, revisions, schema] of [
    ['student_profiles', 'student_profile_revisions', profileRecord],
    ['attendance_records', 'attendance_revisions', attendanceRecord],
  ] as const) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      const record = schema.parse(JSON.parse(String(row.payload)));
      requireValid(record.id === row.id && record.revision === row.revision);
      const history = db
        .prepare(`SELECT * FROM ${revisions} WHERE id=? ORDER BY revision`)
        .all(record.id);
      requireValid(
        history.length === record.revision && String(history.at(-1)?.payload) === row.payload,
      );
      for (const [index, item] of history.entries()) {
        const version = schema.parse(JSON.parse(String(item.payload)));
        z.uuid().parse(item.request_id);
        z.string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(item.input_hash);
        z.string().trim().min(1).max(300).parse(item.reason);
        z.iso.datetime().parse(item.created_at);
        requireValid(
          version.id === record.id &&
            version.revision === index + 1 &&
            version.updatedAt === item.created_at,
        );
        if ('studentId' in version) requireValid(version.studentId === record.id);
        else {
          requireValid(
            version.classId === row.class_id &&
              new Set(version.rows.map((v) => v.studentId)).size === version.rows.length,
          );
          requireValid(version.classId === (record as z.infer<typeof attendanceRecord>).classId);
          const first = attendanceRecord.parse(JSON.parse(String(history[0]!.payload)));
          requireValid(
            version.rosterHash === first.rosterHash && version.classroomId === first.classroomId,
          );
          requireValid(
            JSON.stringify(
              version.rows.map(({ studentId, studentNumber, displayName }) => ({
                studentId,
                studentNumber,
                displayName,
              })),
            ) ===
              JSON.stringify(
                first.rows.map(({ studentId, studentNumber, displayName }) => ({
                  studentId,
                  studentNumber,
                  displayName,
                })),
              ),
          );
          requireValid(version.createdAt === first.createdAt);
          for (const member of version.rows)
            requireValid(
              db
                .prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=? LIMIT 1')
                .get(member.studentId, version.classId),
            );
          if (version.classroomId)
            requireValid(
              db
                .prepare('SELECT id FROM teaching_sessions WHERE id=? AND class_id=?')
                .get(version.classroomId, version.classId),
            );
        }
      }
    }
  }
}
