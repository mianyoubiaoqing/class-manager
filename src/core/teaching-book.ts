import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Snapshot } from '../shared/contracts';
import { epochInput } from '../shared/contracts';
import {
  teachingContentSchemas,
  teachingKindSchema,
  teachingListInput,
  teachingSaveInput,
  teachingDeleteInput,
  teachingSettingsInput,
  type TeachingRecord,
  type TeachingSettings,
} from '../shared/teaching-workbench';
import { DomainError } from './errors';

export const teachingSchemaStatements = [
  `CREATE TABLE teaching_records (id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classrooms(id), kind TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=131072))`,
  `CREATE INDEX teaching_records_class ON teaching_records(class_id,kind)`,
  `CREATE TABLE teaching_record_revisions (request_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES teaching_records(id), revision INTEGER NOT NULL, input_hash TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=131072), UNIQUE(record_id,revision))`,
  `CREATE TABLE teaching_preferences (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)`,
  `CREATE TABLE teaching_reminder_receipts (record_id TEXT PRIMARY KEY REFERENCES teaching_records(id), due_at TEXT NOT NULL, delivered_at TEXT NOT NULL)`,
];
const recordSchema = z
  .object({
    id: z.uuid(),
    classId: z.uuid(),
    kind: teachingKindSchema,
    revision: z.number().int().positive(),
    content: z.unknown(),
    deleted: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export function parseTeachingRecord(raw: unknown): TeachingRecord {
  const value = recordSchema.parse(raw);
  return { ...value, content: teachingContentSchemas[value.kind].parse(value.content) };
}
export function validateTeachingRecords(db: DatabaseSync): void {
  const invalid = () => {
    throw new DomainError('BACKUP_INVALID', '教学记录与版本历史不一致，已拒绝打开。');
  };
  const records = new Map<string, TeachingRecord>();
  const validateReferences = (record: TeachingRecord) => {
    const content = record.content;
    const studentIds =
      'studentId' in content
        ? [content.studentId]
        : 'submissions' in content
          ? content.submissions.map((s) => s.studentId)
          : [];
    if (
      new Set(studentIds).size !== studentIds.length ||
      studentIds.some(
        (id) =>
          !db
            .prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?')
            .get(id, record.classId),
      )
    )
      invalid();
    if (
      'photoIds' in content &&
      (new Set(content.photoIds).size !== content.photoIds.length ||
        content.photoIds.some((id) => !db.prepare('SELECT id FROM assets WHERE id=?').get(id)))
    )
      invalid();
    if (
      'examId' in content &&
      !db
        .prepare('SELECT id FROM exams WHERE id=? AND class_id=?')
        .get(content.examId, record.classId)
    )
      invalid();
  };
  for (const row of db.prepare('SELECT * FROM teaching_records').all()) {
    const record = parseTeachingRecord(JSON.parse(String(row.payload)));
    if (
      record.id !== row.id ||
      record.classId !== row.class_id ||
      record.kind !== row.kind ||
      record.revision !== row.revision ||
      Number(record.deleted) !== row.deleted ||
      record.createdAt !== row.created_at ||
      record.updatedAt !== row.updated_at ||
      record.createdAt > record.updatedAt
    )
      invalid();
    records.set(record.id, record);
    validateReferences(record);
  }
  const history = new Map<string, TeachingRecord[]>();
  for (const row of db
    .prepare('SELECT * FROM teaching_record_revisions ORDER BY record_id,revision')
    .all()) {
    const record = parseTeachingRecord(JSON.parse(String(row.payload)));
    const current = records.get(record.id);
    z.uuid().parse(row.request_id);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(row.input_hash);
    if (
      !current ||
      row.record_id !== record.id ||
      row.revision !== record.revision ||
      record.kind !== current.kind ||
      record.classId !== current.classId ||
      record.createdAt !== current.createdAt
    )
      invalid();
    const versions = history.get(record.id) ?? [];
    if (record.revision !== versions.length + 1 || record.createdAt > record.updatedAt) invalid();
    validateReferences(record);
    versions.push(record);
    history.set(record.id, versions);
  }
  for (const record of records.values())
    if (JSON.stringify(history.get(record.id)?.at(-1)) !== JSON.stringify(record)) invalid();
  for (const row of db.prepare('SELECT * FROM teaching_reminder_receipts').all()) {
    z.iso.datetime().parse(row.due_at);
    z.iso.datetime().parse(row.delivered_at);
    const record = records.get(String(row.record_id));
    if (!record || !['todo', 'reminder'].includes(record.kind)) invalid();
  }
  const settings = db.prepare('SELECT payload FROM teaching_preferences').get();
  if (settings)
    z.object({ notifications: z.boolean(), sound: z.boolean() })
      .strict()
      .parse(JSON.parse(String(settings.payload)));
}
export class TeachingBook {
  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshot: () => Snapshot,
  ) {}
  private guard(epoch: string) {
    const snapshot = this.snapshot();
    if (snapshot.epoch !== epoch)
      throw new DomainError('STALE_WORKSPACE', '数据已恢复或切换，请刷新后重试。');
    return snapshot;
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  list(raw: unknown): TeachingRecord[] {
    const input = teachingListInput.parse(raw);
    this.guard(input.epoch);
    return this.db
      .prepare(
        'SELECT payload FROM teaching_records WHERE (? IS NULL OR class_id=?) AND (? IS NULL OR kind=?) AND (?=1 OR deleted=0) ORDER BY updated_at DESC,id',
      )
      .all(
        input.classId ?? null,
        input.classId ?? null,
        input.kind ?? null,
        input.kind ?? null,
        Number(input.includeDeleted),
      )
      .map((row) => parseTeachingRecord(JSON.parse(String(row.payload))));
  }
  private replay(input: { requestId: string }, hash: string): TeachingRecord | null {
    const row = this.db
      .prepare('SELECT input_hash,payload FROM teaching_record_revisions WHERE request_id=?')
      .get(input.requestId);
    if (!row) return null;
    if (row.input_hash !== hash)
      throw new DomainError('IDEMPOTENCY_CONFLICT', '请求编号已用于其他操作。');
    return parseTeachingRecord(JSON.parse(String(row.payload)));
  }
  private write(record: TeachingRecord, requestId: string, hash: string) {
    if (
      Number(this.db.prepare('SELECT COUNT(*) AS n FROM teaching_record_revisions').get()?.n) >=
      20000
    )
      throw new DomainError('STORAGE_LIMIT', '教学记录历史已达容量上限，请先备份并联系维护者。');
    const payload = JSON.stringify(record);
    this.db
      .prepare(
        'INSERT INTO teaching_records VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,updated_at=excluded.updated_at,payload=excluded.payload',
      )
      .run(
        record.id,
        record.classId,
        record.kind,
        record.revision,
        Number(record.deleted),
        record.createdAt,
        record.updatedAt,
        payload,
      );
    this.db
      .prepare('INSERT INTO teaching_record_revisions VALUES (?,?,?,?,?)')
      .run(requestId, record.id, record.revision, hash, payload);
    return record;
  }
  save(raw: unknown): TeachingRecord {
    const input = teachingSaveInput.parse(raw),
      snapshot = this.guard(input.epoch);
    const content = teachingContentSchemas[input.kind].parse(input.content);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.transaction(() => {
      const replay = this.replay(input, hash);
      if (replay) return replay;
      if (!snapshot.classes.some((c) => c.id === input.classId))
        throw new DomainError('NOT_FOUND', '班级不存在。');
      const studentIds = new Set(
        snapshot.students.filter((s) => s.classId === input.classId && s.active).map((s) => s.id),
      );
      if ('studentId' in content && !studentIds.has(content.studentId))
        throw new DomainError('VALIDATION', '学生不属于当前班级或已停用。');
      if ('submissions' in content) {
        const ids = content.submissions.map((s) => s.studentId);
        if (new Set(ids).size !== ids.length || ids.some((id) => !studentIds.has(id)))
          throw new DomainError('VALIDATION', '作业提交名单包含重复或其他班级学生。');
      }
      if (
        'photoIds' in content &&
        (new Set(content.photoIds).size !== content.photoIds.length ||
          content.photoIds.some((id) => !snapshot.assets.some((a) => a.id === id)))
      )
        throw new DomainError('VALIDATION', '照片文件不存在。');
      if (
        'examId' in content &&
        !this.db
          .prepare('SELECT id FROM exams WHERE id=? AND class_id=?')
          .get(content.examId, input.classId)
      )
        throw new DomainError('VALIDATION', '考试不属于当前班级。');
      if (
        input.kind === 'examArchive' &&
        'examId' in content &&
        this.list({ epoch: input.epoch, classId: input.classId, kind: input.kind }).some(
          (r) => r.id !== input.id && 'examId' in r.content && r.content.examId === content.examId,
        )
      )
        throw new DomainError('VALIDATION', '此考试已有归档状态，请修改原记录。');
      const old = input.id
        ? this.list({ epoch: input.epoch, includeDeleted: true }).find((r) => r.id === input.id)
        : undefined;
      if (
        input.id &&
        (!old ||
          old.revision !== input.expectedRevision ||
          old.kind !== input.kind ||
          old.classId !== input.classId ||
          old.deleted)
      )
        throw new DomainError('REVISION_CONFLICT', '记录已修改或删除，请刷新后重试。');
      if (
        input.kind === 'studentExtra' &&
        this.list({ epoch: input.epoch, classId: input.classId, kind: input.kind }).some(
          (r) =>
            r.id !== input.id &&
            'studentId' in r.content &&
            'studentId' in content &&
            r.content.studentId === content.studentId,
        )
      )
        throw new DomainError('VALIDATION', '学生扩展资料已存在，请编辑原记录。');
      const now = new Date(Math.max(Date.now(), old ? Date.parse(old.updatedAt) : 0)).toISOString();
      return this.write(
        {
          id: input.id ?? randomUUID(),
          classId: input.classId,
          kind: input.kind,
          revision: (old?.revision ?? 0) + 1,
          content,
          deleted: false,
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
        },
        input.requestId,
        hash,
      );
    });
  }
  remove(raw: unknown): TeachingRecord {
    const input = teachingDeleteInput.parse(raw);
    this.guard(input.epoch);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.transaction(() => {
      const replay = this.replay(input, hash);
      if (replay) return replay;
      const old = this.list({ epoch: input.epoch, includeDeleted: true }).find(
        (r) => r.id === input.id,
      );
      if (!old || old.revision !== input.expectedRevision)
        throw new DomainError('REVISION_CONFLICT', '记录已变化，请刷新后重试。');
      return this.write(
        {
          ...old,
          revision: old.revision + 1,
          deleted: input.deleted,
          updatedAt: new Date(Math.max(Date.now(), Date.parse(old.updatedAt))).toISOString(),
        },
        input.requestId,
        hash,
      );
    });
  }
  settings(raw: unknown): TeachingSettings {
    this.guard(epochInput.parse(raw).epoch);
    const row = this.db.prepare('SELECT payload FROM teaching_preferences WHERE id=1').get();
    return row ? JSON.parse(String(row.payload)) : { notifications: true, sound: true };
  }
  saveSettings(raw: unknown): TeachingSettings {
    const { epoch, ...settings } = teachingSettingsInput.parse(raw);
    this.guard(epoch);
    this.db
      .prepare(
        'INSERT INTO teaching_preferences VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(JSON.stringify(settings));
    return settings;
  }
  due(raw: unknown): TeachingRecord[] {
    const { epoch, now, since } = z
      .object({ epoch: z.uuid(), now: z.iso.datetime(), since: z.iso.datetime().optional() })
      .strict()
      .parse(raw);
    this.guard(epoch);
    return this.list({ epoch }).filter((r) => {
      if ((r.kind !== 'todo' && r.kind !== 'reminder') || !('dueAt' in r.content) || r.content.done)
        return false;
      const delta = Date.parse(now) - Date.parse(r.content.dueAt);
      const receipt = this.db
        .prepare('SELECT due_at FROM teaching_reminder_receipts WHERE record_id=?')
        .get(r.id);
      return (
        delta >= 0 &&
        (!since || Date.parse(r.content.dueAt) >= Date.parse(since)) &&
        receipt?.due_at !== r.content.dueAt
      );
    });
  }
  acknowledge(raw: unknown): void {
    const input = z
      .object({ epoch: z.uuid(), id: z.uuid(), dueAt: z.iso.datetime() })
      .strict()
      .parse(raw);
    this.guard(input.epoch);
    this.db
      .prepare(
        'INSERT INTO teaching_reminder_receipts VALUES (?,?,?) ON CONFLICT(record_id) DO UPDATE SET due_at=excluded.due_at,delivered_at=excluded.delivered_at',
      )
      .run(input.id, input.dueAt, new Date().toISOString());
  }
}
