import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { createRosterTemplate } from '../src/core/roster-import';
import { schoolRosterHeaders } from '../src/shared/roster-fields';

const roots: string[] = [];
const workspaces: Workspace[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) workspace.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'roster-import-'));
  roots.push(root);
  const workspace = new Workspace(root);
  workspaces.push(workspace);
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成验证班' });
  const classId = workspace.snapshot().classes[0]!.id;
  const input = { epoch, classId };
  const preview = (text: string) =>
    workspace.previewRoster(Buffer.from(text), 'csv', '合成名册.csv', input);
  return { workspace, root, input, preview };
}
test('preview does not write; confirm imports both roster and memberships and replays one receipt', async () => {
  const { workspace, root, input, preview } = setup();
  const p = await preview('\uFEFF学生编号,姓名\r\n0001,合成甲\r\nab-02,合成乙\r\n');
  expect(p).toMatchObject({ canConfirm: true, added: 2, skipped: 0 });
  expect(workspace.snapshot().students).toHaveLength(0);
  const result = workspace.confirmRoster({ epoch: input.epoch, token: p.token });
  expect(result).toMatchObject({ added: 2, replayed: false });
  expect(result.snapshot.students.map((s) => s.studentNumber).sort()).toEqual(['0001', 'AB-02']);
  expect(workspace.confirmRoster({ epoch: input.epoch, token: p.token })).toMatchObject({
    added: 2,
    replayed: true,
  });
  expect(workspace.snapshot().students).toHaveLength(2);
  workspace.close();
  workspaces.splice(workspaces.indexOf(workspace), 1);
  const reopened = new Workspace(root);
  workspaces.push(reopened);
  expect(reopened.snapshot().students.every((s) => s.active && s.classId === input.classId)).toBe(
    true,
  );
  expect(() => reopened.confirmRoster({ epoch: input.epoch, token: p.token })).toThrow('失效');
  expect(
    await reopened.previewRoster(
      Buffer.from('学生编号,姓名\n0001,合成甲\nab-02,合成乙'),
      'csv',
      '合成名册.csv',
      input,
    ),
  ).toMatchObject({ added: 0, skipped: 2, canConfirm: false });
});
test('file duplicates reject the entire batch, including otherwise valid rows', async () => {
  const { workspace, input, preview } = setup();
  const p = await preview('学号,学生姓名\na01,合成甲\nA01,合成甲\n002,合成乙');
  expect(p.rows.map((r) => r.status)).toEqual(['error', 'error', 'new']);
  expect(p.canConfirm).toBe(false);
  expect(() => workspace.confirmRoster({ epoch: input.epoch, token: p.token })).toThrow('修正');
  expect(workspace.snapshot().students).toHaveLength(0);
});
test.each(['different-name', 'other-class', 'inactive'] as const)(
  'existing identity conflict: %s does not overwrite or move students',
  async (kind) => {
    const { workspace, input, preview } = setup();
    workspace.createClass({ epoch: input.epoch, name: '合成另一班' });
    const other = workspace.snapshot().classes.find((c) => c.id !== input.classId)!.id;
    workspace.saveStudent({
      ...input,
      classId: kind === 'other-class' ? other : input.classId,
      studentNumber: '001',
      displayName: '合成甲',
    });
    const student = workspace.snapshot().students[0]!;
    if (kind === 'inactive')
      workspace.setStudentActive({
        epoch: input.epoch,
        id: student.id,
        expectedRevision: student.revision,
        active: false,
      });
    const before = workspace.snapshot();
    const p = await preview(
      `学生编号,姓名\n001,${kind === 'different-name' ? '合成乙' : '合成甲'}\n002,合成丙`,
    );
    expect(p.canConfirm).toBe(false);
    expect(() => workspace.confirmRoster({ epoch: input.epoch, token: p.token })).toThrow('修正');
    expect(workspace.snapshot()).toEqual(before);
  },
);
test('exact existing active identity is skipped while a new student is committed', async () => {
  const { workspace, input, preview } = setup();
  workspace.saveStudent({ ...input, studentNumber: '001', displayName: '合成甲' });
  const p = await preview('学生编号,姓名\n001,合成甲\n002,合成乙');
  expect(p).toMatchObject({ added: 1, skipped: 1, canConfirm: true });
  expect(
    workspace.confirmRoster({ epoch: input.epoch, token: p.token }).snapshot.students,
  ).toHaveLength(2);
});
test('a roster change after preview invalidates the entire import', async () => {
  const { workspace, input, preview } = setup();
  const p = await preview('学生编号,姓名\n001,合成甲');
  workspace.saveStudent({ ...input, studentNumber: '002', displayName: '合成乙' });
  expect(() => workspace.confirmRoster({ epoch: input.epoch, token: p.token })).toThrow(
    '名册已变化',
  );
  expect(workspace.snapshot().students.map((s) => s.studentNumber)).toEqual(['002']);
});
test('cancel, replacement, invalid replacement and expiry invalidate old tokens', async () => {
  const { workspace, input, preview } = setup();
  const confirm = (token: string) => workspace.confirmRoster({ epoch: input.epoch, token });
  const p = await preview('学生编号,姓名\n001,合成甲');
  workspace.cancelRosterPreview({ epoch: input.epoch });
  expect(() => confirm(p.token)).toThrow('失效');
  const a = await preview('学生编号,姓名\n001,合成甲');
  const b = await preview('学生编号,姓名\n002,合成乙');
  expect(() => confirm(a.token)).toThrow('失效');
  await expect(preview('')).rejects.toThrow();
  expect(() => confirm(b.token)).toThrow('失效');
  const c = await preview('学生编号,姓名\n003,合成丙');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
  expect(() => confirm(c.token)).toThrow('失效');
  expect(workspace.snapshot().students).toHaveLength(0);
});
test('restore rejects both a preview and an already committed replay token from the previous epoch', async () => {
  const { workspace, input, preview } = setup();
  const backup = workspace.exportBackup({ epoch: input.epoch });
  const a = await preview('学生编号,姓名\n001,合成甲');
  workspace.confirmRoster({ epoch: input.epoch, token: a.token });
  const b = await preview('学生编号,姓名\n002,合成乙');
  const restore = workspace.previewRestore(backup);
  workspace.commitRestore({ epoch: input.epoch, token: restore.token });
  for (const token of [a.token, b.token])
    expect(() => workspace.confirmRoster({ epoch: input.epoch, token })).toThrow('刷新');
  expect(workspace.snapshot().students).toHaveLength(0);
});
test.each([
  '姓名\n合成甲',
  '学生编号,学号,姓名\n001,001,合成甲',
  '学生编号,姓名,班级\n001,合成甲,错误班级',
  '学生编号,姓名\n001,合成甲,多余列',
  '学生编号,姓名\n!invalid,合成甲',
  '学生编号,姓名\n001,',
])('invalid CSV is visible and cannot confirm: %s', async (text) => {
  const { workspace, input, preview } = setup();
  const p = await preview(text);
  expect(p.canConfirm).toBe(false);
  expect(() => workspace.confirmRoster({ epoch: input.epoch, token: p.token })).toThrow();
  expect(workspace.snapshot().students).toHaveLength(0);
});
test('XLSX template preserves textual leading zeros; numeric identifiers and formulas are rejected', async () => {
  const { workspace, input } = setup();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(await createRosterTemplate('xlsx')).buffer);
  const sheet = workbook.worksheets[0]!;
  expect(sheet.getColumn(1).numFmt).toBe('@');
  sheet.addRow(['0001', '合成甲']);
  const valid = await workspace.previewRoster(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    'xlsx',
    '合成名册.xlsx',
    input,
  );
  expect(valid).toMatchObject({ canConfirm: true, added: 1 });
  expect(valid.rows[0]!.studentNumber).toBe('0001');
  sheet.getCell('A2').value = 1;
  sheet.getCell('A2').numFmt = '0000';
  const numeric = await workspace.previewRoster(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    'xlsx',
    '合成名册.xlsx',
    input,
  );
  expect(numeric.canConfirm).toBe(false);
  expect(numeric.rows[0]!.message).toContain('前导零');
  sheet.getCell('A2').value = { formula: '1+1', result: 2 };
  const formula = await workspace.previewRoster(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    'xlsx',
    '合成名册.xlsx',
    input,
  );
  expect(formula.canConfirm).toBe(false);
  sheet.getRow(2).hidden = true;
  await expect(
    workspace.previewRoster(
      Buffer.from(await workbook.xlsx.writeBuffer()),
      'xlsx',
      '合成名册.xlsx',
      input,
    ),
  ).rejects.toThrow('隐藏');
});
test('templates contain no sample student data and CSV is UTF-8 with BOM', async () => {
  expect((await createRosterTemplate('csv')).toString('utf8')).toBe(
    '\uFEFF' + schoolRosterHeaders.join(',') + '\r\n',
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(await createRosterTemplate('xlsx')).buffer);
  expect(workbook.worksheets[0]!.rowCount).toBe(1);
});
test('a thousand-row batch remains all-or-nothing and durable', async () => {
  const { workspace, input, preview } = setup();
  const text =
    '学生编号,姓名\n' +
    Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, '0')},合成学生${i}`).join('\n');
  const p = await preview(text);
  expect(p.added).toBe(1000);
  expect(workspace.snapshot().students).toHaveLength(0);
  expect(
    workspace.confirmRoster({ epoch: input.epoch, token: p.token }).snapshot.students,
  ).toHaveLength(1000);
});
test('oversize and invalid encoding fail without preserving an earlier valid preview', async () => {
  const { workspace, input, preview } = setup();
  const p = await preview('学生编号,姓名\n001,合成甲');
  await expect(
    workspace.previewRoster(new Uint8Array(5 * 1024 * 1024 + 1), 'csv', '合成名册.csv', input),
  ).rejects.toThrow('5 MiB');
  expect(() => workspace.confirmRoster({ epoch: input.epoch, token: p.token })).toThrow('失效');
  await expect(
    workspace.previewRoster(new Uint8Array([0xff]), 'csv', '合成名册.csv', input),
  ).rejects.toThrow('UTF-8');
  await expect(
    preview(
      '学生编号,姓名\n' + Array.from({ length: 10001 }, (_, i) => `${i},合成学生`).join('\n'),
    ),
  ).rejects.toThrow('10000');
});
