import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { epochInput } from '../shared/contracts';
import type { ScoreVersionView } from '../shared/score-commands';
import type { ExplanationPacket } from '../shared/score-explanation';
import {
  explanationClaimInput,
  explanationCompleteInput,
  explanationDiscardInput,
  explanationEditInput,
  explanationListInput,
  explanationPayloadSchema,
  explanationPrepareInput,
  explanationReadInput,
  explanationRecordSchema,
  type ExplanationDraftReceipt,
  type ExplanationDraftSummary,
  type ExplanationDraftView,
  type ExplanationPreparation,
  type ExplanationRecord,
} from '../shared/explanation-drafts';
import { prepareExplanation, validateExplanationOutput } from './score-explanation';
import {
  EXPLANATION_COLUMNS,
  initialExplanationContent,
  serializeExplanation,
} from './explanation-records';
import { MAX_EXPLANATION_DRAFTS } from './storage-limits';
import { DomainError } from './errors';
import { transaction } from './database';

export type ExplanationCheckpoint = (
  stage: 'generated' | 'edited' | 'discarded' | 'committed',
) => void;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = (record: ExplanationRecord, replayed = false): ExplanationDraftReceipt => ({
  id: record.id,
  revision: record.revision,
  status: record.status,
  replayed,
});

function scopeLabel(
  scope: ExplanationDraftSummary['scope'],
  roster: Array<{ studentId: string; studentNumber: string; displayName: string }>,
): string {
  if (scope.kind === 'class') return '班级';
  const student = roster.find((item) => item.studentId === scope.studentId);
  return student ? `${student.studentNumber} ${student.displayName}` : '历史学生';
}

/** Owns one prepared generation and persistent drafts; it never calls the network or changes scores. */
export class ExplanationBook {
  private alive = true;
  private pending?: {
    token: string;
    epoch: string;
    expiresAt: number;
    packet: string;
    requestId?: string;
  };

  constructor(
    private readonly db: DatabaseSync,
    private readonly epoch: () => string,
    private readonly readScore: (versionId: string) => ScoreVersionView,
    private readonly checkpoint?: ExplanationCheckpoint,
  ) {}

  private guard(epoch: string): void {
    if (!this.alive || epoch !== this.epoch())
      throw new DomainError('STALE', '数据工作区已切换，请重新读取解释草案。');
  }
  dispose(): void {
    this.pending = undefined;
    this.alive = false;
  }
  cancel(raw: unknown): void {
    const { epoch } = epochInput.parse(raw);
    this.guard(epoch);
    this.pending = undefined;
  }
  prepare(raw: unknown): ExplanationPreparation {
    const { epoch } = epochInput.strip().parse(raw);
    this.guard(epoch);
    this.pending = undefined;
    const input = explanationPrepareInput.parse(raw);
    const packet = prepareExplanation(this.readScore(input.sourceVersionId), input.selection);
    const token = randomUUID();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    this.pending = { token, epoch, expiresAt, packet: JSON.stringify(packet) };
    return { token, expiresAt: new Date(expiresAt).toISOString(), packet };
  }
  private pendingPacket(epoch: string, token: string) {
    this.guard(epoch);
    const pending = this.pending;
    if (
      !pending ||
      pending.epoch !== epoch ||
      pending.token !== token ||
      Date.now() >= pending.expiresAt
    )
      throw new DomainError('EXPLANATION_EXPIRED', '解释生成准备已失效，请重新选择指标。');
    const packet = JSON.parse(pending.packet) as ExplanationPacket;
    if (this.readScore(packet.sourceVersionId).stale) {
      this.pending = undefined;
      throw new DomainError('STALE', '成绩已更正，旧来源的生成结果不会保存。');
    }
    return { pending, packet };
  }
  claim(raw: unknown): ExplanationPacket {
    const input = explanationClaimInput.parse(raw);
    const { pending, packet } = this.pendingPacket(input.epoch, input.token);
    if (pending.requestId)
      throw new DomainError('CONFLICT', '此生成任务已发起，不能重复调用模型。');
    if (
      this.db
        .prepare('SELECT id FROM explanation_drafts WHERE generation_request_id=?')
        .get(input.requestId)
    )
      throw new DomainError('CONFLICT', '生成请求编号已使用，请建立新任务。');
    pending.requestId = input.requestId;
    // Give an already claimed request enough time for the 60-second network deadline and handoff.
    pending.expiresAt = Date.now() + 2 * 60 * 1000;
    return packet;
  }
  complete(raw: unknown, admitCommit?: () => void): ExplanationDraftReceipt {
    const input = explanationCompleteInput.parse(raw);
    this.guard(input.epoch);
    const generationHash = digest({
      token: input.token,
      provider: input.provider,
      output: input.output,
    });
    const existing = this.db
      .prepare(
        `SELECT ${EXPLANATION_COLUMNS} FROM explanation_drafts WHERE generation_request_id=?`,
      )
      .get(input.requestId);
    if (existing) {
      const record = explanationRecordSchema.parse(existing);
      if (record.generationHash !== generationHash)
        throw new DomainError('CONFLICT', '生成请求编号已用于不同内容。');
      return receipt(record, true);
    }
    const { pending, packet } = this.pendingPacket(input.epoch, input.token);
    if (pending.requestId !== input.requestId)
      throw new DomainError('CONFLICT', '结果不属于已发起的生成任务。');
    const original = validateExplanationOutput(input.output, packet);
    const payload = serializeExplanation({
      formatVersion: 1,
      promptVersion: packet.promptVersion,
      selection: packet.selection,
      inputHash: packet.inputHash,
      provider: input.provider,
      original,
      content: initialExplanationContent(original),
    });
    const source = this.readScore(packet.sourceVersionId);
    const timestamp = new Date(
      Math.max(
        Date.now(),
        Date.parse(source.record.createdAt),
        Date.parse(input.provider.generatedAt),
      ),
    ).toISOString();
    const record: ExplanationRecord = {
      id: randomUUID(),
      sourceVersionId: packet.sourceVersionId,
      revision: 1,
      status: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
      discardedAt: null,
      generationRequestId: input.requestId,
      generationHash,
    };
    transaction(this.db, () => {
      if (
        Number(this.db.prepare('SELECT COUNT(*) AS count FROM explanation_drafts').get()?.count) >=
        MAX_EXPLANATION_DRAFTS
      )
        throw new DomainError('EXPLANATION_LIMIT', '解释草案数量达到上限，请先备份并联系维护者。');
      this.db
        .prepare(
          `INSERT INTO explanation_drafts
        (id, source_version_id, revision, status, created_at, updated_at, discarded_at, generation_request_id, generation_hash, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.sourceVersionId,
          record.revision,
          record.status,
          record.createdAt,
          record.updatedAt,
          null,
          record.generationRequestId,
          record.generationHash,
          payload,
        );
      this.checkpoint?.('generated');
      // Main may cancel while this worker is busy; admission is checked before committing.
      admitCommit?.();
    });
    this.pending = undefined;
    this.checkpoint?.('committed');
    return receipt(record);
  }
  private stored(id: string) {
    const raw = this.db
      .prepare(`SELECT ${EXPLANATION_COLUMNS}, payload FROM explanation_drafts WHERE id=?`)
      .get(id);
    if (!raw) throw new DomainError('NOT_FOUND', '解释草案不存在。');
    const { payload, ...record } = raw;
    return {
      record: explanationRecordSchema.parse(record),
      payload: explanationPayloadSchema.parse(JSON.parse(String(payload))),
    };
  }
  read(raw: unknown): ExplanationDraftView {
    const input = explanationReadInput.parse(raw);
    this.guard(input.epoch);
    const { record, payload } = this.stored(input.id);
    const source = this.readScore(record.sourceVersionId);
    return {
      record,
      payload,
      scopeLabel: scopeLabel(payload.selection.scope, source.payload.analysis.roster),
      packet: prepareExplanation({ ...source, stale: false }, payload.selection),
      stale: source.stale,
      latestSourceVersionId: source.latestVersionId,
    };
  }
  list(raw: unknown): ExplanationDraftSummary[] {
    const input = explanationListInput.parse(raw);
    this.guard(input.epoch);
    const ids = this.db
      .prepare(
        `SELECT d.id FROM explanation_drafts d JOIN score_versions v ON v.id=d.source_version_id
      WHERE (? IS NULL OR v.exam_id=?) AND (?=1 OR d.status='draft') ORDER BY d.updated_at DESC, d.id`,
      )
      .all(input.examId ?? null, input.examId ?? null, input.includeDiscarded ? 1 : 0);
    const sources = new Map<
      string,
      { examId: string; examName: string; stale: boolean; students: Map<string, string> }
    >();
    return ids.map(({ id }) => {
      const { record, payload } = this.stored(String(id));
      let source = sources.get(record.sourceVersionId);
      if (!source) {
        // Parse each source once per list; many drafts can share a large historical score payload.
        const storedSource = this.db
          .prepare(
            "SELECT exam_id AS examId, json_extract(payload, '$.definition.name') AS name, json_extract(payload, '$.analysis.roster') AS roster FROM score_versions WHERE id=?",
          )
          .get(record.sourceVersionId)!;
        const latest = this.db
          .prepare('SELECT id FROM score_versions WHERE exam_id=? ORDER BY revision DESC LIMIT 1')
          .get(String(storedSource.examId))!;
        source = {
          examId: String(storedSource.examId),
          examName: String(storedSource.name),
          stale: latest.id !== record.sourceVersionId,
          students: new Map(
            (
              JSON.parse(String(storedSource.roster)) as Array<{
                studentId: string;
                studentNumber: string;
                displayName: string;
              }>
            ).map((student) => [
              student.studentId,
              `${student.studentNumber} ${student.displayName}`,
            ]),
          ),
        };
        sources.set(record.sourceVersionId, source);
      }
      return {
        record,
        examId: source.examId,
        examName: source.examName,
        stale: source.stale,
        scopeLabel:
          payload.selection.scope.kind === 'class'
            ? '班级'
            : (source.students.get(payload.selection.scope.studentId) ?? '历史学生'),
        scope: payload.selection.scope,
      };
    });
  }
  edit(raw: unknown): ExplanationDraftReceipt {
    const input = explanationEditInput.parse(raw);
    this.guard(input.epoch);
    return transaction(this.db, () => {
      const { record, payload } = this.stored(input.id);
      if (record.status !== 'draft') throw new DomainError('CONFLICT', '已丢弃草案不能编辑。');
      const same = JSON.stringify(payload.content) === JSON.stringify(input.content);
      if (
        same &&
        (input.expectedRevision === record.revision ||
          input.expectedRevision === record.revision - 1)
      )
        return receipt(record, true);
      if (input.expectedRevision !== record.revision)
        throw new DomainError('CONFLICT', '草案已修改，请重新读取。');
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(record.updatedAt))).toISOString();
      this.db
        .prepare(
          'UPDATE explanation_drafts SET revision=revision+1, updated_at=?, payload=? WHERE id=?',
        )
        .run(updatedAt, serializeExplanation({ ...payload, content: input.content }), record.id);
      this.checkpoint?.('edited');
      return receipt({ ...record, revision: record.revision + 1, updatedAt });
    });
  }
  discard(raw: unknown): ExplanationDraftReceipt {
    const input = explanationDiscardInput.parse(raw);
    this.guard(input.epoch);
    return transaction(this.db, () => {
      const { record } = this.stored(input.id);
      if (record.status === 'discarded' && input.expectedRevision === record.revision - 1)
        return receipt(record, true);
      if (record.status !== 'draft' || input.expectedRevision !== record.revision)
        throw new DomainError('CONFLICT', '草案状态已变化，请重新读取。');
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(record.updatedAt))).toISOString();
      this.db
        .prepare(
          "UPDATE explanation_drafts SET revision=revision+1, status='discarded', updated_at=?, discarded_at=? WHERE id=?",
        )
        .run(updatedAt, updatedAt, record.id);
      this.checkpoint?.('discarded');
      return receipt({
        ...record,
        revision: record.revision + 1,
        status: 'discarded',
        updatedAt,
        discardedAt: updatedAt,
      });
    });
  }
}
