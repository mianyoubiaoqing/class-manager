import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { epochInput, type Snapshot } from '../shared/contracts';
import {
  growthEventSaveInput,
  growthEventSchema,
  growthStudentInput,
  growthReadInput,
  growthPrepareInput,
  growthClaimInput,
  growthCompleteInput,
  growthManualInput,
  growthSummarySchema,
  growthSummaryEditInput,
  growthSummaryDiscardInput,
  growthConfirmInput,
  growthEntrySchema,
  type GrowthEvent,
  type GrowthEventRevision,
  type GrowthSelection,
  type GrowthSummary,
  type GrowthTimeline,
  type GrowthPacket,
  type GrowthPreparation,
  type GrowthReceipt,
  type GrowthSummaryView,
  type GrowthConfirmReceipt,
} from '../shared/growth';
import {
  growthHash,
  growthPacket,
  growthOutput,
  assertGrowthRedacted,
  growthOutboundPacket,
} from './growth-source';
import { transaction } from './database';
import { DomainError } from './errors';
import {
  MAX_GROWTH_EVENTS,
  MAX_GROWTH_EVENT_REVISIONS,
  MAX_GROWTH_SUMMARIES,
  MAX_GROWTH_SUMMARY_REVISIONS,
  MAX_GROWTH_EVENT_BYTES,
  MAX_GROWTH_SUMMARY_BYTES,
} from './storage-limits';

export type GrowthCheckpoint = (
  stage: 'event-written' | 'summary-written' | 'entry-written' | 'committed',
) => void;
/** 教师私有事实、独立总结草案和不可变正式条目的本地边界；精确来源、事务、幂等和失效都由后台处理。 */
export class GrowthBook {
  private alive = true;
  private pending?: {
    token: string;
    epoch: string;
    expiresAt: number;
    packet: GrowthPacket;
    requestId?: string;
  };
  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshot: () => Snapshot,
    private readonly checkpoint?: GrowthCheckpoint,
  ) {}
  private guard(epoch: string) {
    if (!this.alive || epoch !== this.snapshot().epoch)
      throw new DomainError('STALE_WORKSPACE', '成长档案工作区已切换，请重新读取。');
  }
  dispose(): void {
    this.pending = undefined;
    this.alive = false;
  }
  private limit(
    table:
      'growth_events' | 'growth_event_revisions' | 'growth_summaries' | 'growth_summary_revisions',
    maximum: number,
  ) {
    if (Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count) >= maximum)
      throw new DomainError(
        'STORAGE_LIMIT',
        '成长记录容量达到上限，请先备份并联系维护者，原记录保留。',
      );
  }
  private serialize(value: GrowthEvent | GrowthSummary, maximum: number) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > maximum)
      throw new DomainError('STORAGE_LIMIT', '成长记录超过单份容量上限。');
    return json;
  }
  private student(studentId: string) {
    const student = this.snapshot().students.find((s) => s.id === studentId);
    if (!student) throw new DomainError('NOT_FOUND', '学生不存在。');
    if (!student.active || !student.classId)
      throw new DomainError('GROWTH_MEMBER', '学生已停用，请查看历史，不能建立或更正当前记录。');
    return student;
  }
  private event(id: string): GrowthEvent {
    const row = this.db.prepare('SELECT payload FROM growth_events WHERE id=?').get(id);
    if (!row) throw new DomainError('NOT_FOUND', '事件记录不存在。');
    return growthEventSchema.parse(JSON.parse(String(row.payload)));
  }
  private summary(id: string): GrowthSummary {
    const row = this.db.prepare('SELECT payload FROM growth_summaries WHERE id=?').get(id);
    if (!row) throw new DomainError('NOT_FOUND', '阶段总结草案不存在。');
    return growthSummarySchema.parse(JSON.parse(String(row.payload)));
  }
  private timestamp(previous = '') {
    return new Date(Math.max(Date.now(), Date.parse(previous) || 0)).toISOString();
  }
  saveEvent(raw: unknown): GrowthReceipt {
    const input = growthEventSaveInput.parse(raw);
    this.guard(input.epoch);
    const inputHash = growthHash(input);
    const replay = this.db
      .prepare(
        'SELECT event_id AS id, revision, input_hash AS hash FROM growth_event_revisions WHERE request_id=?',
      )
      .get(input.requestId);
    if (replay) {
      if (replay.hash !== inputHash)
        throw new DomainError('CONFLICT', '此记录请求已用于不同内容。');
      return { id: String(replay.id), revision: Number(replay.revision), replayed: true };
    }
    this.student(input.studentId);
    const previous = input.id ? this.event(input.id) : undefined;
    if (
      previous &&
      (previous.studentId !== input.studentId || previous.revision !== input.expectedRevision)
    )
      throw new DomainError('CONFLICT', '事件或学生已变化，请重新读取。');
    const now = this.timestamp(previous?.updatedAt);
    const record = growthEventSchema.parse({
      id: previous?.id ?? randomUUID(),
      studentId: input.studentId,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      content: input.content,
    });
    const payload = this.serialize(record, MAX_GROWTH_EVENT_BYTES);
    transaction(this.db, () => {
      if (!previous) {
        this.limit('growth_events', MAX_GROWTH_EVENTS);
        this.db
          .prepare('INSERT INTO growth_events VALUES (?,?,?,?)')
          .run(record.id, record.studentId, record.revision, payload);
      } else
        this.db
          .prepare('UPDATE growth_events SET revision=?,payload=? WHERE id=?')
          .run(record.revision, payload, record.id);
      this.limit('growth_event_revisions', MAX_GROWTH_EVENT_REVISIONS);
      this.db
        .prepare('INSERT INTO growth_event_revisions VALUES (?,?,?,?,?,?,?)')
        .run(record.id, record.revision, input.requestId, inputHash, input.reason, now, payload);
      this.checkpoint?.('event-written');
    });
    this.checkpoint?.('committed');
    return { id: record.id, revision: record.revision, replayed: false };
  }
  eventHistory(raw: unknown): GrowthEventRevision[] {
    const input = growthReadInput.parse(raw);
    this.guard(input.epoch);
    this.event(input.id);
    return this.db
      .prepare(
        'SELECT payload, request_id AS requestId, reason, created_at AS createdAt FROM growth_event_revisions WHERE event_id=? ORDER BY revision DESC',
      )
      .all(input.id)
      .map((row) => ({
        record: growthEventSchema.parse(JSON.parse(String(row.payload))),
        requestId: String(row.requestId),
        reason: String(row.reason),
        createdAt: String(row.createdAt),
      }));
  }
  private packet(selection: GrowthSelection, allowStale = false) {
    const member = this.student(selection.studentId);
    const result = growthPacket(this.db, {
      selection,
      studentRevision: member.revision,
      classId: member.classId!,
    });
    if (result.stale && !allowStale)
      throw new DomainError('GROWTH_STALE', '所选事件或成绩已有更正，请重新核对最新版本。');
    return result.packet;
  }
  prepare(raw: unknown): GrowthPreparation {
    this.pending = undefined;
    const input = growthPrepareInput.parse(raw);
    this.guard(input.epoch);
    const packet = growthOutboundPacket(this.packet(input.selection));
    assertGrowthRedacted(this.db, packet);
    const pending = {
      token: randomUUID(),
      epoch: input.epoch,
      expiresAt: Date.now() + 15 * 60 * 1000,
      packet: structuredClone(packet),
    };
    this.pending = pending;
    return {
      token: pending.token,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      packet: structuredClone(packet),
    };
  }
  cancel(raw: unknown): void {
    const { epoch } = epochInput.parse(raw);
    this.guard(epoch);
    this.pending = undefined;
  }
  private pendingPacket(epoch: string, token: string) {
    this.guard(epoch);
    const pending = this.pending;
    if (
      !pending ||
      pending.epoch !== epoch ||
      pending.token !== token ||
      pending.expiresAt <= Date.now()
    )
      throw new DomainError('GROWTH_EXPIRED', '总结生成准备已失效，请重新核对事实。');
    if (growthPacket(this.db, pending.packet.source).stale)
      throw new DomainError('GROWTH_STALE', '来源或学生已变化，旧结果不会保存。');
    return pending;
  }
  claim(raw: unknown): GrowthPacket {
    const input = growthClaimInput.parse(raw),
      pending = this.pendingPacket(input.epoch, input.token);
    if (
      pending.requestId ||
      this.db
        .prepare('SELECT draft_id FROM growth_summary_revisions WHERE request_id=?')
        .get(input.requestId)
    )
      throw new DomainError('CONFLICT', '总结任务已发起，不能重复调用。');
    assertGrowthRedacted(this.db, pending.packet);
    pending.requestId = input.requestId;
    pending.expiresAt = Date.now() + 2 * 60 * 1000;
    return structuredClone(pending.packet);
  }
  private addSummary(
    record: GrowthSummary,
    requestId: string,
    inputHash: string,
    admitCommit?: () => void,
  ): GrowthReceipt {
    const payload = this.serialize(record, MAX_GROWTH_SUMMARY_BYTES);
    transaction(this.db, () => {
      this.limit('growth_summaries', MAX_GROWTH_SUMMARIES);
      this.limit('growth_summary_revisions', MAX_GROWTH_SUMMARY_REVISIONS);
      this.db
        .prepare('INSERT INTO growth_summaries VALUES (?,?,?,?)')
        .run(record.id, record.studentId, record.revision, payload);
      this.db
        .prepare('INSERT INTO growth_summary_revisions VALUES (?,?,?,?,?,?,?)')
        .run(
          record.id,
          record.revision,
          'created',
          requestId,
          inputHash,
          record.updatedAt,
          payload,
        );
      this.checkpoint?.('summary-written');
      admitCommit?.();
    });
    this.checkpoint?.('committed');
    return { id: record.id, revision: 1, replayed: false };
  }
  complete(raw: unknown, admitCommit?: () => void): GrowthReceipt {
    const input = growthCompleteInput.parse(raw);
    this.guard(input.epoch);
    const inputHash = growthHash(input),
      replay = this.replay(input.requestId, inputHash);
    if (replay) return replay;
    const pending = this.pendingPacket(input.epoch, input.token);
    if (pending.requestId !== input.requestId)
      throw new DomainError('CONFLICT', '结果不属于已认领的总结任务。');
    const original = growthOutput(input.output, pending.packet);
    const facts = original.factIds.map(
      (id) => pending.packet.wire.facts.find((f) => f.id === id)!.text,
    );
    const content = [
      ...facts,
      ...original.suggestions.map((s) => `待教师核实的行动建议：${s.text}`),
      ...original.limitations.map((s) => `资料限制：${s}`),
    ].join('\n');
    const now = this.timestamp(input.provider.generatedAt);
    const record = growthSummarySchema.parse({
      id: randomUUID(),
      studentId: pending.packet.source.selection.studentId,
      revision: 1,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      source: pending.packet.source,
      inputHash: pending.packet.inputHash,
      provider: input.provider,
      original,
      content,
      reviewed: false,
      supersedesEntryId: null,
    });
    const receipt = this.addSummary(record, input.requestId, inputHash, admitCommit);
    this.pending = undefined;
    return receipt;
  }
  private replay(requestId: string, hash: string): GrowthReceipt | undefined {
    const row = this.db
      .prepare(
        'SELECT draft_id AS id,revision,input_hash AS hash FROM growth_summary_revisions WHERE request_id=?',
      )
      .get(requestId);
    if (!row) return;
    if (row.hash !== hash) throw new DomainError('CONFLICT', '此总结请求已用于不同内容。');
    return { id: String(row.id), revision: Number(row.revision), replayed: true };
  }
  createManual(raw: unknown): GrowthReceipt {
    const input = growthManualInput.parse(raw);
    this.guard(input.epoch);
    const inputHash = growthHash(input),
      replay = this.replay(input.requestId, inputHash);
    if (replay) return replay;
    const packet = this.packet(input.selection);
    if (input.supersedesEntryId) {
      const previous = this.db
        .prepare('SELECT payload FROM growth_summary_entries WHERE id=?')
        .get(input.supersedesEntryId);
      if (
        !previous ||
        growthEntrySchema.parse(JSON.parse(String(previous.payload))).studentId !==
          input.selection.studentId
      )
        throw new DomainError('GROWTH_SOURCE', '更正来源条目不属于此学生。');
    }
    const now = this.timestamp();
    const record = growthSummarySchema.parse({
      id: randomUUID(),
      studentId: input.selection.studentId,
      revision: 1,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      source: packet.source,
      inputHash: packet.inputHash,
      provider: null,
      original: null,
      content: input.content,
      reviewed: false,
      supersedesEntryId: input.supersedesEntryId ?? null,
    });
    return this.addSummary(record, input.requestId, inputHash);
  }
  readSummary(raw: unknown): GrowthSummaryView {
    const input = growthReadInput.parse(raw);
    this.guard(input.epoch);
    const record = this.summary(input.id),
      { packet, stale } = growthPacket(this.db, record.source);
    const entry = this.db
      .prepare('SELECT id FROM growth_summary_entries WHERE draft_id=?')
      .get(input.id);
    return { record, packet, stale, entryId: entry ? String(entry.id) : null };
  }
  private revise(record: GrowthSummary, operation: 'edited' | 'discarded' | 'confirmed') {
    const payload = this.serialize(record, MAX_GROWTH_SUMMARY_BYTES);
    this.limit('growth_summary_revisions', MAX_GROWTH_SUMMARY_REVISIONS);
    this.db
      .prepare('UPDATE growth_summaries SET revision=?,payload=? WHERE id=?')
      .run(record.revision, payload, record.id);
    this.db
      .prepare('INSERT INTO growth_summary_revisions VALUES (?,?,?,?,?,?,?)')
      .run(
        record.id,
        record.revision,
        operation,
        randomUUID(),
        growthHash(record),
        record.updatedAt,
        payload,
      );
    this.checkpoint?.('summary-written');
  }
  editSummary(raw: unknown): GrowthReceipt {
    const input = growthSummaryEditInput.parse(raw);
    this.guard(input.epoch);
    const previous = this.summary(input.id);
    this.student(previous.studentId);
    if (previous.status !== 'draft' || previous.revision !== input.expectedRevision)
      throw new DomainError('CONFLICT', '草稿已更改或入档，请重新读取。');
    const record = growthSummarySchema.parse({
      ...previous,
      content: input.content,
      reviewed: true,
      revision: previous.revision + 1,
      updatedAt: this.timestamp(previous.updatedAt),
    });
    transaction(this.db, () => this.revise(record, 'edited'));
    this.checkpoint?.('committed');
    return { id: record.id, revision: record.revision, replayed: false };
  }
  discardSummary(raw: unknown): GrowthReceipt {
    const input = growthSummaryDiscardInput.parse(raw);
    this.guard(input.epoch);
    const previous = this.summary(input.id);
    if (previous.status !== 'draft' || previous.revision !== input.expectedRevision)
      throw new DomainError('CONFLICT', '草稿已更改或入档，不能放弃。');
    const record = {
      ...previous,
      status: 'discarded' as const,
      revision: previous.revision + 1,
      updatedAt: this.timestamp(previous.updatedAt),
    };
    transaction(this.db, () => this.revise(record, 'discarded'));
    this.checkpoint?.('committed');
    return { id: record.id, revision: record.revision, replayed: false };
  }
  confirmSummary(raw: unknown): GrowthConfirmReceipt {
    const input = growthConfirmInput.parse(raw);
    this.guard(input.epoch);
    const replay = this.db
      .prepare('SELECT id FROM growth_summary_entries WHERE draft_id=?')
      .get(input.id);
    if (replay) return { entryId: String(replay.id), draftId: input.id, replayed: true };
    const previous = this.summary(input.id);
    this.student(previous.studentId);
    if (
      previous.status !== 'draft' ||
      previous.revision !== input.expectedRevision ||
      !previous.reviewed
    )
      throw new DomainError('CONFLICT', '须先保存教师复核后的草稿，并使用最新修订确认。');
    if (growthPacket(this.db, previous.source).stale)
      throw new DomainError(
        'GROWTH_STALE',
        '来源或成员已变化，请以最新来源新建草稿并重新复核。旧总结保留。',
      );
    if (
      previous.supersedesEntryId &&
      this.db
        .prepare(
          "SELECT id FROM growth_summary_entries WHERE json_extract(payload,'$.supersedesEntryId')=?",
        )
        .get(previous.supersedesEntryId)
    )
      throw new DomainError('CONFLICT', '原总结已有正式更正，请从最新条目继续。');
    const now = this.timestamp(previous.updatedAt),
      record = {
        ...previous,
        status: 'confirmed' as const,
        revision: previous.revision + 1,
        updatedAt: now,
      };
    const entry = growthEntrySchema.parse({
      id: randomUUID(),
      draftId: record.id,
      draftRevision: record.revision,
      studentId: record.studentId,
      createdAt: now,
      reason: input.reason,
      source: record.source,
      inputHash: record.inputHash,
      content: record.content,
      supersedesEntryId: record.supersedesEntryId,
    });
    transaction(this.db, () => {
      this.revise(record, 'confirmed');
      this.db
        .prepare('INSERT INTO growth_summary_entries VALUES (?,?,?,?)')
        .run(entry.id, entry.draftId, entry.studentId, JSON.stringify(entry));
      this.checkpoint?.('entry-written');
    });
    this.checkpoint?.('committed');
    return { entryId: entry.id, draftId: record.id, replayed: false };
  }
  summaryHistory(raw: unknown): GrowthSummary[] {
    const input = growthReadInput.parse(raw);
    this.guard(input.epoch);
    this.summary(input.id);
    return this.db
      .prepare(
        'SELECT payload FROM growth_summary_revisions WHERE draft_id=? ORDER BY revision DESC',
      )
      .all(input.id)
      .map((row) => growthSummarySchema.parse(JSON.parse(String(row.payload))));
  }
  timeline(raw: unknown): GrowthTimeline {
    const input = growthStudentInput.parse(raw);
    this.guard(input.epoch);
    if (!this.snapshot().students.some((s) => s.id === input.studentId))
      throw new DomainError('NOT_FOUND', '学生不存在。');
    const summaries = this.db
      .prepare('SELECT id FROM growth_summaries WHERE student_id=? ORDER BY rowid DESC')
      .all(input.studentId)
      .map((row) => this.readSummary({ epoch: input.epoch, id: row.id }));
    const entries = this.db
      .prepare('SELECT payload FROM growth_summary_entries WHERE student_id=? ORDER BY rowid DESC')
      .all(input.studentId)
      .map((row) => growthEntrySchema.parse(JSON.parse(String(row.payload))));
    return {
      events: this.db
        .prepare('SELECT payload FROM growth_events WHERE student_id=? ORDER BY rowid DESC')
        .all(input.studentId)
        .map((row) => growthEventSchema.parse(JSON.parse(String(row.payload))))
        .sort(
          (a, b) =>
            b.content.date.localeCompare(a.content.date) || b.updatedAt.localeCompare(a.updatedAt),
        ),
      summaries,
      entries: entries.map((record) => ({
        record,
        stale: growthPacket(this.db, record.source).stale,
        supersededBy: entries.find((e) => e.supersedesEntryId === record.id)?.id ?? null,
      })),
    };
  }
}
