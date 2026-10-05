import type { DatabaseSync } from 'node:sqlite';
import {
  scorePublicationRecordSchema,
  type ScorePublicationReceipt,
} from '../shared/score-publication';
import type { ScoreVersionPayload } from '../shared/score-records';
import { readGradingReview, readGradingScore, storedGradingPreparation } from './grading-records';
import { validateGradingReview } from './grading';
import { validateScorePayload } from './score-record-validation';
import { DomainError } from './errors';
import { MAX_GRADING_REVIEWS } from './storage-limits';

export const PUBLICATION_COLUMNS =
  'review_id AS reviewId, exam_id AS examId, previous_version_id AS previousVersionId, score_version_id AS scoreVersionId, created_at AS createdAt, reason';

/** 从不可变完整复核和其确切成绩父版构造单份入分；保留其他学生、科目和原始文件来源。 */
export function reviewedScorePayload(db: DatabaseSync, reviewId: string): ScoreVersionPayload {
  const review = readGradingReview(db, reviewId);
  const { request } = review.payload;
  const complete = validateGradingReview(
    review.payload.rows,
    storedGradingPreparation(db, request),
    review.payload.inputHash,
  );
  if (complete.totalHundredths !== review.record.totalHundredths)
    throw new DomainError('GRADING_INVALID', '冻结复核总分不一致，未入分。');
  const parent = readGradingScore(db, request.scoreVersionId);
  const score = {
    status: 'valid' as const,
    hundredths: complete.totalHundredths,
  };
  const entries = parent.payload.analysis.entries.filter(
    (entry) => entry.studentId !== request.studentId || entry.subjectId !== request.subjectId,
  );
  entries.push({ studentId: request.studentId, subjectId: request.subjectId, score });
  return validateScorePayload({
    ...parent.payload,
    analysis: { ...parent.payload.analysis, entries },
    publication: { reviewId, previousVersionId: parent.record.id },
  });
}

/** 查询持久提交事实；已发布复核即使后来来源过期仍返回原回执，不再次改分。 */
export function readScorePublication(
  db: DatabaseSync,
  reviewId: string,
): ScorePublicationReceipt | null {
  const row = db
    .prepare(`SELECT ${PUBLICATION_COLUMNS} FROM grading_publications WHERE review_id=?`)
    .get(reviewId);
  if (!row) return null;
  const record = scorePublicationRecordSchema.parse(row);
  const version = readGradingScore(db, record.scoreVersionId).record;
  return {
    reviewId,
    previousVersionId: record.previousVersionId,
    examId: version.examId,
    versionId: version.id,
    revision: version.revision,
    createdAt: version.createdAt,
    replayed: true,
  };
}

/** 备份/重开校验完整发布凭据、父子成绩及唯一目标变更；不能通过重新计算包哈希伪造入分。 */
export function validateScorePublications(db: DatabaseSync): void {
  try {
    const rows = db.prepare(`SELECT ${PUBLICATION_COLUMNS} FROM grading_publications`).all();
    if (rows.length > MAX_GRADING_REVIEWS) throw Error('Publication quota');
    const published = new Set<string>();
    for (const row of rows) {
      const record = scorePublicationRecordSchema.parse(row);
      const review = readGradingReview(db, record.reviewId);
      const parent = readGradingScore(db, record.previousVersionId);
      const next = readGradingScore(db, record.scoreVersionId);
      if (
        record.examId !== parent.record.examId ||
        next.record.examId !== record.examId ||
        review.payload.request.scoreVersionId !== parent.record.id ||
        next.record.revision !== parent.record.revision + 1 ||
        next.record.createdAt !== record.createdAt ||
        next.record.reason !== record.reason ||
        Date.parse(record.createdAt) < Date.parse(review.record.createdAt) ||
        JSON.stringify(next.payload) !== JSON.stringify(reviewedScorePayload(db, record.reviewId))
      )
        throw Error('Publication chain');
      published.add(record.scoreVersionId);
    }
    for (const row of db.prepare('SELECT id, payload FROM score_versions').iterate()) {
      // validateDatabase already validates every score payload; only check the reciprocal link here.
      const payload = JSON.parse(String(row.payload));
      if (Boolean(payload.publication) !== published.has(String(row.id)))
        throw Error('Missing publication record');
    }
  } catch {
    throw new DomainError('BACKUP_INVALID', '正式入分凭据或成绩来源不完整，已拒绝打开。');
  }
}
