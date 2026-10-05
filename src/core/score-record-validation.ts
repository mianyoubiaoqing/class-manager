import type { DatabaseSync } from 'node:sqlite';
import {
  scoreVersionPayloadSchema,
  storedExamSchema,
  storedScoreVersionSchema,
  type ScoreVersionPayload,
} from '../shared/score-records';
import { calculateScoreStatistics } from './scores';
import { DomainError } from './errors';
import { MAX_EXAMS, MAX_SCORE_PAYLOAD_BYTES, MAX_SCORE_VERSIONS } from './storage-limits';

export function validateScorePayload(raw: unknown): ScoreVersionPayload {
  const payload = scoreVersionPayloadSchema.parse(raw);
  const { roster, ...analysis } = payload.analysis;
  calculateScoreStatistics({
    ...analysis,
    roster: roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
  });
  if (new Set(roster.map((student) => student.studentNumber)).size !== roster.length) {
    throw new DomainError('BACKUP_INVALID', '成绩版本名册存在重复学生编号。');
  }
  const mappings = payload.source.columnMappings;
  const exclusions = payload.source.exclusions;
  if (
    new Set(mappings.map((mapping) => mapping.header)).size !== mappings.length ||
    new Set(mappings.map((mapping) => mapping.subjectId)).size !== mappings.length ||
    mappings.some(
      (mapping) =>
        ['学生编号', '姓名', '班级'].includes(mapping.header) ||
        /赋分|等级|转换分/u.test(mapping.header),
    ) ||
    analysis.subjects.some(
      (subject) =>
        ['学生编号', '姓名', '班级'].includes(subject.name) ||
        /赋分|等级|转换分/u.test(subject.name),
    ) ||
    mappings.some(
      (mapping) => !analysis.subjects.some((subject) => subject.id === mapping.subjectId),
    ) ||
    new Set(exclusions.map((exclusion) => exclusion.row)).size !== exclusions.length
  ) {
    throw new DomainError('BACKUP_INVALID', '成绩版本来源映射或排除记录无效。');
  }
  return payload;
}

/** 备份中的 JSON 仍是不可信数据，SQL 结构正确不代表成绩语义正确。 */
export function validateScoreRecords(db: DatabaseSync): void {
  try {
    for (const [table, maximum] of [
      ['exams', MAX_EXAMS],
      ['score_versions', MAX_SCORE_VERSIONS],
    ] as const) {
      if (Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count) > maximum) {
        throw new DomainError('BACKUP_INVALID', '考试或成绩版本数量超过限制。');
      }
    }
    const exams = db
      .prepare('SELECT id, class_id AS classId, created_at AS createdAt FROM exams')
      .all()
      .map((row) => storedExamSchema.parse(row));
    const examById = new Map(exams.map((exam) => [exam.id, exam]));
    const studentIds = new Set(
      db
        .prepare('SELECT id FROM students')
        .all()
        .map((row) => row.id),
    );
    const revisions = new Map<string, { revision: number; createdAt: string }>();
    const rows = db
      .prepare(
        `SELECT id, exam_id AS examId, revision, request_id AS requestId,
        request_hash AS requestHash, created_at AS createdAt, reason,
        length(CAST(payload AS BLOB)) AS payloadBytes FROM score_versions ORDER BY exam_id, revision`,
      )
      .all();
    for (const { payloadBytes, ...row } of rows) {
      const version = storedScoreVersionSchema.parse(row);
      const exam = examById.get(version.examId);
      const previous = revisions.get(version.examId);
      if (
        !exam ||
        version.revision !== (previous?.revision ?? 0) + 1 ||
        Date.parse(version.createdAt) < Date.parse(previous?.createdAt ?? exam.createdAt) ||
        Number(payloadBytes) > MAX_SCORE_PAYLOAD_BYTES
      ) {
        throw new DomainError('BACKUP_INVALID', '成绩版本链或内容大小无效。');
      }
      const raw = db.prepare('SELECT payload FROM score_versions WHERE id=?').get(version.id);
      const payload = validateScorePayload(JSON.parse(String(raw?.payload)));
      if (
        payload.publication &&
        Number(db.prepare('PRAGMA user_version').get()?.user_version) < 9
      ) {
        throw new DomainError('BACKUP_INVALID', '旧数据版本不能包含正式入分来源。');
      }
      if (payload.analysis.roster.some((student) => !studentIds.has(student.studentId))) {
        throw new DomainError('BACKUP_INVALID', '成绩版本引用了不存在的学生。');
      }
      revisions.set(version.examId, version);
    }
    if (revisions.size !== exams.length) {
      throw new DomainError('BACKUP_INVALID', '考试缺少已确认的成绩版本。');
    }
  } catch {
    throw new DomainError('BACKUP_INVALID', '成绩记录不完整或无效，已拒绝打开。');
  }
}
