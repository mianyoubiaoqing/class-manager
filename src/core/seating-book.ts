import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { epochInput, type Snapshot } from '../shared/contracts';
import {
  seatingAdjustInput,
  seatingConfirmInput,
  seatingHistoryInput,
  seatingPrepareInput,
  seatingReadInput,
  seatingTokenInput,
  seatingVersionSchema,
  type SeatingConfirmation,
  type SeatingPreparation,
  type SeatingVersion,
  type SeatingVersionView,
} from '../shared/seating-records';
import type { SeatingDraft } from '../shared/seating';
import {
  changeSeatingLayout,
  inspectSeatingDraft,
  moveSeatingStudent,
  randomizeSeating,
  setSeatingLock,
} from './seating';
import { SEATING_COLUMNS, serializeSeating, validateSeatingPayload } from './seating-records';
import { MAX_SEATING_VERSIONS } from './storage-limits';
import { DomainError } from './errors';
import { transaction } from './database';

export type SeatingCheckpoint = (stage: 'version-inserted' | 'committed') => void;
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const lifetimeMs = 15 * 60 * 1000;
interface Pending {
  token: string;
  epoch: string;
  classId: string;
  className: string;
  expectedRevision: number;
  fingerprint: string;
  expiresAt: number;
  serialized: string;
}

/**
 * Private 15-minute drafts and immutable class-specific version streams; no caller-owned snapshots.
 * Inputs use strict shared schemas (ZodError); stale epochs/tokens, changed rosters/versions,
 * missing records and quotas use DomainError. Other storage failures reach the normal publicError
 * boundary. Prepare/adjust/cancel only change memory; confirm writes one SQLite transaction;
 * read/history are read-only. No network, file export or printing occurs here.
 */
export class SeatingBook {
  private pending?: Pending;
  private disposed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshot: () => Snapshot,
    private readonly checkpoint?: SeatingCheckpoint,
  ) {}

  dispose(): void {
    this.pending = undefined;
    this.disposed = true;
  }
  private guard(epoch: string): Snapshot {
    if (this.disposed) throw new DomainError('STALE_WORKSPACE', '座位工作区已关闭或恢复，请刷新。');
    const snapshot = this.snapshot();
    if (snapshot.epoch !== epoch) throw new DomainError('STALE_WORKSPACE', '数据已切换，请刷新。');
    return snapshot;
  }
  private roster(snapshot: Snapshot, classId: string) {
    const classroom = snapshot.classes.find((item) => item.id === classId);
    if (!classroom) throw new DomainError('NOT_FOUND', '班级不存在。');
    const students = snapshot.students.filter((item) => item.classId === classId && item.active);
    const memberIds = new Set(students.map((student) => student.id));
    const memberships = snapshot.enrollments.filter(
      (item) => item.classId === classId && item.validTo === null && memberIds.has(item.studentId),
    );
    return {
      classroom,
      members: students.map((item) => ({
        studentId: item.id,
        studentNumber: item.studentNumber,
        displayName: item.displayName,
      })),
      fingerprint: hash([
        classroom,
        students.map((item) => [item.id, item.revision, item.studentNumber, item.displayName]),
        memberships.map((item) => [item.id, item.studentId, item.validFrom]),
      ]),
      notBefore: Math.max(
        Date.parse(classroom.createdAt),
        ...students.map((item) => Date.parse(item.createdAt)),
        ...memberships.map((item) => Date.parse(item.validFrom)),
      ),
    };
  }
  private latest(classId: string): SeatingVersion | null {
    const row = this.db
      .prepare(
        `SELECT ${SEATING_COLUMNS} FROM seating_versions WHERE class_id=? ORDER BY revision DESC LIMIT 1`,
      )
      .get(classId);
    return row ? seatingVersionSchema.parse(row) : null;
  }
  private payload(versionId: string) {
    const row = this.db.prepare('SELECT payload FROM seating_versions WHERE id=?').get(versionId);
    if (!row) throw new DomainError('NOT_FOUND', '座位版本不存在。');
    return validateSeatingPayload(JSON.parse(String(row.payload)));
  }
  private view(pending: Pending): SeatingPreparation {
    return {
      ...inspectSeatingDraft(JSON.parse(pending.serialized)),
      token: pending.token,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      classId: pending.classId,
      className: pending.className,
      expectedRevision: pending.expectedRevision,
    };
  }
  private current(epoch: string, token: string): Pending {
    const snapshot = this.guard(epoch);
    const pending = this.pending;
    if (
      !pending ||
      pending.epoch !== epoch ||
      pending.token !== token ||
      pending.expiresAt <= Date.now()
    )
      throw new DomainError('SEATING_DRAFT_EXPIRED', '座位草案已失效，请重新开始。');
    if (
      this.roster(snapshot, pending.classId).fingerprint !== pending.fingerprint ||
      (this.latest(pending.classId)?.revision ?? 0) !== pending.expectedRevision
    )
      throw new DomainError('CONFLICT', '名册或座位版本已改变，请重新开始草案。');
    return pending;
  }

  /** Start from current roster or latest confirmed positions. Invalid new starts revoke older draft tokens. */
  prepare(raw: unknown): SeatingPreparation {
    const snapshot = this.guard(epochInput.strip().parse(raw).epoch);
    this.pending = undefined;
    const input = seatingPrepareInput.parse(raw);
    const roster = this.roster(snapshot, input.classId);
    const latest = this.latest(input.classId);
    if ((latest?.revision ?? 0) !== input.expectedRevision)
      throw new DomainError('CONFLICT', '座位版本已改变，请刷新。');
    let draft: SeatingDraft;
    if (input.source.kind === 'latest') {
      if (!latest) throw new DomainError('NOT_FOUND', '尚无已确认座位方案。');
      draft = this.payload(latest.id).arrangement;
      if (hash(draft.members) !== hash(roster.members))
        throw new DomainError(
          'CONFLICT',
          '成员或姓名已变化，请从当前名册建立新草案；历史方案仍保留。',
        );
    } else {
      draft = {
        layout: input.source.layout,
        members: roster.members,
        assignments: [],
        lockedStudentIds: [],
      };
    }
    const validated = inspectSeatingDraft(draft).draft;
    this.pending = {
      token: randomUUID(),
      epoch: input.epoch,
      classId: input.classId,
      className: roster.classroom.name,
      expectedRevision: input.expectedRevision,
      fingerprint: roster.fingerprint,
      expiresAt: Date.now() + lifetimeMs,
      serialized: JSON.stringify(validated),
    };
    return this.view(this.pending);
  }

  /** Successful adjustment rotates the token; rejected operations leave the existing draft intact. */
  adjust(raw: unknown): SeatingPreparation {
    const input = seatingAdjustInput.parse(raw);
    const pending = this.current(input.epoch, input.token);
    const draft: SeatingDraft = JSON.parse(pending.serialized);
    const change = input.change;
    let next: SeatingDraft;
    switch (change.kind) {
      case 'randomize':
        next = randomizeSeating(draft);
        break;
      case 'move':
        next = moveSeatingStudent(draft, change.studentId, change.target);
        break;
      case 'lock':
        next = setSeatingLock(draft, change.studentId, change.locked);
        break;
      case 'layout':
        next = changeSeatingLayout(draft, change.layout);
        break;
    }
    this.pending = {
      ...pending,
      token: randomUUID(),
      expiresAt: Date.now() + lifetimeMs,
      serialized: JSON.stringify(next),
    };
    return this.view(this.pending);
  }

  /** Cancel only this token, without touching confirmed versions or a newer in-flight draft. */
  readDraft(raw: unknown): SeatingPreparation {
    const input = seatingTokenInput.parse(raw);
    return this.view(this.current(input.epoch, input.token));
  }
  cancel(raw: unknown): void {
    const input = seatingTokenInput.parse(raw);
    this.guard(input.epoch);
    if (!this.pending) return;
    if (this.pending.token !== input.token)
      throw new DomainError('CONFLICT', '不能取消较新的座位草案。');
    this.pending = undefined;
  }

  /** Freeze the private complete draft transactionally; exact request retries survive lost replies/reopen. */
  confirm(raw: unknown): SeatingConfirmation {
    const input = seatingConfirmInput.parse(raw);
    this.guard(input.epoch);
    const requestHash = hash(input);
    try {
      const result = transaction(this.db, () => {
        const existing = this.db
          .prepare(`SELECT ${SEATING_COLUMNS} FROM seating_versions WHERE request_id=?`)
          .get(input.requestId);
        if (existing) {
          const record = seatingVersionSchema.parse(existing);
          if (record.requestHash !== requestHash)
            throw new DomainError('IDEMPOTENCY_CONFLICT', '同一请求编号不能确认不同的座位草案。');
          return {
            versionId: record.id,
            classId: record.classId,
            revision: record.revision,
            createdAt: record.createdAt,
            replayed: true,
          };
        }
        const pending = this.current(input.epoch, input.token);
        if (pending.expectedRevision !== input.expectedRevision)
          throw new DomainError('CONFLICT', '确认版本与草案不一致。');
        if (
          Number(this.db.prepare('SELECT COUNT(*) AS count FROM seating_versions').get()?.count) >=
          MAX_SEATING_VERSIONS
        )
          throw new DomainError('STORAGE_LIMIT', '座位历史版本已达上限，原记录未删除。');
        const previous = this.latest(pending.classId);
        const arrangement: SeatingDraft = JSON.parse(pending.serialized);
        const prior = previous ? this.payload(previous.id) : null;
        const layoutVersionId =
          prior && hash(prior.arrangement.layout) === hash(arrangement.layout)
            ? prior.layoutVersionId
            : randomUUID();
        const serialized = serializeSeating({
          formatVersion: 1,
          classId: pending.classId,
          className: pending.className,
          layoutVersionId,
          arrangement,
        });
        const roster = this.roster(this.guard(input.epoch), pending.classId);
        const createdAt = new Date(
          Math.max(Date.now(), roster.notBefore, previous ? Date.parse(previous.createdAt) : 0),
        ).toISOString();
        const versionId = randomUUID();
        const revision = pending.expectedRevision + 1;
        this.db
          .prepare('INSERT INTO seating_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            versionId,
            pending.classId,
            revision,
            input.requestId,
            requestHash,
            createdAt,
            input.reason,
            serialized,
          );
        this.checkpoint?.('version-inserted');
        return { versionId, classId: pending.classId, revision, createdAt, replayed: false };
      });
      if (!result.replayed) {
        this.pending = undefined;
        this.checkpoint?.('committed');
      }
      return result;
    } catch (error) {
      if (error && typeof error === 'object' && 'errcode' in error && error.errcode === 13)
        throw new DomainError('STORAGE_LIMIT', '数据库空间不足，未完成的座位写入已回滚。');
      throw error;
    }
  }

  /** Read immutable history, never substituting current labels for stored snapshot labels. */
  read(raw: unknown): SeatingVersionView {
    const input = seatingReadInput.parse(raw);
    const snapshot = this.guard(input.epoch);
    const row = this.db
      .prepare(`SELECT ${SEATING_COLUMNS} FROM seating_versions WHERE id=?`)
      .get(input.versionId);
    if (!row) throw new DomainError('NOT_FOUND', '座位版本不存在。');
    const record = seatingVersionSchema.parse(row);
    const payload = this.payload(record.id);
    const latest = this.latest(record.classId)!;
    return {
      record,
      payload,
      latestVersionId: latest.id,
      stale: latest.id !== record.id,
      rosterChanged:
        hash(this.roster(snapshot, record.classId).members) !== hash(payload.arrangement.members),
    };
  }

  /** Newest-first metadata for one class; reading has no draft or storage side effects. */
  history(raw: unknown): SeatingVersion[] {
    const input = seatingHistoryInput.parse(raw);
    this.roster(this.guard(input.epoch), input.classId);
    return this.db
      .prepare(
        `SELECT ${SEATING_COLUMNS} FROM seating_versions WHERE class_id=? ORDER BY revision DESC`,
      )
      .all(input.classId)
      .map((row) => seatingVersionSchema.parse(row));
  }
}
