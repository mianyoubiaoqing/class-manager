import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  lessonDraftRecordSchema,
  lessonPayloadSchema,
  lessonVersionRecordSchema,
  type LessonPayload,
  type LessonDraftView,
  type LessonVersionView,
} from '../shared/lesson-records';
import type { LessonRequest } from '../shared/lessons';
import { prepareLesson, prepareLocalLesson, validateLessonContent } from './lesson-drafting';
import { readStoredMaterial } from './material-records';
import { MAX_LESSON_DRAFTS, MAX_LESSON_VERSIONS, MAX_LESSON_PAYLOAD_BYTES } from './storage-limits';
import { DomainError } from './errors';

export const LESSON_DRAFT_COLUMNS = `id, lesson_id AS lessonId, revision, status, created_at AS createdAt, updated_at AS updatedAt, base_version_id AS baseVersionId, generation_request_id AS generationRequestId, generation_hash AS generationHash`;
export const LESSON_VERSION_COLUMNS = `id, lesson_id AS lessonId, draft_id AS draftId, revision, request_id AS requestId, request_hash AS requestHash, created_at AS createdAt, reason`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Prepare only the referenced immutable materials; no network, file reads or unselected copies. */
export function storedLessonPreparation(db: DatabaseSync, request: LessonRequest) {
  if (!request.selection.length) return prepareLocalLesson(request);
  return prepareLesson(
    request,
    [...new Set(request.selection.map((ref) => ref.sourceVersionId))].map(
      (id) => readStoredMaterial(db, id).version,
    ),
  );
}
/** The same source/structure checks protect model originals, teacher edits and backup records. */
export function validateLessonPayload(db: DatabaseSync, raw: unknown): LessonPayload {
  const payload = lessonPayloadSchema.parse(raw);
  const preparation = storedLessonPreparation(db, payload.request);
  if (payload.inputHash !== preparation.fingerprint)
    throw new DomainError('LESSON_INVALID', '备课来源指纹不一致。');
  validateLessonContent(payload.original, preparation);
  validateLessonContent(payload.content, preparation);
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_LESSON_PAYLOAD_BYTES)
    throw new DomainError('LESSON_LIMIT', '备课版本超过 3 MiB 保存上限。');
  return payload;
}
export function serializeLesson(db: DatabaseSync, payload: LessonPayload): string {
  return JSON.stringify(validateLessonPayload(db, payload));
}
export function readLessonDraft(db: DatabaseSync, id: string): LessonDraftView {
  const raw = db
    .prepare(`SELECT ${LESSON_DRAFT_COLUMNS}, payload FROM lesson_drafts WHERE id=?`)
    .get(id);
  if (!raw) throw new DomainError('NOT_FOUND', '备课草案不存在。');
  const { payload, ...record } = raw;
  return {
    record: lessonDraftRecordSchema.parse(record),
    payload: validateLessonPayload(db, JSON.parse(String(payload))),
  };
}
export function readLessonVersion(db: DatabaseSync, id: string): LessonVersionView {
  const raw = db
    .prepare(`SELECT ${LESSON_VERSION_COLUMNS}, payload FROM lesson_versions WHERE id=?`)
    .get(id);
  if (!raw) throw new DomainError('NOT_FOUND', '备课冻结版本不存在。');
  const { payload, ...record } = raw;
  return {
    record: lessonVersionRecordSchema.parse(record),
    payload: validateLessonPayload(db, JSON.parse(String(payload))),
  };
}

/** Strict relational/provenance validation before opening a writable database or restoring it. */
export function validateLessonRecords(db: DatabaseSync): void {
  try {
    if (
      Number(db.prepare('SELECT COUNT(*) AS count FROM lesson_drafts').get()?.count) >
        MAX_LESSON_DRAFTS ||
      Number(db.prepare('SELECT COUNT(*) AS count FROM lesson_versions').get()?.count) >
        MAX_LESSON_VERSIONS
    )
      throw new Error('Lesson quota');
    const versions = db
      .prepare(
        'SELECT id, length(CAST(payload AS BLOB)) AS bytes FROM lesson_versions ORDER BY lesson_id, revision',
      )
      .all();
    const latest = new Map<string, { id: string; revision: number; timestamp: number }>();
    const frozen = new Map<string, LessonVersionView>();
    for (const row of versions) {
      if (Number(row.bytes) > MAX_LESSON_PAYLOAD_BYTES) throw new Error('Version size');
      const value = readLessonVersion(db, String(row.id));
      const previous = latest.get(value.record.lessonId);
      const draft = readLessonDraft(db, value.record.draftId);
      const timestamp = Date.parse(value.record.createdAt);
      const expectedHash = digest({
        id: draft.record.id,
        expectedRevision: draft.record.revision - 1,
        reason: value.record.reason,
        payload: value.payload,
      });
      if (
        value.record.revision !== (previous?.revision ?? 0) + 1 ||
        (previous && timestamp < previous.timestamp) ||
        draft.record.lessonId !== value.record.lessonId ||
        draft.record.status !== 'frozen' ||
        draft.record.baseVersionId !== (previous?.id ?? null) ||
        draft.record.updatedAt !== value.record.createdAt ||
        JSON.stringify(draft.payload) !== JSON.stringify(value.payload) ||
        value.record.requestHash !== expectedHash
      )
        throw new Error('Invalid version stream');
      latest.set(value.record.lessonId, {
        id: value.record.id,
        revision: value.record.revision,
        timestamp,
      });
      frozen.set(draft.record.id, value);
    }
    const roots = new Set<string>();
    for (const row of db
      .prepare('SELECT id, length(CAST(payload AS BLOB)) AS bytes FROM lesson_drafts')
      .all()) {
      if (Number(row.bytes) > MAX_LESSON_PAYLOAD_BYTES) throw new Error('Draft size');
      const { record, payload } = readLessonDraft(db, String(row.id));
      if (
        Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
        (payload.provider !== null &&
          Date.parse(record.createdAt) < Date.parse(payload.provider.generatedAt)) ||
        (record.status === 'frozen') !== frozen.has(record.id)
      )
        throw new Error('Invalid draft metadata');
      for (const id of new Set(payload.request.selection.map((ref) => ref.sourceVersionId)))
        if (Date.parse(record.createdAt) < Date.parse(readStoredMaterial(db, id).record.createdAt))
          throw new Error('Source after draft');
      if (record.baseVersionId) {
        const base = readLessonVersion(db, record.baseVersionId);
        if (
          base.record.lessonId !== record.lessonId ||
          Date.parse(base.record.createdAt) > Date.parse(record.createdAt) ||
          record.generationHash !==
            digest({ baseVersionId: base.record.id, payload: base.payload }) ||
          JSON.stringify({ ...payload, content: base.payload.content }) !==
            JSON.stringify(base.payload) ||
          (record.revision === 1 &&
            JSON.stringify(payload.content) !== JSON.stringify(base.payload.content))
        )
          throw new Error('Invalid base version');
      } else {
        if (roots.has(record.lessonId)) throw new Error('Duplicate original lesson');
        roots.add(record.lessonId);
      }
      if (
        record.revision === 1 &&
        (record.status !== 'draft' ||
          record.createdAt !== record.updatedAt ||
          (!record.baseVersionId &&
            JSON.stringify(payload.original) !== JSON.stringify(payload.content)))
      )
        throw new Error('Invalid initial draft');
    }
  } catch {
    throw new DomainError('BACKUP_INVALID', '备课草案、冻结版本或资料来源无效，已拒绝打开。');
  }
}
