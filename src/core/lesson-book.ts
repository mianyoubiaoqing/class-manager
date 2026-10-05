import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { epochInput } from '../shared/contracts';
import {
  LESSON_PROMPT_VERSION,
  lessonClaimInput,
  lessonCreateInput,
  lessonCompleteInput,
  lessonDiscardInput,
  lessonDraftReadInput,
  lessonEditInput,
  lessonFreezeInput,
  lessonListInput,
  lessonPrepareInput,
  lessonReviseInput,
  lessonVersionReadInput,
  lessonDraftRecordSchema,
  lessonVersionRecordSchema,
  type LessonDraftRecord,
  type LessonPayload,
} from '../shared/lesson-records';
import { lessonRequestSchema } from '../shared/lessons';
import {
  storedLessonPreparation,
  serializeLesson,
  readLessonDraft,
  readLessonVersion,
  LESSON_DRAFT_COLUMNS,
  LESSON_VERSION_COLUMNS,
} from './lesson-records';
import { validateLessonContent, validateLessonOutput } from './lesson-drafting';
import { readStoredMaterial } from './material-records';
import { MAX_LESSON_DRAFTS, MAX_LESSON_VERSIONS } from './storage-limits';
import { DomainError } from './errors';
import { transaction } from './database';

export type LessonCheckpoint = (
  stage: 'generated' | 'edited' | 'discarded' | 'frozen' | 'revised' | 'committed',
) => void;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = (record: LessonDraftRecord, replayed = false) => ({
  id: record.id,
  revision: record.revision,
  status: record.status,
  replayed,
});
const timestamp = (...boundaries: string[]) =>
  new Date(Math.max(Date.now(), ...boundaries.map(Date.parse))).toISOString();

/** Owns bounded backend preparations and draft/version transitions. Network calls belong to Main;
 * immutable materials and frozen versions never change when a teacher edits or cancels a draft. */
export class LessonBook {
  private alive = true;
  private pending?: {
    token: string;
    epoch: string;
    expiresAt: number;
    request: string;
    fingerprint: string;
    requestId?: string;
  };
  constructor(
    private readonly db: DatabaseSync,
    private readonly epoch: () => string,
    private readonly checkpoint?: LessonCheckpoint,
  ) {}
  private guard(epoch: string) {
    if (!this.alive || epoch !== this.epoch())
      throw new DomainError('STALE_WORKSPACE', '备课工作区已切换，请重新读取。');
  }
  dispose() {
    this.pending = undefined;
    this.alive = false;
  }
  cancel(raw: unknown) {
    const { epoch } = epochInput.parse(raw);
    this.guard(epoch);
    this.pending = undefined;
  }
  /** Save the exact confirmed content, without initiating another model request or fabricating provider metadata. */
  create(raw: unknown) {
    const input = lessonCreateInput.parse(raw);
    this.guard(input.epoch);
    const preparation = storedLessonPreparation(this.db, input.request);
    const content = validateLessonContent(input.content, preparation);
    const generationHash = digest({ request: input.request, content });
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT id FROM lesson_drafts WHERE generation_request_id=?')
        .get(input.requestId);
      if (existing) {
        const { record, payload } = readLessonDraft(this.db, String(existing.id));
        if (record.generationHash !== generationHash || payload.authoring !== 'local')
          throw new DomainError('CONFLICT', '请求编号已用于不同备课内容。');
        return receipt(record, true);
      }
      const createdAt = timestamp(
        ...preparation.sources.map(
          (source) => readStoredMaterial(this.db, source.sourceVersionId).record.createdAt,
        ),
      );
      const record: LessonDraftRecord = {
        id: randomUUID(),
        lessonId: randomUUID(),
        revision: 1,
        status: 'draft',
        createdAt,
        updatedAt: createdAt,
        baseVersionId: null,
        generationRequestId: input.requestId,
        generationHash,
      };
      this.insertDraft(
        record,
        serializeLesson(this.db, {
          formatVersion: 1,
          promptVersion: LESSON_PROMPT_VERSION,
          request: preparation.request,
          inputHash: preparation.fingerprint,
          provider: null,
          authoring: 'local',
          original: content,
          content,
        }),
      );
      this.checkpoint?.('generated');
      return receipt(record);
    });
  }
  prepare(raw: unknown) {
    const { epoch } = epochInput.strip().parse(raw);
    this.guard(epoch);
    this.pending = undefined;
    const input = lessonPrepareInput.parse(raw);
    const preparation = storedLessonPreparation(this.db, input.request);
    const token = randomUUID();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    this.pending = {
      token,
      epoch,
      expiresAt,
      request: JSON.stringify(input.request),
      fingerprint: preparation.fingerprint,
    };
    return { token, expiresAt: new Date(expiresAt).toISOString(), preparation };
  }
  private pendingPreparation(epoch: string, token: string) {
    this.guard(epoch);
    const pending = this.pending;
    if (
      !pending ||
      pending.epoch !== epoch ||
      pending.token !== token ||
      Date.now() >= pending.expiresAt
    )
      throw new DomainError('LESSON_EXPIRED', '备课生成准备已失效，请重新选择资料。');
    const preparation = storedLessonPreparation(
      this.db,
      lessonRequestSchema.parse(JSON.parse(pending.request)),
    );
    if (preparation.fingerprint !== pending.fingerprint)
      throw new DomainError('LESSON_INVALID', '所选资料指纹已变化，拒绝生成。');
    return { pending, preparation };
  }
  /** Claim once before a paid call. Neither restart nor repeated claims resume a network request. */
  claim(raw: unknown) {
    const input = lessonClaimInput.parse(raw);
    const { pending, preparation } = this.pendingPreparation(input.epoch, input.token);
    if (
      pending.requestId ||
      this.db
        .prepare('SELECT id FROM lesson_drafts WHERE generation_request_id=?')
        .get(input.requestId)
    )
      throw new DomainError('CONFLICT', '生成任务已发起或请求编号已使用。');
    pending.requestId = input.requestId;
    pending.expiresAt = Date.now() + 2 * 60 * 1000;
    return preparation;
  }
  /** Internal Main/worker completion only. A cancellation admission check runs inside the SQL
   * transaction immediately before commit. Invalid output leaves the stored history untouched. */
  complete(raw: unknown, admitCommit?: () => void) {
    const input = lessonCompleteInput.parse(raw);
    this.guard(input.epoch);
    const generationHash = digest({
      token: input.token,
      provider: input.provider,
      output: input.output,
    });
    const existing = this.db
      .prepare('SELECT id FROM lesson_drafts WHERE generation_request_id=?')
      .get(input.requestId);
    if (existing) {
      const { record } = readLessonDraft(this.db, String(existing.id));
      if (record.generationHash !== generationHash)
        throw new DomainError('CONFLICT', '请求编号已用于不同备课结果。');
      return receipt(record, true);
    }
    const { pending, preparation } = this.pendingPreparation(input.epoch, input.token);
    if (pending.requestId !== input.requestId)
      throw new DomainError('CONFLICT', '结果不属于已发起的备课任务。');
    const content = validateLessonOutput(input.output, preparation);
    const payload = serializeLesson(this.db, {
      formatVersion: 1,
      promptVersion: LESSON_PROMPT_VERSION,
      request: preparation.request,
      inputHash: preparation.fingerprint,
      provider: input.provider,
      original: content,
      content,
    });
    const createdAt = timestamp(
      input.provider.generatedAt,
      ...preparation.sources.map(
        (source) => readStoredMaterial(this.db, source.sourceVersionId).record.createdAt,
      ),
    );
    const record: LessonDraftRecord = {
      id: randomUUID(),
      lessonId: randomUUID(),
      revision: 1,
      status: 'draft',
      createdAt,
      updatedAt: createdAt,
      baseVersionId: null,
      generationRequestId: input.requestId,
      generationHash,
    };
    transaction(this.db, () => {
      this.insertDraft(record, payload);
      this.checkpoint?.('generated');
      admitCommit?.();
    });
    this.pending = undefined;
    this.checkpoint?.('committed');
    return receipt(record);
  }
  private insertDraft(record: LessonDraftRecord, payload: string) {
    if (
      Number(this.db.prepare('SELECT COUNT(*) AS count FROM lesson_drafts').get()?.count) >=
      MAX_LESSON_DRAFTS
    )
      throw new DomainError('LESSON_LIMIT', '备课草案数量达到上限，请先备份并联系维护者。');
    this.db
      .prepare('INSERT INTO lesson_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.id,
        record.lessonId,
        record.revision,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.baseVersionId,
        record.generationRequestId,
        record.generationHash,
        payload,
      );
  }
  read(raw: unknown) {
    const input = lessonDraftReadInput.parse(raw);
    this.guard(input.epoch);
    return readLessonDraft(this.db, input.id);
  }
  readVersion(raw: unknown) {
    const input = lessonVersionReadInput.parse(raw);
    this.guard(input.epoch);
    return readLessonVersion(this.db, input.versionId);
  }
  list(raw: unknown) {
    const input = lessonListInput.parse(raw);
    this.guard(input.epoch);
    return this.db
      .prepare(
        `SELECT ${LESSON_DRAFT_COLUMNS}, json_extract(payload, '$.content.title') AS title FROM lesson_drafts WHERE (?=1 OR status='draft') ORDER BY updated_at DESC, id`,
      )
      .all(input.includeClosed ? 1 : 0)
      .map(({ title, ...record }) => ({
        record: lessonDraftRecordSchema.parse(record),
        title: String(title),
      }));
  }
  history(raw: unknown) {
    const input = lessonDraftReadInput.parse(raw);
    this.guard(input.epoch);
    const draft = readLessonDraft(this.db, input.id);
    return this.db
      .prepare(
        `SELECT ${LESSON_VERSION_COLUMNS} FROM lesson_versions WHERE lesson_id=? ORDER BY revision DESC`,
      )
      .all(draft.record.lessonId)
      .map((row) => lessonVersionRecordSchema.parse(row));
  }
  edit(raw: unknown) {
    const input = lessonEditInput.parse(raw);
    this.guard(input.epoch);
    return transaction(this.db, () => {
      const { record, payload } = readLessonDraft(this.db, input.id);
      if (record.status !== 'draft')
        throw new DomainError('CONFLICT', '关闭或冻结的草案不能编辑。');
      const content = validateLessonContent(
        input.content,
        storedLessonPreparation(this.db, payload.request),
      );
      const same = JSON.stringify(payload.content) === JSON.stringify(content);
      if (
        same &&
        (input.expectedRevision === record.revision ||
          input.expectedRevision === record.revision - 1)
      )
        return receipt(record, true);
      if (input.expectedRevision !== record.revision)
        throw new DomainError('CONFLICT', '草案已修改，请重新读取。');
      const updatedAt = timestamp(record.updatedAt);
      this.db
        .prepare('UPDATE lesson_drafts SET revision=revision+1, updated_at=?, payload=? WHERE id=?')
        .run(updatedAt, serializeLesson(this.db, { ...payload, content }), record.id);
      this.checkpoint?.('edited');
      return receipt({ ...record, revision: record.revision + 1, updatedAt });
    });
  }
  discard(raw: unknown) {
    const input = lessonDiscardInput.parse(raw);
    this.guard(input.epoch);
    return transaction(this.db, () => {
      const { record } = readLessonDraft(this.db, input.id);
      if (record.status === 'discarded' && input.expectedRevision === record.revision - 1)
        return receipt(record, true);
      if (record.status !== 'draft' || record.revision !== input.expectedRevision)
        throw new DomainError('CONFLICT', '草案状态已变化，请重新读取。');
      const updatedAt = timestamp(record.updatedAt);
      this.db
        .prepare(
          "UPDATE lesson_drafts SET revision=revision+1, status='discarded', updated_at=? WHERE id=?",
        )
        .run(updatedAt, record.id);
      this.checkpoint?.('discarded');
      return receipt({ ...record, revision: record.revision + 1, status: 'discarded', updatedAt });
    });
  }
  freeze(raw: unknown) {
    const input = lessonFreezeInput.parse(raw);
    this.guard(input.epoch);
    return transaction(this.db, () => {
      const { record, payload } = readLessonDraft(this.db, input.id);
      const requestHash = digest({
        id: input.id,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        payload,
      });
      const existing = this.db
        .prepare(`SELECT ${LESSON_VERSION_COLUMNS} FROM lesson_versions WHERE request_id=?`)
        .get(input.requestId);
      if (existing) {
        const version = lessonVersionRecordSchema.parse(existing);
        if (version.requestHash !== requestHash)
          throw new DomainError('CONFLICT', '冻结请求编号已用于其他内容。');
        return { versionId: version.id, revision: version.revision, replayed: true };
      }
      if (record.status !== 'draft' || record.revision !== input.expectedRevision)
        throw new DomainError('CONFLICT', '草案已修改或关闭，请重新读取。');
      const latest = this.db
        .prepare(
          `SELECT ${LESSON_VERSION_COLUMNS} FROM lesson_versions WHERE lesson_id=? ORDER BY revision DESC LIMIT 1`,
        )
        .get(record.lessonId);
      const previous = latest ? lessonVersionRecordSchema.parse(latest) : null;
      if (record.baseVersionId !== (previous?.id ?? null))
        throw new DomainError('CONFLICT', '已有新的冻结版本，请基于最新版重新编辑。');
      if (
        Number(this.db.prepare('SELECT COUNT(*) AS count FROM lesson_versions').get()?.count) >=
        MAX_LESSON_VERSIONS
      )
        throw new DomainError('LESSON_LIMIT', '冻结版本数量达到上限，请先备份并联系维护者。');
      const version = {
        id: randomUUID(),
        lessonId: record.lessonId,
        draftId: record.id,
        revision: (previous?.revision ?? 0) + 1,
        requestId: input.requestId,
        requestHash,
        createdAt: timestamp(record.updatedAt, ...(previous ? [previous.createdAt] : [])),
        reason: input.reason,
      };
      this.db
        .prepare('INSERT INTO lesson_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          version.id,
          version.lessonId,
          version.draftId,
          version.revision,
          version.requestId,
          version.requestHash,
          version.createdAt,
          version.reason,
          serializeLesson(this.db, payload),
        );
      this.db
        .prepare(
          "UPDATE lesson_drafts SET revision=revision+1, status='frozen', updated_at=? WHERE id=?",
        )
        .run(version.createdAt, record.id);
      this.checkpoint?.('frozen');
      return { versionId: version.id, revision: version.revision, replayed: false };
    });
  }
  /** Explicit local revision of the latest frozen version. Preserve provider/original provenance;
   * create an independent draft, with no model call and no mutation of its frozen base. */
  revise(raw: unknown) {
    const input = lessonReviseInput.parse(raw);
    this.guard(input.epoch);
    return transaction(this.db, () => {
      const base = readLessonVersion(this.db, input.versionId);
      const generationHash = digest({ baseVersionId: base.record.id, payload: base.payload });
      const existing = this.db
        .prepare('SELECT id FROM lesson_drafts WHERE generation_request_id=?')
        .get(input.requestId);
      if (existing) {
        const { record } = readLessonDraft(this.db, String(existing.id));
        if (record.generationHash !== generationHash || record.baseVersionId !== base.record.id)
          throw new DomainError('CONFLICT', '修订请求编号已用于其他内容。');
        return receipt(record, true);
      }
      if (
        this.db
          .prepare(
            'SELECT id FROM lesson_versions WHERE lesson_id=? ORDER BY revision DESC LIMIT 1',
          )
          .get(base.record.lessonId)?.id !== base.record.id
      )
        throw new DomainError('CONFLICT', '请基于最新冻结版本创建修订。');
      const createdAt = timestamp(base.record.createdAt);
      const record: LessonDraftRecord = {
        id: randomUUID(),
        lessonId: base.record.lessonId,
        revision: 1,
        status: 'draft',
        createdAt,
        updatedAt: createdAt,
        baseVersionId: base.record.id,
        generationRequestId: input.requestId,
        generationHash,
      };
      this.insertDraft(record, serializeLesson(this.db, base.payload as LessonPayload));
      this.checkpoint?.('revised');
      return receipt(record);
    });
  }
}
