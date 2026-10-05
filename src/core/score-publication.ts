import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../shared/contracts';
import {
  scorePublicationReadInput,
  scorePublicationConfirmInput,
  type ScorePublicationPreview,
  type ScorePublicationReceipt,
} from '../shared/score-publication';
import { readGradingReview, readGradingScore } from './grading-records';
import { readScorePublication, reviewedScorePayload } from './score-publication-records';
import { calculateScoreStatistics } from './scores';
import { transaction } from './database';
import { DomainError } from './errors';
import { MAX_SCORE_PAYLOAD_BYTES, MAX_SCORE_VERSIONS } from './storage-limits';

export type PublicationCheckpoint = (
  stage: 'score-inserted' | 'publication-inserted' | 'committed',
) => void;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 成绩模块拥有单份入分事务。只认后台复核和预览令牌，Renderer 不能提交分数或来源快照。 */
export class ScorePublication {
  private alive = true;
  private pending?: {
    token: string;
    reviewId: string;
    epoch: string;
    versionId: string;
    fingerprint: string;
    expiresAt: number;
  };
  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshot: () => Snapshot,
    private readonly checkpoint?: PublicationCheckpoint,
  ) {}
  dispose() {
    this.pending = undefined;
    this.alive = false;
  }
  private guard(epoch: string) {
    if (!this.alive || this.snapshot().epoch !== epoch)
      throw new DomainError('STALE_WORKSPACE', '成绩工作区已切换，请重新读取。');
  }
  private fingerprint() {
    return hash(
      this.snapshot().students.map(({ id, revision, active, classId }) => ({
        id,
        revision,
        active,
        classId,
      })),
    );
  }
  status(raw: unknown) {
    const input = scorePublicationReadInput.parse(raw);
    this.guard(input.epoch);
    readGradingReview(this.db, input.reviewId);
    return readScorePublication(this.db, input.reviewId);
  }
  prepare(raw: unknown): ScorePublicationPreview {
    this.pending = undefined;
    const input = scorePublicationReadInput.parse(raw);
    this.guard(input.epoch);
    const review = readGradingReview(this.db, input.reviewId);
    const receipt = readScorePublication(this.db, input.reviewId);
    if (!receipt && review.stale)
      throw new DomainError('GRADING_STALE', '成绩或评分细则有新版本，请重新绑定并逐题复核。');
    const request = review.payload.request;
    const parent = readGradingScore(this.db, request.scoreVersionId);
    const payload = reviewedScorePayload(this.db, input.reviewId);
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_SCORE_PAYLOAD_BYTES)
      throw new DomainError('STORAGE_LIMIT', '入分版本超过容量限制，原成绩保留。');
    const before = parent.payload.analysis.entries.find(
      (e) => e.studentId === request.studentId && e.subjectId === request.subjectId,
    )?.score ?? { status: 'missing' as const };
    const after = payload.analysis.entries.find(
      (e) => e.studentId === request.studentId && e.subjectId === request.subjectId,
    )!.score;
    if (!receipt)
      this.pending = {
        token: randomUUID(),
        epoch: input.epoch,
        reviewId: input.reviewId,
        versionId: parent.record.id,
        fingerprint: this.fingerprint(),
        expiresAt: Date.now() + 15 * 60 * 1000,
      };
    return {
      reviewId: input.reviewId,
      draftId: review.record.draftId,
      draftRevision: review.record.draftRevision,
      rubricVersionId: request.rubricVersionId,
      examId: request.examId,
      studentId: request.studentId,
      subjectId: request.subjectId,
      expectedVersionId: parent.record.id,
      before,
      after,
      replacesExisting: before.status !== 'missing',
      token: this.pending?.token ?? null,
      expiresAt: this.pending ? new Date(this.pending.expiresAt).toISOString() : null,
      receipt,
      statistics: calculateScoreStatistics({
        ...payload.analysis,
        roster: payload.analysis.roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
      }),
    };
  }
  confirm(raw: unknown): ScorePublicationReceipt {
    const input = scorePublicationConfirmInput.parse(raw);
    this.guard(input.epoch);
    const result = transaction(this.db, () => {
      const existing = readScorePublication(this.db, input.reviewId);
      if (existing) return existing;
      const pending = this.pending;
      if (
        !pending ||
        pending.token !== input.token ||
        pending.epoch !== input.epoch ||
        pending.reviewId !== input.reviewId ||
        pending.expiresAt <= Date.now()
      )
        throw new DomainError('SCORE_PREVIEW_EXPIRED', '入分预览已失效，请重新核对。');
      const review = readGradingReview(this.db, input.reviewId);
      if (
        review.stale ||
        pending.versionId !== input.expectedVersionId ||
        pending.fingerprint !== this.fingerprint()
      )
        throw new DomainError('CONFLICT', '来源、名册或成绩版本已变化，请重新核对。');
      const request = review.payload.request;
      const parent = readGradingScore(this.db, request.scoreVersionId);
      const old = parent.payload.analysis.entries.find(
        (e) => e.studentId === request.studentId && e.subjectId === request.subjectId,
      )?.score;
      if (old && old.status !== 'missing' && !input.acknowledgeReplacement)
        throw new DomainError('SCORE_REPLACEMENT_REQUIRED', '已有成绩须核对差异并明确确认替换。');
      const serialized = JSON.stringify(reviewedScorePayload(this.db, input.reviewId));
      if (
        Buffer.byteLength(serialized) > MAX_SCORE_PAYLOAD_BYTES ||
        Number(this.db.prepare('SELECT COUNT(*) AS count FROM score_versions').get()?.count) >=
          MAX_SCORE_VERSIONS
      )
        throw new DomainError('STORAGE_LIMIT', '成绩版本容量达到上限，原历史未删除。');
      const versionId = randomUUID();
      const createdAt = new Date(
        Math.max(
          Date.now(),
          Date.parse(parent.record.createdAt),
          Date.parse(review.record.createdAt),
        ),
      ).toISOString();
      const revision = parent.record.revision + 1;
      this.db.prepare('INSERT INTO score_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        versionId,
        request.examId,
        revision,
        randomUUID(),
        hash({
          reviewId: input.reviewId,
          previousVersionId: parent.record.id,
          reason: input.reason,
        }),
        createdAt,
        input.reason,
        serialized,
      );
      this.checkpoint?.('score-inserted');
      this.db
        .prepare('INSERT INTO grading_publications VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.reviewId, request.examId, parent.record.id, versionId, createdAt, input.reason);
      this.checkpoint?.('publication-inserted');
      return {
        reviewId: input.reviewId,
        previousVersionId: parent.record.id,
        examId: request.examId,
        versionId,
        revision,
        createdAt,
        replayed: false,
      };
    });
    this.pending = undefined;
    if (!result.replayed) this.checkpoint?.('committed');
    return result;
  }
}
