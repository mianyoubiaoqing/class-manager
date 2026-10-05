import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION, validateDatabase } from '../src/core/database';
import { ClassroomBook } from '../src/core/classroom-book';
import { countdownView } from '../src/core/countdown';
import { countdownSettingSchema } from '../src/shared/classroom';
import { createClassroomProjection } from '../src/core/classroom-projection';
import { readLessonVersion } from '../src/core/lesson-records';
import { Workspace } from '../src/core/workspace';
import { seedOfficeWorkspace } from './fixtures/office-runtime';

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-classroom-'));
  roots.push(root);
  const seeded = await seedOfficeWorkspace(root);
  const path = join(root, 'workspaces', seeded.epoch, 'data.sqlite');
  const db = openDatabase(path, 'open');
  databases.push(db);
  const classId = randomUUID();
  db.prepare('INSERT INTO classrooms VALUES (?,?,1,?)').run(
    classId,
    '合成课堂班级',
    new Date().toISOString(),
  );
  let monotonic = 1000,
    wall = Date.now();
  const book = new ClassroomBook(
    db,
    () => seeded.epoch,
    () => monotonic,
    () => wall,
  );
  const version = readLessonVersion(db, seeded.versionId);
  const command = {
    epoch: seeded.epoch,
    requestId: randomUUID(),
    versionId: seeded.versionId,
    classId,
    slideIds: version.payload.content.slides.map((slide) => slide.id),
    acknowledgeScope: true as const,
  };
  const view = book.create(command);
  const control = (
    action: 'pause' | 'resume' | 'reset' | 'next' | 'previous' | 'finish' | 'answers' | 'questions',
    visible?: boolean,
  ) => {
    const current = book.read({ epoch: seeded.epoch, id: view.record.id });
    return book.control({
      epoch: seeded.epoch,
      id: view.record.id,
      expectedRevision: current.record.revision,
      action,
      ...(visible === undefined ? {} : { visible }),
    });
  };
  return {
    root,
    path,
    db,
    book,
    seeded,
    version,
    command,
    view,
    control,
    advance: (ms: number) => {
      monotonic += ms;
    },
    wallJump: (ms: number) => {
      wall += ms;
    },
  };
}

test('exact frozen range, idempotence and optimistic progress survive close and restore', async () => {
  const f = await fixture();
  expect(f.book.create(f.command).record.id).toBe(f.view.record.id);
  expect(() => f.book.create({ ...f.command, versionId: f.seeded.latestVersionId })).toThrow(
    '不同',
  );
  expect(() =>
    f.book.create({
      ...f.command,
      requestId: randomUUID(),
      slideIds: [...f.command.slideIds].reverse(),
    }),
  ).toThrow('原顺序');
  expect(() =>
    f.book.create({ ...f.command, requestId: randomUUID(), acknowledgeScope: false }),
  ).toThrow();
  expect(() => f.book.read({ epoch: randomUUID(), id: f.view.record.id })).toThrow('切换');
  const next = f.control('next');
  expect(() =>
    f.book.control({
      epoch: f.seeded.epoch,
      id: next.record.id,
      expectedRevision: 1,
      action: 'pause',
    }),
  ).toThrow('变化');
  expect(next.record.versionId).toBe(f.seeded.versionId);
  f.book.dispose();
  f.db.close();
  databases.splice(databases.indexOf(f.db), 1);
  const reopened = new Workspace(f.root);
  try {
    expect(
      reopened.classroom.read({ epoch: f.seeded.epoch, id: next.record.id }).record.payload.index,
    ).toBe(1);
    const backup = reopened.exportBackup({ epoch: f.seeded.epoch });
    const preview = reopened.previewRestore(backup);
    expect(preview.teachingSessionCount).toBe(1);
    const restored = reopened.commitRestore({ epoch: f.seeded.epoch, token: preview.token });
    expect(
      reopened.classroom.read({ epoch: restored.epoch, id: next.record.id }).record.versionId,
    ).toBe(f.seeded.versionId);
    expect(() => reopened.classroom.read({ epoch: f.seeded.epoch, id: next.record.id })).toThrow(
      '切换',
    );
  } finally {
    reopened.close();
  }
});

test('monotonic elapsed spans hidden gaps and checkpoints without wall-clock drift; restart pauses', async () => {
  const f = await fixture();
  f.control('resume');
  f.advance(123456);
  f.wallJump(-10 * 86400000);
  expect(f.book.read({ epoch: f.seeded.epoch, id: f.view.record.id }).record.elapsedMs).toBe(
    123456,
  );
  f.book.checkpoint();
  f.advance(7890);
  f.wallJump(20 * 86400000);
  expect(f.control('pause').record.elapsedMs).toBe(131346);
  f.advance(999999);
  expect(f.control('resume').record.elapsedMs).toBe(131346);
  f.advance(5000);
  f.book.checkpoint();
  f.advance(2000);
  f.book.dispose();
  const next = new ClassroomBook(
    f.db,
    () => f.seeded.epoch,
    () => 0,
  );
  const value = next.read({ epoch: f.seeded.epoch, id: f.view.record.id });
  expect(value.record).toMatchObject({ status: 'paused', elapsedMs: 136346, interrupted: true });
  expect(value.record.updatedAt >= value.record.createdAt).toBe(true);
  next.dispose();
});

test('answers and question prompts require explicit choices and clear when changing slides', async () => {
  const f = await fixture();
  const projection = (view = f.book.read({ epoch: f.seeded.epoch, id: f.view.record.id })) =>
    createClassroomProjection(view, f.version.payload.content, null, () =>
      Buffer.from('synthetic'),
    );
  expect(JSON.stringify(projection())).not.toMatch(
    /TEACHER_|teacherNotes|origin|quote|className|classId|student/,
  );
  expect(projection().answers).toEqual([]);
  f.control('next');
  f.control('answers', true);
  expect(JSON.stringify(projection())).toContain('TEACHER_');
  f.control('questions', true);
  f.control('previous');
  expect(projection().answers).toEqual([]);
  expect(projection().questions).toEqual([]);
  expect(f.control('finish').record.status).toBe('ended');
  expect(() => f.control('resume')).toThrow('结束');
});

test.each([
  ['Asia/Shanghai', '2027-06-07', '2027-06-06T15:59:59Z', 1, 'future'],
  ['Asia/Shanghai', '2027-06-07', '2027-06-06T16:00:00Z', 0, 'today'],
  ['Asia/Shanghai', '2027-06-07', '2028-01-01T00:00:00Z', 0, 'expired'],
  ['America/New_York', '2027-03-15', '2027-03-14T05:00:00Z', 1, 'future'],
  ['UTC', '2028-03-01', '2028-02-28T23:00:00Z', 2, 'future'],
])('calendar countdown %s %s at %s', (timeZone, targetDate, now, remainingDays, status) => {
  expect(
    countdownView(
      { revision: 1, setting: { name: '合成高考目标', timeZone, targetDate } },
      Date.parse(now),
    ),
  ).toMatchObject({ remainingDays, status });
});

test('countdown validates dates/zones and durable settings revision', async () => {
  expect(
    countdownSettingSchema.safeParse({ name: '目标', targetDate: '2027-02-29', timeZone: 'UTC' })
      .success,
  ).toBe(false);
  expect(
    countdownSettingSchema.safeParse({
      name: '目标',
      targetDate: '2028-02-29',
      timeZone: 'Unknown/Zone',
    }).success,
  ).toBe(false);
  const f = await fixture();
  const value = f.book.setCountdown({
    epoch: f.seeded.epoch,
    expectedRevision: 0,
    setting: { name: '自主目标', targetDate: '2027-06-07', timeZone: 'Asia/Shanghai' },
  });
  expect(value.revision).toBe(1);
  expect(() =>
    f.book.setCountdown({ epoch: f.seeded.epoch, expectedRevision: 0, setting: value.setting }),
  ).toThrow('更新');
});

test('failed checkpoint and pause preserve the last durable timer and recover without drift', async () => {
  const f = await fixture();
  f.control('resume');
  f.advance(1000);
  f.book.checkpoint();
  f.db.exec(
    "CREATE TRIGGER deny_classroom_write BEFORE UPDATE ON teaching_sessions BEGIN SELECT RAISE(ABORT,'Synthetic write denial'); END",
  );
  f.advance(2345);
  expect(() => f.book.checkpoint()).toThrow('Synthetic write denial');
  expect(() => f.control('pause')).toThrow('Synthetic write denial');
  expect(f.book.clock({ epoch: f.seeded.epoch, id: f.view.record.id })).toMatchObject({
    checkpointFailed: true,
    elapsedMs: 3345,
    status: 'running',
  });
  expect(f.db.prepare('SELECT elapsed_ms FROM teaching_sessions').get()?.elapsed_ms).toBe(1000);
  f.db.exec('DROP TRIGGER deny_classroom_write');
  f.advance(1234);
  expect(f.control('pause').record.elapsedMs).toBe(4579);
  expect(f.book.clock({ epoch: f.seeded.epoch, id: f.view.record.id }).checkpointFailed).toBe(
    false,
  );
});

test('one timer can run; selected subset rejects pages outside scope and same-section pages preserve elapsed', async () => {
  const f = await fixture();
  const subset = f.book.create({
    ...f.command,
    requestId: randomUUID(),
    slideIds: [f.command.slideIds[1]!],
  });
  f.control('resume');
  expect(() =>
    f.book.control({
      epoch: f.seeded.epoch,
      id: subset.record.id,
      expectedRevision: 1,
      action: 'resume',
    }),
  ).toThrow('暂停另一堂');
  expect(() =>
    f.book.control({
      epoch: f.seeded.epoch,
      id: subset.record.id,
      expectedRevision: 1,
      action: 'slide',
      slideId: f.command.slideIds[0],
    }),
  ).toThrow('范围');
  f.advance(3456);
  expect(f.control('next').record).toMatchObject({ elapsedMs: 3456, status: 'running' });
  f.control('pause');
  expect(
    f.book.control({
      epoch: f.seeded.epoch,
      id: subset.record.id,
      expectedRevision: 1,
      action: 'resume',
    }).record.status,
  ).toBe('running');
});

test.each(['descriptor', 'countdown'] as const)(
  'backup validation rejects tampered %s before publishing',
  async (kind) => {
    const f = await fixture();
    if (kind === 'descriptor') {
      f.db.prepare('UPDATE teaching_sessions SET request_hash=?').run('0'.repeat(64));
    } else {
      f.db
        .prepare('INSERT INTO countdown_settings VALUES (1,1,?)')
        .run(JSON.stringify({ name: 'Invalid', targetDate: '2027-02-29', timeZone: 'UTC' }));
    }
    expect(() => validateDatabase(f.db)).toThrow();
  },
);

test.each(['copied', 'upgraded'] as const)(
  'v6 migration failure at %s preserves independently frozen lesson content and retries to current schema',
  async (stage) => {
    const root = mkdtempSync(join(tmpdir(), 'cm-classroom-v6-'));
    roots.push(root);
    const path = join(root, 'historical-v6.sqlite');
    const historical = readFileSync(
      new URL('./fixtures/frozen-v6-lessons.sqlite', import.meta.url),
    );
    expect(createHash('sha256').update(historical).digest('hex')).toBe(
      'b090b59aa694e9a31bf74821061804fd463ac3a0653b3b65fc72440e6fcd747f',
    );
    writeFileSync(path, historical);
    const baseline = openDatabase(path, 'readonly');
    const before = baseline.prepare('SELECT * FROM lesson_versions').all();
    baseline.close();
    expect(() =>
      openDatabase(path, 'open', {
        migrationCheckpoint: (checkpoint) => {
          if (checkpoint === stage) throw new Error('Synthetic v6 interruption');
        },
      }),
    ).toThrow('interruption');
    const old = openDatabase(path, 'readonly');
    expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
    expect(old.prepare('SELECT * FROM lesson_versions').all()).toEqual(before);
    old.close();
    const upgraded = openDatabase(path, 'open');
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    expect(upgraded.prepare('SELECT * FROM lesson_versions').all()).toEqual(before);
    upgraded.close();
    const copied = readdirSync(root).find((name) => name.includes(`before-v${SCHEMA_VERSION}`))!;
    expect(readFileSync(join(root, copied)).length).toBeGreaterThan(0);
  },
);
