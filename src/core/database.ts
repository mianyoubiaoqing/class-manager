import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DomainError } from './errors';
import { readSnapshot } from './snapshot';
import { validateScoreRecords } from './score-record-validation';
import { validateExplanationRecords } from './explanation-records';
import { validateSeatingRecords } from './seating-records';
import { validateDutyRecords } from './duty-records';
import { validateMaterialRecords } from './material-records';
import { validateLessonRecords } from './lesson-records';
import { validateClassroomRecords } from './classroom-records';
import { CLASSROOM_LIMITS } from '../shared/classroom';
import { validateGradingRecords } from './grading-records';
import { validateScorePublications } from './score-publication-records';
import { validateGrowthRecords } from './growth-records';
import { pupilSchemaStatements, validatePupilRecords } from './pupil-records';
import {
  MAX_DATABASE_BYTES,
  MAX_SCORE_PAYLOAD_BYTES,
  MAX_EXPLANATION_PAYLOAD_BYTES,
  MAX_SEATING_PAYLOAD_BYTES,
  MAX_DUTY_PAYLOAD_BYTES,
  MAX_MATERIAL_PAYLOAD_BYTES,
  MAX_LESSON_PAYLOAD_BYTES,
  MAX_RUBRIC_PAYLOAD_BYTES,
  MAX_GRADING_PAYLOAD_BYTES,
  MAX_GRADING_ATTEMPT_BYTES,
  MAX_GROWTH_EVENT_BYTES,
  MAX_GROWTH_SUMMARY_BYTES,
} from './storage-limits';

export const SCHEMA_VERSION = 12;
export const APPLICATION_ID = 0x434d3030;
const schemaStatements = [
  `CREATE TABLE classrooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE students (
    id TEXT PRIMARY KEY, student_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
    revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL
  )`,
  `CREATE TABLE enrollments (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
    class_id TEXT NOT NULL REFERENCES classrooms(id), valid_from TEXT NOT NULL, valid_to TEXT
  )`,
  `CREATE UNIQUE INDEX one_active_enrollment ON enrollments(student_id) WHERE valid_to IS NULL`,
  `CREATE TABLE assets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0),
    sha256 TEXT NOT NULL
  )`,
];
const scoreSchemaStatements = [
  // 历史名册校验按学生查最后归属；无此索引，大名册会退化为重复全表扫描。
  `CREATE INDEX enrollment_history ON enrollments(student_id)`,
  `CREATE TABLE exams (
    id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classrooms(id), created_at TEXT NOT NULL
  )`,
  `CREATE TABLE score_versions (
    id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exams(id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, reason TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_SCORE_PAYLOAD_BYTES}),
    UNIQUE(exam_id, revision)
  )`,
];
const explanationSchemaStatements = [
  `CREATE TABLE explanation_drafts (
    id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES score_versions(id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    status TEXT NOT NULL CHECK(status IN ('draft','discarded')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, discarded_at TEXT,
    generation_request_id TEXT NOT NULL UNIQUE, generation_hash TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_EXPLANATION_PAYLOAD_BYTES})
  )`,
  `CREATE INDEX explanation_source ON explanation_drafts(source_version_id)`,
];
const seatingSchemaStatements = [
  `CREATE TABLE seating_versions (
    id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classrooms(id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, reason TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_SEATING_PAYLOAD_BYTES}),
    UNIQUE(class_id, revision)
  )`,
];
const dutySchemaStatements = [
  `CREATE TABLE duty_clock (
    id INTEGER PRIMARY KEY CHECK(id=1), protected_date TEXT NOT NULL
  )`,
  `CREATE TABLE duty_versions (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, class_id TEXT NOT NULL REFERENCES classrooms(id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, protected_date TEXT NOT NULL, reason TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_DUTY_PAYLOAD_BYTES}),
    UNIQUE(plan_id, revision)
  )`,
];
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const materialSchemaStatements = [
  `CREATE TABLE material_versions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
    import_request_id TEXT NOT NULL UNIQUE, import_hash TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_MATERIAL_PAYLOAD_BYTES})
  )`,
  `CREATE TABLE material_assets (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id),
    source_version_id TEXT NOT NULL REFERENCES material_versions(id), mime TEXT NOT NULL
  )`,
  `CREATE INDEX material_asset_source ON material_assets(source_version_id)`,
];
const lessonSchemaStatements = [
  `CREATE TABLE lesson_drafts (
    id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
    status TEXT NOT NULL CHECK(status IN ('draft','discarded','frozen')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    base_version_id TEXT REFERENCES lesson_versions(id), generation_request_id TEXT NOT NULL UNIQUE,
    generation_hash TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_LESSON_PAYLOAD_BYTES})
  )`,
  `CREATE TABLE lesson_versions (
    id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL,
    draft_id TEXT NOT NULL UNIQUE REFERENCES lesson_drafts(id),
    revision INTEGER NOT NULL CHECK(revision > 0), request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_LESSON_PAYLOAD_BYTES}),
    UNIQUE(lesson_id, revision)
  )`,
  `CREATE INDEX lesson_draft_series ON lesson_drafts(lesson_id)`,
];

const classroomSchemaStatements = [
  `CREATE TABLE teaching_sessions (
    id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES lesson_versions(id),
    class_id TEXT NOT NULL REFERENCES classrooms(id), revision INTEGER NOT NULL CHECK(revision > 0),
    request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('paused','running','ended')),
    elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0 AND elapsed_ms <= ${CLASSROOM_LIMITS.elapsedMs}),
    interrupted INTEGER NOT NULL CHECK(interrupted IN (0,1)),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${CLASSROOM_LIMITS.payloadBytes})
  )`,
  `CREATE TABLE countdown_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision > 0),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 1024)
  )`,
];

const gradingSchemaStatements = [
  `CREATE TABLE rubric_versions (
    id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exams(id), subject_id TEXT NOT NULL,
    score_version_id TEXT NOT NULL REFERENCES score_versions(id), revision INTEGER NOT NULL CHECK(revision > 0),
    request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_RUBRIC_PAYLOAD_BYTES}),
    UNIQUE(exam_id, subject_id, revision)
  )`,
  `CREATE TABLE grading_drafts (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
    status TEXT NOT NULL CHECK(status IN ('draft','frozen')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    create_request_id TEXT NOT NULL UNIQUE, create_hash TEXT NOT NULL,
    base_review_id TEXT REFERENCES grading_reviews(id),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GRADING_PAYLOAD_BYTES})
  )`,
  `CREATE TABLE grading_reviews (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES grading_drafts(id),
    draft_revision INTEGER NOT NULL CHECK(draft_revision > 0), request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, total_hundredths INTEGER NOT NULL CHECK(total_hundredths >= 0), reason TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GRADING_PAYLOAD_BYTES})
  )`,
  `CREATE TABLE grading_attempts (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES grading_drafts(id), base_revision INTEGER NOT NULL CHECK(base_revision > 0),
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled','interrupted')),
    started_at TEXT NOT NULL, ended_at TEXT, result_revision INTEGER, request_hash TEXT NOT NULL, result_hash TEXT, error_code TEXT,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GRADING_ATTEMPT_BYTES})
  )`,
  `CREATE INDEX grading_attempt_draft ON grading_attempts(draft_id)`,
  `CREATE TABLE grading_revisions (
    draft_id TEXT NOT NULL REFERENCES grading_drafts(id), revision INTEGER NOT NULL CHECK(revision > 0),
    operation TEXT NOT NULL CHECK(operation IN ('created','edited','rebound','generated','frozen')),
    created_at TEXT NOT NULL, request_id TEXT,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GRADING_PAYLOAD_BYTES}),
    PRIMARY KEY(draft_id, revision)
  )`,
];

const publicationSchemaStatements = [
  `CREATE TABLE grading_publications (
    review_id TEXT PRIMARY KEY REFERENCES grading_reviews(id), exam_id TEXT NOT NULL REFERENCES exams(id),
    previous_version_id TEXT NOT NULL REFERENCES score_versions(id), score_version_id TEXT NOT NULL UNIQUE REFERENCES score_versions(id),
    created_at TEXT NOT NULL, reason TEXT NOT NULL
  )`,
];

const growthSchemaStatements = [
  `CREATE TABLE growth_events (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), revision INTEGER NOT NULL CHECK(revision > 0),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GROWTH_EVENT_BYTES})
  )`,
  `CREATE TABLE growth_event_revisions (
    event_id TEXT NOT NULL REFERENCES growth_events(id), revision INTEGER NOT NULL CHECK(revision > 0),
    request_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GROWTH_EVENT_BYTES}), PRIMARY KEY(event_id, revision)
  )`,
  `CREATE TABLE growth_summaries (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), revision INTEGER NOT NULL CHECK(revision > 0),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GROWTH_SUMMARY_BYTES})
  )`,
  `CREATE TABLE growth_summary_revisions (
    draft_id TEXT NOT NULL REFERENCES growth_summaries(id), revision INTEGER NOT NULL CHECK(revision > 0),
    operation TEXT NOT NULL CHECK(operation IN ('created','edited','discarded','confirmed')),
    request_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GROWTH_SUMMARY_BYTES}), PRIMARY KEY(draft_id, revision)
  )`,
  `CREATE TABLE growth_summary_entries (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES growth_summaries(id), student_id TEXT NOT NULL REFERENCES students(id),
    payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_GROWTH_SUMMARY_BYTES})
  )`,
];

/** 遇到未知或被修改的结构立即停写，不能用“重建空库”掩盖兼容性错误。 */
export function validateDatabase(db: DatabaseSync): void {
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
  const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count);
  if (pageSize * pages > MAX_DATABASE_BYTES) {
    throw new DomainError('STORAGE_LIMIT', '数据库超过 64 MiB 容量上限，请保留原数据。');
  }
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  const applicationId = db.prepare('PRAGMA application_id').get()?.application_id;
  if (
    (version !== 1 &&
      version !== 2 &&
      version !== 3 &&
      version !== 4 &&
      version !== 5 &&
      version !== 6 &&
      version !== 7 &&
      version !== 8 &&
      version !== 9 &&
      version !== 10 &&
      version !== 11 &&
      version !== SCHEMA_VERSION) ||
    applicationId !== APPLICATION_ID
  ) {
    throw new DomainError(
      'UNSUPPORTED_SCHEMA',
      '数据版本不受此程序支持。请保留数据并使用兼容版本。',
    );
  }
  const expectedSchema = [
    ...schemaStatements,
    ...(version !== 1 ? scoreSchemaStatements : []),
    ...(Number(version) >= 3 ? explanationSchemaStatements : []),
    ...(Number(version) >= 4 ? seatingSchemaStatements : []),
    ...(Number(version) >= 5 ? dutySchemaStatements : []),
    ...(Number(version) >= 6 ? [...materialSchemaStatements, ...lessonSchemaStatements] : []),
    ...(Number(version) >= 7 ? classroomSchemaStatements : []),
    ...(Number(version) >= 8 ? gradingSchemaStatements : []),
    ...(Number(version) >= 9 ? publicationSchemaStatements : []),
    ...(Number(version) >= 10 ? growthSchemaStatements : []),
    ...(Number(version) >= 12 ? pupilSchemaStatements : []),
  ]
    .map(normalized)
    .sort();
  const actual = db
    .prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name')
    .all()
    .map((row) => normalized(String(row.sql)))
    .sort();
  // 备份是不可信输入，转为可写之前拒绝额外的触发器、视图或其他结构。
  if (JSON.stringify(actual) !== JSON.stringify(expectedSchema)) {
    throw new DomainError('BACKUP_INVALID', '数据库结构与此版本不符，已拒绝打开。');
  }
  if (
    db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length !== 0
  ) {
    throw new DomainError('BACKUP_INVALID', '数据完整性检查失败，原数据未被替换。');
  }
  readSnapshot(db, '', '');
  if (version !== 1) validateScoreRecords(db);
  if (Number(version) >= 3) validateExplanationRecords(db);
  if (Number(version) >= 4) validateSeatingRecords(db);
  if (Number(version) >= 5) validateDutyRecords(db);
  if (Number(version) >= 6) {
    validateMaterialRecords(db);
    validateLessonRecords(db);
  }
  if (Number(version) >= 7) validateClassroomRecords(db);
  if (Number(version) >= 8) validateGradingRecords(db);
  if (Number(version) >= 9) validateScorePublications(db);
  if (Number(version) >= 10) validateGrowthRecords(db);
  if (Number(version) >= 12) validatePupilRecords(db);
}

export function openDatabase(
  path: string,
  mode: 'create' | 'open' | 'readonly',
  options: {
    migrationCheckpoint?: (stage: 'copied' | 'upgraded') => void;
    validateBeforeMigration?: (db: DatabaseSync) => void;
  } = {},
): DatabaseSync {
  if (mode !== 'create' && !existsSync(path)) {
    throw new DomainError('STORAGE_ERROR', '数据文件缺失，程序不会自动创建空库覆盖。');
  }
  const db = new DatabaseSync(path, {
    readOnly: mode === 'readonly',
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000;');
    if (mode !== 'readonly') {
      const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
      db.exec(`PRAGMA max_page_count=${Math.floor(MAX_DATABASE_BYTES / pageSize)}`);
    }
    if (mode === 'create') {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      try {
        for (const sql of [
          ...schemaStatements,
          ...scoreSchemaStatements,
          ...explanationSchemaStatements,
          ...seatingSchemaStatements,
          ...dutySchemaStatements,
          ...materialSchemaStatements,
          ...lessonSchemaStatements,
          ...classroomSchemaStatements,
          ...gradingSchemaStatements,
          ...publicationSchemaStatements,
          ...growthSchemaStatements,
          ...pupilSchemaStatements,
        ])
          db.exec(sql);
        db.exec("INSERT INTO duty_clock VALUES (1, '1900-01-01')");
        db.exec(
          `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`,
        );
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    validateDatabase(db);
    if (mode === 'open') {
      db.exec('PRAGMA synchronous=FULL;');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (typeof version === 'number' && version >= 1 && version < SCHEMA_VERSION) {
        options.validateBeforeMigration?.(db);
        // 原库先完整验证；保留独立副本，迁移失败由 SQLite 事务回滚。
        db.prepare('VACUUM INTO ?').run(`${path}.before-v${SCHEMA_VERSION}-${randomUUID()}.sqlite`);
        options.migrationCheckpoint?.('copied');
        transaction(db, () => {
          if (version === 1) for (const sql of scoreSchemaStatements) db.exec(sql);
          if (version < 3) for (const sql of explanationSchemaStatements) db.exec(sql);
          if (version < 4) for (const sql of seatingSchemaStatements) db.exec(sql);
          if (version < 5) {
            for (const sql of dutySchemaStatements) db.exec(sql);
            db.exec("INSERT INTO duty_clock VALUES (1, '1900-01-01')");
          }
          if (version < 6)
            for (const sql of [...materialSchemaStatements, ...lessonSchemaStatements])
              db.exec(sql);
          if (version < 7) for (const sql of classroomSchemaStatements) db.exec(sql);
          if (version < 8) for (const sql of gradingSchemaStatements) db.exec(sql);
          if (version < 9) for (const sql of publicationSchemaStatements) db.exec(sql);
          if (version < 10) for (const sql of growthSchemaStatements) db.exec(sql);
          if (version < 12) for (const sql of pupilSchemaStatements) db.exec(sql);
          db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
          validateDatabase(db);
          options.migrationCheckpoint?.('upgraded');
        });
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLITE_FULL 等错误可能已由 SQLite 自动回滚，不能覆盖原始失败原因。
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
