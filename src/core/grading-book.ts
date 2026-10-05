import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { epochInput } from '../shared/contracts';
import {
  rubricCreateInput,
  rubricReadInput,
  rubricListInput,
  gradingCreateInput,
  gradingReadInput,
  gradingEditInput,
  gradingRebindInput,
  gradingFreezeInput,
  gradingListInput,
  gradingPrepareInput,
  gradingClaimInput,
  gradingCompleteInput,
  gradingEndInput,
  gradingHistoryInput,
  gradingRevisionRecordSchema,
  rubricRecordSchema,
  gradingDraftRecordSchema,
  type GradingPayload,
  type GradingDraftRecord,
} from '../shared/grading-records';
import type { GradingPreparation } from './grading';
import {
  validateRubric,
  validateGradingOutput,
  applyGradingEdits,
  validateGradingReview,
} from './grading';
import {
  gradingDigest,
  readGradingScore,
  readRubric,
  storedGradingPreparation,
  gradingIsStale,
  validateGradingPayload,
  readGradingDraft,
  readGradingReview,
  readGradingAttempt,
  gradingSourceTime,
  RUBRIC_COLUMNS,
  GRADING_DRAFT_COLUMNS,
  GRADING_ATTEMPT_COLUMNS,
} from './grading-records';
import {
  MAX_RUBRIC_VERSIONS,
  MAX_RUBRIC_PAYLOAD_BYTES,
  MAX_GRADING_DRAFTS,
  MAX_GRADING_REVIEWS,
  MAX_GRADING_ATTEMPTS,
  MAX_GRADING_ATTEMPT_BYTES,
  MAX_GRADING_REVISIONS,
} from './storage-limits';
import { DomainError } from './errors';
import { transaction } from './database';

export type GradingCheckpoint = (
  stage:
    'draft-stored' | 'edited' | 'attempt-claimed' | 'attempt-completed' | 'frozen' | 'committed',
) => void;
const timestamp = (...minimum: number[]) =>
  new Date(Math.max(Date.now(), ...minimum)).toISOString();
const receipt = (record: GradingDraftRecord, replayed = false) => ({
  id: record.id,
  revision: record.revision,
  status: record.status,
  replayed,
});
const sameBinding = (first: GradingPayload['request'], second: GradingPayload['request']) =>
  first.examId === second.examId &&
  first.subjectId === second.subjectId &&
  first.studentId === second.studentId;

/**
 * 后台拥有细则、答卷草案、逐次尝试和不可变复核版本。渲染层只提交具名操作及教师修改。
 * 模型网络在 Main 执行；认领先持久记录，重开标中断，不重放付费请求。本模块不写正式成绩。
 * 所有写入串行事务，并受 revision/epoch/来源指纹保护；检查点仅用于故障注入。
 */
export class GradingBook {
  private alive = true;
  private pending?: {
    token: string;
    epoch: string;
    id: string;
    revision: number;
    expiresAt: number;
    preparation: GradingPreparation;
    requestId?: string;
  };
  constructor(
    private readonly db: DatabaseSync,
    private readonly epoch: () => string,
    private readonly checkpoint?: GradingCheckpoint,
  ) {
    transaction(db, () => {
      for (const row of db
        .prepare("SELECT id, started_at AS startedAt FROM grading_attempts WHERE status='running'")
        .all())
        db.prepare(
          "UPDATE grading_attempts SET status='interrupted', ended_at=?, error_code='GRADING_INTERRUPTED' WHERE id=?",
        ).run(timestamp(Date.parse(String(row.startedAt))), row.id!);
    });
  }
  private guard(epoch: string) {
    if (!this.alive || epoch !== this.epoch())
      throw new DomainError('STALE_WORKSPACE', '阅卷工作区已切换，请重新读取。');
  }
  dispose() {
    this.pending = undefined;
    this.alive = false;
  }
  private quota(table: string, maximum: number) {
    if (Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count) >= maximum)
      throw new DomainError('GRADING_LIMIT', '阅卷记录数量达到上限，请先备份并联系维护者。');
  }
  private assertCurrent(preparation: GradingPreparation) {
    if (gradingIsStale(this.db, preparation.request))
      throw new DomainError('GRADING_STALE', '成绩或评分细则有新版本，请重新绑定并逐题复核。');
  }
  private assertEditable(id: string) {
    const draft = readGradingDraft(this.db, id);
    if (draft.record.status !== 'draft')
      throw new DomainError('CONFLICT', '冻结复核不能编辑，请明确创建修订草案。');
    if (
      this.db
        .prepare("SELECT id FROM grading_attempts WHERE draft_id=? AND status='running'")
        .get(id)
    )
      throw new DomainError('BUSY', '答卷生成尚未结束，请先取消或等待。');
    return draft;
  }
  private checkRevision(record: GradingDraftRecord, expected: number) {
    if (record.revision !== expected)
      throw new DomainError('CONFLICT', '阅卷草案已修改，请刷新后重试。');
  }
  private appendRevision(
    record: GradingDraftRecord,
    payload: string,
    operation: 'created' | 'edited' | 'rebound' | 'generated' | 'frozen',
    requestId: string | null,
  ) {
    this.quota('grading_revisions', MAX_GRADING_REVISIONS);
    this.db
      .prepare('INSERT INTO grading_revisions VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.revision, operation, record.updatedAt, requestId, payload);
  }
  private save(
    record: GradingDraftRecord,
    payload: GradingPayload,
    operation: 'edited' | 'rebound' | 'generated' | 'frozen',
    requestId: string | null = null,
  ) {
    const serialized = JSON.stringify(validateGradingPayload(this.db, payload));
    this.db
      .prepare('UPDATE grading_drafts SET revision=?, status=?, updated_at=?, payload=? WHERE id=?')
      .run(record.revision, record.status, record.updatedAt, serialized, record.id);
    this.appendRevision(record, serialized, operation, requestId);
  }

  /** 创建不可变细则版本，同请求同内容重放；新版本使旧来源显示过期，不改旧审核。 */
  createRubric(raw: unknown) {
    const input = rubricCreateInput.parse(raw);
    this.guard(input.epoch);
    const definition = validateRubric(input.definition);
    const requestHash = gradingDigest({
      scoreVersionId: input.scoreVersionId,
      subjectId: input.subjectId,
      definition,
    });
    const existing = this.db
      .prepare('SELECT id FROM rubric_versions WHERE request_id=?')
      .get(input.requestId);
    if (existing) {
      const view = readRubric(this.db, String(existing.id));
      if (view.record.requestHash !== requestHash)
        throw new DomainError('CONFLICT', '细则请求编号已用于其他内容。');
      return { id: view.record.id, revision: view.record.revision, replayed: true };
    }
    const score = readGradingScore(this.db, input.scoreVersionId);
    const subject = score.payload.analysis.subjects.find((value) => value.id === input.subjectId);
    if (
      !subject ||
      subject.precision !== definition.precision ||
      Math.round(Number(subject.maxScore) * 100) !== definition.maxHundredths
    )
      throw new DomainError('GRADING_INVALID', '细则满分、小数位或科目不符合所选考试。');
    if (
      this.db
        .prepare('SELECT id FROM score_versions WHERE exam_id=? ORDER BY revision DESC LIMIT 1')
        .get(score.record.examId)?.id !== score.record.id
    )
      throw new DomainError('GRADING_STALE', '成绩有新版本，请重新读取考试。');
    const previous = this.db
      .prepare(
        'SELECT revision, created_at AS createdAt FROM rubric_versions WHERE exam_id=? AND subject_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(score.record.examId, input.subjectId);
    const payload = JSON.stringify(definition);
    if (Buffer.byteLength(payload) > MAX_RUBRIC_PAYLOAD_BYTES)
      throw new DomainError('GRADING_LIMIT', '评分细则超过 1 MiB。');
    const record = {
      id: randomUUID(),
      examId: score.record.examId,
      subjectId: input.subjectId,
      scoreVersionId: score.record.id,
      revision: Number(previous?.revision ?? 0) + 1,
      requestId: input.requestId,
      requestHash,
      createdAt: timestamp(
        Date.parse(score.record.createdAt),
        previous ? Date.parse(String(previous.createdAt)) : 0,
      ),
    };
    transaction(this.db, () => {
      this.quota('rubric_versions', MAX_RUBRIC_VERSIONS);
      this.db
        .prepare('INSERT INTO rubric_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          record.id,
          record.examId,
          record.subjectId,
          record.scoreVersionId,
          record.revision,
          record.requestId,
          record.requestHash,
          record.createdAt,
          payload,
        );
    });
    return { id: record.id, revision: record.revision, replayed: false };
  }
  readRubric(raw: unknown) {
    const input = rubricReadInput.parse(raw);
    this.guard(input.epoch);
    return readRubric(this.db, input.id);
  }
  listRubrics(raw: unknown) {
    const input = rubricListInput.parse(raw);
    this.guard(input.epoch);
    return this.db
      .prepare(
        `SELECT ${RUBRIC_COLUMNS} FROM rubric_versions WHERE exam_id=? AND subject_id=? ORDER BY revision DESC LIMIT ? OFFSET ?`,
      )
      .all(input.examId, input.subjectId, input.limit, input.offset)
      .map((row) => rubricRecordSchema.parse(row));
  }

  /** 明确创建答卷或旧复核的修订草案，修订清除审核声明；重复请求不产生第二份。 */
  create(raw: unknown) {
    const input = gradingCreateInput.parse(raw);
    this.guard(input.epoch);
    const createHash = gradingDigest({ request: input.request, baseReviewId: input.baseReviewId });
    const existing = this.db
      .prepare('SELECT id FROM grading_drafts WHERE create_request_id=?')
      .get(input.requestId);
    if (existing) {
      const draft = readGradingDraft(this.db, String(existing.id));
      if (draft.record.createHash !== createHash)
        throw new DomainError('CONFLICT', '答卷请求编号已用于其他内容。');
      return receipt(draft.record, true);
    }
    const prep = storedGradingPreparation(this.db, input.request);
    this.assertCurrent(prep);
    let rows = validateGradingOutput('{"formatVersion":1,"assessments":[]}', prep);
    let baseTime = 0;
    if (input.baseReviewId) {
      const base = readGradingReview(this.db, input.baseReviewId);
      if (!sameBinding(base.payload.request, input.request))
        throw new DomainError('GRADING_INVALID', '修订必须属于同一考试、学生和科目。');
      baseTime = Date.parse(base.record.createdAt);
      if (base.payload.inputHash === prep.fingerprint)
        rows = base.payload.rows.map((value) => ({ ...value, reviewed: false }));
    }
    const createdAt = timestamp(gradingSourceTime(this.db, input.request), baseTime);
    const record: GradingDraftRecord = {
      id: randomUUID(),
      revision: 1,
      status: 'draft',
      createdAt,
      updatedAt: createdAt,
      createRequestId: input.requestId,
      createHash,
      baseReviewId: input.baseReviewId,
    };
    const payload = JSON.stringify(
      validateGradingPayload(this.db, {
        formatVersion: 1,
        initialRequest: input.request,
        request: input.request,
        inputHash: prep.fingerprint,
        rows,
      }),
    );
    transaction(this.db, () => {
      this.quota('grading_drafts', MAX_GRADING_DRAFTS);
      this.db
        .prepare('INSERT INTO grading_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          record.id,
          record.revision,
          record.status,
          record.createdAt,
          record.updatedAt,
          record.createRequestId,
          record.createHash,
          record.baseReviewId,
          payload,
        );
      this.checkpoint?.('draft-stored');
      this.appendRevision(record, payload, 'created', input.requestId);
    });
    this.checkpoint?.('committed');
    return receipt(record);
  }
  read(raw: unknown) {
    const input = gradingReadInput.parse(raw);
    this.guard(input.epoch);
    return readGradingDraft(this.db, input.id);
  }
  readReview(raw: unknown) {
    const input = gradingReadInput.parse(raw);
    this.guard(input.epoch);
    return readGradingReview(this.db, input.id);
  }
  list(raw: unknown) {
    const input = gradingListInput.parse(raw);
    this.guard(input.epoch);
    return this.db
      .prepare(
        `SELECT ${GRADING_DRAFT_COLUMNS}, json_extract(payload, '$.request.studentId') AS studentId, json_extract(payload, '$.request.subjectId') AS subjectId FROM grading_drafts WHERE json_extract(payload, '$.request.examId')=? AND (?=1 OR status='draft') ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(input.examId, input.includeFrozen ? 1 : 0, input.limit, input.offset)
      .map(({ studentId, subjectId, ...record }) => ({
        record: gradingDraftRecordSchema.parse(record),
        studentId: z.uuid().parse(studentId),
        subjectId: z.uuid().parse(subjectId),
      }));
  }
  attempts(raw: unknown) {
    const input = gradingReadInput.parse(raw);
    this.guard(input.epoch);
    readGradingDraft(this.db, input.id);
    return this.db
      .prepare(
        `SELECT ${GRADING_ATTEMPT_COLUMNS} FROM grading_attempts WHERE draft_id=? ORDER BY started_at, id LIMIT 20`,
      )
      .all(input.id)
      .map((row) => readGradingAttempt(this.db, String(row.id)));
  }
  /** 读取不可变草案修订快照，分页最多 50 条；可限定确切 revision，无写入、模型调用或自动重试。 */
  history(raw: unknown) {
    const input = gradingHistoryInput.parse(raw);
    this.guard(input.epoch);
    readGradingDraft(this.db, input.id);
    return this.db
      .prepare(
        'SELECT draft_id AS draftId, revision, operation, created_at AS createdAt, request_id AS requestId, payload FROM grading_revisions WHERE draft_id=? AND (? IS NULL OR revision=?) ORDER BY revision DESC LIMIT ? OFFSET ?',
      )
      .all(input.id, input.revision ?? null, input.revision ?? null, input.limit, input.offset)
      .map(({ payload, ...record }) => ({
        record: gradingRevisionRecordSchema.parse(record),
        payload: validateGradingPayload(this.db, JSON.parse(String(payload))),
      }));
  }

  /** 保存具名人工修改；来源过期或生成中拒绝，原成绩不变，同一次失回包可精确重放。 */
  edit(raw: unknown) {
    const input = gradingEditInput.parse(raw);
    this.guard(input.epoch);
    const draft = this.assertEditable(input.id);
    const prep = storedGradingPreparation(this.db, draft.payload.request);
    this.assertCurrent(prep);
    const rows = applyGradingEdits(draft.payload.rows, input.edits, prep);
    if (
      draft.record.revision === input.expectedRevision + 1 &&
      gradingDigest(rows) === gradingDigest(draft.payload.rows)
    )
      return receipt(draft.record, true);
    this.checkRevision(draft.record, input.expectedRevision);
    const record = {
      ...draft.record,
      revision: draft.record.revision + 1,
      updatedAt: timestamp(Date.parse(draft.record.updatedAt)),
    };
    transaction(this.db, () => {
      this.save(record, { ...draft.payload, rows }, 'edited');
      this.checkpoint?.('edited');
    });
    this.pending = undefined;
    this.checkpoint?.('committed');
    return receipt(record);
  }
  /** 显式重绑新的细则/图像/成绩版本，整份来源变动清除全部审核，旧冻结版不变。 */
  rebind(raw: unknown) {
    const input = gradingRebindInput.parse(raw);
    this.guard(input.epoch);
    const draft = this.assertEditable(input.id);
    if (!sameBinding(draft.payload.request, input.request))
      throw new DomainError('GRADING_INVALID', '更换考试、学生或科目须创建新的答卷。');
    const prep = storedGradingPreparation(this.db, input.request);
    this.assertCurrent(prep);
    if (
      draft.record.revision === input.expectedRevision + 1 &&
      gradingDigest(input.request) === gradingDigest(draft.payload.request)
    )
      return receipt(draft.record, true);
    this.checkRevision(draft.record, input.expectedRevision);
    const rows =
      prep.fingerprint === draft.payload.inputHash
        ? draft.payload.rows
        : validateGradingOutput('{"formatVersion":1,"assessments":[]}', prep);
    const record = {
      ...draft.record,
      revision: draft.record.revision + 1,
      updatedAt: timestamp(
        Date.parse(draft.record.updatedAt),
        gradingSourceTime(this.db, input.request),
      ),
    };
    transaction(this.db, () => {
      this.save(
        record,
        {
          ...draft.payload,
          request: input.request,
          inputHash: prep.fingerprint,
          rows,
        },
        'rebound',
      );
      this.checkpoint?.('edited');
    });
    this.pending = undefined;
    this.checkpoint?.('committed');
    return receipt(record);
  }
  /** 准备只产生私有短期令牌，不启动付费；选中已复核题目须明确同意替换其建议。 */
  prepare(raw: unknown) {
    const { epoch } = epochInput.strip().parse(raw);
    this.guard(epoch);
    if (
      this.pending?.requestId &&
      this.db
        .prepare("SELECT id FROM grading_attempts WHERE id=? AND status='running'")
        .get(this.pending.requestId)
    )
      throw new DomainError('BUSY', '答卷生成尚未结束，请先取消或等待。');
    this.pending = undefined;
    const input = gradingPrepareInput.parse(raw);
    const draft = this.assertEditable(input.id);
    this.checkRevision(draft.record, input.expectedRevision);
    const request = {
      ...draft.payload.request,
      selectedPageIds: input.selectedPageIds,
      selectedQuestionIds: input.selectedQuestionIds,
    };
    const preparation = storedGradingPreparation(this.db, request);
    this.assertCurrent(preparation);
    if (
      !input.acknowledgeReplaceReviewed &&
      draft.payload.rows.some(
        (row) => row.reviewed && request.selectedQuestionIds.includes(row.questionId),
      )
    )
      throw new DomainError('GRADING_INVALID', '所选题目已人工复核，请明确确认替换范围。');
    const token = randomUUID(),
      expiresAt = Date.now() + 15 * 60 * 1000;
    this.pending = {
      token,
      epoch,
      id: draft.record.id,
      revision: draft.record.revision,
      expiresAt,
      preparation,
    };
    return { token, expiresAt: new Date(expiresAt).toISOString(), preparation };
  }
  private pendingPreparation(epoch: string, token: string) {
    this.guard(epoch);
    const pending = this.pending;
    if (
      !pending ||
      pending.token !== token ||
      pending.epoch !== epoch ||
      Date.now() >= pending.expiresAt
    )
      throw new DomainError('GRADING_EXPIRED', '阅卷准备已失效，请重新核对外发范围。');
    const draft = readGradingDraft(this.db, pending.id);
    this.checkRevision(draft.record, pending.revision);
    if (
      draft.record.status !== 'draft' ||
      draft.payload.inputHash !== pending.preparation.fingerprint
    )
      throw new DomainError('GRADING_STALE', '答卷依据已变化。');
    this.assertCurrent(pending.preparation);
    return pending;
  }
  /** 付费前只认领一次并保存运行尝试；再次认领拒绝，不自动重放或重试。 */
  claim(raw: unknown) {
    const input = gradingClaimInput.parse(raw);
    const pending = this.pendingPreparation(input.epoch, input.token);
    if (
      pending.requestId ||
      this.db.prepare('SELECT id FROM grading_attempts WHERE id=?').get(input.requestId) ||
      this.db.prepare("SELECT id FROM grading_attempts WHERE status='running'").get()
    )
      throw new DomainError('CONFLICT', '已有阅卷任务或请求编号已使用。');
    if (
      Number(
        this.db
          .prepare('SELECT COUNT(*) AS count FROM grading_attempts WHERE draft_id=?')
          .get(pending.id)?.count,
      ) >= 20
    )
      throw new DomainError('GRADING_LIMIT', '单份答卷已达 20 次尝试上限，请创建明确的修订草案。');
    const payload = {
      token: input.token,
      request: pending.preparation.request,
      inputHash: pending.preparation.fingerprint,
      output: null,
      provider: null,
    };
    const requestHash = gradingDigest({
      token: input.token,
      draftId: pending.id,
      baseRevision: pending.revision,
      request: payload.request,
      inputHash: payload.inputHash,
    });
    const startedAt = timestamp(Date.parse(readGradingDraft(this.db, pending.id).record.updatedAt));
    transaction(this.db, () => {
      this.quota('grading_attempts', MAX_GRADING_ATTEMPTS);
      this.db
        .prepare(
          "INSERT INTO grading_attempts VALUES (?, ?, ?, 'running', ?, NULL, NULL, ?, NULL, NULL, ?)",
        )
        .run(
          input.requestId,
          pending.id,
          pending.revision,
          startedAt,
          requestHash,
          JSON.stringify(payload),
        );
      this.checkpoint?.('attempt-claimed');
    });
    pending.requestId = input.requestId;
    pending.expiresAt = Date.now() + 2 * 60 * 1000;
    return pending.preparation;
  }
  /** 内部完成：有效输出与本批选题一致，保留其余题目/人工进度；同结果提交幂等。 */
  complete(raw: unknown, admitCommit?: () => void) {
    const input = gradingCompleteInput.parse(raw);
    this.guard(input.epoch);
    const attempt = readGradingAttempt(this.db, input.requestId);
    const resultHash = gradingDigest({
      token: input.token,
      provider: input.provider,
      output: input.output,
    });
    if (attempt.record.status === 'succeeded') {
      if (attempt.record.resultHash !== resultHash)
        throw new DomainError('CONFLICT', '请求编号已保存不同阅卷结果。');
      return {
        id: attempt.record.draftId,
        revision: attempt.record.resultRevision!,
        status: 'draft' as const,
        replayed: true,
      };
    }
    const pending = this.pendingPreparation(input.epoch, input.token);
    if (
      attempt.record.status !== 'running' ||
      pending.requestId !== input.requestId ||
      attempt.payload.token !== input.token
    )
      throw new DomainError('CONFLICT', '任务已取消、中断或结果不属于已认领范围。');
    const draft = readGradingDraft(this.db, pending.id);
    const generated = validateGradingOutput(input.output, pending.preparation);
    const rows = draft.payload.rows.map((row) =>
      pending.preparation.request.selectedQuestionIds.includes(row.questionId)
        ? generated.find((value) => value.questionId === row.questionId)!
        : row,
    );
    const endedAt = timestamp(
      Date.parse(attempt.record.startedAt),
      Date.parse(input.provider.generatedAt),
    );
    const record = { ...draft.record, revision: draft.record.revision + 1, updatedAt: endedAt };
    const payload = JSON.stringify({
      ...attempt.payload,
      provider: input.provider,
      output: input.output,
    });
    if (Buffer.byteLength(payload) > MAX_GRADING_ATTEMPT_BYTES)
      throw new DomainError('GRADING_LIMIT', '阅卷尝试结果超过保存上限。');
    transaction(this.db, () => {
      this.save(record, { ...draft.payload, rows }, 'generated', input.requestId);
      this.db
        .prepare(
          "UPDATE grading_attempts SET status='succeeded', ended_at=?, result_revision=?, result_hash=?, payload=? WHERE id=?",
        )
        .run(endedAt, record.revision, resultHash, payload, input.requestId);
      this.checkpoint?.('attempt-completed');
      admitCommit?.();
    });
    this.pending = undefined;
    this.checkpoint?.('committed');
    return receipt(record);
  }
  /** 失败/取消只结束指定尝试，保留答卷输入和全部已存进度；迟到结果不能再完成。 */
  end(raw: unknown) {
    const input = gradingEndInput.parse(raw);
    this.guard(input.epoch);
    const attempt = readGradingAttempt(this.db, input.requestId);
    if (attempt.record.status !== 'running')
      return { status: attempt.record.status, replayed: true };
    transaction(this.db, () =>
      this.db
        .prepare('UPDATE grading_attempts SET status=?, ended_at=?, error_code=? WHERE id=?')
        .run(
          input.status,
          timestamp(Date.parse(attempt.record.startedAt)),
          input.errorCode,
          input.requestId,
        ),
    );
    if (this.pending?.requestId === input.requestId) this.pending = undefined;
    return { status: input.status, replayed: false };
  }
  cancel(raw: unknown) {
    const { epoch } = epochInput.parse(raw);
    this.guard(epoch);
    if (this.pending?.requestId)
      this.end({
        epoch,
        requestId: this.pending.requestId,
        status: 'cancelled',
        errorCode: 'GRADING_CANCELLED',
      });
    this.pending = undefined;
  }
  /** 全部题目及页数完整、教师明确复核且来源仍最新时冻结；不更新正式成绩。 */
  freeze(raw: unknown, admitCommit?: () => void) {
    const input = gradingFreezeInput.parse(raw);
    this.guard(input.epoch);
    const existing = this.db
      .prepare('SELECT id FROM grading_reviews WHERE request_id=?')
      .get(input.requestId);
    if (existing) {
      const review = readGradingReview(this.db, String(existing.id));
      if (
        review.record.draftId !== input.id ||
        review.record.draftRevision !== input.expectedRevision + 1 ||
        review.record.reason !== input.reason
      )
        throw new DomainError('CONFLICT', '确认编号已用于其他复核。');
      return {
        reviewId: review.record.id,
        totalHundredths: review.record.totalHundredths,
        replayed: true,
      };
    }
    const draft = this.assertEditable(input.id);
    this.checkRevision(draft.record, input.expectedRevision);
    const prep = storedGradingPreparation(this.db, draft.payload.request);
    this.assertCurrent(prep);
    const confirmed = validateGradingReview(draft.payload.rows, prep, draft.payload.inputHash);
    const record = {
      ...draft.record,
      revision: draft.record.revision + 1,
      status: 'frozen' as const,
      updatedAt: timestamp(Date.parse(draft.record.updatedAt)),
    };
    const id = randomUUID();
    const requestHash = gradingDigest({
      id: draft.record.id,
      expectedRevision: input.expectedRevision,
      payload: draft.payload,
      reason: input.reason,
    });
    transaction(this.db, () => {
      this.quota('grading_reviews', MAX_GRADING_REVIEWS);
      this.save(record, draft.payload, 'frozen', input.requestId);
      this.db
        .prepare('INSERT INTO grading_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          id,
          input.id,
          record.revision,
          input.requestId,
          requestHash,
          record.updatedAt,
          confirmed.totalHundredths,
          input.reason,
          JSON.stringify(draft.payload),
        );
      this.checkpoint?.('frozen');
      admitCommit?.();
    });
    this.pending = undefined;
    this.checkpoint?.('committed');
    return { reviewId: id, totalHundredths: confirmed.totalHundredths, replayed: false };
  }
}
