import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { epochInput } from '../shared/contracts';
import {
  classroomCreateInput,
  classroomListInput,
  classroomReadInput,
  classroomControlInput,
  countdownInput,
  CLASSROOM_LIMITS,
  type ClassroomRecord,
  type ClassroomTeacherView,
} from '../shared/classroom';
import { readClassroomRecord, readCountdownRecord } from './classroom-records';
import { readLessonVersion } from './lesson-records';
import { countdownView } from './countdown';
import { transaction } from './database';
import { DomainError } from './errors';

/** Owns progress and monotonic timer anchors. Restart pauses at the last durable checkpoint. */
export class ClassroomBook {
  private alive = true;
  private checkpointFailed = false;
  private anchors = new Map<string, { startedAt: number; baseMs: number }>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly epoch: () => string,
    private readonly monotonic = () => performance.now(),
    private readonly wall = () => Date.now(),
  ) {
    db.exec(
      "UPDATE teaching_sessions SET status='paused', interrupted=1, revision=revision+1 WHERE status='running'",
    );
  }
  private guard(epoch: string) {
    if (!this.alive || epoch !== this.epoch())
      throw new DomainError('STALE_WORKSPACE', '课堂工作区已切换，请重新读取。');
  }
  private elapsed(record: ClassroomRecord, now = this.monotonic()) {
    const anchor = this.anchors.get(record.id);
    return Math.min(
      CLASSROOM_LIMITS.elapsedMs,
      anchor === undefined
        ? record.elapsedMs
        : anchor.baseMs + Math.max(0, Math.floor(now - anchor.startedAt)),
    );
  }
  private teacher(record: ClassroomRecord): ClassroomTeacherView {
    const version = readLessonVersion(this.db, record.versionId);
    const className = this.db
      .prepare('SELECT name FROM classrooms WHERE id=?')
      .get(record.classId)?.name;
    if (typeof className !== 'string') throw new DomainError('NOT_FOUND', '课堂班级不存在。');
    return {
      record: { ...record, elapsedMs: this.elapsed(record) },
      title: version.payload.content.title,
      versionRevision: version.record.revision,
      className,
      slides: record.payload.slideIds.map((id) => {
        const slide = version.payload.content.slides.find((value) => value.id === id)!;
        const section = version.payload.content.sections.find(
          (value) => value.id === slide.sectionId,
        )!;
        return {
          id,
          title: slide.title,
          sectionId: section.id,
          sectionTitle: section.title,
          durationMinutes: section.durationMinutes,
        };
      }),
    };
  }
  list(raw: unknown) {
    const { epoch, limit, offset } = classroomListInput.parse(raw);
    this.guard(epoch);
    const items = this.db
      .prepare('SELECT id FROM teaching_sessions ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(limit, offset)
      .map((row) => this.teacher(readClassroomRecord(this.db, String(row.id))));
    return {
      items,
      total: Number(
        this.db.prepare('SELECT COUNT(*) AS count FROM teaching_sessions').get()?.count,
      ),
    };
  }
  read(raw: unknown) {
    const input = classroomReadInput.parse(raw);
    this.guard(input.epoch);
    return this.teacher(readClassroomRecord(this.db, input.id));
  }
  revision(raw: unknown) {
    const input = classroomReadInput.parse(raw);
    this.guard(input.epoch);
    const row = this.db.prepare('SELECT revision FROM teaching_sessions WHERE id=?').get(input.id);
    if (!row) throw new DomainError('NOT_FOUND', '课堂进度不存在。');
    return Number(row.revision);
  }
  clock(raw: unknown) {
    const input = classroomReadInput.parse(raw);
    this.guard(input.epoch);
    const record = readClassroomRecord(this.db, input.id, false);
    return {
      checkpointFailed: this.checkpointFailed,
      elapsedMs: this.elapsed(record),
      status: record.status,
      countdown: this.countdown({ epoch: input.epoch }),
    };
  }
  create(raw: unknown) {
    const input = classroomCreateInput.parse(raw);
    this.guard(input.epoch);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ ...input, epoch: undefined }))
      .digest('hex');
    const existing = this.db
      .prepare('SELECT id, request_hash AS hash FROM teaching_sessions WHERE request_id=?')
      .get(input.requestId);
    if (existing) {
      if (existing.hash !== requestHash)
        throw new DomainError('CONFLICT', '课堂请求编号已用于不同内容。');
      return this.read({ epoch: input.epoch, id: existing.id });
    }
    const version = readLessonVersion(this.db, input.versionId);
    if (!this.db.prepare('SELECT id FROM classrooms WHERE id=?').get(input.classId))
      throw new DomainError('NOT_FOUND', '请选择有效班级。');
    if (
      Number(this.db.prepare('SELECT COUNT(*) AS count FROM teaching_sessions').get()?.count) >=
      CLASSROOM_LIMITS.sessions
    )
      throw new DomainError('STORAGE_LIMIT', '课堂进度已达 1000 条上限。');
    const indices = input.slideIds.map((id) =>
      version.payload.content.slides.findIndex((slide) => slide.id === id),
    );
    if (
      indices.some(
        (index, position) => index < 0 || (position > 0 && index <= indices[position - 1]!),
      )
    )
      throw new DomainError('VALIDATION', '展示范围必须来自所选冻结版并保持原顺序。');
    const now = new Date(Math.max(this.wall(), Date.parse(version.record.createdAt))).toISOString();
    const id = randomUUID();
    transaction(this.db, () =>
      this.db
        .prepare(
          `INSERT INTO teaching_sessions (id,version_id,class_id,revision,request_id,request_hash,created_at,updated_at,status,elapsed_ms,interrupted,payload) VALUES (?,?,?,1,?,?,?,?,'paused',0,0,?)`,
        )
        .run(
          id,
          input.versionId,
          input.classId,
          input.requestId,
          requestHash,
          now,
          now,
          JSON.stringify({
            slideIds: input.slideIds,
            index: 0,
            answersVisible: false,
            questionsVisible: false,
          }),
        ),
    );
    return this.read({ epoch: input.epoch, id });
  }
  control(raw: unknown) {
    const input = classroomControlInput.parse(raw);
    this.guard(input.epoch);
    const record = readClassroomRecord(this.db, input.id);
    if (record.revision !== input.expectedRevision)
      throw new DomainError('CONFLICT', '课堂进度已变化，请重新读取。');
    if (record.status === 'ended')
      throw new DomainError('CONFLICT', '课堂已结束，请创建新的课堂。');
    const sample = this.monotonic();
    let elapsedMs = this.elapsed(record, sample);
    let status: ClassroomRecord['status'] = record.status;
    const payload = { ...record.payload };
    switch (input.action) {
      case 'resume':
        if ([...this.anchors.keys()].some((id) => id !== record.id))
          throw new DomainError('BUSY', '请先暂停另一堂正在计时的课。');
        status = 'running';
        break;
      case 'pause':
        status = 'paused';
        break;
      case 'finish':
        status = 'ended';
        break;
      case 'reset':
        elapsedMs = 0;
        status = 'paused';
        break;
      case 'answers':
        payload.answersVisible = input.visible!;
        break;
      case 'questions':
        payload.questionsVisible = input.visible!;
        break;
      default: {
        const index =
          input.action === 'slide'
            ? payload.slideIds.indexOf(input.slideId!)
            : payload.index + (input.action === 'next' ? 1 : -1);
        if (index < 0 || index >= payload.slideIds.length)
          throw new DomainError('VALIDATION', '没有所选范围内的课件页。');
        const version = readLessonVersion(this.db, record.versionId);
        if (
          version.payload.content.slides.find((value) => value.id === payload.slideIds[index])!
            .sectionId !==
          version.payload.content.slides.find(
            (value) => value.id === payload.slideIds[payload.index],
          )!.sectionId
        ) {
          elapsedMs = 0;
          status = 'paused';
        }
        payload.index = index;
        payload.answersVisible = false;
        payload.questionsVisible = false;
      }
    }
    const now = new Date(Math.max(this.wall(), Date.parse(record.updatedAt))).toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          'UPDATE teaching_sessions SET revision=revision+1, updated_at=?, status=?, elapsed_ms=?, interrupted=0, payload=? WHERE id=? AND revision=?',
        )
        .run(now, status, elapsedMs, JSON.stringify(payload), record.id, record.revision);
    });
    if (status === 'running') {
      // The persisted elapsed value includes the preceding interval; always reset the anchor.
      this.anchors.set(record.id, { startedAt: sample, baseMs: elapsedMs });
    } else this.anchors.delete(record.id);
    this.checkpointFailed = false;
    return this.read({ epoch: input.epoch, id: record.id });
  }
  checkpoint() {
    if (!this.alive) return;
    try {
      for (const id of this.anchors.keys()) {
        const record = readClassroomRecord(this.db, id);
        const sample = this.monotonic();
        const elapsedMs = this.elapsed(record, sample);
        this.db
          .prepare("UPDATE teaching_sessions SET elapsed_ms=? WHERE id=? AND status='running'")
          .run(elapsedMs, id);
      }
      this.checkpointFailed = false;
    } catch (error) {
      this.checkpointFailed = true;
      throw error;
    }
  }
  pauseAll() {
    this.checkpoint();
    this.db.exec(
      "UPDATE teaching_sessions SET status='paused', revision=revision+1 WHERE status='running'",
    );
    this.anchors.clear();
  }
  dispose() {
    this.anchors.clear();
    this.alive = false;
  }
  countdown(raw: unknown) {
    const { epoch } = epochInput.parse(raw);
    this.guard(epoch);
    const record = readCountdownRecord(this.db);
    return record ? countdownView(record, this.wall()) : null;
  }
  setCountdown(raw: unknown) {
    const input = countdownInput.parse(raw);
    this.guard(input.epoch);
    const old = readCountdownRecord(this.db);
    if ((old?.revision ?? 0) !== input.expectedRevision)
      throw new DomainError('CONFLICT', '倒计时已更新，请重新读取。');
    this.db
      .prepare(
        'INSERT INTO countdown_settings (id,revision,payload) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',
      )
      .run(input.expectedRevision + 1, JSON.stringify(input.setting));
    return this.countdown({ epoch: input.epoch })!;
  }
}
