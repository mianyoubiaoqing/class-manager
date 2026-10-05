import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import {
  APPLICATION_ID,
  SCHEMA_VERSION,
  openDatabase,
  transaction,
  validateDatabase,
} from '../src/core/database';
import { Workspace } from '../src/core/workspace';
import type { ScoreVersionPayload } from '../src/shared/score-records';
import { MAX_DATABASE_BYTES, MAX_SCORE_PAYLOAD_BYTES } from '../src/core/storage-limits';
import { createExplanationPreparer } from '../src/core/score-explanation';
import { initialExplanationContent, serializeExplanation } from '../src/core/explanation-records';
import { ExplanationBook } from '../src/core/explanation-book';
import type { ExplanationOutput } from '../src/shared/score-explanation';

const roots: string[] = [];
const now = '2026-09-30T02:00:00.000Z';
const classId = '10000000-0000-4000-8000-000000000001';
const studentId = '20000000-0000-4000-8000-000000000001';
const subjectId = '30000000-0000-4000-8000-000000000001';
const groupId = '40000000-0000-4000-8000-000000000001';
const examId = '50000000-0000-4000-8000-000000000001';

function root() {
  const directory = mkdtempSync(join(tmpdir(), 'cm-migration-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// 冻结的 v1 建表文本，不能从当前建表器反推旧格式，否则迁移测试会自证。
function legacy(path: string, version: 1 | 2 | 3 | 4 | 5 = 1) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE classrooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL CHECK(revision > 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE students (
      id TEXT PRIMARY KEY, student_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
      revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL
    );
    CREATE TABLE enrollments (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
      class_id TEXT NOT NULL REFERENCES classrooms(id), valid_from TEXT NOT NULL, valid_to TEXT
    );
    CREATE UNIQUE INDEX one_active_enrollment ON enrollments(student_id) WHERE valid_to IS NULL;
    CREATE TABLE assets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0),
      sha256 TEXT NOT NULL
    );
    PRAGMA application_id=${APPLICATION_ID};
    PRAGMA user_version=1;
  `);
  db.prepare('INSERT INTO classrooms VALUES (?, ?, 1, ?)').run(classId, '合成历史班级', now);
  db.prepare('INSERT INTO students VALUES (?, ?, ?, 1, 1, ?)').run(
    studentId,
    '0001',
    '合成甲',
    now,
  );
  db.prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, NULL)').run(
    randomUUID(),
    studentId,
    classId,
    now,
  );
  if (version >= 2) {
    // Frozen v2 SQL: do not derive this fixture from the current schema creator.
    db.exec(`
      CREATE INDEX enrollment_history ON enrollments(student_id);
      CREATE TABLE exams (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classrooms(id), created_at TEXT NOT NULL
      );
      CREATE TABLE score_versions (
        id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exams(id),
        revision INTEGER NOT NULL CHECK(revision > 0),
        request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, reason TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 41943040),
        UNIQUE(exam_id, revision)
      );
      PRAGMA user_version=2;
    `);
    addVersion(db);
  }
  if (version >= 3) {
    // Frozen v3 structure, independent of the current schema creator.
    db.exec(`
      CREATE TABLE explanation_drafts (
        id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES score_versions(id),
        revision INTEGER NOT NULL CHECK(revision > 0),
        status TEXT NOT NULL CHECK(status IN ('draft','discarded')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, discarded_at TEXT,
        generation_request_id TEXT NOT NULL UNIQUE, generation_hash TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 524288)
      );
      CREATE INDEX explanation_source ON explanation_drafts(source_version_id);
      PRAGMA user_version=3;
    `);
    const source = db.prepare('SELECT id FROM score_versions').get()!;
    // Historical bytes and hash are literal: current producers must not regenerate this fixture.
    const historicalPayload =
      '{"formatVersion":1,"promptVersion":"score-explanation-v1","selection":{"scope":{"kind":"class"},"subjectIds":["30000000-0000-4000-8000-000000000001"],"metrics":["fullScore","validCount","mean"]},"inputHash":"3972ede27f4c4fea78d5fb3d24789a9fd0d68f914a9a655653fbdbdc4e896be6","original":{"formatVersion":1,"observations":[{"factId":"F001","value":"150"},{"factId":"F002","value":1},{"factId":"F003","value":"99.00"}],"interpretations":[],"questions":[],"actions":[],"limitations":["冻结 v3 合成解释"]},"content":{"interpretations":"","questions":"","actions":"","teacherNotes":""},"provider":{"provider":"deepseek","requestModel":"synthetic","responseModel":"synthetic","responseId":"synthetic-v3","generatedAt":"2026-09-30T02:00:00.000Z","durationMs":0,"usage":null}}';
    db.prepare('INSERT INTO explanation_drafts VALUES (?, ?, 1, ?, ?, ?, NULL, ?, ?, ?)').run(
      randomUUID(),
      source.id!,
      'draft',
      now,
      now,
      randomUUID(),
      'c'.repeat(64),
      historicalPayload,
    );
  }
  if (version >= 4) {
    // Frozen v4 SQL and payload, independent of the current seating producer and schema.
    db.exec(`CREATE TABLE seating_versions (
      id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classrooms(id),
      revision INTEGER NOT NULL CHECK(revision > 0),
      request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, reason TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 262144),
      UNIQUE(class_id, revision)
    ); PRAGMA user_version=4;`);
    const payload =
      '{"formatVersion":1,"classId":"10000000-0000-4000-8000-000000000001","className":"合成历史班级","layoutVersionId":"60000000-0000-4000-8000-000000000001","arrangement":{"layout":{"rows":1,"columns":1,"unavailable":[]},"members":[{"studentId":"20000000-0000-4000-8000-000000000001","studentNumber":"0001","displayName":"合成甲"}],"assignments":[{"row":1,"column":1,"studentId":"20000000-0000-4000-8000-000000000001"}],"lockedStudentIds":[]}}';
    db.prepare('INSERT INTO seating_versions VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      classId,
      randomUUID(),
      'd'.repeat(64),
      now,
      '冻结 v4 座位',
      payload,
    );
  }
  if (version === 5) {
    // Frozen v5 statements; do not derive compatibility from the new creator.
    db.exec(`CREATE TABLE duty_clock (
      id INTEGER PRIMARY KEY CHECK(id=1), protected_date TEXT NOT NULL
    );
    CREATE TABLE duty_versions (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, class_id TEXT NOT NULL REFERENCES classrooms(id),
      revision INTEGER NOT NULL CHECK(revision > 0),
      request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, protected_date TEXT NOT NULL, reason TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 16777216),
      UNIQUE(plan_id, revision)
    );
    INSERT INTO duty_clock VALUES (1, '2026-09-30'); PRAGMA user_version=5;`);
    const payload =
      '{"formatVersion":1,"classId":"10000000-0000-4000-8000-000000000001","className":"合成历史班级","title":"冻结v5值日","arrangement":{"members":[{"studentId":"20000000-0000-4000-8000-000000000001","studentNumber":"0001","displayName":"合成甲"}],"participantIds":["20000000-0000-4000-8000-000000000001"],"groups":[{"id":"70000000-0000-4000-8000-000000000001","name":"第一组","studentIds":["20000000-0000-4000-8000-000000000001"]}],"dates":["2026-09-30"],"posts":[{"id":"80000000-0000-4000-8000-000000000001","name":"清扫","startMinute":960,"endMinute":980,"required":1}],"unavailable":[],"days":[{"date":"2026-09-30","groupId":"70000000-0000-4000-8000-000000000001","groupName":"第一组","groupMemberIds":["20000000-0000-4000-8000-000000000001"],"completed":false,"posts":[{"postId":"80000000-0000-4000-8000-000000000001","slots":[{"studentId":"20000000-0000-4000-8000-000000000001","temporaryReplacement":false}]}]}]}}';
    db.prepare('INSERT INTO duty_versions VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      randomUUID(),
      classId,
      randomUUID(),
      'e'.repeat(64),
      now,
      '2026-09-30',
      '冻结v5合成值日',
      payload,
    );
  }
  db.close();
}
function oldWorkspace() {
  const directory = root();
  const epoch = randomUUID();
  const dataDirectory = join(directory, 'workspaces', epoch);
  mkdirSync(join(dataDirectory, 'assets'), { recursive: true });
  const path = join(dataDirectory, 'data.sqlite');
  legacy(path);
  writeFileSync(
    join(directory, 'current.json'),
    JSON.stringify({ workspaceId: epoch, switchedAt: now }),
  );
  return { directory, epoch, path };
}
function bundle(path: string) {
  const bytes = readFileSync(path);
  const db = new DatabaseSync(path, { readOnly: true });
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  db.close();
  return Buffer.from(
    JSON.stringify({
      format: 'class-manager-backup',
      version,
      createdAt: now,
      assets: [],
      database: {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        base64: bytes.toString('base64'),
      },
    }),
  );
}
function payload(): ScoreVersionPayload {
  return {
    formatVersion: 1,
    scoreBasis: 'raw',
    definition: {
      name: '合成月考',
      date: '2026-09-30',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
      className: '合成历史班级',
    },
    analysis: {
      subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 }],
      groups: [{ id: groupId, name: '数学组', subjectIds: [subjectId] }],
      roster: [{ studentId, groupId, studentNumber: '0001', displayName: '合成甲' }],
      entries: [{ studentId, subjectId, score: { status: 'valid', hundredths: 9900 } }],
      includeRanks: false,
    },
    source: {
      kind: 'csv',
      fileHash: 'a'.repeat(64),
      fileName: 'synthetic.csv',
      columnMappings: [],
      exclusions: [],
    },
  };
}
function addVersion(db: DatabaseSync, revision = 1, value = payload()) {
  if (revision === 1) db.prepare('INSERT INTO exams VALUES (?, ?, ?)').run(examId, classId, now);
  db.prepare('INSERT INTO score_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    randomUUID(),
    examId,
    revision,
    randomUUID(),
    'b'.repeat(64),
    now,
    '教师确认合成记录',
    JSON.stringify(value),
  );
}

test('v1 read-only validation never migrates or modifies the file', () => {
  const path = join(root(), 'old.sqlite');
  legacy(path);
  const bytes = readFileSync(path);
  const db = openDatabase(path, 'readonly');
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  db.close();
  expect(readFileSync(path)).toEqual(bytes);
  expect(readdirSync(join(path, '..'))).toEqual(['old.sqlite']);
});

test('frozen v2 scores survive read-only validation, upgrade and backup restore', () => {
  const path = join(root(), 'v2.sqlite');
  legacy(path, 2);
  const bytes = readFileSync(path);
  const original = openDatabase(path, 'readonly');
  const scores = original.prepare('SELECT * FROM score_versions').all();
  expect(original.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  original.close();
  expect(readFileSync(path)).toEqual(bytes);
  const oldBackup = bundle(path);
  const upgraded = openDatabase(path, 'open');
  expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  expect(upgraded.prepare('SELECT * FROM score_versions').all()).toEqual(scores);
  expect(upgraded.prepare('SELECT COUNT(*) AS count FROM explanation_drafts').get()?.count).toBe(0);
  upgraded.close();
  const copyName = readdirSync(join(path, '..')).find((name) =>
    name.includes(`before-v${SCHEMA_VERSION}`),
  )!;
  const copy = openDatabase(join(path, '..', copyName), 'readonly');
  expect(copy.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  expect(copy.prepare('SELECT * FROM score_versions').all()).toEqual(scores);
  copy.close();
  const workspace = new Workspace(root());
  try {
    const epoch = workspace.snapshot().epoch;
    const preview = workspace.previewRestore(oldBackup);
    expect(preview).toMatchObject({ scoreVersionCount: 1, explanationDraftCount: 0 });
    expect(workspace.commitRestore({ epoch, token: preview.token }).schemaVersion).toBe(
      SCHEMA_VERSION,
    );
    expect(workspace.scores.list({ epoch: workspace.snapshot().epoch })).toHaveLength(1);
  } finally {
    workspace.close();
  }
});

test.each(['copied', 'upgraded'] as const)(
  'v2 interruption at %s retains scores and retries',
  (checkpoint) => {
    const path = join(root(), 'v2.sqlite');
    legacy(path, 2);
    expect(() =>
      openDatabase(path, 'open', {
        migrationCheckpoint: (stage) => {
          if (stage === checkpoint) throw new Error('synthetic interruption');
        },
      }),
    ).toThrow('synthetic interruption');
    const original = openDatabase(path, 'readonly');
    expect(original.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(original.prepare('SELECT COUNT(*) AS count FROM score_versions').get()?.count).toBe(1);
    original.close();
    const upgraded = openDatabase(path, 'open');
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    upgraded.close();
  },
);

test('frozen v3 explanations remain byte-identical in read-only mode and survive upgrade/restore', () => {
  const path = join(root(), 'v3.sqlite');
  legacy(path, 3);
  const bytes = readFileSync(path);
  const old = openDatabase(path, 'readonly');
  const drafts = old.prepare('SELECT * FROM explanation_drafts').all();
  expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
  old.close();
  expect(readFileSync(path)).toEqual(bytes);
  const backup = bundle(path);
  const upgraded = openDatabase(path, 'open');
  expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  expect(upgraded.prepare('SELECT * FROM explanation_drafts').all()).toEqual(drafts);
  expect(upgraded.prepare('SELECT COUNT(*) AS count FROM seating_versions').get()?.count).toBe(0);
  upgraded.close();
  const copyName = readdirSync(join(path, '..')).find((name) =>
    name.includes(`before-v${SCHEMA_VERSION}`),
  )!;
  const copy = openDatabase(join(path, '..', copyName), 'readonly');
  expect(copy.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
  expect(copy.prepare('SELECT * FROM explanation_drafts').all()).toEqual(drafts);
  copy.close();
  const workspace = new Workspace(root());
  try {
    const epoch = workspace.snapshot().epoch;
    const preview = workspace.previewRestore(backup);
    expect(preview).toMatchObject({ explanationDraftCount: 1, seatingVersionCount: 0 });
    const restored = workspace.commitRestore({ epoch, token: preview.token });
    expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
    const view = workspace.explanations.read({ epoch: restored.epoch, id: String(drafts[0]!.id) });
    expect(view.payload.original.limitations).toEqual(['冻结 v3 合成解释']);
  } finally {
    workspace.close();
  }
});

test.each(['copied', 'upgraded'] as const)(
  'v3 interruption at %s preserves old explanations',
  (checkpoint) => {
    const path = join(root(), 'v3.sqlite');
    legacy(path, 3);
    expect(() =>
      openDatabase(path, 'open', {
        migrationCheckpoint: (stage) => {
          if (stage === checkpoint) throw new Error('Synthetic v3 interruption');
        },
      }),
    ).toThrow('Synthetic v3 interruption');
    const old = openDatabase(path, 'readonly');
    expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    expect(old.prepare('SELECT COUNT(*) AS count FROM explanation_drafts').get()?.count).toBe(1);
    old.close();
    const retried = openDatabase(path, 'open');
    expect(retried.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    retried.close();
  },
);

test('frozen v4 seating and explanations survive read-only inspection, current migration and restore', () => {
  const path = join(root(), 'v4.sqlite');
  legacy(path, 4);
  const before = readFileSync(path);
  const old = openDatabase(path, 'readonly');
  const seats = old.prepare('SELECT * FROM seating_versions').all();
  const explanations = old.prepare('SELECT * FROM explanation_drafts').all();
  expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
  old.close();
  expect(readFileSync(path)).toEqual(before);
  const backup = bundle(path);
  const upgraded = openDatabase(path, 'open');
  expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  expect(upgraded.prepare('SELECT * FROM seating_versions').all()).toEqual(seats);
  expect(upgraded.prepare('SELECT * FROM explanation_drafts').all()).toEqual(explanations);
  expect(upgraded.prepare('SELECT COUNT(*) AS n FROM duty_versions').get()?.n).toBe(0);
  upgraded.close();
  const name = readdirSync(join(path, '..')).find((item) =>
    item.includes(`before-v${SCHEMA_VERSION}`),
  )!;
  const copy = openDatabase(join(path, '..', name), 'readonly');
  expect(copy.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
  expect(copy.prepare('SELECT * FROM seating_versions').all()).toEqual(seats);
  copy.close();
  const workspace = new Workspace(root());
  try {
    const preview = workspace.previewRestore(backup);
    expect(preview).toMatchObject({ seatingVersionCount: 1, dutyVersionCount: 0 });
    const restored = workspace.commitRestore({
      epoch: workspace.snapshot().epoch,
      token: preview.token,
    });
    expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(
      workspace.seating.read({ epoch: restored.epoch, versionId: String(seats[0]!.id) }).payload
        .className,
    ).toBe('合成历史班级');
  } finally {
    workspace.close();
  }
});

test.each(['copied', 'upgraded'] as const)(
  'v4 migration failure at %s preserves original versions',
  (checkpoint) => {
    const path = join(root(), 'v4.sqlite');
    legacy(path, 4);
    expect(() =>
      openDatabase(path, 'open', {
        migrationCheckpoint: (stage) => {
          if (stage === checkpoint) throw new Error('Synthetic v4 interruption');
        },
      }),
    ).toThrow(/Synthetic v4/);
    const old = openDatabase(path, 'readonly');
    expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
    expect(old.prepare('SELECT COUNT(*) AS n FROM seating_versions').get()?.n).toBe(1);
    old.close();
    const retried = openDatabase(path, 'open');
    expect(retried.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    retried.close();
  },
);

test('frozen v5 tables, clock floor and existing history survive readonly inspection, current migration and restore', () => {
  const path = join(root(), 'v5.sqlite');
  legacy(path, 5);
  const bytes = readFileSync(path);
  const old = openDatabase(path, 'readonly');
  const scores = old.prepare('SELECT * FROM score_versions').all();
  const seats = old.prepare('SELECT * FROM seating_versions').all();
  const explanations = old.prepare('SELECT * FROM explanation_drafts').all();
  const floor = old.prepare('SELECT * FROM duty_clock').all();
  old.close();
  expect(readFileSync(path)).toEqual(bytes);
  const backup = bundle(path);
  const current = openDatabase(path, 'open');
  expect(current.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  expect(current.prepare('SELECT * FROM score_versions').all()).toEqual(scores);
  expect(current.prepare('SELECT * FROM seating_versions').all()).toEqual(seats);
  expect(current.prepare('SELECT * FROM explanation_drafts').all()).toEqual(explanations);
  expect(current.prepare('SELECT * FROM duty_clock').all()).toEqual(floor);
  expect(current.prepare('SELECT COUNT(*) AS n FROM material_versions').get()?.n).toBe(0);
  current.close();
  const copyName = readdirSync(join(path, '..')).find((name) =>
    name.includes(`before-v${SCHEMA_VERSION}`),
  )!;
  const copy = openDatabase(join(path, '..', copyName), 'readonly');
  expect(copy.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
  copy.close();
  const workspace = new Workspace(root());
  try {
    const preview = workspace.previewRestore(backup);
    expect(preview).toMatchObject({
      materialVersionCount: 0,
      lessonDraftCount: 0,
      lessonVersionCount: 0,
    });
    expect(
      workspace.commitRestore({ epoch: workspace.snapshot().epoch, token: preview.token })
        .schemaVersion,
    ).toBe(SCHEMA_VERSION);
  } finally {
    workspace.close();
  }
});

test.each([1, 2, 3, 4, 5] as const)(
  'legacy v%s backups retain the 1 MiB per-asset and 32-asset boundaries',
  (version) => {
    const path = join(root(), 'legacy.sqlite');
    legacy(path, version);
    const original = JSON.parse(bundle(path).toString());
    const workspace = new Workspace(root());
    try {
      const epoch = workspace.snapshot().epoch;
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      const asset = {
        id: randomUUID(),
        name: 'oversized.bin',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        base64: bytes.toString('base64'),
      };
      expect(() =>
        workspace.previewRestore(Buffer.from(JSON.stringify({ ...original, assets: [asset] }))),
      ).toThrow('大小上限');
      expect(() =>
        workspace.previewRestore(
          Buffer.from(
            JSON.stringify({
              ...original,
              assets: Array.from({ length: 33 }, () => ({
                ...asset,
                id: randomUUID(),
                bytes: 0,
                sha256: createHash('sha256').update('').digest('hex'),
                base64: '',
              })),
            }),
          ),
        ),
      ).toThrow('数量上限');
      expect(workspace.snapshot().epoch).toBe(epoch);
    } finally {
      workspace.close();
    }
  },
);

test.each(['copied', 'upgraded'] as const)(
  'v5 migration exception at %s retains old schema and history',
  (checkpoint) => {
    const path = join(root(), 'v5.sqlite');
    legacy(path, 5);
    expect(() =>
      openDatabase(path, 'open', {
        migrationCheckpoint: (stage) => {
          if (stage === checkpoint) throw new Error('v5 interrupted');
        },
      }),
    ).toThrow('v5 interrupted');
    const old = openDatabase(path, 'readonly');
    expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
    expect(old.prepare('SELECT COUNT(*) AS n FROM seating_versions').get()?.n).toBe(1);
    old.close();
    const current = openDatabase(path, 'open');
    expect(current.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    current.close();
  },
);

test('writable database connections enforce the same page ceiling as backup and reopen', () => {
  const path = join(root(), 'new.sqlite');
  for (const mode of ['create', 'open'] as const) {
    const db = openDatabase(path, mode);
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
    expect(
      Number(db.prepare('PRAGMA max_page_count').get()?.max_page_count) * pageSize,
    ).toBeLessThanOrEqual(MAX_DATABASE_BYTES);
    db.close();
  }
});

test('startup migrates v1 once and retains a complete independently readable old copy', () => {
  const { directory, path } = oldWorkspace();
  const workspace = new Workspace(directory);
  expect(workspace.snapshot()).toMatchObject({
    schemaVersion: SCHEMA_VERSION,
    students: [{ studentNumber: '0001' }],
  });
  workspace.close();
  const copies = readdirSync(join(path, '..')).filter((name) =>
    name.includes(`before-v${SCHEMA_VERSION}`),
  );
  expect(copies).toHaveLength(1);
  const copy = openDatabase(join(path, '..', copies[0]!), 'readonly');
  expect(copy.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(copy.prepare('SELECT display_name FROM students').get()?.display_name).toBe('合成甲');
  copy.close();
  const reopened = new Workspace(directory);
  reopened.close();
  expect(
    readdirSync(join(path, '..')).filter((name) => name.includes(`before-v${SCHEMA_VERSION}`)),
  ).toEqual(copies);
});

test.each(['structure', 'semantic'] as const)(
  'invalid v1 %s is refused before any migration writes',
  (kind) => {
    const path = join(root(), 'old.sqlite');
    legacy(path);
    const db = new DatabaseSync(path);
    db.exec(
      kind === 'structure'
        ? 'CREATE TABLE unexpected (id TEXT)'
        : "UPDATE students SET student_number='lowercase'",
    );
    db.close();
    const before = readFileSync(path);
    expect(() => openDatabase(path, 'open')).toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(path, '..'))).toEqual(['old.sqlite']);
  },
);

test.each(['copied', 'upgraded'] as const)(
  'migration exception at %s preserves v1 and supports retry',
  (checkpoint) => {
    const path = join(root(), 'old.sqlite');
    legacy(path);
    expect(() =>
      openDatabase(path, 'open', {
        migrationCheckpoint: (stage) => {
          if (stage === checkpoint) throw new Error('synthetic interruption');
        },
      }),
    ).toThrow('synthetic interruption');
    const original = openDatabase(path, 'readonly');
    expect(original.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    original.close();
    const upgraded = openDatabase(path, 'open');
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    upgraded.close();
  },
);

test.each([1, 5] as const)('v%s abrupt migration exits recover atomically', (version) => {
  for (const checkpoint of ['copied', 'upgraded'] as const) {
    const directory = root();
    const path = join(directory, 'old.sqlite');
    legacy(path, version);
    const childPath = join(directory, 'child.cjs');
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-migration.ts'],
        outfile: childPath,
        platform: 'node',
        format: 'cjs',
        bundle: true,
        target: 'node24',
      }),
    );
    const child = spawnSync(process.execPath, [childPath, path, checkpoint], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(88);
    // 首次重开必须走生产入口；不能先用裸连接帮应用完成热日志恢复。
    const db = openDatabase(path, 'open');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS count FROM students').get()?.count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM score_versions').get()?.count).toBe(
      version === 1 ? 0 : 1,
    );
    db.close();
  }
});

test('legacy backup preview remains v1 and only a confirmed restore upgrades the staged copy', () => {
  const path = join(root(), 'old.sqlite');
  legacy(path);
  const bytes = readFileSync(path);
  const directory = root();
  const workspace = new Workspace(directory);
  try {
    const epoch = workspace.snapshot().epoch;
    const preview = workspace.previewRestore(bundle(path));
    const stagedPath = join(directory, 'staging', preview.token, 'data.sqlite');
    expect(readFileSync(stagedPath)).toEqual(bytes);
    expect(workspace.snapshot().students).toHaveLength(0);
    const restored = workspace.commitRestore({ epoch, token: preview.token });
    expect(restored).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      students: [{ studentNumber: '0001' }],
    });
    expect(readFileSync(path)).toEqual(bytes);
    const recovery = workspace.previewRecovery();
    expect(recovery.studentCount).toBe(0);
  } finally {
    workspace.close();
  }
});

test.each(['missing', 'corrupt'] as const)(
  'invalid v1 attachment %s blocks migration without changing the database',
  (kind) => {
    const { directory, path } = oldWorkspace();
    const db = new DatabaseSync(path);
    const assetId = randomUUID();
    db.prepare('INSERT INTO assets VALUES (?, ?, ?, ?)').run(
      assetId,
      '合成附件',
      4,
      'a'.repeat(64),
    );
    db.close();
    if (kind === 'corrupt') writeFileSync(join(path, '..', 'assets', `${assetId}.bin`), 'bad!');
    const before = readFileSync(path);
    expect(() => new Workspace(directory)).toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect(
      readdirSync(join(path, '..')).filter((name) => name.includes(`before-v${SCHEMA_VERSION}`)),
    ).toEqual([]);
  },
);

test('v3 exports declare their version and reject mismatched backup metadata', () => {
  const workspace = new Workspace(root());
  try {
    const value = JSON.parse(
      workspace.exportBackup({ epoch: workspace.snapshot().epoch }).toString('utf8'),
    );
    expect(value.version).toBe(SCHEMA_VERSION);
    value.version = 1;
    expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(value)))).toThrow(
      '版本不一致',
    );
  } finally {
    workspace.close();
  }
});

test('all score versions and their historical roster survive backup, restore and reopening', () => {
  const { directory, path } = oldWorkspace();
  const db = openDatabase(path, 'open');
  addVersion(db);
  const corrected = payload();
  corrected.analysis.entries[0]!.score = { status: 'valid', hundredths: 10000 };
  addVersion(db, 2, corrected);
  db.exec("UPDATE students SET display_name='合成现名'; UPDATE classrooms SET name='合成现班'");
  validateDatabase(db);
  const before = db.prepare('SELECT * FROM score_versions ORDER BY revision').all();
  db.close();
  const workspace = new Workspace(directory);
  let restoredPath: string;
  try {
    const epoch = workspace.snapshot().epoch;
    const preview = workspace.previewRestore(workspace.exportBackup({ epoch }));
    const result = workspace.commitRestore({ epoch, token: preview.token });
    restoredPath = join(directory, 'workspaces', result.epoch, 'data.sqlite');
  } finally {
    workspace.close();
  }
  const reopened = openDatabase(restoredPath!, 'readonly');
  expect(reopened.prepare('SELECT * FROM score_versions ORDER BY revision').all()).toEqual(before);
  const historical = JSON.parse(String(before[0]!.payload));
  expect(historical.analysis.roster[0].displayName).toBe('合成甲');
  expect(reopened.prepare('SELECT display_name FROM students').get()?.display_name).toBe(
    '合成现名',
  );
  reopened.close();
});

test('maximum roster and subjects with 1000 student drafts fit storage and backup round-trip', () => {
  const { directory, path } = oldWorkspace();
  const db = openDatabase(path, 'open');
  const value = payload();
  value.analysis.subjects = Array.from({ length: 20 }, (_, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `合成科目${index + 1}`,
    maxScore: '10000',
    precision: 2,
  }));
  value.analysis.groups[0]!.subjectIds = value.analysis.subjects.map((subject) => subject.id);
  value.analysis.roster = Array.from({ length: 10000 }, (_, index) => ({
    studentId: index === 0 ? studentId : randomUUID(),
    groupId,
    studentNumber: String(index + 1).padStart(32, '0'),
    displayName: '合'.repeat(60),
  }));
  value.analysis.entries = value.analysis.roster.flatMap((student) =>
    value.analysis.subjects.map((subject) => ({
      studentId: student.studentId,
      subjectId: subject.id,
      score: { status: 'valid' as const, hundredths: 1000000 },
    })),
  );
  const serializedBytes = Buffer.byteLength(JSON.stringify(value));
  expect(serializedBytes).toBeGreaterThan(32 * 1024 * 1024);
  expect(serializedBytes).toBeLessThan(MAX_SCORE_PAYLOAD_BYTES);
  try {
    transaction(db, () => {
      const insertStudent = db.prepare('INSERT INTO students VALUES (?, ?, ?, 1, 1, ?)');
      const insertEnrollment = db.prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, NULL)');
      for (const student of value.analysis.roster) {
        if (student.studentId === studentId) {
          db.prepare('UPDATE students SET student_number=?, display_name=? WHERE id=?').run(
            student.studentNumber,
            student.displayName,
            studentId,
          );
        } else {
          insertStudent.run(student.studentId, student.studentNumber, student.displayName, now);
          insertEnrollment.run(randomUUID(), student.studentId, classId, now);
        }
      }
      addVersion(db, 1, value);
      const version = db.prepare('SELECT id, request_id AS requestId FROM score_versions').get()!;
      const prepare = createExplanationPreparer({
        record: {
          id: String(version.id),
          examId,
          revision: 1,
          requestId: String(version.requestId),
          requestHash: 'b'.repeat(64),
          createdAt: now,
          reason: '教师确认合成记录',
        },
        payload: value,
        latestVersionId: String(version.id),
        stale: false,
        statistics: { subjects: [], groups: [], totals: [] },
      });
      const insertDraft = db.prepare(
        `INSERT INTO explanation_drafts VALUES (?, ?, 1, 'draft', ?, ?, NULL, ?, ?, ?)`,
      );
      for (const student of value.analysis.roster.slice(-1000)) {
        const packet = prepare({
          subjectIds: value.analysis.subjects.map((subject) => subject.id),
          metrics: ['fullScore', 'studentStatus', 'studentScore'],
          scope: { kind: 'student', studentId: student.studentId },
        });
        const fact = packet.wire.facts.at(-1)!;
        const original: ExplanationOutput = {
          formatVersion: 1,
          observations: [{ factId: fact.id, value: fact.value }],
          interpretations: [],
          questions: [],
          actions: [],
          limitations: ['合成压力测试，无题目资料'],
        };
        insertDraft.run(
          randomUUID(),
          version.id!,
          now,
          now,
          randomUUID(),
          'c'.repeat(64),
          serializeExplanation({
            formatVersion: 1,
            promptVersion: packet.promptVersion,
            selection: packet.selection,
            inputHash: packet.inputHash,
            original,
            content: initialExplanationContent(original),
            provider: {
              provider: 'deepseek',
              requestModel: 'synthetic',
              responseModel: 'synthetic',
              responseId: 'synthetic',
              generatedAt: now,
              durationMs: 0,
              usage: null,
            },
          }),
        );
      }
    });
    validateDatabase(db);
    const prepareSpy = vi.spyOn(db, 'prepare');
    try {
      const epoch = randomUUID();
      const book = new ExplanationBook(
        db,
        () => epoch,
        () => {
          throw new Error('List must not load score views');
        },
      );
      const drafts = book.list({ epoch });
      expect(drafts).toHaveLength(1000);
      expect(
        drafts.every((draft) => draft.examName === value.definition.name && !draft.stale),
      ).toBe(true);
      expect(prepareSpy.mock.calls.filter(([sql]) => sql.includes('json_extract'))).toHaveLength(1);
    } finally {
      prepareSpy.mockRestore();
    }
  } finally {
    db.close();
  }
  const workspace = new Workspace(directory);
  let restoredPath: string;
  try {
    const epoch = workspace.snapshot().epoch;
    const bytes = workspace.exportBackup({ epoch });
    const preview = workspace.previewRestore(bytes);
    expect(preview.studentCount).toBe(10000);
    expect(preview.explanationDraftCount).toBe(1000);
    const restored = workspace.commitRestore({ epoch, token: preview.token });
    restoredPath = join(directory, 'workspaces', restored.epoch, 'data.sqlite');
  } finally {
    workspace.close();
  }
  const restored = openDatabase(restoredPath, 'readonly');
  try {
    const stored = JSON.parse(
      String(restored.prepare('SELECT payload FROM score_versions').get()?.payload),
    );
    expect(stored.analysis.roster).toHaveLength(10000);
    expect(stored.analysis.entries).toHaveLength(200000);
    expect(stored.analysis.entries.at(-1)?.score).toEqual({ status: 'valid', hundredths: 1000000 });
    expect(restored.prepare('SELECT COUNT(*) AS count FROM explanation_drafts').get()?.count).toBe(
      1000,
    );
  } finally {
    restored.close();
  }
  // This upper-bound round trip includes repeated full validation (~62s locally), not a 60s SLA.
}, 120000);

test.each([
  'json',
  'invalid-score',
  'missing-student',
  'revision-gap',
  'date',
  'duplicate-mapping',
  'reserved-mapping',
  'converted-mapping',
  'empty-exam',
] as const)('correctly hashed backup with invalid score data is rejected: %s', (kind) => {
  const { path } = oldWorkspace();
  const db = openDatabase(path, 'open');
  const value = payload();
  if (kind === 'invalid-score')
    value.analysis.entries[0]!.score = { status: 'valid', hundredths: 15100 };
  if (kind === 'missing-student') {
    value.analysis.roster[0]!.studentId = randomUUID();
    value.analysis.entries[0]!.studentId = value.analysis.roster[0]!.studentId;
  }
  if (kind === 'date') value.definition.date = '2026-02-30';
  if (kind === 'duplicate-mapping')
    value.source.columnMappings = [
      { header: '数学原始分', subjectId },
      { header: '数学成绩', subjectId },
    ];
  if (kind === 'reserved-mapping')
    value.source.columnMappings = [{ header: '学生编号', subjectId }];
  if (kind === 'converted-mapping')
    value.source.columnMappings = [{ header: '数学赋分', subjectId }];
  addVersion(db, 1, value);
  if (kind === 'json') db.exec("UPDATE score_versions SET payload='{'");
  if (kind === 'revision-gap') db.exec('UPDATE score_versions SET revision=2');
  if (kind === 'empty-exam') db.exec('DELETE FROM score_versions');
  db.close();
  const workspace = new Workspace(root());
  try {
    const epoch = workspace.snapshot().epoch;
    expect(() => workspace.previewRestore(bundle(path))).toThrow('成绩');
    expect(workspace.snapshot().epoch).toBe(epoch);
    expect(workspace.snapshot().students).toHaveLength(0);
  } finally {
    workspace.close();
  }
});
