import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  classroomRecordSchema,
  countdownRecordSchema,
  CLASSROOM_LIMITS,
  type ClassroomRecord,
} from '../shared/classroom';
import { readLessonVersion } from './lesson-records';
import { DomainError } from './errors';

export const CLASSROOM_COLUMNS = `id, version_id AS versionId, class_id AS classId, revision, request_id AS requestId, request_hash AS requestHash, created_at AS createdAt, updated_at AS updatedAt, status, elapsed_ms AS elapsedMs, interrupted, payload`;
export function readClassroomRecord(
  db: DatabaseSync,
  id: string,
  validateVersion = true,
): ClassroomRecord {
  const row = db.prepare(`SELECT ${CLASSROOM_COLUMNS} FROM teaching_sessions WHERE id=?`).get(id);
  if (!row) throw new DomainError('NOT_FOUND', '课堂进度不存在。');
  const value = classroomRecordSchema.parse({
    ...row,
    interrupted: row.interrupted === 1,
    payload: JSON.parse(String(row.payload)),
  });
  if (!validateVersion) return value;
  const version = readLessonVersion(db, value.versionId);
  const indices = value.payload.slideIds.map((id) =>
    version.payload.content.slides.findIndex((slide) => slide.id === id),
  );
  const expectedHash = createHash('sha256')
    .update(
      JSON.stringify({
        requestId: value.requestId,
        versionId: value.versionId,
        classId: value.classId,
        slideIds: value.payload.slideIds,
        acknowledgeScope: true,
      }),
    )
    .digest('hex');
  if (
    indices.some(
      (index, position) => index < 0 || (position > 0 && index <= indices[position - 1]!),
    ) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    Date.parse(value.createdAt) < Date.parse(version.record.createdAt) ||
    (value.status === 'running' && value.interrupted) ||
    value.requestHash !== expectedHash
  )
    throw new DomainError('BACKUP_INVALID', '课堂版本、范围或时间记录不一致。');
  return value;
}
export function readCountdownRecord(db: DatabaseSync) {
  const row = db.prepare('SELECT revision, payload FROM countdown_settings WHERE id=1').get();
  return row
    ? countdownRecordSchema.parse({
        revision: row.revision,
        setting: JSON.parse(String(row.payload)),
      })
    : null;
}
export function validateClassroomRecords(db: DatabaseSync) {
  try {
    if (
      Number(db.prepare('SELECT COUNT(*) AS count FROM teaching_sessions').get()?.count) >
      CLASSROOM_LIMITS.sessions
    )
      throw new Error('Session quota');
    for (const row of db
      .prepare('SELECT id, length(CAST(payload AS BLOB)) AS bytes FROM teaching_sessions')
      .all()) {
      if (Number(row.bytes) > CLASSROOM_LIMITS.payloadBytes) throw new Error('Session size');
      readClassroomRecord(db, String(row.id));
    }
    readCountdownRecord(db);
  } catch {
    throw new DomainError('BACKUP_INVALID', '课堂进度或倒计时设置无效，已拒绝打开。');
  }
}
