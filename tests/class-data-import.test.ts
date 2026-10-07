import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { DatabaseSync } from 'node:sqlite';

const roots: string[] = [],
  workspaces: Workspace[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const w of workspaces.splice(0)) w.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'class-data-import-'));
  roots.push(root);
  const workspace = new Workspace(root);
  workspaces.push(workspace);
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成验证班' });
  const input = { epoch, classId: workspace.snapshot().classes[0]!.id };
  const select = (text: string) =>
    workspace.classData.select(
      [{ bytes: Buffer.from(text), format: 'csv', fileName: '合成资料.csv' }],
      input,
    );
  return { workspace, input, select, root };
}
test('name-only roster and numbered scores preserve one student identity', async () => {
  const { workspace, input } = setup();
  const p = await workspace.classData.select(
    [
      { bytes: Buffer.from('姓名\n合成甲'), format: 'csv', fileName: '名单.csv' },
      { bytes: Buffer.from('学号,姓名,数学\n001,合成甲,128'), format: 'csv', fileName: '成绩.csv' },
    ],
    input,
  );
  expect(p).toMatchObject({ added: 1, canConfirm: true });
  expect(new Set(p.rows.map((row) => row.studentId)).size).toBe(1);
  expect(p.rows.map((row) => row.studentNumber)).toEqual(['001', '001']);
  expect(
    workspace.classData.confirm({ epoch: input.epoch, token: p.token }).snapshot.students,
  ).toHaveLength(1);
});
test('numeric identifiers with padded display formats require explicit text preservation', async () => {
  const { workspace, input } = setup();
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('名单');
  sheet.addRows([
    ['学号', '姓名'],
    [1, '合成甲'],
  ]);
  sheet.getCell('A2').numFmt = '000';
  const p = await workspace.classData.select(
    [{ bytes: Buffer.from(await book.xlsx.writeBuffer()), format: 'xlsx', fileName: '补零.xlsx' }],
    input,
  );
  expect(p.canConfirm).toBe(false);
  expect(p.rows[0]!.message).toContain('前导零');
  expect(workspace.snapshot().students).toHaveLength(0);
});
test('a score write failure rolls back the entire roster and exam transaction', async () => {
  const { workspace, input, select, root } = setup();
  const p = await select('姓名,数学\n合成甲,128');
  const pointer = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
  const db = new DatabaseSync(join(root, 'workspaces', pointer.workspaceId, 'data.sqlite'));
  try {
    db.exec(
      "CREATE TRIGGER fail_shared_import BEFORE INSERT ON score_versions BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
    );
    expect(() => workspace.classData.confirm({ epoch: input.epoch, token: p.token })).toThrow();
    expect(workspace.snapshot().students).toHaveLength(0);
    expect(workspace.scores.list({ epoch: input.epoch })).toHaveLength(0);
    db.exec('DROP TRIGGER fail_shared_import');
    expect(
      workspace.classData.confirm({ epoch: input.epoch, token: p.token }).snapshot.students,
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});
test('score-only file creates confirmed identities and an exam atomically, reusable by attendance and backups', async () => {
  const { workspace, input, select, root } = setup();
  const p = await select('姓名,语文,数学,英语\n合成甲,116,128,120\n合成乙,108,119,缺考');
  expect(p).toMatchObject({ added: 2, hasScores: true, canConfirm: true, unresolved: 0 });
  expect(workspace.snapshot().students).toHaveLength(0);
  expect(workspace.scores.list({ epoch: input.epoch })).toHaveLength(0);
  const receipt = workspace.classData.confirm({ epoch: input.epoch, token: p.token });
  expect(receipt.added).toBe(2);
  expect(workspace.classData.confirm({ epoch: input.epoch, token: p.token }).replayed).toBe(true);
  const exams = workspace.scores.list({ epoch: input.epoch, classId: input.classId });
  expect(exams).toHaveLength(1);
  const view = workspace.scores.read({ epoch: input.epoch, versionId: exams[0]!.versionId });
  expect(view.payload.analysis.roster).toHaveLength(2);
  expect(view.payload.analysis.entries.filter((e) => e.score.status === 'absent')).toHaveLength(1);
  expect(
    workspace.pupils
      .roster(input)
      .students.map((s) => s.studentId)
      .sort(),
  ).toEqual(receipt.snapshot.students.map((s) => s.id).sort());
  const backup = workspace.exportBackup({ epoch: input.epoch });
  expect(workspace.previewRestore(backup).examCount).toBe(1);
  workspace.close();
  workspaces.splice(workspaces.indexOf(workspace), 1);
  const reopened = new Workspace(root);
  workspaces.push(reopened);
  expect(reopened.snapshot().students).toHaveLength(2);
  expect(reopened.scores.list({ epoch: input.epoch })).toHaveLength(1);
});
test('two worksheets link a numbered roster to name-only scores without duplicate identities', async () => {
  const { workspace, input } = setup();
  const book = new ExcelJS.Workbook();
  book.addWorksheet('学生信息').addRows([
    ['学号', '学生姓名'],
    ['001', '合成甲'],
    ['002', '合成乙'],
  ]);
  book.addWorksheet('10月月考').addRows([
    ['姓名', '语文'],
    ['合成甲', 116],
    ['合成乙', 108],
  ]);
  const p = await workspace.classData.select(
    [
      {
        bytes: Buffer.from(await book.xlsx.writeBuffer()),
        format: 'xlsx',
        fileName: '合成班级资料.xlsx',
      },
    ],
    input,
  );
  expect(p).toMatchObject({ added: 2, canConfirm: true, scoreRows: 2 });
  expect(p.rows).toHaveLength(4);
  const saved = workspace.classData.confirm({ epoch: input.epoch, token: p.token });
  expect(saved.snapshot.students.map((s) => s.studentNumber).sort()).toEqual(['001', '002']);
  expect(
    workspace.scores.read({
      epoch: input.epoch,
      versionId: workspace.scores.list({ epoch: input.epoch })[0]!.versionId,
    }).payload.analysis.entries,
  ).toHaveLength(2);
});
test('two separate files import a roster and scores; identical roster reimport does not create duplicates', async () => {
  const { workspace, input, select } = setup();
  const p = await workspace.classData.select(
    [
      { bytes: Buffer.from('学生编号,姓名\n001,合成甲'), format: 'csv', fileName: '名单.csv' },
      {
        bytes: Buffer.from('学生编号,姓名,数学\n001,合成甲,128'),
        format: 'csv',
        fileName: '考试.csv',
      },
    ],
    input,
  );
  expect(p.canConfirm).toBe(true);
  workspace.classData.confirm({ epoch: input.epoch, token: p.token });
  const next = await select('学生编号,姓名\n001,合成甲');
  expect(next).toMatchObject({ added: 0, matched: 1, canConfirm: false });
  expect(workspace.snapshot().students).toHaveLength(1);
});
test('same-name matching requires explicit selection and an unknown student requires explicit addition', async () => {
  const { workspace, input, select } = setup();
  for (const studentNumber of ['001', '002'])
    workspace.saveStudent({ ...input, studentNumber, displayName: '合成同名' });
  const p = await select('姓名,语文\n合成同名,110\n合成新生,100');
  expect(p).toMatchObject({ unresolved: 2, canConfirm: false, added: 0 });
  const next = workspace.classData.configure({
    ...p.configuration,
    resolutions: [
      { key: p.rows[0]!.key, action: 'existing', studentId: workspace.snapshot().students[1]!.id },
      { key: p.rows[1]!.key, action: 'new' },
    ],
  });
  expect(next).toMatchObject({ unresolved: 0, added: 1, canConfirm: true });
  expect(workspace.snapshot().students).toHaveLength(2);
  const receipt = workspace.classData.confirm({ epoch: input.epoch, token: next.token });
  expect(receipt.snapshot.students).toHaveLength(3);
});
test('unique names reuse local students and preserve generated identifiers across subsequent exams', async () => {
  const { workspace, input, select } = setup();
  const a = await select('姓名,语文\n合成甲,110');
  workspace.classData.confirm({ epoch: input.epoch, token: a.token });
  const student = workspace.snapshot().students[0]!;
  const b = await select('姓名,语文\n合成甲,120');
  const next = workspace.classData.configure({ ...b.configuration, examName: '第二次合成考试' });
  expect(next).toMatchObject({ added: 0, matched: 1, canConfirm: true });
  expect(next.rows[0]!.studentId).toBe(student.id);
  workspace.classData.confirm({ epoch: input.epoch, token: next.token });
  expect(workspace.snapshot().students).toHaveLength(1);
  expect(workspace.scores.list({ epoch: input.epoch })).toHaveLength(2);
});
test('duplicate exam rejects before roster or scores are written', async () => {
  const { workspace, input, select } = setup();
  const a = await select('学生编号,姓名,语文\n001,合成甲,110');
  workspace.classData.confirm({ epoch: input.epoch, token: a.token });
  const b = await select('学生编号,姓名,语文\n001,合成甲,120\n002,合成乙,100');
  const resolved = workspace.classData.configure({
    ...b.configuration,
    resolutions: [{ key: b.rows[1]!.key, action: 'new' }],
  });
  expect(resolved.canConfirm).toBe(false);
  expect(resolved.issues.join()).toContain('同名');
  expect(() => workspace.classData.confirm({ epoch: input.epoch, token: b.token })).toThrow();
  expect(workspace.snapshot().students).toHaveLength(1);
  expect(workspace.scores.list({ epoch: input.epoch })).toHaveLength(1);
});
test('invalid score is visible, leaves the original data intact, and can be explicitly excluded', async () => {
  const { workspace, input, select } = setup();
  const p = await select('学生编号,姓名,数学\n001,合成甲,999\n002,合成乙,100');
  expect(p.canConfirm).toBe(false);
  expect(p.rows[0]!.status).toBe('error');
  expect(() => workspace.classData.confirm({ epoch: input.epoch, token: p.token })).toThrow();
  expect(workspace.snapshot().students).toHaveLength(0);
  const next = workspace.classData.configure({
    ...p.configuration,
    resolutions: [{ key: p.rows[0]!.key, action: 'skip' }],
  });
  expect(next.canConfirm).toBe(true);
  expect(next.added).toBe(1);
  workspace.classData.confirm({ epoch: input.epoch, token: next.token });
  expect(workspace.snapshot().students.map((s) => s.studentNumber)).toEqual(['002']);
});
test('changed maximum or decimal precision requires revalidation of the saved preview', async () => {
  const { workspace, input, select } = setup();
  const p = await select('姓名,数学\n合成甲,120.5');
  expect(p.canConfirm).toBe(false);
  const next = workspace.classData.configure({
    ...p.configuration,
    subjects: p.configuration.subjects.map((s) => ({ ...s, precision: 1 })),
  });
  expect(next.canConfirm).toBe(true);
  const invalid = workspace.classData.configure({
    ...next.configuration,
    subjects: next.configuration.subjects.map((s) => ({ ...s, maxScore: '100' })),
  });
  expect(invalid.canConfirm).toBe(false);
  expect(() => workspace.classData.confirm({ epoch: input.epoch, token: p.token })).toThrow();
  expect(workspace.snapshot().students).toHaveLength(0);
});
test('duplicate rows and foreign-class selections cannot silently add or move identities', async () => {
  const { workspace, input, select } = setup();
  const p = await select('学生编号,姓名\n001,合成甲\n001,合成甲');
  expect(p.canConfirm).toBe(false);
  workspace.createClass({ epoch: input.epoch, name: '另一个合成班' });
  const other = workspace.snapshot().classes.find((c) => c.id !== input.classId)!.id;
  workspace.saveStudent({
    epoch: input.epoch,
    classId: other,
    studentNumber: '002',
    displayName: '合成乙',
  });
  const a = await select('学生编号,姓名\n002,合成乙');
  expect(a.canConfirm).toBe(false);
  const b = workspace.classData.configure({
    ...a.configuration,
    resolutions: [
      { key: a.rows[0]!.key, action: 'existing', studentId: workspace.snapshot().students[0]!.id },
    ],
  });
  expect(b.canConfirm).toBe(false);
  expect(workspace.snapshot().students[0]!.classId).toBe(other);
});
test('membership changes, cancellation, replacement and expiry invalidate pending confirmation', async () => {
  const { workspace, input, select } = setup();
  const confirm = (token: string) => workspace.classData.confirm({ epoch: input.epoch, token });
  const p = await select('姓名\n合成甲');
  workspace.saveStudent({ ...input, studentNumber: '001', displayName: '合成乙' });
  expect(() => confirm(p.token)).toThrow('名册');
  const a = await select('姓名\n合成乙');
  workspace.classData.cancel(input);
  expect(() => confirm(a.token)).toThrow();
  const b = await select('姓名\n合成乙');
  await expect(select('')).rejects.toThrow();
  expect(() => confirm(b.token)).toThrow();
  const c = await select('姓名\n合成乙');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
  expect(() => confirm(c.token)).toThrow();
  expect(workspace.snapshot().students).toHaveLength(1);
});
test('restore invalidates import and replay tokens from the old workspace', async () => {
  const { workspace, input, select } = setup();
  const backup = workspace.exportBackup({ epoch: input.epoch });
  const p = await select('姓名\n合成甲');
  workspace.classData.confirm({ epoch: input.epoch, token: p.token });
  const restore = workspace.previewRestore(backup);
  workspace.commitRestore({ epoch: input.epoch, token: restore.token });
  expect(() => workspace.classData.confirm({ epoch: input.epoch, token: p.token })).toThrow();
  expect(workspace.snapshot().students).toHaveLength(0);
});
