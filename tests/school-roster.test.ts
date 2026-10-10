import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { afterEach, expect, test } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { schoolRosterHeaders } from '../src/shared/roster-fields';
import { readScoreTable } from '../src/core/score-table';

const roots: string[] = [],
  workspaces: Workspace[] = [];
afterEach(() => {
  for (const w of workspaces.splice(0)) w.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'school-roster-'));
  roots.push(root);
  const w = new Workspace(root);
  workspaces.push(w);
  const epoch = w.snapshot().epoch;
  w.createClass({ epoch, name: '合成花名册班' });
  return { w, root, input: { epoch, classId: w.snapshot().classes[0]!.id } };
}
const values = [
  '0001',
  '合成甲',
  '女',
  '2010年9月',
  '110101201009010012',
  'G110101201009010012',
  '0003456',
  '0007890',
  '13800000001',
  '合成父亲',
  '110101198001010012',
  '13800000002',
  '合成母亲',
  '110101198201010012',
  '13800000003',
  '合成街道1号',
  '是',
  '是，建档立卡',
];
async function file(row: (string | number | Date)[] = values) {
  const b = new ExcelJS.Workbook(),
    s = b.addWorksheet('Sheet1');
  s.mergeCells('B1:R1');
  s.getCell('B1').value = '合成花名册';
  s.getRow(2).values = schoolRosterHeaders;
  s.getRow(4).values = row;
  s.mergeCells('B77:Q77');
  s.getCell('D4').numFmt = row[3] instanceof Date ? 'yyyy年mm月' : '@';
  return Buffer.from(await b.xlsx.writeBuffer());
}
const profile = {
  gender: 'female',
  birthMonth: '2010-09',
  idCard: values[4],
  studentRegistration: values[5],
  examRegistration: values[6],
  applicationNumber: values[7],
  studentPhone: values[8],
  fatherName: values[9],
  fatherIdCard: values[10],
  fatherPhone: values[11],
  motherName: values[12],
  motherIdCard: values[13],
  motherPhone: values[14],
  address: values[15],
  boarding: 'yes',
  povertyStatus: values[17],
};
test.each(['roster', 'shared'] as const)(
  '%s imports exact 18-column school layout, persists profiles and supports backup restore',
  async (mode) => {
    const { w, root, input } = setup(),
      bytes = await file();
    const p =
      mode === 'roster'
        ? await w.previewRoster(bytes, 'xlsx', '合成花名册.xlsx', input)
        : await w.classData.select([{ bytes, format: 'xlsx', fileName: '合成花名册.xlsx' }], input);
    expect(p).toMatchObject({ added: 1, canConfirm: true });
    expect(p.rows[0]!.row).toBe(4);
    expect(w.snapshot().students).toHaveLength(0);
    const r =
      mode === 'roster'
        ? w.confirmRoster({ epoch: input.epoch, token: p.token })
        : w.classData.confirm({ epoch: input.epoch, token: p.token });
    const student = r.snapshot.students[0]!;
    expect(
      w.pupils.readProfile({ epoch: input.epoch, studentId: student.id }).content,
    ).toMatchObject(profile);
    expect(w.pupils.profileHistory({ epoch: input.epoch, studentId: student.id })).toHaveLength(1);
    const backup = w.exportBackup({ epoch: input.epoch });
    expect(w.previewRestore(backup).studentCount).toBe(1);
    w.close();
    workspaces.splice(workspaces.indexOf(w), 1);
    const reopened = new Workspace(root);
    workspaces.push(reopened);
    expect(
      reopened.pupils.readProfile({ epoch: input.epoch, studentId: student.id }).content,
    ).toMatchObject(profile);
    const rp = reopened.previewRestore(backup);
    reopened.commitRestore({ epoch: input.epoch, token: rp.token });
    expect(
      reopened.pupils.readProfile({ epoch: reopened.snapshot().epoch, studentId: student.id })
        .content,
    ).toMatchObject(profile);
  },
);
test('reimport updates filled profile fields, preserves blanks, and skips identical data', async () => {
  const { w, input } = setup();
  let p = await w.previewRoster(await file(), 'xlsx', '合成.xlsx', input);
  w.confirmRoster({ epoch: input.epoch, token: p.token });
  p = await w.previewRoster(await file(), 'xlsx', '合成.xlsx', input);
  expect(p).toMatchObject({ added: 0, updated: 0, skipped: 1, canConfirm: false });
  const changed = [...values];
  changed[11] = '13900000002';
  changed[14] = '';
  changed[15] = '';
  p = await w.previewRoster(await file(changed), 'xlsx', '合成.xlsx', input);
  expect(p).toMatchObject({ added: 0, updated: 1, canConfirm: true });
  w.confirmRoster({ epoch: input.epoch, token: p.token });
  const studentId = w.snapshot().students[0]!.id;
  expect(w.pupils.readProfile({ epoch: input.epoch, studentId }).content).toMatchObject({
    fatherPhone: '13900000002',
    motherPhone: values[14],
    address: values[15],
  });
  expect(w.pupils.profileHistory({ epoch: input.epoch, studentId })).toHaveLength(2);
});
test('shared import joins roster fields and scores, then allows profile-only enrichment', async () => {
  const { w, input } = setup();
  const p = await w.classData.select(
    [
      { bytes: await file(), format: 'xlsx', fileName: '名册.xlsx' },
      {
        bytes: Buffer.from('学号,姓名,数学\n0001,合成甲,100'),
        format: 'csv',
        fileName: '成绩.csv',
      },
    ],
    input,
  );
  expect(p).toMatchObject({ profileRows: 1, hasScores: true, canConfirm: true, added: 1 });
  w.classData.confirm({ epoch: input.epoch, token: p.token });
  expect(w.scores.list({ epoch: input.epoch })).toHaveLength(1);
  const changed = [...values];
  changed[17] = '否';
  const next = await w.classData.select(
    [{ bytes: await file(changed), format: 'xlsx', fileName: '名册.xlsx' }],
    input,
  );
  expect(next).toMatchObject({ added: 0, profileRows: 1, canConfirm: true });
  w.classData.confirm({ epoch: input.epoch, token: next.token });
  expect(
    w.pupils.readProfile({ epoch: input.epoch, studentId: w.snapshot().students[0]!.id }).content
      .povertyStatus,
  ).toBe('否');
});
test('profile write failure rolls back student creation in both import paths', async () => {
  for (const mode of ['roster', 'shared']) {
    const { w, root, input } = setup();
    const pointer = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
    const db = new DatabaseSync(join(root, 'workspaces', pointer.workspaceId, 'data.sqlite'));
    try {
      db.exec(
        "CREATE TRIGGER fail_profile BEFORE INSERT ON student_profile_revisions BEGIN SELECT RAISE(ABORT, 'synthetic profile failure'); END",
      );
      const bytes = await file();
      const p =
        mode === 'roster'
          ? await w.previewRoster(bytes, 'xlsx', '合成.xlsx', input)
          : await w.classData.select([{ bytes, format: 'xlsx', fileName: '合成.xlsx' }], input);
      const confirm = () =>
        mode === 'roster'
          ? w.confirmRoster({ epoch: input.epoch, token: p.token })
          : w.classData.confirm({ epoch: input.epoch, token: p.token });
      expect(confirm).toThrow('synthetic');
      expect(w.snapshot().students).toHaveLength(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM student_profiles').get()?.n).toBe(0);
      db.exec('DROP TRIGGER fail_profile');
      expect(confirm().snapshot.students).toHaveLength(1);
    } finally {
      db.close();
    }
  }
});
test('profile edits after preview prevent overwrite by stale shared import', async () => {
  const { w, input } = setup();
  w.saveStudent({ ...input, studentNumber: '0001', displayName: '合成甲' });
  const p = await w.classData.select(
    [{ bytes: await file(), format: 'xlsx', fileName: '合成.xlsx' }],
    input,
  );
  const student = w.snapshot().students[0]!,
    old = w.pupils.readProfile({ epoch: input.epoch, studentId: student.id });
  w.pupils.saveProfile({
    epoch: input.epoch,
    studentId: student.id,
    expectedRevision: old.revision,
    expectedStudentRevision: student.revision,
    requestId: crypto.randomUUID(),
    content: { ...old.content, fatherName: '合成修改' },
    reason: '合成编辑',
  });
  expect(() => w.classData.confirm({ epoch: input.epoch, token: p.token })).toThrow('档案已变化');
  expect(
    w.pupils.readProfile({ epoch: input.epoch, studentId: student.id }).content.fatherName,
  ).toBe('合成修改');
});
test('Excel date stores birth month; unsafe numeric identity and data-cell merges reject without writes', async () => {
  const { w, input } = setup();
  const row: (string | number | Date)[] = [...values];
  row[3] = new Date('2010-09-01T00:00:00Z');
  const p = await w.previewRoster(await file(row), 'xlsx', '合成.xlsx', input);
  expect(p.canConfirm).toBe(true);
  expect(p.rows[0]!.profile?.birthMonth).toBe('2010-09');
  row[4] = 110101201009010000;
  const invalid = await w.previewRoster(await file(row), 'xlsx', '合成.xlsx', input);
  expect(invalid.canConfirm).toBe(false);
  expect(invalid.rows[0]!.message).toContain('精度');
  const b = new ExcelJS.Workbook();
  await b.xlsx.load(Uint8Array.from(await file()).buffer);
  b.worksheets[0]!.mergeCells('I4:J4');
  await expect(
    w.previewRoster(Buffer.from(await b.xlsx.writeBuffer()), 'xlsx', '合成.xlsx', input),
  ).rejects.toThrow('合并');
  await expect(readScoreTable(await file(), 'xlsx')).rejects.toThrow('合并');
  expect(w.snapshot().students).toHaveLength(0);
});
