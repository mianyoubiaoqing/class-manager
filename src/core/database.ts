import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { DomainError } from './errors';

export const SCHEMA_VERSION = 1;
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
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const expectedSchema = schemaStatements.map(normalized).sort();

/** 遇到未知或被修改的结构立即停写，不能用“重建空库”掩盖兼容性错误。 */
export function validateDatabase(db: DatabaseSync): void {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  const applicationId = db.prepare('PRAGMA application_id').get()?.application_id;
  if (version !== SCHEMA_VERSION || applicationId !== APPLICATION_ID) {
    throw new DomainError(
      'UNSUPPORTED_SCHEMA',
      '数据版本不受此程序支持。请保留数据并使用兼容版本。',
    );
  }
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
}

export function openDatabase(path: string, mode: 'create' | 'open' | 'readonly'): DatabaseSync {
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
    if (mode === 'create') {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      try {
        for (const sql of schemaStatements) db.exec(sql);
        db.exec(
          `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`,
        );
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    validateDatabase(db);
    if (mode === 'open') db.exec('PRAGMA synchronous=FULL;');
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
    db.exec('ROLLBACK');
    throw error;
  }
}
