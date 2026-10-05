import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  rubricRecordSchema,
  gradingPayloadSchema,
  gradingDraftRecordSchema,
  gradingReviewRecordSchema,
  gradingAttemptRecordSchema,
  gradingAttemptPayloadSchema,
  gradingRevisionRecordSchema,
  type GradingPayload,
} from '../shared/grading-records';
import type { GradingRequest } from '../shared/grading';
import { storedScoreVersionSchema, scoreVersionPayloadSchema } from '../shared/score-records';
import {
  validateRubric,
  prepareGrading,
  validateGradingRows,
  validateGradingReview,
  validateGradingOutput,
} from './grading';
import { readStoredMaterial } from './material-records';
import { DomainError } from './errors';
import {
  MAX_RUBRIC_VERSIONS,
  MAX_RUBRIC_PAYLOAD_BYTES,
  MAX_GRADING_DRAFTS,
  MAX_GRADING_REVIEWS,
  MAX_GRADING_ATTEMPTS,
  MAX_GRADING_PAYLOAD_BYTES,
  MAX_GRADING_ATTEMPT_BYTES,
  MAX_GRADING_REVISIONS,
} from './storage-limits';

export const gradingDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const RUBRIC_COLUMNS =
  'id, exam_id AS examId, subject_id AS subjectId, score_version_id AS scoreVersionId, revision, request_id AS requestId, request_hash AS requestHash, created_at AS createdAt';
export const GRADING_DRAFT_COLUMNS =
  'id, revision, status, created_at AS createdAt, updated_at AS updatedAt, create_request_id AS createRequestId, create_hash AS createHash, base_review_id AS baseReviewId';
export const GRADING_REVIEW_COLUMNS =
  'id, draft_id AS draftId, draft_revision AS draftRevision, request_id AS requestId, request_hash AS requestHash, created_at AS createdAt, total_hundredths AS totalHundredths, reason';
export const GRADING_ATTEMPT_COLUMNS =
  'id, draft_id AS draftId, base_revision AS baseRevision, status, started_at AS startedAt, ended_at AS endedAt, result_revision AS resultRevision, request_hash AS requestHash, result_hash AS resultHash, error_code AS errorCode';

export function readGradingScore(db: DatabaseSync, id: string) {
  const row = db
    .prepare(
      'SELECT id, exam_id AS examId, revision, request_id AS requestId, request_hash AS requestHash, created_at AS createdAt, reason, payload FROM score_versions WHERE id=?',
    )
    .get(id);
  if (!row) throw new DomainError('NOT_FOUND', '阅卷关联的成绩版本不存在。');
  const { payload, ...record } = row;
  return {
    record: storedScoreVersionSchema.parse(record),
    payload: scoreVersionPayloadSchema.parse(JSON.parse(String(payload))),
  };
}
export function readRubric(db: DatabaseSync, id: string) {
  const row = db
    .prepare(`SELECT ${RUBRIC_COLUMNS}, payload FROM rubric_versions WHERE id=?`)
    .get(id);
  if (!row) throw new DomainError('NOT_FOUND', '评分细则版本不存在。');
  const { payload, ...record } = row;
  return {
    record: rubricRecordSchema.parse(record),
    definition: validateRubric(JSON.parse(String(payload))),
  };
}
/** 从不可变后台版本重建阅卷依据；不接受渲染层的材料/成绩快照。 */
export function storedGradingPreparation(db: DatabaseSync, request: GradingRequest) {
  const rubric = readRubric(db, request.rubricVersionId);
  return prepareGrading(
    request,
    {
      id: rubric.record.id,
      examId: rubric.record.examId,
      subjectId: rubric.record.subjectId,
      revision: rubric.record.revision,
      definition: rubric.definition,
    },
    readGradingScore(db, request.scoreVersionId),
    [...new Set(request.pages.map((page) => page.sourceVersionId))].map(
      (id) => readStoredMaterial(db, id).version,
    ),
  );
}
/** 只判定最新依据，历史仍可读取；新细则或成绩版本须显式重绑并重新复核。 */
export function gradingIsStale(db: DatabaseSync, request: GradingRequest) {
  return (
    db
      .prepare('SELECT id FROM score_versions WHERE exam_id=? ORDER BY revision DESC LIMIT 1')
      .get(request.examId)?.id !== request.scoreVersionId ||
    db
      .prepare(
        'SELECT id FROM rubric_versions WHERE exam_id=? AND subject_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(request.examId, request.subjectId)?.id !== request.rubricVersionId
  );
}
export function validateGradingPayload(db: DatabaseSync, raw: unknown): GradingPayload {
  const payload = gradingPayloadSchema.parse(raw);
  const preparation = storedGradingPreparation(db, payload.request);
  if (payload.inputHash !== preparation.fingerprint)
    throw new DomainError('GRADING_INVALID', '保存的阅卷来源指纹不一致。');
  validateGradingRows(payload.rows, preparation);
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_GRADING_PAYLOAD_BYTES)
    throw new DomainError('GRADING_LIMIT', '阅卷内容超过 2 MiB 保存上限。');
  return payload;
}
export function readGradingDraft(db: DatabaseSync, id: string) {
  const row = db
    .prepare(`SELECT ${GRADING_DRAFT_COLUMNS}, payload FROM grading_drafts WHERE id=?`)
    .get(id);
  if (!row) throw new DomainError('NOT_FOUND', '阅卷草案不存在。');
  const { payload, ...record } = row;
  const value = validateGradingPayload(db, JSON.parse(String(payload)));
  return {
    record: gradingDraftRecordSchema.parse(record),
    payload: value,
    stale: gradingIsStale(db, value.request),
    reviewId:
      String(db.prepare('SELECT id FROM grading_reviews WHERE draft_id=?').get(id)?.id ?? '') ||
      null,
  };
}
export function readGradingReview(db: DatabaseSync, id: string) {
  const row = db
    .prepare(`SELECT ${GRADING_REVIEW_COLUMNS}, payload FROM grading_reviews WHERE id=?`)
    .get(id);
  if (!row) throw new DomainError('NOT_FOUND', '冻结复核版本不存在。');
  const { payload, ...record } = row;
  const value = validateGradingPayload(db, JSON.parse(String(payload)));
  return {
    record: gradingReviewRecordSchema.parse(record),
    payload: value,
    stale: gradingIsStale(db, value.request),
  };
}
export function readGradingAttempt(db: DatabaseSync, id: string) {
  const row = db
    .prepare(`SELECT ${GRADING_ATTEMPT_COLUMNS}, payload FROM grading_attempts WHERE id=?`)
    .get(id);
  if (!row) throw new DomainError('NOT_FOUND', '阅卷尝试不存在。');
  const { payload, ...record } = row;
  return {
    record: gradingAttemptRecordSchema.parse(record),
    payload: gradingAttemptPayloadSchema.parse(JSON.parse(String(payload))),
  };
}
export function gradingSourceTime(db: DatabaseSync, request: GradingRequest) {
  return Math.max(
    Date.parse(readGradingScore(db, request.scoreVersionId).record.createdAt),
    Date.parse(readRubric(db, request.rubricVersionId).record.createdAt),
    ...request.pages.map((page) =>
      Date.parse(readStoredMaterial(db, page.sourceVersionId).record.createdAt),
    ),
  );
}

/** 不可变操作链说明每次人工修改、重绑、生成与冻结；最后快照必须与当前草案相同。 */
function validateGradingHistory(db: DatabaseSync) {
  if (
    Number(db.prepare('SELECT COUNT(*) AS count FROM grading_revisions').get()?.count) >
      MAX_GRADING_REVISIONS ||
    db
      .prepare(
        'SELECT draft_id FROM grading_revisions WHERE length(CAST(payload AS BLOB)) > ? LIMIT 1',
      )
      .get(MAX_GRADING_PAYLOAD_BYTES)
  )
    throw new Error('Revision quota');
  for (const value of db.prepare('SELECT id FROM grading_drafts').all()) {
    const draft = readGradingDraft(db, String(value.id));
    let previous: { payload: GradingPayload; revision: number; timestamp: number } | undefined;
    const revisions = db
      .prepare(
        'SELECT draft_id AS draftId, revision, operation, created_at AS createdAt, request_id AS requestId, payload FROM grading_revisions WHERE draft_id=? ORDER BY revision',
      )
      .all(draft.record.id);
    for (const { payload: raw, ...metadata } of revisions) {
      const record = gradingRevisionRecordSchema.parse(metadata);
      const payload = validateGradingPayload(db, JSON.parse(String(raw)));
      const prep = storedGradingPreparation(db, payload.request);
      const time = Date.parse(record.createdAt);
      if (
        record.revision !== (previous?.revision ?? 0) + 1 ||
        time < (previous?.timestamp ?? Date.parse(draft.record.createdAt)) ||
        time < gradingSourceTime(db, payload.request) ||
        gradingDigest(payload.initialRequest) !== gradingDigest(draft.payload.initialRequest)
      )
        throw new Error('Revision provenance');
      if (!previous) {
        if (
          record.operation !== 'created' ||
          record.requestId !== draft.record.createRequestId ||
          record.createdAt !== draft.record.createdAt ||
          gradingDigest(payload.request) !== gradingDigest(payload.initialRequest)
        )
          throw new Error('Initial revision');
        const base = draft.record.baseReviewId
          ? readGradingReview(db, draft.record.baseReviewId)
          : null;
        const expected =
          base && base.payload.inputHash === prep.fingerprint
            ? base.payload.rows.map((row) => ({ ...row, reviewed: false }))
            : validateGradingOutput('{"formatVersion":1,"assessments":[]}', prep);
        if (gradingDigest(payload.rows) !== gradingDigest(expected))
          throw new Error('Initial rows');
      } else {
        if (!sameHistoryBinding(previous.payload.request, payload.request))
          throw new Error('Changed binding');
        if (record.operation === 'edited') {
          if (
            record.requestId ||
            gradingDigest({ ...payload, rows: [] }) !==
              gradingDigest({ ...previous.payload, rows: [] }) ||
            payload.rows.some(
              (row, index) =>
                gradingDigest(row) !== gradingDigest(previous!.payload.rows[index]) &&
                (row.origin !== 'teacher' || !row.reviewed),
            )
          )
            throw new Error('Teacher edit history');
        } else if (record.operation === 'rebound') {
          const expected =
            payload.inputHash === previous.payload.inputHash
              ? previous.payload.rows
              : validateGradingOutput('{"formatVersion":1,"assessments":[]}', prep);
          if (record.requestId || gradingDigest(payload.rows) !== gradingDigest(expected))
            throw new Error('Rebinding history');
        } else if (record.operation === 'generated') {
          if (!record.requestId) throw new Error('Generation identity');
          const attempt = readGradingAttempt(db, record.requestId);
          if (
            attempt.record.draftId !== record.draftId ||
            attempt.record.status !== 'succeeded' ||
            attempt.record.baseRevision !== previous.revision ||
            attempt.record.resultRevision !== record.revision ||
            attempt.record.endedAt !== record.createdAt ||
            attempt.payload.output === null ||
            gradingDigest({ ...payload, rows: [] }) !==
              gradingDigest({ ...previous.payload, rows: [] }) ||
            gradingDigest({
              ...payload.request,
              selectedPageIds: attempt.payload.request.selectedPageIds,
              selectedQuestionIds: attempt.payload.request.selectedQuestionIds,
            }) !== gradingDigest(attempt.payload.request)
          )
            throw new Error('Generation history');
          const generated = validateGradingOutput(
            attempt.payload.output,
            storedGradingPreparation(db, attempt.payload.request),
          );
          const expected = previous.payload.rows.map((row) =>
            attempt.payload.request.selectedQuestionIds.includes(row.questionId)
              ? generated.find((item) => item.questionId === row.questionId)!
              : row,
          );
          if (gradingDigest(payload.rows) !== gradingDigest(expected))
            throw new Error('Batch history');
        } else if (record.operation === 'frozen') {
          const row = db
            .prepare('SELECT id FROM grading_reviews WHERE draft_id=?')
            .get(record.draftId);
          if (!row) throw new Error('Missing frozen history');
          const review = readGradingReview(db, String(row.id));
          if (
            record.requestId !== review.record.requestId ||
            record.createdAt !== review.record.createdAt ||
            record.revision !== draft.record.revision ||
            gradingDigest(payload) !== gradingDigest(previous.payload) ||
            draft.record.status !== 'frozen'
          )
            throw new Error('Freeze history');
        } else throw new Error('Repeated creation');
      }
      previous = { payload, revision: record.revision, timestamp: time };
    }
    if (
      !previous ||
      previous.revision !== draft.record.revision ||
      previous.timestamp !== Date.parse(draft.record.updatedAt) ||
      gradingDigest(previous.payload) !== gradingDigest(draft.payload)
    )
      throw new Error('Missing current revision');
  }
}
const sameHistoryBinding = (first: GradingRequest, second: GradingRequest) =>
  first.examId === second.examId &&
  first.subjectId === second.subjectId &&
  first.studentId === second.studentId;
/** 数据库/备份开写前验证规模、归属、来源指纹、审核状态、冻结副本及尝试结果。 */
export function validateGradingRecords(db: DatabaseSync) {
  try {
    if (
      Number(
        db.prepare("SELECT COUNT(*) AS count FROM grading_attempts WHERE status='running'").get()
          ?.count,
      ) > 1 ||
      db
        .prepare(
          'SELECT draft_id FROM grading_attempts GROUP BY draft_id HAVING COUNT(*) > 20 LIMIT 1',
        )
        .get()
    )
      throw new Error('Attempt quota');
    for (const [table, count, bytes] of [
      ['rubric_versions', MAX_RUBRIC_VERSIONS, MAX_RUBRIC_PAYLOAD_BYTES],
      ['grading_drafts', MAX_GRADING_DRAFTS, MAX_GRADING_PAYLOAD_BYTES],
      ['grading_reviews', MAX_GRADING_REVIEWS, MAX_GRADING_PAYLOAD_BYTES],
      ['grading_attempts', MAX_GRADING_ATTEMPTS, MAX_GRADING_ATTEMPT_BYTES],
    ] as const) {
      if (
        Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count) > count ||
        db
          .prepare(`SELECT id FROM ${table} WHERE length(CAST(payload AS BLOB)) > ? LIMIT 1`)
          .get(bytes)
      )
        throw new Error('Grading quota');
    }
    const series = new Map<string, { revision: number; createdAt: string }>();
    for (const row of db
      .prepare('SELECT id FROM rubric_versions ORDER BY exam_id, subject_id, revision')
      .all()) {
      const { record, definition } = readRubric(db, String(row.id));
      const score = readGradingScore(db, record.scoreVersionId);
      const subject = score.payload.analysis.subjects.find(
        (value) => value.id === record.subjectId,
      );
      const key = `${record.examId}:${record.subjectId}`;
      const previous = series.get(key);
      if (
        !subject ||
        record.examId !== score.record.examId ||
        definition.precision !== subject.precision ||
        definition.maxHundredths !== Math.round(Number(subject.maxScore) * 100) ||
        record.revision !== (previous?.revision ?? 0) + 1 ||
        Date.parse(record.createdAt) <
          Math.max(
            Date.parse(score.record.createdAt),
            previous ? Date.parse(previous.createdAt) : 0,
          ) ||
        record.requestHash !==
          gradingDigest({
            scoreVersionId: record.scoreVersionId,
            subjectId: record.subjectId,
            definition,
          })
      )
        throw new Error('Rubric provenance');
      series.set(key, record);
    }
    const frozen = new Set<string>();
    for (const row of db.prepare('SELECT id FROM grading_reviews').all()) {
      const review = readGradingReview(db, String(row.id));
      const draft = readGradingDraft(db, review.record.draftId);
      const prep = storedGradingPreparation(db, review.payload.request);
      const confirmed = validateGradingReview(review.payload.rows, prep, review.payload.inputHash);
      if (
        draft.record.status !== 'frozen' ||
        draft.record.revision !== review.record.draftRevision ||
        draft.record.updatedAt !== review.record.createdAt ||
        JSON.stringify(draft.payload) !== JSON.stringify(review.payload) ||
        confirmed.totalHundredths !== review.record.totalHundredths ||
        review.record.requestHash !==
          gradingDigest({
            id: draft.record.id,
            expectedRevision: draft.record.revision - 1,
            payload: review.payload,
            reason: review.record.reason,
          })
      )
        throw new Error('Frozen review');
      frozen.add(draft.record.id);
    }
    for (const row of db.prepare('SELECT id FROM grading_drafts').all()) {
      const { record, payload } = readGradingDraft(db, String(row.id));
      storedGradingPreparation(db, payload.initialRequest);
      if (
        Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
        Date.parse(record.createdAt) < gradingSourceTime(db, payload.initialRequest) ||
        Date.parse(record.updatedAt) < gradingSourceTime(db, payload.request) ||
        (record.status === 'frozen') !== frozen.has(record.id) ||
        payload.initialRequest.examId !== payload.request.examId ||
        payload.initialRequest.subjectId !== payload.request.subjectId ||
        payload.initialRequest.studentId !== payload.request.studentId ||
        record.createHash !==
          gradingDigest({ request: payload.initialRequest, baseReviewId: record.baseReviewId })
      )
        throw new Error('Draft provenance');
      if (record.baseReviewId) {
        const base = readGradingReview(db, record.baseReviewId);
        if (
          Date.parse(record.createdAt) < Date.parse(base.record.createdAt) ||
          payload.initialRequest.examId !== base.payload.request.examId ||
          payload.initialRequest.subjectId !== base.payload.request.subjectId ||
          payload.initialRequest.studentId !== base.payload.request.studentId
        )
          throw new Error('Review revision');
      }
      if (
        record.revision === 1 &&
        (record.status !== 'draft' ||
          record.createdAt !== record.updatedAt ||
          payload.rows.some((value) => value.reviewed))
      )
        throw new Error('Initial review');
    }
    for (const row of db.prepare('SELECT id FROM grading_attempts').all()) {
      const { record, payload } = readGradingAttempt(db, String(row.id));
      const draft = readGradingDraft(db, record.draftId);
      const prep = storedGradingPreparation(db, payload.request);
      if (
        prep.fingerprint !== payload.inputHash ||
        record.baseRevision > draft.record.revision ||
        Date.parse(record.startedAt) <
          Math.max(Date.parse(draft.record.createdAt), gradingSourceTime(db, payload.request)) ||
        (record.endedAt !== null && Date.parse(record.endedAt) < Date.parse(record.startedAt)) ||
        record.requestHash !==
          gradingDigest({
            token: payload.token,
            draftId: record.draftId,
            baseRevision: record.baseRevision,
            request: payload.request,
            inputHash: payload.inputHash,
          }) ||
        payload.request.examId !== draft.payload.request.examId ||
        payload.request.subjectId !== draft.payload.request.subjectId ||
        payload.request.studentId !== draft.payload.request.studentId
      )
        throw new Error('Attempt provenance');
      if (record.status === 'succeeded') {
        if (
          !payload.provider ||
          payload.output === null ||
          !record.endedAt ||
          record.errorCode ||
          record.resultRevision !== record.baseRevision + 1 ||
          record.resultRevision > draft.record.revision ||
          Date.parse(payload.provider.generatedAt) > Date.parse(record.endedAt) ||
          record.resultHash !==
            gradingDigest({
              token: payload.token,
              provider: payload.provider,
              output: payload.output,
            })
        )
          throw new Error('Attempt success');
        validateGradingOutput(payload.output, prep);
      } else if (
        payload.output !== null ||
        payload.provider !== null ||
        record.resultRevision !== null ||
        record.resultHash !== null ||
        (record.status === 'running'
          ? record.endedAt !== null ||
            record.errorCode !== null ||
            draft.record.status !== 'draft' ||
            record.baseRevision !== draft.record.revision
          : !record.endedAt || !record.errorCode)
      )
        throw new Error('Attempt terminal state');
    }
    validateGradingHistory(db);
  } catch {
    throw new DomainError(
      'BACKUP_INVALID',
      '评分细则、阅卷草案、冻结复核或尝试记录无效，已拒绝打开。',
    );
  }
}
