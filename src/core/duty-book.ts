import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { epochInput, type Snapshot } from '../shared/contracts';
import {
  dutyAdjustInput,
  dutyConfirmInput,
  dutyHistoryInput,
  dutyListInput,
  dutyPlanSummarySchema,
  dutyPrepareInput,
  dutyReadInput,
  dutyTokenInput,
  dutyVersionSchema,
  type DutyConfirmation,
  type DutyPayload,
  type DutyPreparation,
  type DutyVersion,
  type DutyVersionView,
  type DutyPlanSummary,
} from '../shared/duty-records';
import type { DutyDraft, DutyMember } from '../shared/duty';
import {
  changeDutyDayGroup,
  changeDutyGroups,
  changeDutyParticipants,
  completeDutyDay,
  generateDuty,
  inspectDutyDraft,
  replaceDutySlot,
  requireDutyRevision,
  requireNewDuty,
  rotateDuty,
  setDutyUnavailable,
} from './duty';
import {
  advanceDutyDate,
  DUTY_COLUMNS,
  requireCompatibleDutyPlans,
  serializeDuty,
  validateDutyPayload,
} from './duty-records';
import { DomainError } from './errors';
import { transaction } from './database';
import { MAX_DUTY_PLANS, MAX_DUTY_VERSIONS } from './storage-limits';

export type DutyCheckpoint = (stage: 'version-inserted' | 'committed') => void;
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const lifetimeMs = 15 * 60 * 1000;
interface Pending {
  token: string;
  epoch: string;
  planId: string;
  classId: string;
  className: string;
  title: string;
  expectedRevision: number;
  fingerprint: string;
  expiresAt: number;
  protectedDate: string;
  serialized: string;
}

/**
 * Private draft sessions and immutable period revisions. Strict commands reject caller snapshots,
 * malformed inputs (ZodError), stale epochs/tokens, roster/version conflicts (DomainError).
 * Confirmation is transactional and exact-request idempotent across reopen; prepare/adjust/cancel
 * never write a plan but advance a durable calendar floor. Read/history are read-only.
 * No model/file/printing calls. SQLite errors propagate except quota failures; no automatic retry.
 */
export class DutyBook {
  private pending?: Pending;
  private disposed = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshot: () => Snapshot,
    private readonly checkpoint?: DutyCheckpoint,
  ) {}

  dispose(): void {
    this.pending = undefined;
    this.disposed = true;
  }
  private guard(epoch: string): Snapshot {
    if (this.disposed) throw new DomainError('STALE_WORKSPACE', '值日工作区已关闭或恢复，请刷新。');
    const snapshot = this.snapshot();
    if (snapshot.epoch !== epoch) throw new DomainError('STALE_WORKSPACE', '数据已切换，请刷新。');
    return snapshot;
  }
  private roster(snapshot: Snapshot, classId: string) {
    const classroom = snapshot.classes.find((item) => item.id === classId);
    if (!classroom) throw new DomainError('NOT_FOUND', '班级不存在。');
    const students = snapshot.students.filter((item) => item.classId === classId && item.active);
    const ids = new Set(students.map((item) => item.id));
    const enrollments = snapshot.enrollments.filter(
      (item) => item.classId === classId && item.validTo === null && ids.has(item.studentId),
    );
    return {
      classroom,
      members: students.map((item) => ({
        studentId: item.id,
        studentNumber: item.studentNumber,
        displayName: item.displayName,
      })),
      fingerprint: hash([classroom, students, enrollments]),
      notBefore: Math.max(
        Date.parse(classroom.createdAt),
        ...students.map((item) => Date.parse(item.createdAt)),
        ...enrollments.map((item) => Date.parse(item.validFrom)),
      ),
    };
  }
  private selected(
    ids: string[],
    available: DutyMember[],
    existing: DutyMember[] = [],
  ): DutyMember[] {
    if (new Set(ids).size !== ids.length) throw new DomainError('VALIDATION', '参与学生重复。');
    const current = new Map(available.map((member) => [member.studentId, member]));
    const stored = new Map(existing.map((member) => [member.studentId, member]));
    return ids.map((id) => {
      const member = current.get(id);
      if (!member)
        throw new DomainError('CONFLICT', '所选学生已停用、转班或不属于本班，请调整名单。');
      return stored.get(id) ?? member;
    });
  }
  private latest(planId: string): DutyVersion | null {
    const row = this.db
      .prepare(
        `SELECT ${DUTY_COLUMNS} FROM duty_versions WHERE plan_id=? ORDER BY revision DESC LIMIT 1`,
      )
      .get(planId);
    return row ? dutyVersionSchema.parse(row) : null;
  }
  private payload(versionId: string): DutyPayload {
    const row = this.db.prepare('SELECT payload FROM duty_versions WHERE id=?').get(versionId);
    if (!row) throw new DomainError('NOT_FOUND', '值日版本不存在。');
    return validateDutyPayload(JSON.parse(String(row.payload)));
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
      throw new DomainError('DUTY_DRAFT_EXPIRED', '值日草案已失效，请重新开始。');
    if (
      this.roster(snapshot, pending.classId).fingerprint !== pending.fingerprint ||
      (this.latest(pending.planId)?.revision ?? 0) !== pending.expectedRevision
    )
      throw new DomainError('CONFLICT', '名册或值日版本已改变，请重新开始。');
    return pending;
  }
  private view(pending: Pending): DutyPreparation {
    return {
      ...inspectDutyDraft(JSON.parse(pending.serialized)),
      token: pending.token,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      planId: pending.planId,
      classId: pending.classId,
      className: pending.className,
      title: pending.title,
      expectedRevision: pending.expectedRevision,
      protectedDate: pending.protectedDate,
    };
  }

  /** New starts revoke older draft tokens even on failure. Latest drafts permit removing inactive members. */
  readDraft(raw: unknown): DutyPreparation {
    const input = dutyTokenInput.parse(raw);
    return this.view(this.current(input.epoch, input.token));
  }
  prepare(raw: unknown): DutyPreparation {
    const snapshot = this.guard(epochInput.strip().parse(raw).epoch);
    this.pending = undefined;
    const input = dutyPrepareInput.parse(raw);
    const roster = this.roster(snapshot, input.classId);
    const protectedDate = advanceDutyDate(
      this.db,
      undefined,
      Math.max(Date.now(), roster.notBefore),
    );
    let planId: string;
    let className = roster.classroom.name;
    let title: string;
    let draft: DutyDraft;
    if (input.source.kind === 'new') {
      if (input.expectedRevision !== 0)
        throw new DomainError('CONFLICT', '新一期的预期版本必须为 0。');
      planId = randomUUID();
      title = input.source.title;
      draft = generateDuty({
        members: this.selected(input.source.participantIds, roster.members),
        dates: input.source.dates,
        posts: input.source.posts,
        groupCount: input.source.groupCount,
        unavailable: input.source.unavailable,
      }).draft;
      if (draft.dates.some((date) => date < protectedDate))
        throw new DomainError('VALIDATION', '新一期不能安排过去日期。');
    } else {
      planId = input.source.planId;
      const latest = this.latest(planId);
      if (!latest || latest.classId !== input.classId)
        throw new DomainError('NOT_FOUND', '本班值日计划不存在。');
      if (latest.revision !== input.expectedRevision)
        throw new DomainError('CONFLICT', '值日版本已改变，请刷新。');
      const payload = this.payload(latest.id);
      ({ title, className } = payload);
      draft = payload.arrangement;
    }
    this.pending = {
      token: randomUUID(),
      epoch: input.epoch,
      planId,
      classId: input.classId,
      className,
      title,
      expectedRevision: input.expectedRevision,
      fingerprint: roster.fingerprint,
      expiresAt: Date.now() + lifetimeMs,
      protectedDate,
      serialized: JSON.stringify(draft),
    };
    return this.view(this.pending);
  }

  /** Successful changes rotate tokens; rejected edits preserve the old draft, not the date floor. */
  adjust(raw: unknown): DutyPreparation {
    const input = dutyAdjustInput.parse(raw);
    const pending = this.current(input.epoch, input.token);
    const today = advanceDutyDate(this.db);
    const draft: DutyDraft = JSON.parse(pending.serialized);
    const change = input.change;
    let next: DutyDraft;
    switch (change.kind) {
      case 'rotate':
        next = rotateDuty(draft, today).draft;
        break;
      case 'groups':
        next = changeDutyGroups(draft, change.groups, today).draft;
        break;
      case 'participants':
        next = changeDutyParticipants(
          draft,
          this.selected(
            change.participantIds,
            this.roster(this.guard(input.epoch), pending.classId).members,
            draft.members,
          ),
          change.groups,
          today,
        ).draft;
        break;
      case 'replace':
        next = replaceDutySlot(
          draft,
          change.date,
          change.postId,
          change.slotIndex,
          change.studentId,
          today,
        ).draft;
        break;
      case 'day-group':
        next = changeDutyDayGroup(draft, change.date, change.groupId, today).draft;
        break;
      case 'unavailable':
        next = setDutyUnavailable(draft, change.date, change.studentIds, today).draft;
        break;
      case 'complete':
        next = completeDutyDay(draft, change.date, today).draft;
        break;
    }
    this.pending = {
      ...pending,
      token: randomUUID(),
      expiresAt: Date.now() + lifetimeMs,
      protectedDate: today,
      serialized: JSON.stringify(next),
    };
    return this.view(this.pending);
  }

  /** Cancel only the current token; no confirmed records change. No pending token is an idempotent no-op. */
  cancel(raw: unknown): void {
    const input = dutyTokenInput.parse(raw);
    this.guard(input.epoch);
    advanceDutyDate(this.db);
    if (!this.pending) return;
    if (this.pending.token !== input.token)
      throw new DomainError('CONFLICT', '不能取消较新的值日草案。');
    this.pending = undefined;
  }

  /** Confirm the private draft once. Fresh checks cover midnight, membership and all latest plans. */
  confirm(raw: unknown): DutyConfirmation {
    const input = dutyConfirmInput.parse(raw);
    this.guard(input.epoch);
    advanceDutyDate(this.db);
    const requestHash = hash(input);
    try {
      const result = transaction(this.db, () => {
        const existing = this.db
          .prepare(`SELECT ${DUTY_COLUMNS} FROM duty_versions WHERE request_id=?`)
          .get(input.requestId);
        if (existing) {
          const record = dutyVersionSchema.parse(existing);
          if (record.requestHash !== requestHash)
            throw new DomainError('IDEMPOTENCY_CONFLICT', '同一请求编号不能确认不同的值日草案。');
          return this.receipt(record, true);
        }
        const pending = this.current(input.epoch, input.token);
        if (pending.expectedRevision !== input.expectedRevision)
          throw new DomainError('CONFLICT', '确认版本与草案不一致。');
        const prior = this.latest(pending.planId);
        const roster = this.roster(this.guard(input.epoch), pending.classId);
        const createdAt = new Date(
          Math.max(Date.now(), roster.notBefore, prior ? Date.parse(prior.createdAt) : 0),
        ).toISOString();
        const today = advanceDutyDate(this.db, undefined, Date.parse(createdAt));
        const arrangement: DutyDraft = JSON.parse(pending.serialized);
        if (prior) requireDutyRevision(this.payload(prior.id).arrangement, arrangement, today);
        else requireNewDuty(arrangement, today);
        if (arrangement.days.some((day) => day.date >= today && !day.completed))
          this.selected(arrangement.participantIds, roster.members);
        const count = this.db
          .prepare(
            'SELECT COUNT(*) AS versions, COUNT(DISTINCT plan_id) AS plans FROM duty_versions',
          )
          .get()!;
        if (
          Number(count.versions) >= MAX_DUTY_VERSIONS ||
          (!prior && Number(count.plans) >= MAX_DUTY_PLANS)
        )
          throw new DomainError('STORAGE_LIMIT', '值日计划或历史版本已达上限，原记录未删除。');
        const currentPlans = this.db
          .prepare(
            `SELECT payload FROM duty_versions d WHERE plan_id<>?
          AND revision=(SELECT MAX(revision) FROM duty_versions WHERE plan_id=d.plan_id)`,
          )
          .all(pending.planId);
        requireCompatibleDutyPlans([
          arrangement,
          ...currentPlans.map(
            (row) => validateDutyPayload(JSON.parse(String(row.payload))).arrangement,
          ),
        ]);
        const serialized = serializeDuty({
          formatVersion: 1,
          classId: pending.classId,
          className: pending.className,
          title: pending.title,
          arrangement,
        });
        const record: DutyVersion = {
          id: randomUUID(),
          planId: pending.planId,
          classId: pending.classId,
          revision: pending.expectedRevision + 1,
          requestId: input.requestId,
          requestHash,
          createdAt,
          protectedDate: today,
          reason: input.reason,
        };
        this.db
          .prepare('INSERT INTO duty_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            record.id,
            record.planId,
            record.classId,
            record.revision,
            record.requestId,
            record.requestHash,
            record.createdAt,
            record.protectedDate,
            record.reason,
            serialized,
          );
        this.checkpoint?.('version-inserted');
        return this.receipt(record, false);
      });
      if (!result.replayed) {
        this.pending = undefined;
        this.checkpoint?.('committed');
      }
      return result;
    } catch (error) {
      if (error && typeof error === 'object' && 'errcode' in error && error.errcode === 13)
        throw new DomainError('STORAGE_LIMIT', '数据库空间不足，未完成的值日写入已回滚。');
      throw error;
    }
  }
  private receipt(record: DutyVersion, replayed: boolean): DutyConfirmation {
    return {
      versionId: record.id,
      planId: record.planId,
      classId: record.classId,
      revision: record.revision,
      createdAt: record.createdAt,
      replayed,
    };
  }

  /** Return only the selected immutable version; never substitute current names or the latest plan. */
  read(raw: unknown): DutyVersionView {
    const input = dutyReadInput.parse(raw);
    this.guard(input.epoch);
    const row = this.db
      .prepare(`SELECT ${DUTY_COLUMNS} FROM duty_versions WHERE id=?`)
      .get(input.versionId);
    if (!row) throw new DomainError('NOT_FOUND', '值日版本不存在。');
    const record = dutyVersionSchema.parse(row);
    const latest = this.latest(record.planId)!;
    return {
      record,
      payload: this.payload(record.id),
      latestVersionId: latest.id,
      stale: latest.id !== record.id,
    };
  }

  /** Read-only metadata: class history or a specific period, newest-first. */
  history(raw: unknown): DutyVersion[] {
    const input = dutyHistoryInput.parse(raw);
    this.roster(this.guard(input.epoch), input.classId);
    const rows = input.planId
      ? this.db
          .prepare(
            `SELECT ${DUTY_COLUMNS} FROM duty_versions WHERE class_id=? AND plan_id=? ORDER BY revision DESC`,
          )
          .all(input.classId, input.planId)
      : this.db
          .prepare(
            `SELECT ${DUTY_COLUMNS} FROM duty_versions WHERE class_id=? ORDER BY created_at DESC, revision DESC`,
          )
          .all(input.classId);
    return rows.map((row) => dutyVersionSchema.parse(row));
  }

  /** Read only latest-period summaries, without sending full schedules or older revisions to the UI. */
  list(raw: unknown): DutyPlanSummary[] {
    const input = dutyListInput.parse(raw);
    this.roster(this.guard(input.epoch), input.classId);
    return this.db
      .prepare(
        `SELECT plan_id AS planId, class_id AS classId, id AS latestVersionId,
      revision, created_at AS updatedAt, json_extract(payload, '$.title') AS title,
      json_extract(payload, '$.arrangement.dates[0]') AS firstDate,
      json_extract(payload, '$.arrangement.dates[#-1]') AS lastDate,
      json_array_length(payload, '$.arrangement.participantIds') AS participantCount
      FROM duty_versions d WHERE class_id=? AND revision=(
        SELECT MAX(revision) FROM duty_versions WHERE plan_id=d.plan_id
      ) ORDER BY created_at DESC, plan_id`,
      )
      .all(input.classId)
      .map((row) => dutyPlanSummarySchema.parse(row));
  }
}
