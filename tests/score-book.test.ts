import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { ScoreBook, type ScoreCheckpoint } from '../src/core/score-book';
import { openDatabase } from '../src/core/database';
import { MAX_DATABASE_BYTES } from '../src/core/storage-limits';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const live: Workspace[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const workspace of live.splice(0)) workspace.close();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const subjectId = '30000000-0000-4000-8000-000000000001';
const groupId = '40000000-0000-4000-8000-000000000001';
function fixture(checkpoint?: ScoreCheckpoint) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-score-book-'));
  roots.push(directory);
  const workspace = new Workspace(directory, undefined, checkpoint);
  live.push(workspace);
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成班' });
  const classId = workspace.snapshot().classes[0]!.id;
  for (const [studentNumber, displayName] of [
    ['0001', '合成甲'],
    ['0002', '合成乙'],
  ]) {
    workspace.saveStudent({ epoch, classId, studentNumber, displayName });
  }
  const students = workspace.snapshot().students;
  const input = () => ({
    epoch,
    classId,
    expectedRevision: 0,
    definition: {
      name: '合成月考',
      date: '2026-09-30',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 as const }],
    groups: [{ id: groupId, name: '数学组', subjectIds: [subjectId] }],
    assignments: students.map((student) => ({ studentId: student.id, groupId })),
    scoreBasis: 'raw' as const,
    format: 'csv' as const,
    fileName: 'synthetic.csv',
  });
  return { workspace, directory, epoch, classId, students, input };
}

test('a score preview writes nothing until confirmation and confirmed statistics survive reopening', async () => {
  const { workspace, directory, epoch, input } = fixture();
  const preview = await workspace.scores.preview(
    Buffer.from('学生编号,数学\n0001,99\n0002,缺考'),
    input(),
  );
  expect(preview.canConfirm).toBe(true);
  expect(workspace.scores.list({ epoch })).toEqual([]);
  const receipt = workspace.scores.confirm({
    epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  expect(receipt.revision).toBe(1);
  const version = workspace.scores.read({ epoch, versionId: receipt.versionId });
  expect(version.statistics.subjects[0]).toMatchObject({
    mean: '99.00',
    validCount: 1,
    absentCount: 1,
  });
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  const reopened = new Workspace(directory);
  live.push(reopened);
  expect(reopened.scores.read({ epoch, versionId: receipt.versionId }).payload).toEqual(
    version.payload,
  );
});

test('corrections expose exact differences and keep the old version readable but stale', async () => {
  const { workspace, epoch, input, students } = fixture();
  const first = await workspace.scores.preview(
    Buffer.from('学生编号,数学\n0001,99\n0002,缺考'),
    input(),
  );
  const receipt = workspace.scores.confirm({
    epoch,
    token: first.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  const corrected = await workspace.scores.preview(
    Buffer.from('学生编号,数学\n0001,100\n0002,缺考'),
    { ...input(), examId: receipt.examId, expectedRevision: 1 },
  );
  expect(corrected.differences?.scores).toEqual([
    {
      studentId: students[0]!.id,
      subjectId,
      before: { status: 'valid', hundredths: 9900 },
      after: { status: 'valid', hundredths: 10000 },
    },
  ]);
  const next = workspace.scores.confirm({
    epoch,
    token: corrected.token,
    requestId: randomUUID(),
    expectedRevision: 1,
    reason: '复核更正数学成绩',
  });
  expect(next.revision).toBe(2);
  const old = workspace.scores.read({ epoch, versionId: receipt.versionId });
  expect(old.stale).toBe(true);
  expect(old.latestVersionId).toBe(next.versionId);
  expect(old.statistics.subjects[0]?.mean).toBe('99.00');
  expect(
    workspace.scores.read({ epoch, versionId: next.versionId }).statistics.subjects[0]?.mean,
  ).toBe('100.00');
  expect(
    workspace.scores.history({ epoch, examId: receipt.examId }).map((record) => record.revision),
  ).toEqual([2, 1]);
});

test('an unchanged reimport is visible but cannot create a redundant version', async () => {
  const { workspace, epoch, input } = fixture();
  const first = await workspace.scores.preview(
    Buffer.from('学生编号,数学\n0001,99\n0002,缺考'),
    input(),
  );
  const receipt = workspace.scores.confirm({
    epoch,
    token: first.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  const repeated = await workspace.scores.preview(
    Buffer.from('数学,学生编号\n缺考,0002\n99,0001'),
    { ...input(), examId: receipt.examId, expectedRevision: 1 },
  );
  expect(repeated.unchanged).toBe(true);
  expect(repeated.canConfirm).toBe(false);
  expect(repeated.token).toBeNull();
  expect(workspace.scores.history({ epoch, examId: receipt.examId })).toHaveLength(1);
});

test('identical confirmation retries are durable across reopening while reusing the request for different content fails', async () => {
  const { workspace, directory, epoch, input } = fixture();
  const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  const command = {
    epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  };
  const first = workspace.scores.confirm(command);
  expect(workspace.scores.confirm(command)).toEqual({ ...first, replayed: true });
  expect(() => workspace.scores.confirm({ ...command, requestId: randomUUID() })).toThrow('失效');
  expect(() => workspace.scores.confirm({ ...command, reason: '不同理由' })).toThrow(
    '同一请求编号',
  );
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  const reopened = new Workspace(directory);
  live.push(reopened);
  expect(reopened.scores.confirm(command)).toEqual({ ...first, replayed: true });
  expect(reopened.scores.history({ epoch, examId: first.examId })).toHaveLength(1);
});

test('mutating a returned preview cannot alter the server-held confirmation data', async () => {
  const { workspace, epoch, input } = fixture();
  const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  preview.entries[0]!.score = { status: 'valid', hundredths: 15000 };
  preview.statistics!.subjects[0]!.mean = '150.00';
  const receipt = workspace.scores.confirm({
    epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  expect(
    workspace.scores.read({ epoch, versionId: receipt.versionId }).statistics.subjects[0]?.mean,
  ).toBe('99.00');
});

test('oversized input is refused at the score preview entry point', async () => {
  const { workspace, epoch, input } = fixture();
  await expect(
    workspace.scores.preview(new Uint8Array(5 * 1024 * 1024 + 1), input()),
  ).rejects.toMatchObject({ code: 'SCORE_FILE_LIMIT' });
  expect(workspace.scores.list({ epoch })).toEqual([]);
});

test.each(['rename', 'transfer', 'add-student', 'deactivate', 'rename-class'] as const)(
  'roster changes invalidate confirmation: %s',
  async (change) => {
    const { workspace, epoch, classId, input, students } = fixture();
    const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
    const student = students[0]!;
    if (change === 'rename' || change === 'transfer') {
      const nextClassId =
        change === 'transfer'
          ? workspace.createClass({ epoch, name: '其他合成班' }).classes[1]!.id
          : classId;
      workspace.saveStudent({
        epoch,
        id: student.id,
        expectedRevision: student.revision,
        studentNumber: student.studentNumber,
        displayName: '合成新名',
        classId: nextClassId,
      });
    }
    if (change === 'add-student')
      workspace.saveStudent({ epoch, classId, studentNumber: '0003', displayName: '合成丙' });
    if (change === 'deactivate')
      workspace.setStudentActive({
        epoch,
        id: student.id,
        expectedRevision: student.revision,
        active: false,
      });
    if (change === 'rename-class')
      workspace.renameClass({ epoch, id: classId, expectedRevision: 1, name: '合成新班名' });
    expect(() =>
      workspace.scores.confirm({
        epoch,
        token: preview.token,
        requestId: randomUUID(),
        expectedRevision: 0,
        reason: '首次确认',
      }),
    ).toThrow('名册');
    expect(workspace.scores.list({ epoch })).toEqual([]);
  },
);

test('preview cancellation and a newer preview invalidate earlier confirmation tokens', async () => {
  const { workspace, epoch, input } = fixture();
  const first = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  const next = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,100'), input());
  const confirm = (token: string | null) =>
    workspace.scores.confirm({
      epoch,
      token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '首次确认',
    });
  expect(() => confirm(first.token)).toThrow('失效');
  workspace.scores.cancel({ epoch });
  expect(() => confirm(next.token)).toThrow('失效');
  expect(workspace.scores.list({ epoch })).toEqual([]);
});

test('an expired preview cannot be confirmed', async () => {
  const { workspace, epoch, input } = fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  vi.setSystemTime(Date.now() + 16 * 60 * 1000);
  expect(() =>
    workspace.scores.confirm({
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '首次确认',
    }),
  ).toThrow('失效');
});

test('an invalid preview, partial roster or mismatched expected revision cannot write scores', async () => {
  const { workspace, epoch, input } = fixture();
  const invalid = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,151'), input());
  expect(invalid.canConfirm).toBe(false);
  expect(invalid.token).toBeNull();
  await expect(
    workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), {
      ...input(),
      assignments: input().assignments.slice(0, 1),
    }),
  ).rejects.toThrow('完整应考名册');
  const valid = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  expect(() =>
    workspace.scores.confirm({
      epoch,
      token: valid.token,
      requestId: randomUUID(),
      expectedRevision: 1,
      reason: '错误版本',
    }),
  ).toThrow('版本');
  expect(workspace.scores.list({ epoch })).toEqual([]);
});

test('late asynchronous preview results cannot resurrect a cancelled or superseded preview', async () => {
  const { workspace, epoch, input } = fixture();
  const first = workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  const rejected = expect(first).rejects.toThrow('变化');
  workspace.scores.cancel({ epoch });
  await rejected;
  const second = workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  const superseded = expect(second).rejects.toThrow('变化');
  const latest = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,100'), input());
  await superseded;
  const result = workspace.scores.confirm({
    epoch,
    token: latest.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '使用最后一次预览',
  });
  expect(
    workspace.scores.read({ epoch, versionId: result.versionId }).statistics.subjects[0]?.mean,
  ).toBe('100.00');
});

test.each(['close', 'restore'] as const)(
  'a preview finishing after %s cannot resurrect its old workspace',
  async (operation) => {
    const { workspace, directory, epoch, input } = fixture();
    const backup = workspace.exportBackup({ epoch });
    const promise = workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
    const rejected = expect(promise).rejects.toThrow('关闭或恢复');
    if (operation === 'close') {
      workspace.close();
      live.splice(live.indexOf(workspace), 1);
      const reopened = new Workspace(directory);
      live.push(reopened);
      expect(reopened.scores.list({ epoch })).toEqual([]);
    } else {
      const preview = workspace.previewRestore(backup);
      const restored = workspace.commitRestore({ epoch, token: preview.token });
      expect(workspace.scores.list({ epoch: restored.epoch })).toEqual([]);
    }
    await rejected;
  },
);

test('restore disposes existing score handles and invalidates old confirmation epochs', async () => {
  const { workspace, epoch, input } = fixture();
  const backup = workspace.exportBackup({ epoch });
  const handle = workspace.scores;
  const preview = await handle.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  const restore = workspace.previewRestore(backup);
  const changed = workspace.commitRestore({ epoch, token: restore.token });
  expect(() =>
    handle.confirm({
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '过期确认',
    }),
  ).toThrow('关闭或恢复');
  expect(() =>
    workspace.scores.confirm({
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '过期确认',
    }),
  ).toThrow('切换');
  expect(workspace.scores.list({ epoch: changed.epoch })).toEqual([]);
});

test('new import of an existing exam identity requires choosing that exam instead of duplicating it', async () => {
  const { workspace, epoch, input } = fixture();
  const first = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  workspace.scores.confirm({
    epoch,
    token: first.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  await expect(
    workspace.scores.preview(Buffer.from('学生编号,数学\n0001,100'), input()),
  ).rejects.toThrow('已存在');
  expect(workspace.scores.list({ epoch })).toHaveLength(1);
});

test.each(['exam-created', 'version-inserted'] as const)(
  'a failure at %s rolls back all writes and leaves the preview retryable',
  async (checkpoint) => {
    let fail = true;
    const { workspace, epoch, input } = fixture((stage) => {
      if (fail && stage === checkpoint) throw new Error('synthetic failure');
    });
    const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
    const command = {
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '首次确认',
    };
    expect(() => workspace.scores.confirm(command)).toThrow('synthetic failure');
    expect(workspace.scores.list({ epoch })).toEqual([]);
    fail = false;
    const result = workspace.scores.confirm(command);
    expect(result.revision).toBe(1);
    expect(workspace.scores.history({ epoch, examId: result.examId })).toHaveLength(1);
  },
);

test('lost acknowledgement after commit is recovered by the same idempotent request', async () => {
  const { workspace, epoch, input } = fixture((stage) => {
    if (stage === 'committed') throw new Error('synthetic lost reply');
  });
  const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  const command = {
    epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  };
  expect(() => workspace.scores.confirm(command)).toThrow('synthetic lost reply');
  const replay = workspace.scores.confirm(command);
  expect(replay.replayed).toBe(true);
  expect(workspace.scores.history({ epoch, examId: replay.examId })).toHaveLength(1);
});

test.each(['exam-created', 'version-inserted', 'committed'] as const)(
  'abrupt process exit at %s never leaves a partial exam or duplicate confirmation',
  (checkpoint) => {
    const { workspace, directory, epoch, input } = fixture();
    const inputPath = join(directory, 'input.json');
    const commandPath = join(directory, 'command.json');
    writeFileSync(inputPath, JSON.stringify(input()));
    workspace.close();
    live.splice(live.indexOf(workspace), 1);
    const childPath = join(directory, 'crash-score.cjs');
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-score.ts'],
        outfile: childPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
      }),
    );
    const child = spawnSync(
      process.execPath,
      [childPath, directory, inputPath, commandPath, checkpoint],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(89);
    const reopened = new Workspace(directory);
    live.push(reopened);
    const command = JSON.parse(readFileSync(commandPath, 'utf8'));
    if (checkpoint === 'committed') {
      const replay = reopened.scores.confirm(command);
      expect(replay.replayed).toBe(true);
      expect(reopened.scores.history({ epoch, examId: replay.examId })).toHaveLength(1);
      expect(
        reopened.scores.read({ epoch, versionId: replay.versionId }).statistics.subjects[0]?.mean,
      ).toBe('99.00');
    } else {
      expect(reopened.scores.list({ epoch })).toEqual([]);
      expect(() => reopened.scores.confirm(command)).toThrow('失效');
    }
  },
);

test('SQLite capacity failure preserves the original error and rolls back the exam before retry', async () => {
  const { workspace, directory, epoch, input } = fixture();
  const snapshot = workspace.snapshot();
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  const db = openDatabase(join(directory, 'workspaces', epoch, 'data.sqlite'), 'open');
  const book = new ScoreBook(db, () => snapshot);
  try {
    const configuration = input();
    configuration.subjects = Array.from({ length: 20 }, (_, index) => ({
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `合成科目${index + 1}`,
      maxScore: '150',
      precision: 2,
    }));
    configuration.groups[0]!.subjectIds = configuration.subjects.map((subject) => subject.id);
    const file = Buffer.from(
      ['学生编号', ...configuration.subjects.map((subject) => subject.name)].join(',') +
        '\n0001,' +
        Array(20).fill('99').join(','),
    );
    const preview = await book.preview(file, configuration);
    const command = {
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '容量验证',
    };
    const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count);
    db.exec(`PRAGMA max_page_count=${pages}`);
    expect(() => book.confirm(command)).toThrow(expect.objectContaining({ code: 'STORAGE_LIMIT' }));
    expect(book.list({ epoch })).toEqual([]);
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
    db.exec(`PRAGMA max_page_count=${Math.floor(MAX_DATABASE_BYTES / pageSize)}`);
    expect(book.confirm(command).revision).toBe(1);
  } finally {
    book.dispose();
    db.close();
  }
});

test('historical corrections keep the original student identity after transfer and rename', async () => {
  const { workspace, epoch, classId, input, students } = fixture();
  const first = await workspace.scores.preview(
    Buffer.from('学生编号,姓名,数学\n0001,合成甲,99'),
    input(),
  );
  const receipt = workspace.scores.confirm({
    epoch,
    token: first.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  const target = workspace.createClass({ epoch, name: '新合成班' }).classes[1]!.id;
  const student = students[0]!;
  workspace.saveStudent({
    epoch,
    id: student.id,
    expectedRevision: student.revision,
    studentNumber: 'NEW-0001',
    displayName: '合成改名',
    classId: target,
  });
  workspace.renameClass({ epoch, id: classId, expectedRevision: 1, name: '班级改名' });
  const corrected = await workspace.scores.preview(
    Buffer.from('学生编号,姓名,数学\n0001,合成甲,100'),
    { ...input(), examId: receipt.examId, expectedRevision: 1 },
  );
  expect(corrected.canConfirm).toBe(true);
  const next = workspace.scores.confirm({
    epoch,
    token: corrected.token,
    requestId: randomUUID(),
    expectedRevision: 1,
    reason: '更正旧考试',
  });
  const version = workspace.scores.read({ epoch, versionId: next.versionId });
  expect(version.payload.definition.className).toBe('合成班');
  expect(version.payload.analysis.roster[0]).toMatchObject({
    studentId: student.id,
    studentNumber: '0001',
    displayName: '合成甲',
  });
  expect(version.statistics.subjects[0]?.mean).toBe('100.00');
});

test('a backward system clock does not reverse version chronology', async () => {
  const { workspace, epoch, input } = fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T01:00:00Z'));
  const first = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input());
  const receipt = workspace.scores.confirm({
    epoch,
    token: first.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  vi.setSystemTime(new Date('2026-10-01T01:00:00Z'));
  const next = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,100'), {
    ...input(),
    examId: receipt.examId,
    expectedRevision: 1,
  });
  const corrected = workspace.scores.confirm({
    epoch,
    token: next.token,
    requestId: randomUUID(),
    expectedRevision: 1,
    reason: '时钟回拨后的更正',
  });
  expect(corrected.createdAt).toBe(receipt.createdAt);
  expect(workspace.exportBackup({ epoch }).length).toBeGreaterThan(0);
});

test('student history uses latest versions and explicit full marks without inferring progress', async () => {
  const { workspace, epoch, input, students } = fixture();
  const first = await workspace.scores.preview(
    Buffer.from('学生编号,数学\n0001,99\n0002,缺考'),
    input(),
  );
  const initial = workspace.scores.confirm({
    epoch,
    token: first.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '首次确认',
  });
  const correction = await workspace.scores.preview(
    Buffer.from('学生编号,数学\n0001,100\n0002,缺考'),
    { ...input(), examId: initial.examId, expectedRevision: 1 },
  );
  workspace.scores.confirm({
    epoch,
    token: correction.token,
    requestId: randomUUID(),
    expectedRevision: 1,
    reason: '更正成绩',
  });
  const secondInput = input();
  secondInput.definition.date = '2026-10-01';
  secondInput.subjects[0]!.maxScore = '100';
  const second = await workspace.scores.preview(
    Buffer.from('学生编号,数学\n0001,80\n0002,0'),
    secondInput,
  );
  workspace.scores.confirm({
    epoch,
    token: second.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '第二次考试',
  });
  const history = workspace.scores.studentHistory({ epoch, studentId: students[0]!.id, subjectId });
  expect(
    history.entries.map((entry) => [entry.displayScore, entry.maxScore, entry.ratePercent]),
  ).toEqual([
    ['100.00', '150', '66.67'],
    ['80.00', '100', '80.00'],
  ]);
  expect(history.hasMultipleValidExams).toBe(true);
  expect(history.notes.join('')).toContain('不能直接证明能力变化');
  const absent = workspace.scores.studentHistory({ epoch, studentId: students[1]!.id, subjectId });
  expect(absent.entries.map((entry) => [entry.score.status, entry.ratePercent])).toEqual([
    ['absent', null],
    ['valid', '0.00'],
  ]);
  expect(absent.hasMultipleValidExams).toBe(false);
  expect(absent.notes.join('')).toContain('不足两次');
  const backup = workspace.previewRestore(workspace.exportBackup({ epoch }));
  expect(backup).toMatchObject({ examCount: 2, scoreVersionCount: 3 });
});
