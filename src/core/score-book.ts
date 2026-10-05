import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../shared/contracts';
import { epochInput } from '../shared/contracts';
import { SCORE_FILE_LIMITS } from '../shared/score-import';
import {
  scoreConfirmInput,
  scoreHistoryInput,
  scoreListInput,
  scorePreviewInput,
  scoreReadInput,
  scoreTemplateInput,
  studentScoreHistoryInput,
  type ExamSummary,
  type PendingScoreView,
  type ScoreConfirmation,
  type ScoreVersionView,
  type StudentScoreHistory,
} from '../shared/score-commands';
import {
  storedScoreVersionSchema,
  type ScoreVersionPayload,
  type StoredScoreVersion,
} from '../shared/score-records';
import { createScoreTemplate, previewScoreImport } from './score-import';
import { calculateScoreStatistics, presentSubjectScore } from './scores';
import { validateScorePayload } from './score-record-validation';
import { DomainError } from './errors';
import { transaction } from './database';
import { MAX_EXAMS, MAX_SCORE_PAYLOAD_BYTES, MAX_SCORE_VERSIONS } from './storage-limits';
import { scoreDifferences } from './score-differences';
import { ScorePublication, type PublicationCheckpoint } from './score-publication';

export type ScoreCheckpoint = (stage: 'exam-created' | 'version-inserted' | 'committed') => void;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordColumns = `id, exam_id AS examId, revision, request_id AS requestId,
  request_hash AS requestHash, created_at AS createdAt, reason`;
const previewLifetimeMs = 15 * 60 * 1000;
const examIdentity = (definition: Omit<ScoreVersionPayload['definition'], 'className'>) =>
  digest([
    definition.name,
    definition.date,
    definition.academicYear,
    definition.term,
    definition.grade,
  ]);
interface Pending {
  token: string;
  epoch: string;
  examId: string;
  classId: string;
  expectedRevision: number;
  fingerprint: string;
  historicalIds: string[];
  expiresAt: number;
  serialized: string;
  identity: string;
}

/** 管理成绩预览与版本生命周期；外部只能确认令牌，不能提交任意持久化内容。 */
export class ScoreBook {
  private pending?: Pending;
  private sequence = 0;
  private disposed = false;
  readonly publication: ScorePublication;

  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshot: () => Snapshot,
    private readonly checkpoint?: ScoreCheckpoint,
    publicationCheckpoint?: PublicationCheckpoint,
  ) {
    this.publication = new ScorePublication(db, snapshot, publicationCheckpoint);
  }

  dispose(): void {
    this.publication.dispose();
    this.pending = undefined;
    this.sequence++;
    this.disposed = true;
  }

  private guard(epoch: string): Snapshot {
    if (this.disposed) throw new DomainError('STALE_WORKSPACE', '成绩工作区已关闭或恢复，请刷新。');
    const snapshot = this.snapshot();
    if (snapshot.epoch !== epoch)
      throw new DomainError('STALE_WORKSPACE', '数据已切换，请刷新后操作。');
    return snapshot;
  }

  private latest(examId: string): StoredScoreVersion | null {
    const row = this.db
      .prepare(
        `SELECT ${recordColumns} FROM score_versions WHERE exam_id=? ORDER BY revision DESC LIMIT 1`,
      )
      .get(examId);
    return row ? storedScoreVersionSchema.parse(row) : null;
  }

  private payload(versionId: string): ScoreVersionPayload {
    const row = this.db.prepare('SELECT payload FROM score_versions WHERE id=?').get(versionId);
    if (!row) throw new DomainError('NOT_FOUND', '成绩版本不存在。');
    return validateScorePayload(JSON.parse(String(row.payload)));
  }

  private assertDistinctExam(classId: string, identity: string, exceptId?: string): void {
    const rows = this.db
      .prepare(
        `SELECT v.payload FROM exams e JOIN score_versions v ON v.exam_id=e.id
      WHERE e.class_id=? AND e.id<>? AND v.revision=(SELECT MAX(revision) FROM score_versions WHERE exam_id=e.id)`,
      )
      .iterate(classId, exceptId ?? '');
    for (const row of rows) {
      const existing: ScoreVersionPayload = JSON.parse(String(row.payload));
      if (examIdentity(existing.definition) === identity) {
        throw new DomainError(
          'EXAM_DUPLICATE',
          '已存在同名、同日期和同学期考试，请选择已有考试进行更正。',
        );
      }
    }
  }

  private fingerprint(snapshot: Snapshot, classId: string, historicalIds: string[]): string {
    const ids = new Set(historicalIds);
    return digest({
      classroom: snapshot.classes.find((classroom) => classroom.id === classId),
      students: snapshot.students
        .filter((student) => student.classId === classId || ids.has(student.id))
        .map(({ id, revision, classId, active, studentNumber, displayName }) => ({
          id,
          revision,
          classId,
          active,
          studentNumber,
          displayName,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  }

  private configuration(input: ReturnType<typeof scorePreviewInput.parse>) {
    const snapshot = this.guard(input.epoch);
    const classroom = snapshot.classes.find((item) => item.id === input.classId);
    if (!classroom) throw new DomainError('NOT_FOUND', '班级不存在。');
    const identity = examIdentity(input.definition);
    this.assertDistinctExam(input.classId, identity, input.examId);
    const previous = input.examId ? this.latest(input.examId) : null;
    if ((previous?.revision ?? 0) !== input.expectedRevision) {
      throw new DomainError('CONFLICT', '考试版本已变化，请重新预览。');
    }
    if (
      input.examId &&
      this.db.prepare('SELECT class_id FROM exams WHERE id=?').get(input.examId)?.class_id !==
        input.classId
    ) {
      throw new DomainError('CONFLICT', '考试不属于当前班级。');
    }
    const oldPayload = previous ? this.payload(previous.id) : null;
    const roster =
      oldPayload?.analysis.roster ??
      snapshot.students
        .filter((student) => student.active && student.classId === input.classId)
        .map((student) => ({
          studentId: student.id,
          studentNumber: student.studentNumber,
          displayName: student.displayName,
        }));
    const assignments = new Map(input.assignments.map((item) => [item.studentId, item.groupId]));
    if (
      assignments.size !== input.assignments.length ||
      assignments.size !== roster.length ||
      roster.some((student) => !assignments.has(student.studentId))
    ) {
      throw new DomainError(
        'SCORE_ROSTER',
        '必须为完整应考名册逐人指定计分组，不能省略或加入其他学生。',
      );
    }
    const historicalIds = roster.map((student) => student.studentId);
    const fingerprint = this.fingerprint(snapshot, input.classId, historicalIds);
    const context = {
      subjects: input.subjects,
      groups: input.groups,
      scoreBasis: input.scoreBasis,
      className: oldPayload?.definition.className ?? classroom.name,
      roster: roster.map((student) => ({
        ...student,
        groupId: assignments.get(student.studentId)!,
      })),
      columnMappings: input.columnMappings,
      exclusions: input.exclusions,
    };
    return { context, oldPayload, identity, historicalIds, fingerprint };
  }

  async template(raw: unknown): Promise<Buffer> {
    const parsed = scoreTemplateInput.parse(raw);
    const input = scorePreviewInput.parse({ ...parsed, fileName: `template.${parsed.format}` });
    const { context, fingerprint, historicalIds } = this.configuration(input);
    const bytes = await createScoreTemplate(context, input.format);
    if (fingerprint !== this.fingerprint(this.guard(input.epoch), input.classId, historicalIds)) {
      throw new DomainError('CONFLICT', '生成模板期间名册发生变化，请重新导出。');
    }
    return bytes;
  }

  async preview(bytes: Uint8Array, raw: unknown): Promise<PendingScoreView> {
    this.pending = undefined;
    const sequence = ++this.sequence;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > SCORE_FILE_LIMITS.bytes
    ) {
      throw new DomainError('SCORE_FILE_LIMIT', '成绩文件为空或超过 5 MiB 上限。');
    }
    const input = scorePreviewInput.parse(raw);
    const { context, oldPayload, identity, historicalIds, fingerprint } = this.configuration(input);
    const file = await previewScoreImport(Uint8Array.from(bytes), input.format, context);
    const current = this.guard(input.epoch);
    if (
      sequence !== this.sequence ||
      fingerprint !== this.fingerprint(current, input.classId, historicalIds) ||
      (input.examId && this.latest(input.examId)?.revision !== input.expectedRevision)
    ) {
      throw new DomainError('CONFLICT', '预览期间数据发生变化，请重新预览。');
    }
    const examId = input.examId ?? randomUUID();
    let statistics: PendingScoreView['statistics'] = null;
    let differences: PendingScoreView['differences'] = null;
    let unchanged = false;
    if (file.canConfirm) {
      const payload = validateScorePayload({
        formatVersion: 1,
        scoreBasis: 'raw',
        definition: { ...input.definition, className: context.className },
        analysis: {
          subjects: input.subjects,
          groups: input.groups,
          roster: context.roster,
          entries: file.entries,
          includeRanks: input.includeRanks,
        },
        source: {
          kind: input.format,
          fileHash: file.fileHash,
          fileName: input.fileName,
          columnMappings: input.columnMappings,
          exclusions: input.exclusions,
        },
      });
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized) > MAX_SCORE_PAYLOAD_BYTES) {
        throw new DomainError('STORAGE_LIMIT', '本次成绩版本超过容量限制，未保存。');
      }
      statistics = calculateScoreStatistics({
        ...payload.analysis,
        roster: payload.analysis.roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
      });
      differences = oldPayload ? scoreDifferences(oldPayload, payload) : null;
      unchanged =
        differences !== null &&
        differences.scores.length === 0 &&
        differences.configuration.length === 0;
      if (!unchanged)
        this.pending = {
          token: randomUUID(),
          epoch: input.epoch,
          examId,
          classId: input.classId,
          expectedRevision: input.expectedRevision,
          fingerprint,
          historicalIds,
          expiresAt: Date.now() + previewLifetimeMs,
          serialized,
          identity,
        };
    }
    return {
      ...file,
      canConfirm: file.canConfirm && !unchanged,
      token: this.pending?.token ?? null,
      examId,
      expectedRevision: input.expectedRevision,
      expiresAt: this.pending ? new Date(this.pending.expiresAt).toISOString() : null,
      statistics,
      differences,
      unchanged,
    };
  }

  cancel(raw: unknown): void {
    const input = epochInput.parse(raw);
    this.guard(input.epoch);
    this.pending = undefined;
    this.sequence++;
  }

  confirm(raw: unknown): ScoreConfirmation {
    const input = scoreConfirmInput.parse(raw);
    this.guard(input.epoch);
    const requestHash = digest(input);
    const receipt = (record: StoredScoreVersion, replayed: boolean): ScoreConfirmation => ({
      examId: record.examId,
      versionId: record.id,
      revision: record.revision,
      createdAt: record.createdAt,
      replayed,
    });
    try {
      const result = transaction(this.db, () => {
        const existing = this.db
          .prepare(`SELECT ${recordColumns} FROM score_versions WHERE request_id=?`)
          .get(input.requestId);
        if (existing) {
          const record = storedScoreVersionSchema.parse(existing);
          if (record.requestHash !== requestHash)
            throw new DomainError('IDEMPOTENCY_CONFLICT', '同一请求编号不能用于不同的确认内容。');
          return receipt(record, true);
        }
        const pending = this.pending;
        if (
          !pending ||
          pending.token !== input.token ||
          pending.epoch !== input.epoch ||
          pending.expiresAt < Date.now()
        ) {
          throw new DomainError('SCORE_PREVIEW_EXPIRED', '成绩预览已失效，请重新预览。');
        }
        if (
          pending.expectedRevision !== input.expectedRevision ||
          this.fingerprint(this.guard(input.epoch), pending.classId, pending.historicalIds) !==
            pending.fingerprint
        ) {
          throw new DomainError('CONFLICT', '名册或确认版本已变化，请重新预览。');
        }
        const previous = this.latest(pending.examId);
        this.assertDistinctExam(pending.classId, pending.identity, pending.examId);
        if ((previous?.revision ?? 0) !== pending.expectedRevision)
          throw new DomainError('CONFLICT', '成绩已被更正，请重新预览。');
        if (
          Number(this.db.prepare('SELECT COUNT(*) AS count FROM score_versions').get()?.count) >=
            MAX_SCORE_VERSIONS ||
          (!previous &&
            Number(this.db.prepare('SELECT COUNT(*) AS count FROM exams').get()?.count) >=
              MAX_EXAMS)
        ) {
          throw new DomainError('STORAGE_LIMIT', '考试或版本数量达到上限，原历史记录未删除。');
        }
        const createdAt = new Date(
          Math.max(Date.now(), Date.parse(previous?.createdAt ?? '1970-01-01T00:00:00Z')),
        ).toISOString();
        if (!previous) {
          this.db
            .prepare('INSERT INTO exams VALUES (?, ?, ?)')
            .run(pending.examId, pending.classId, createdAt);
          this.checkpoint?.('exam-created');
        }
        const versionId = randomUUID();
        const revision = pending.expectedRevision + 1;
        this.db
          .prepare('INSERT INTO score_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            versionId,
            pending.examId,
            revision,
            input.requestId,
            requestHash,
            createdAt,
            input.reason,
            pending.serialized,
          );
        this.checkpoint?.('version-inserted');
        return { examId: pending.examId, versionId, revision, createdAt, replayed: false };
      });
      if (!result.replayed) {
        this.pending = undefined;
        this.checkpoint?.('committed');
      }
      return result;
    } catch (error) {
      if (error && typeof error === 'object' && 'errcode' in error && error.errcode === 13) {
        throw new DomainError('STORAGE_LIMIT', '数据库空间不足，未完成的写入已回滚，原成绩保留。');
      }
      throw error;
    }
  }

  list(raw: unknown): ExamSummary[] {
    const input = scoreListInput.parse(raw);
    this.guard(input.epoch);
    const rows = this.db
      .prepare(
        `SELECT e.id, e.class_id AS classId, v.id AS versionId, v.revision, v.created_at AS updatedAt
      FROM exams e JOIN score_versions v ON v.exam_id=e.id
      WHERE v.revision=(SELECT MAX(revision) FROM score_versions WHERE exam_id=e.id)
      AND (? IS NULL OR e.class_id=?) ORDER BY v.created_at DESC, e.id`,
      )
      .all(input.classId ?? null, input.classId ?? null);
    return rows.map((row) => {
      const payload = this.payload(String(row.versionId));
      return {
        examId: String(row.id),
        classId: String(row.classId),
        versionId: String(row.versionId),
        revision: Number(row.revision),
        updatedAt: String(row.updatedAt),
        definition: payload.definition,
        studentCount: payload.analysis.roster.length,
      };
    });
  }

  history(raw: unknown): StoredScoreVersion[] {
    const input = scoreHistoryInput.parse(raw);
    this.guard(input.epoch);
    return this.db
      .prepare(`SELECT ${recordColumns} FROM score_versions WHERE exam_id=? ORDER BY revision DESC`)
      .all(input.examId)
      .map((row) => storedScoreVersionSchema.parse(row));
  }

  studentHistory(raw: unknown): StudentScoreHistory {
    const input = studentScoreHistoryInput.parse(raw);
    const snapshot = this.guard(input.epoch);
    if (!snapshot.students.some((student) => student.id === input.studentId)) {
      throw new DomainError('NOT_FOUND', '学生不存在。');
    }
    const rows = this.db
      .prepare(
        `SELECT ${recordColumns} FROM score_versions v
      WHERE revision=(SELECT MAX(revision) FROM score_versions WHERE exam_id=v.exam_id)`,
      )
      .all();
    const entries: StudentScoreHistory['entries'] = [];
    for (const row of rows) {
      const record = storedScoreVersionSchema.parse(row);
      const payload = this.payload(record.id);
      if (!payload.analysis.roster.some((student) => student.studentId === input.studentId))
        continue;
      const subject = payload.analysis.subjects.find((subject) => subject.id === input.subjectId);
      if (!subject) continue;
      const score = payload.analysis.entries.find(
        (entry) => entry.studentId === input.studentId && entry.subjectId === input.subjectId,
      )?.score ?? { status: 'missing' as const };
      entries.push({
        examId: record.examId,
        versionId: record.id,
        revision: record.revision,
        examName: payload.definition.name,
        date: payload.definition.date,
        className: payload.definition.className,
        subjectName: subject.name,
        maxScore: subject.maxScore,
        score,
        ...presentSubjectScore(score, subject),
      });
    }
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.examId.localeCompare(b.examId));
    const hasMultipleValidExams =
      entries.filter((entry) => entry.score.status === 'valid').length >= 2;
    const notes = ['试卷难度与参照群体可能变化，分数和得分率不能直接证明能力变化。'];
    if (!hasMultipleValidExams) notes.push('有效历史考试不足两次，不生成趋势结论。');
    return { entries, hasMultipleValidExams, notes };
  }

  read(raw: unknown): ScoreVersionView {
    const input = scoreReadInput.parse(raw);
    this.guard(input.epoch);
    const row = this.db
      .prepare(`SELECT ${recordColumns} FROM score_versions WHERE id=?`)
      .get(input.versionId);
    if (!row) throw new DomainError('NOT_FOUND', '成绩版本不存在。');
    const record = storedScoreVersionSchema.parse(row);
    const payload = this.payload(record.id);
    const latest = this.latest(record.examId)!;
    return {
      record,
      payload,
      latestVersionId: latest.id,
      stale: latest.id !== record.id,
      statistics: calculateScoreStatistics({
        ...payload.analysis,
        roster: payload.analysis.roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
      }),
    };
  }
}
