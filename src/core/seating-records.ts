import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  seatingPayloadSchema,
  seatingVersionSchema,
  type SeatingPayload,
} from '../shared/seating-records';
import { requireCompleteSeating } from './seating';
import { DomainError } from './errors';
import { MAX_SEATING_PAYLOAD_BYTES, MAX_SEATING_VERSIONS } from './storage-limits';

export const SEATING_COLUMNS = `id, class_id AS classId, revision, request_id AS requestId,
  request_hash AS requestHash, created_at AS createdAt, reason`;

/**
 * Return a detached snapshot with complete coverage, preserving historical labels.
 * Malformed fields raise ZodError; rule conflicts raise VALIDATION. No input mutation or I/O.
 */
export function validateSeatingPayload(input: unknown): SeatingPayload {
  const payload = seatingPayloadSchema.parse(input);
  requireCompleteSeating(payload.arrangement);
  return payload;
}

/** Validate and encode without mutation/I/O; oversized UTF-8 payloads raise STORAGE_LIMIT. */
export function serializeSeating(payload: SeatingPayload): string {
  const serialized = JSON.stringify(validateSeatingPayload(payload));
  if (Buffer.byteLength(serialized) > MAX_SEATING_PAYLOAD_BYTES)
    throw new DomainError('STORAGE_LIMIT', '座位版本超过 256 KiB 上限，未保存。');
  return serialized;
}

/**
 * Read-only validation of every version before writable open/restore; failures raise BACKUP_INVALID.
 * Changed live labels/enrollments do not rewrite history. No input or database changes occur.
 */
export function validateSeatingRecords(db: DatabaseSync): void {
  try {
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM seating_versions').get()?.count);
    if (count > MAX_SEATING_VERSIONS) throw new Error('Version count limit');
    if (count === 0) return;
    const classes = new Map(
      db
        .prepare('SELECT id, created_at AS createdAt FROM classrooms')
        .all()
        .map((row) => [String(row.id), String(row.createdAt)]),
    );
    const students = new Set(
      db
        .prepare('SELECT id FROM students')
        .all()
        .map((row) => String(row.id)),
    );
    const memberships = new Map<string, Array<{ from: number; to: number }>>();
    for (const row of db
      .prepare('SELECT student_id, class_id, valid_from, valid_to FROM enrollments')
      .all()) {
      const key = `${row.student_id}:${row.class_id}`;
      const periods = memberships.get(key) ?? [];
      periods.push({
        from: Date.parse(String(row.valid_from)),
        to: row.valid_to === null ? Infinity : Date.parse(String(row.valid_to)),
      });
      memberships.set(key, periods);
    }
    const previous = new Map<string, { revision: number; createdAt: string }>();
    const layouts = new Map<string, string>();
    const rows = db
      .prepare(
        `SELECT ${SEATING_COLUMNS},
      length(CAST(payload AS BLOB)) AS payloadBytes FROM seating_versions ORDER BY class_id, revision`,
      )
      .all();
    for (const { payloadBytes, ...raw } of rows) {
      const record = seatingVersionSchema.parse(raw);
      const prior = previous.get(record.classId);
      const classCreated = classes.get(record.classId);
      if (
        !classCreated ||
        record.revision !== (prior?.revision ?? 0) + 1 ||
        Date.parse(record.createdAt) < Date.parse(prior?.createdAt ?? classCreated) ||
        Number(payloadBytes) > MAX_SEATING_PAYLOAD_BYTES
      )
        throw new Error('Invalid version chain');
      const row = db.prepare('SELECT payload FROM seating_versions WHERE id=?').get(record.id);
      const payload = validateSeatingPayload(JSON.parse(String(row?.payload)));
      const confirmedAt = Date.parse(record.createdAt);
      if (
        payload.classId !== record.classId ||
        payload.arrangement.members.some(
          (member) =>
            !students.has(member.studentId) ||
            !(memberships.get(`${member.studentId}:${record.classId}`) ?? []).some(
              (period) => period.from <= confirmedAt && confirmedAt <= period.to,
            ),
        )
      )
        throw new Error('Invalid historical member or class');
      const layoutHash = createHash('sha256')
        .update(JSON.stringify(payload.arrangement.layout))
        .digest('hex');
      const identity = `${record.classId}:${layoutHash}`;
      const known = layouts.get(payload.layoutVersionId);
      if (known && known !== identity) throw new Error('Layout version changed');
      layouts.set(payload.layoutVersionId, identity);
      previous.set(record.classId, record);
    }
  } catch {
    throw new DomainError('BACKUP_INVALID', '座位版本或成员快照无效，已拒绝打开。');
  }
}
