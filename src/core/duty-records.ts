import type { DatabaseSync } from 'node:sqlite';
import { dutyPayloadSchema, dutyVersionSchema, type DutyPayload } from '../shared/duty-records';
import { dutyDateSchema, type DutyDraft } from '../shared/duty';
import { requireCompleteDuty, requireDutyRevision, requireNewDuty } from './duty';
import { DomainError } from './errors';
import { MAX_DUTY_PAYLOAD_BYTES, MAX_DUTY_PLANS, MAX_DUTY_VERSIONS } from './storage-limits';

export const DUTY_COLUMNS = `id, plan_id AS planId, class_id AS classId, revision,
  request_id AS requestId, request_hash AS requestHash, created_at AS createdAt,
  protected_date AS protectedDate, reason`;

/** Pure China-local calendar conversion, independent of machine timezone; invalid instants reject. */
export function dutyCalendarDate(instant: number): string {
  const shifted = new Date(instant + 8 * 60 * 60 * 1000);
  return dutyDateSchema.parse(shifted.toISOString().slice(0, 10));
}

/** Read the durable date floor. Missing/corrupt singleton state is a storage error, never reset. */
export function readDutyDate(db: DatabaseSync): string {
  return dutyDateSchema.parse(
    db.prepare('SELECT protected_date FROM duty_clock WHERE id=1').get()?.protected_date,
  );
}

/**
 * Raise (never lower) the China-local date floor with one SQLite statement. This metadata write
 * is deliberate even when the following user operation fails; observations must survive restart.
 * Restore supplies the previous workspace floor. No nested transaction or external I/O.
 */
export function advanceDutyDate(db: DatabaseSync, minimum?: string, instant = Date.now()): string {
  const date = [
    readDutyDate(db),
    dutyCalendarDate(instant),
    ...(minimum ? [dutyDateSchema.parse(minimum)] : []),
  ]
    .sort()
    .at(-1)!;
  db.prepare('UPDATE duty_clock SET protected_date=? WHERE id=1').run(date);
  return date;
}

/** Validate/detach a complete frozen payload; ZodError/VALIDATION reject malformed or incomplete data. */
export function validateDutyPayload(input: unknown): DutyPayload {
  const payload = dutyPayloadSchema.parse(input);
  requireCompleteDuty(payload.arrangement);
  return payload;
}

/** Pure UTF-8 serialization; enforce the same quota used by SQLite and backup validation. */
export function serializeDuty(payload: DutyPayload): string {
  const serialized = JSON.stringify(validateDutyPayload(payload));
  if (Buffer.byteLength(serialized) > MAX_DUTY_PAYLOAD_BYTES)
    throw new DomainError('STORAGE_LIMIT', '值日方案超过 16 MiB 上限，未保存。');
  return serialized;
}

/**
 * Reject overlapping posts for the same student/date across the supplied current plans.
 * Caller supplies only each plan's latest version; historical revisions are not simultaneous plans.
 * No mutation/I/O; interval endpoints are half-open. Failure contains no names or raw documents.
 */
export function requireCompatibleDutyPlans(plans: Iterable<DutyDraft>): void {
  const occupied = new Map<string, { start: number; end: number }[]>();
  for (const plan of plans) {
    const posts = new Map(plan.posts.map((post) => [post.id, post]));
    for (const day of plan.days) {
      for (const assignment of day.posts) {
        const post = posts.get(assignment.postId);
        if (!post) throw new DomainError('VALIDATION', '值日岗位引用无效。');
        for (const slot of assignment.slots) {
          if (!slot) continue;
          const key = `${day.date}:${slot.studentId}`;
          const intervals = occupied.get(key) ?? [];
          if (
            intervals.some((entry) => entry.start < post.endMinute && post.startMinute < entry.end)
          )
            throw new DomainError(
              'DUTY_CONFLICT',
              `${day.date} 存在学生跨计划同时占岗，请调整时间或人员。`,
            );
          intervals.push({ start: post.startMinute, end: post.endMinute });
          occupied.set(key, intervals);
        }
      }
    }
  }
}

/**
 * Read-only full validation before writable open/restore. Enforce version chains, period identity,
 * date floors, historical enrollment, revision invariants and cross-plan conflicts; failure becomes
 * BACKUP_INVALID without exposing stored content. No repair, migration, clock read or mutation.
 */
export function validateDutyRecords(db: DatabaseSync): void {
  try {
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM duty_clock').get()?.n) !== 1)
      throw new Error('Invalid duty clock');
    const floor = readDutyDate(db);
    const rows = db
      .prepare(
        `SELECT ${DUTY_COLUMNS}, length(CAST(payload AS BLOB)) AS bytes
      FROM duty_versions ORDER BY plan_id, revision`,
      )
      .all();
    if (rows.length > MAX_DUTY_VERSIONS) throw new Error('Too many duty versions');
    const classes = new Map(
      db
        .prepare('SELECT id, created_at FROM classrooms')
        .all()
        .map((row) => [String(row.id), String(row.created_at)]),
    );
    const memberships = new Map<string, { from: number; to: number }[]>();
    for (const row of db
      .prepare('SELECT student_id, class_id, valid_from, valid_to FROM enrollments')
      .all()) {
      const key = `${row.student_id}:${row.class_id}`;
      const list = memberships.get(key) ?? [];
      list.push({
        from: Date.parse(String(row.valid_from)),
        to: row.valid_to === null ? Infinity : Date.parse(String(row.valid_to)),
      });
      memberships.set(key, list);
    }
    const latest = new Map<
      string,
      { record: ReturnType<typeof dutyVersionSchema.parse>; payload: DutyPayload }
    >();
    for (const { bytes, ...raw } of rows) {
      const record = dutyVersionSchema.parse(raw);
      const prior = latest.get(record.planId);
      const classCreated = classes.get(record.classId);
      if (
        !classCreated ||
        record.revision !== (prior?.record.revision ?? 0) + 1 ||
        Date.parse(record.createdAt) < Date.parse(prior?.record.createdAt ?? classCreated) ||
        record.protectedDate > floor ||
        record.protectedDate < (prior?.record.protectedDate ?? '1900-01-01') ||
        record.protectedDate < dutyCalendarDate(Date.parse(record.createdAt)) ||
        Number(bytes) > MAX_DUTY_PAYLOAD_BYTES
      )
        throw new Error('Invalid duty version metadata');
      const stored = db.prepare('SELECT payload FROM duty_versions WHERE id=?').get(record.id);
      const payload = validateDutyPayload(JSON.parse(String(stored?.payload)));
      if (payload.classId !== record.classId) throw new Error('Wrong class');
      if (prior) {
        if (
          prior.record.classId !== record.classId ||
          prior.payload.title !== payload.title ||
          prior.payload.className !== payload.className
        )
          throw new Error('Changed period identity');
        requireDutyRevision(prior.payload.arrangement, payload.arrangement, record.protectedDate);
      } else {
        requireNewDuty(payload.arrangement, record.protectedDate);
      }
      const previousIds = new Set(
        prior?.payload.arrangement.members.map((member) => member.studentId),
      );
      const needsCurrentMembers = payload.arrangement.days.some(
        (day) => day.date >= record.protectedDate && !day.completed,
      );
      const required = new Set([
        ...payload.arrangement.members
          .filter((member) => !previousIds.has(member.studentId))
          .map((member) => member.studentId),
        ...(needsCurrentMembers ? payload.arrangement.participantIds : []),
      ]);
      for (const studentId of required) {
        if (
          !(memberships.get(`${studentId}:${record.classId}`) ?? []).some(
            (entry) =>
              entry.from <= Date.parse(record.createdAt) &&
              Date.parse(record.createdAt) <= entry.to,
          )
        )
          throw new Error('Invalid historical enrollment');
      }
      latest.set(record.planId, { record, payload });
    }
    if (latest.size > MAX_DUTY_PLANS) throw new Error('Too many duty periods');
    requireCompatibleDutyPlans([...latest.values()].map((item) => item.payload.arrangement));
  } catch {
    throw new DomainError(
      'BACKUP_INVALID',
      '值日历史、日期保护或岗位安排校验失败，原数据未被替换。',
    );
  }
}
