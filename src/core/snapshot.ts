import type { DatabaseSync } from 'node:sqlite';
import {
  assetSchema,
  classroomSchema,
  enrollmentSchema,
  studentSchema,
  type Snapshot,
} from '../shared/contracts';
import { DomainError } from './errors';
import {
  MAX_ASSETS,
  MAX_ASSET_BYTES,
  MAX_ASSETS_BYTES,
  LEGACY_MAX_ASSETS,
  LEGACY_MAX_ASSET_BYTES,
  LEGACY_MAX_ASSETS_BYTES,
} from './storage-limits';

export function readSnapshot(
  db: DatabaseSync,
  epoch: string,
  dataDirectory: string,
  copies = 0,
): Snapshot {
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  const current = schemaVersion >= 6;
  for (const [table, limit] of [
    ['classrooms', 100],
    ['students', 10000],
    ['enrollments', 50000],
    ['assets', current ? MAX_ASSETS : LEGACY_MAX_ASSETS],
  ] as const) {
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
    if (count > limit) throw new DomainError('BACKUP_INVALID', '数据量超出 M0 支持范围。');
  }
  const classes = db
    .prepare('SELECT id, name, revision, created_at AS createdAt FROM classrooms ORDER BY rowid')
    .all()
    .map((row) => classroomSchema.parse(row));
  const enrollments = db
    .prepare(
      'SELECT id, student_id AS studentId, class_id AS classId, valid_from AS validFrom, valid_to AS validTo FROM enrollments ORDER BY rowid',
    )
    .all()
    .map((row) => enrollmentSchema.parse(row));
  const students = db
    .prepare(
      `SELECT s.id, s.student_number AS studentNumber,
    s.display_name AS displayName, s.active, s.revision, s.created_at AS createdAt,
    e.class_id AS classId, c.name AS className FROM students s
    LEFT JOIN enrollments e ON e.rowid=(SELECT MAX(rowid) FROM enrollments WHERE student_id=s.id)
    LEFT JOIN classrooms c ON c.id=e.class_id ORDER BY s.student_number COLLATE NOCASE`,
    )
    .all()
    .map((row) => studentSchema.parse({ ...row, active: row.active === 1 }));
  const histories = new Map<string, typeof enrollments>();
  for (const entry of enrollments) {
    const history = histories.get(entry.studentId) ?? [];
    history.push(entry);
    histories.set(entry.studentId, history);
  }
  for (const student of students) {
    const history = histories.get(student.id) ?? [];
    const active = history.filter((entry) => entry.validTo === null);
    if (
      !/^[A-Z0-9_-]{1,32}$/.test(student.studentNumber) ||
      active.length !== (student.active ? 1 : 0) ||
      (student.active && active[0]?.id !== history.at(-1)?.id) ||
      history.some((entry) => entry.validTo !== null && entry.validTo < entry.validFrom)
    ) {
      throw new DomainError('BACKUP_INVALID', '名册与班级归属记录不一致。');
    }
  }
  const assets = db
    .prepare('SELECT id, name, bytes, sha256 FROM assets ORDER BY id')
    .all()
    .map((row) => assetSchema.parse(row));
  if (
    assets.some((asset) => asset.bytes > (current ? MAX_ASSET_BYTES : LEGACY_MAX_ASSET_BYTES)) ||
    assets.reduce((sum, asset) => sum + asset.bytes, 0) >
      (current ? MAX_ASSETS_BYTES : LEGACY_MAX_ASSETS_BYTES)
  )
    throw new DomainError('BACKUP_INVALID', '附件大小或总量超过对应版本的上限。');
  return {
    epoch,
    classes,
    students,
    enrollments,
    assets,
    schemaVersion,
    dataDirectory,
    recoveryCopies: copies,
  };
}
