import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
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
async function columnStyles(bytes: Buffer, min = '19', max = '16384') {
  const zip = await JSZip.loadAsync(bytes),
    name = 'xl/worksheets/sheet1.xml';
  zip.file(
    name,
    (await zip.file(name)!.async('string')).replace(
      '<sheetData>',
      `<cols><col min="${min}" max="${max}" width="10" customWidth="1"/></cols><sheetData>`,
    ),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
test.each(['roster', 'shared'] as const)(
  '%s accepts 18 data columns with empty column formatting through XFD',
  async (mode) => {
    const { w, input } = setup(),
      bytes = await columnStyles(await file());
    const p =
      mode === 'roster'
        ? await w.previewRoster(bytes, 'xlsx', '合成花名册.xlsx', input)
        : await w.classData.select([{ bytes, format: 'xlsx', fileName: '合成花名册.xlsx' }], input);
    expect(p).toMatchObject({ added: 1, canConfirm: true });
    const r =
      mode === 'roster'
        ? w.confirmRoster({ epoch: input.epoch, token: p.token })
        : w.classData.confirm({ epoch: input.epoch, token: p.token });
    expect(r.snapshot.students).toHaveLength(1);
    expect(
      w.pupils.readProfile({ epoch: input.epoch, studentId: r.snapshot.students[0]!.id }).content,
    ).toMatchObject(profile);
  },
);
test.each([
  ['0', '18'],
  ['19', '18'],
  ['19', '16385'],
])('invalid column style range %s:%s still rejects', async (min, max) => {
  const { w, input } = setup();
  await expect(
    w.previewRoster(await columnStyles(await file(), min, max), 'xlsx', '合成.xlsx', input),
  ).rejects.toMatchObject({ code: 'SCORE_FILE_LIMIT' });
  expect(w.snapshot().students).toHaveLength(0);
});
test('wide formatting never permits actual data beyond the 23-column boundary', async () => {
  const { w, input } = setup(),
    b = new ExcelJS.Workbook();
  await b.xlsx.load(Uint8Array.from(await file()).buffer);
  b.worksheets[0]!.getCell('X4').value = '不能静默丢弃的合成数据';
  await expect(
    w.previewRoster(
      await columnStyles(Buffer.from(await b.xlsx.writeBuffer())),
      'xlsx',
      '合成.xlsx',
      input,
    ),
  ).rejects.toMatchObject({ code: 'SCORE_FILE_LIMIT' });
  expect(w.snapshot().students).toHaveLength(0);
});
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

test.each(['roster', 'shared'] as const)(
  '%s accepts ordinary Excel roster cell types without requiring manual reformatting',
  async (mode) => {
    const { w, input } = setup(),
      b = new ExcelJS.Workbook(),
      s = b.addWorksheet('名单');
    s.addRow(['学号', '姓名', '出生日期', '考籍号', '是否住校', '父亲姓名', '父亲联系电话']);
    s.addRow([
      1,
      { richText: [{ text: '合成' }, { text: '甲' }] },
      new Date('2010-09-01T00:00:00Z'),
      3456,
      true,
      { formula: '"合成父亲"', result: '合成父亲' },
      13800000002,
    ]);
    s.getCell('A2').numFmt = '0000';
    s.getCell('C2').numFmt = 'yyyy/mm/dd';
    s.getCell('D2').numFmt = '0000000';
    s.addRow([2, '合成乙', '2010年9月2日', '0003457', '走读', '合成家长', '13800000003']);
    s.getCell('A3').numFmt = '0000';
    const bytes = Buffer.from(await b.xlsx.writeBuffer());
    const p =
      mode === 'roster'
        ? await w.previewRoster(bytes, 'xlsx', '合成.xlsx', input)
        : await w.classData.select([{ bytes, format: 'xlsx', fileName: '合成.xlsx' }], input);
    expect(p).toMatchObject({ added: 2, canConfirm: true });
    expect(p.rows.map((r) => r.studentNumber)).toEqual(['0001', '0002']);
    expect(p.rows[0]!.message).toContain('公式');
    const r =
      mode === 'roster'
        ? w.confirmRoster({ epoch: input.epoch, token: p.token })
        : w.classData.confirm({ epoch: input.epoch, token: p.token });
    const first = r.snapshot.students.find((s) => s.studentNumber === '0001')!,
      second = r.snapshot.students.find((s) => s.studentNumber === '0002')!;
    expect(w.pupils.readProfile({ epoch: input.epoch, studentId: first.id }).content).toMatchObject(
      {
        birthDate: '2010-09-01',
        examRegistration: '0003456',
        boarding: 'yes',
        fatherName: '合成父亲',
        fatherPhone: '13800000002',
      },
    );
    expect(
      w.pupils.readProfile({ epoch: input.epoch, studentId: second.id }).content,
    ).toMatchObject({ birthDate: '2010-09-02', boarding: 'no' });
  },
);
test.each(['√', '✓', '住宿', '寄宿', 'YES'])(
  'boarding value %s is understood as boarding',
  async (value) => {
    const { w, input } = setup();
    const p = await w.previewRoster(
      Buffer.from(`学号,姓名,是否住校\n001,合成甲,${value}`),
      'csv',
      '合成.csv',
      input,
    );
    expect(p.canConfirm).toBe(true);
    expect(p.rows[0]!.profile?.boarding).toBe('yes');
  },
);
test.each(['×', '走读生', '不住宿', 'NO'])(
  'boarding value %s is understood as day school',
  async (value) => {
    const { w, input } = setup();
    const p = await w.previewRoster(
      Buffer.from(`学号,姓名,是否住校\n001,合成甲,${value}`),
      'csv',
      '合成.csv',
      input,
    );
    expect(p.canConfirm).toBe(true);
    expect(p.rows[0]!.profile?.boarding).toBe('no');
  },
);

test.each(['roster', 'shared'] as const)(
  '%s reads link labels and normalized parent headers without following links',
  async (mode) => {
    const { w, input } = setup(),
      b = new ExcelJS.Workbook(),
      s = b.addWorksheet('名单');
    s.addRows([
      [
        '学 号',
        { richText: [{ text: '姓' }, { text: '名' }] },
        '父亲\n姓名',
        '身份证号码',
        '联系电话',
        '母亲姓名',
        '身份证号码',
        '联系电话',
        '家庭详细住址(具体到门牌号)',
      ],
      [
        1,
        { text: '合成甲', hyperlink: 'https://example.invalid/do-not-fetch' },
        '合成父亲',
        values[10],
        13800000002,
        '合成母亲',
        values[13],
        13800000003,
        '合成街道1号',
      ],
    ]);
    const bytes = Buffer.from(await b.xlsx.writeBuffer());
    const p =
      mode === 'roster'
        ? await w.previewRoster(bytes, 'xlsx', '合成.xlsx', input)
        : await w.classData.select([{ bytes, format: 'xlsx', fileName: '合成.xlsx' }], input);
    expect(p.canConfirm).toBe(true);
    expect(p.rows[0]!.message).toContain('未访问链接');
    expect(p.rows[0]!.profile).toMatchObject({
      fatherIdCard: values[10],
      fatherPhone: '13800000002',
      motherIdCard: values[13],
      motherPhone: '13800000003',
      address: '合成街道1号',
    });
    await expect(readScoreTable(bytes, 'xlsx')).rejects.toThrow('外部链接');
  },
);

test.each(['roster', 'shared'] as const)(
  '%s rejects corrupted and ambiguous roster cells with field-specific advice',
  async (mode) => {
    const { w, input } = setup();
    for (const [header, value, reason] of [
      ['学号', 1000000000000000, '精度'], // 16 digits can be safe in JS but are not reliable in Excel.
      ['考籍号', 1234567890123456, '精度'],
      ['父亲姓名', { formula: '"合成父亲"' }, '公式没有已保存'],
      ['父亲姓名', { formula: '1/0', result: { error: '#DIV/0!' } }, '错误值'],
      ['是否住校', '2', '含义不明确'],
      ['出生日期', '2010-02-30', '不是有效日期'],
      ['出生日期', '9/1/2010', '年在前'],
      ['出生日期', '2010-911', '年在前'],
    ] as const) {
      const b = new ExcelJS.Workbook(),
        s = b.addWorksheet('名单');
      if (header === '学号')
        s.addRows([
          ['学号', '姓名'],
          [value, '合成甲'],
        ]);
      else
        s.addRows([
          ['学号', '姓名', header],
          ['001', '合成甲', value],
        ]);
      const bytes = Buffer.from(await b.xlsx.writeBuffer());
      const p =
        mode === 'roster'
          ? await w.previewRoster(bytes, 'xlsx', '合成.xlsx', input)
          : await w.classData.select([{ bytes, format: 'xlsx', fileName: '合成.xlsx' }], input);
      expect(p.canConfirm).toBe(false);
      expect(p.rows[0]!.message).toContain(header);
      expect(p.rows[0]!.message).toContain(reason);
      expect(w.snapshot().students).toHaveLength(0);
    }
  },
);

test.each(['2010/9/1', '2010.9.1', '20100901', 20100901])(
  'year-first birth date %s is normalized',
  async (value) => {
    const { w, input } = setup(),
      b = new ExcelJS.Workbook(),
      s = b.addWorksheet('名单');
    s.addRows([
      ['学号', '姓名', '出生日期'],
      [1, '合成甲', value],
    ]);
    const p = await w.previewRoster(
      Buffer.from(await b.xlsx.writeBuffer()),
      'xlsx',
      '合成.xlsx',
      input,
    );
    expect(p.canConfirm).toBe(true);
    expect(p.rows[0]!.profile?.birthDate).toBe('2010-09-01');
  },
);

test.each([false, true])('Excel numeric date serial respects date1904=%s', async (date1904) => {
  const { w, input } = setup(),
    b = new ExcelJS.Workbook(),
    s = b.addWorksheet('名单');
  b.properties.date1904 = date1904;
  s.addRows([
    ['学号', '姓名', '出生日期', '是否住校'],
    [1, '合成甲', date1904 ? 38960 : 40422, false],
  ]);
  const p = await w.previewRoster(
    Buffer.from(await b.xlsx.writeBuffer()),
    'xlsx',
    '合成.xlsx',
    input,
  );
  expect(p.canConfirm).toBe(true);
  expect(p.rows[0]!.profile).toMatchObject({ birthDate: '2010-09-01', boarding: 'no' });
});

test('roster compatibility does not accept cached formulas in score columns', async () => {
  const { w, input } = setup(),
    b = new ExcelJS.Workbook(),
    s = b.addWorksheet('成绩');
  s.addRows([
    ['学号', '姓名', '数学'],
    [1, { richText: [{ text: '合成甲' }] }, { formula: '50+50', result: 100 }],
  ]);
  const p = await w.classData.select(
    [{ bytes: Buffer.from(await b.xlsx.writeBuffer()), format: 'xlsx', fileName: '合成.xlsx' }],
    input,
  );
  expect(p.canConfirm).toBe(false);
  expect(p.rows[0]!.message).toContain('数学');
  expect(w.snapshot().students).toHaveLength(0);
});

test.each(['roster', 'shared'] as const)(
  '%s imports the school layout with cached all-zero birth-month placeholders',
  async (mode) => {
    const { w, input } = setup(),
      b = new ExcelJS.Workbook();
    await b.xlsx.load(Uint8Array.from(await file()).buffer);
    b.worksheets[0]!.getCell('D4').value = { formula: 'MID(E4,7,6)', result: '000000' };
    const bytes = Buffer.from(await b.xlsx.writeBuffer());
    const p =
      mode === 'roster'
        ? await w.previewRoster(bytes, 'xlsx', '合成.xlsx', input)
        : await w.classData.select([{ bytes, format: 'xlsx', fileName: '合成.xlsx' }], input);
    expect(p).toMatchObject({ added: 1, canConfirm: true });
    expect(p.rows[0]!.message).toContain('全零');
    expect(p.rows[0]!.message).toContain('公式');
    const saved =
      mode === 'roster'
        ? w.confirmRoster({ epoch: input.epoch, token: p.token })
        : w.classData.confirm({ epoch: input.epoch, token: p.token });
    expect(
      w.pupils.readProfile({ epoch: input.epoch, studentId: saved.snapshot.students[0]!.id })
        .content,
    ).toMatchObject({ ...profile, birthMonth: '' });
  },
);

test('all-zero placeholders do not clear an existing birth month; real invalid months still block', async () => {
  const { w, input } = setup();
  const p = await w.previewRoster(await file(), 'xlsx', '合成.xlsx', input);
  w.confirmRoster({ epoch: input.epoch, token: p.token });
  const changed = [...values];
  changed[3] = '000000';
  changed[11] = '13900000002';
  const update = await w.previewRoster(await file(changed), 'xlsx', '合成.xlsx', input);
  expect(update).toMatchObject({ updated: 1, canConfirm: true });
  w.confirmRoster({ epoch: input.epoch, token: update.token });
  expect(
    w.pupils.readProfile({ epoch: input.epoch, studentId: w.snapshot().students[0]!.id }).content,
  ).toMatchObject({ birthMonth: '2010-09', fatherPhone: '13900000002' });
  changed[3] = '201013';
  const invalid = await w.previewRoster(await file(changed), 'xlsx', '合成.xlsx', input);
  expect(invalid.canConfirm).toBe(false);
  expect(invalid.rows[0]!.message).toContain('出生年月');
});

test.each(['roster', 'shared'] as const)(
  '%s preserves school identity text of nonstandard length with a review notice',
  async (mode) => {
    const { w, root, input } = setup();
    const row = [...values];
    row[4] = '1101010000000000';
    row[10] = '家长未提供';
    const bytes = await file(row);
    const p =
      mode === 'roster'
        ? await w.previewRoster(bytes, 'xlsx', '合成.xlsx', input)
        : await w.classData.select([{ bytes, format: 'xlsx', fileName: '合成.xlsx' }], input);
    expect(p).toMatchObject({ added: 1, canConfirm: true });
    expect(p.rows[0]!.message).toContain('格式待核对');
    const saved =
      mode === 'roster'
        ? w.confirmRoster({ epoch: input.epoch, token: p.token })
        : w.classData.confirm({ epoch: input.epoch, token: p.token });
    expect(
      w.pupils.readProfile({ epoch: input.epoch, studentId: saved.snapshot.students[0]!.id })
        .content,
    ).toMatchObject({ idCard: row[4], fatherIdCard: row[10] });
    w.close();
    workspaces.splice(workspaces.indexOf(w), 1);
    const reopened = new Workspace(root);
    workspaces.push(reopened);
    expect(
      reopened.pupils.readProfile({ epoch: input.epoch, studentId: saved.snapshot.students[0]!.id })
        .content.idCard,
    ).toBe(row[4]);
  },
);
