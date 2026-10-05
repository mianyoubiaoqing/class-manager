import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { expect, test } from 'vitest';
import { createScoreTemplate, previewScoreImport } from '../src/core/score-import';
import { readScoreTable } from '../src/core/score-table';
import { SCORE_FILE_LIMITS, type ScoreImportContext } from '../src/shared/score-import';
import { calculateScoreStatistics } from '../src/core/scores';

const subjectId = '00000000-0000-4000-8000-000000000001';
const groupId = '20000000-0000-4000-8000-000000000001';
function context(): ScoreImportContext {
  return {
    className: '合成一班',
    scoreBasis: 'raw',
    subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 }],
    groups: [{ id: groupId, name: '数学', subjectIds: [subjectId] }],
    roster: [1, 2, 3].map((index) => ({
      studentId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      groupId,
      studentNumber: String(index).padStart(4, '0'),
      displayName: `合成学生${index}`,
    })),
  };
}
const csv = (text: string) => Buffer.from(text, 'utf8');

async function xlsx(edit: (sheet: ExcelJS.Worksheet, book: ExcelJS.Workbook) => void) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('成绩');
  sheet.addRows([
    ['学生编号', '姓名', '数学'],
    ['0001', '合成学生1', 0],
    ['0002', '合成学生2', '缺考'],
  ]);
  edit(sheet, book);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test('CSV preview preserves identifiers and is usable by deterministic statistics without writing data', async () => {
  const scope = context();
  const before = structuredClone(scope);
  const preview = await previewScoreImport(
    csv('\uFEFF学生编号,姓名,数学\r\n0001,合成学生1,0\r\n0002,合成学生2,缺考\r\n'),
    'csv',
    scope,
  );
  expect(preview.canConfirm).toBe(true);
  expect(preview.rows.map((row) => row.studentNumber)).toEqual(['0001', '0002']);
  expect(preview.entries.map((entry) => entry.score)).toEqual([
    { status: 'valid', hundredths: 0 },
    { status: 'absent' },
  ]);
  expect(preview.missingStudentIds).toEqual([scope.roster[2]!.studentId]);
  expect(preview.fileHash).toMatch(/^[a-f0-9]{64}$/);
  const stats = calculateScoreStatistics({
    subjects: scope.subjects,
    groups: scope.groups,
    roster: scope.roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
    entries: preview.entries,
  });
  expect(stats.subjects[0]).toMatchObject({ mean: '0.00', missingCount: 1, absentCount: 1 });
  expect(scope).toEqual(before);
});

test('XLSX has the same state semantics and rejects numeric identifiers instead of losing leading zeros', async () => {
  const preview = await previewScoreImport(await xlsx(() => {}), 'xlsx', context());
  expect(preview.canConfirm).toBe(true);
  expect(preview.entries[0]?.score).toEqual({ status: 'valid', hundredths: 0 });
  const numeric = await previewScoreImport(
    await xlsx((sheet) => {
      sheet.getCell('A2').value = 1;
      sheet.getCell('A2').numFmt = '0000';
    }),
    'xlsx',
    context(),
  );
  expect(numeric.canConfirm).toBe(false);
  expect(numeric.rows[0]?.issues).toContainEqual(
    expect.objectContaining({ row: 2, column: 1, code: 'SCORE_STUDENT_NUMBER' }),
  );
  expect(numeric.entries).toEqual([]);
});

test('duplicate rows block both records unless the teacher explicitly excludes one with a reason', async () => {
  const file = csv('学生编号,姓名,数学\n0001,合成学生1,99\n0001,合成学生1,100\n');
  const preview = await previewScoreImport(file, 'csv', context());
  expect(preview.canConfirm).toBe(false);
  expect(
    preview.rows.every((row) => row.issues.some((issue) => issue.code === 'SCORE_DUPLICATE_ROW')),
  ).toBe(true);
  const excluded = await previewScoreImport(file, 'csv', {
    ...context(),
    exclusions: [{ row: 2, reason: '教师选择保留第三行的更正成绩' }],
  });
  expect(excluded.canConfirm).toBe(true);
  expect(excluded.rows[0]).toMatchObject({
    excluded: true,
    exclusionReason: '教师选择保留第三行的更正成绩',
  });
  expect(excluded.entries[0]?.score).toEqual({ status: 'valid', hundredths: 10000 });
});

test('name and class conflicts keep their original row and column positions', async () => {
  const preview = await previewScoreImport(
    csv('学生编号,姓名,班级,数学\n0001,错误姓名,其他班,99\n0002,合成学生2,合成一班,151'),
    'csv',
    context(),
  );
  expect(preview.canConfirm).toBe(false);
  expect(preview.rows[0]?.issues.map((issue) => [issue.row, issue.column, issue.code])).toEqual([
    [2, 2, 'SCORE_NAME_CONFLICT'],
    [2, 3, 'SCORE_CLASS'],
  ]);
  expect(preview.rows[1]?.issues[0]).toMatchObject({ row: 3, column: 4, code: 'SCORE_VALUE' });
  expect(preview.entries).toEqual([]);
});

test('aliases require explicit mapping and transformed-score headers are still blocked', async () => {
  const file = csv('学生编号,数学原始分\n0001,100');
  expect((await previewScoreImport(file, 'csv', context())).canConfirm).toBe(false);
  expect(
    (
      await previewScoreImport(file, 'csv', {
        ...context(),
        columnMappings: [{ header: '数学原始分', subjectId }],
      })
    ).canConfirm,
  ).toBe(true);
  const converted = await previewScoreImport(csv('学生编号,数学赋分\n0001,100'), 'csv', {
    ...context(),
    columnMappings: [{ header: '数学赋分', subjectId }],
  });
  expect(converted.canConfirm).toBe(false);
  expect(converted.issues.some((issue) => issue.code === 'SCORE_BASIS')).toBe(true);
});

test('the original-score confirmation and missing columns cannot be bypassed by excluding rows', async () => {
  const scope = { ...context(), scoreBasis: 'unknown' as const };
  expect((await previewScoreImport(csv('学生编号,数学\n0001,99'), 'csv', scope)).canConfirm).toBe(
    false,
  );
  const preview = await previewScoreImport(csv('学生编号,姓名\n0001,合成学生1'), 'csv', {
    ...context(),
    exclusions: [{ row: 2, reason: '排除行不能修正错误表头' }],
  });
  expect(preview.canConfirm).toBe(false);
  expect(preview.issues.some((issue) => issue.code === 'SCORE_MISSING_COLUMN')).toBe(true);
});

test('formula cells cannot use their cached numeric result as a score', async () => {
  const preview = await previewScoreImport(
    await xlsx((sheet) => {
      sheet.getCell('C2').value = { formula: '100+1', result: 101 };
    }),
    'xlsx',
    context(),
  );
  expect(preview.canConfirm).toBe(false);
  expect(preview.rows[0]?.issues[0]).toMatchObject({ row: 2, column: 3, code: 'SCORE_CELL' });
});

test('external hyperlinks are rejected before spreadsheet parsing', async () => {
  await expect(
    previewScoreImport(
      await xlsx((sheet) => {
        sheet.getCell('B2').value = { text: '合成学生1', hyperlink: 'https://example.invalid/' };
      }),
      'xlsx',
      context(),
    ),
  ).rejects.toMatchObject({ code: 'SCORE_XLSX_UNSAFE' });
});

test.each(['multiple', 'merged', 'hidden', 'far-row', 'far-column'] as const)(
  'unsupported workbook shape is rejected without silently truncating: %s',
  async (shape) => {
    const bytes = await xlsx((sheet, book) => {
      if (shape === 'multiple') book.addWorksheet('其他');
      if (shape === 'merged') sheet.mergeCells('B2:C2');
      if (shape === 'hidden') sheet.getRow(2).hidden = true;
      if (shape === 'far-row') sheet.getCell('A10002').value = '0003';
      if (shape === 'far-column') sheet.getCell('X1').value = '多余列';
    });
    await expect(previewScoreImport(bytes, 'xlsx', context())).rejects.toThrow();
  },
);

test.each(['csv', 'xlsx'] as const)(
  'generated %s template round-trips text identifiers',
  async (format) => {
    const scope = context();
    const bytes = await createScoreTemplate(scope, format);
    const preview = await previewScoreImport(bytes, format, scope);
    expect(preview.canConfirm).toBe(true);
    expect(preview.rows.map((row) => row.studentNumber)).toEqual(['0001', '0002', '0003']);
    expect(preview.entries.every((entry) => entry.score.status === 'missing')).toBe(true);
  },
);

test('CSV template formula escaping preserves exact roster identities on reimport', async () => {
  const scope = context();
  scope.roster[0]!.studentNumber = '-0001';
  scope.roster[0]!.displayName = '=合成姓名';
  scope.roster[1]!.displayName = "'@原本带引号";
  scope.className = '+合成班';
  scope.subjects[0]!.name = '@自定义科目';
  const bytes = await createScoreTemplate(scope, 'csv');
  expect(bytes.toString('utf8')).toContain('"\'=合成姓名"');
  const preview = await previewScoreImport(bytes, 'csv', scope);
  expect(preview.canConfirm).toBe(true);
  expect(preview.rows[0]).toMatchObject({ studentNumber: '-0001', displayName: '=合成姓名' });
  expect(preview.rows[1]?.displayName).toBe("'@原本带引号");
});

test('XLSX literal identity strings are not treated as formula objects', async () => {
  const scope = context();
  scope.roster[0]!.displayName = '=合成姓名';
  scope.className = '+合成班';
  scope.subjects[0]!.name = '@自定义科目';
  const preview = await previewScoreImport(await createScoreTemplate(scope, 'xlsx'), 'xlsx', scope);
  expect(preview.canConfirm).toBe(true);
  expect(preview.rows[0]?.displayName).toBe('=合成姓名');
});

test.each(['merge', 'columns', 'duplicate-cell', 'wrong-row', 'duplicate-row'] as const)(
  'XLSX preflight rejects dangerous ranges and ambiguous coordinates: %s',
  async (failure) => {
    const zip = await JSZip.loadAsync(await xlsx(() => {}));
    const path = 'xl/worksheets/sheet1.xml';
    let xml = await zip.file(path)!.async('string');
    if (failure === 'merge') {
      xml = xml.replace(
        '</worksheet>',
        '<mergeCells><mergeCell ref="A1:W1048576"/></mergeCells></worksheet>',
      );
    }
    if (failure === 'columns') {
      xml = xml.replace(
        '<sheetData>',
        '<cols><col min="1" max="1048576" width="10"/></cols><sheetData>',
      );
    }
    if (failure === 'duplicate-cell') {
      xml = xml.replace('<c r="C2"', '<c r="C2"><v>99</v></c><c r="C2"');
    }
    if (failure === 'wrong-row') xml = xml.replace('<c r="C2"', '<c r="C3"');
    if (failure === 'duplicate-row') xml = xml.replace('</sheetData>', '<row r="2"/></sheetData>');
    zip.file(path, xml);
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await expect(readScoreTable(bytes, 'xlsx')).rejects.toMatchObject({
      code:
        failure === 'merge'
          ? 'SCORE_XLSX_UNSAFE'
          : failure === 'columns'
            ? 'SCORE_FILE_LIMIT'
            : 'SCORE_XLSX_INVALID',
    });
  },
);

test('ZIP local and central directory paths must agree', async () => {
  const bytes = await xlsx(() => {});
  const path = Buffer.from('xl/worksheets/sheet1.xml');
  const position = bytes.indexOf(path);
  expect(position).toBeGreaterThan(0);
  Buffer.from('xl/worksheets/sheet2.xml').copy(bytes, position);
  await expect(readScoreTable(bytes, 'xlsx')).rejects.toMatchObject({ code: 'SCORE_XLSX_INVALID' });
});

test('CSV malformed quoting, invalid UTF-8 and byte/row limits fail closed', async () => {
  await expect(readScoreTable(csv('学生编号,数学\n"0001,20'), 'csv')).rejects.toMatchObject({
    code: 'SCORE_CSV_INVALID',
  });
  await expect(readScoreTable(Buffer.from([0xff, 0xfe, 0]), 'csv')).rejects.toMatchObject({
    code: 'SCORE_FILE_ENCODING',
  });
  await expect(
    readScoreTable(Buffer.alloc(SCORE_FILE_LIMITS.bytes + 1), 'csv'),
  ).rejects.toMatchObject({ code: 'SCORE_FILE_LIMIT' });
  await expect(
    readScoreTable(csv('学生编号,数学\n' + '0001,1\n'.repeat(SCORE_FILE_LIMITS.rows + 1)), 'csv'),
  ).rejects.toMatchObject({ code: 'SCORE_FILE_LIMIT' });
});

test.each(['DTD', 'deep-XML', 'expanded-size', 'entry-count', 'macro'] as const)(
  'XLSX archive preflight rejects unsafe structure: %s',
  async (failure) => {
    const zip = await JSZip.loadAsync(await xlsx(() => {}));
    if (failure === 'DTD') {
      zip.file('xl/extra.xml', '<!DOCTYPE x [<!ENTITY value "data">]><x>&value;</x>');
    }
    if (failure === 'deep-XML') {
      zip.file('xl/extra.xml', '<x>'.repeat(129) + '</x>'.repeat(129));
    }
    if (failure === 'expanded-size') {
      zip.file('xl/extra.xml', `<x>${'a'.repeat(SCORE_FILE_LIMITS.entryBytes)}</x>`);
    }
    if (failure === 'entry-count') {
      for (let index = 0; index < SCORE_FILE_LIMITS.zipEntries; index++) {
        zip.file(`extra/${index}.xml`, '<x/>');
      }
    }
    if (failure === 'macro') zip.file('xl/vbaProject.bin', 'synthetic macro bytes');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await expect(previewScoreImport(bytes, 'xlsx', context())).rejects.toMatchObject({
      code: failure === 'DTD' || failure === 'macro' ? 'SCORE_XLSX_UNSAFE' : 'SCORE_FILE_LIMIT',
    });
  },
);

test('a 10000-student, 20-subject CSV is processed completely at the supported limits', async () => {
  const scope = context();
  scope.subjects = Array.from({ length: 20 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `科目${index + 1}`,
    maxScore: '150',
    precision: 2,
  }));
  scope.groups[0]!.subjectIds = scope.subjects.map((subject) => subject.id);
  scope.roster = Array.from({ length: 10000 }, (_, index) => ({
    studentId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    groupId,
    studentNumber: String(index + 1).padStart(5, '0'),
    displayName: `合成学生${index + 1}`,
  }));
  const bytes = csv(
    ['学生编号', ...scope.subjects.map((subject) => subject.name)].join(',') +
      '\n' +
      scope.roster
        .map((student) => `${student.studentNumber},${Array(20).fill('99.99').join(',')}`)
        .join('\n'),
  );
  const started = performance.now();
  const preview = await previewScoreImport(bytes, 'csv', scope);
  expect(preview.canConfirm).toBe(true);
  expect(preview.rows).toHaveLength(10000);
  expect(preview.entries).toHaveLength(200000);
  expect(preview.missingStudentIds).toEqual([]);
  console.info(
    `Synthetic 10000-row/20-subject CSV: ${bytes.length} bytes, ${Math.round(performance.now() - started)}ms`,
  );
});

test('missing identity header produces a header error, never a column zero diagnostic', async () => {
  const preview = await previewScoreImport(csv('姓名,数学\n合成学生1,100'), 'csv', context());
  expect(preview.canConfirm).toBe(false);
  expect(
    [...preview.issues, ...preview.rows.flatMap((row) => row.issues)].every(
      (issue) => issue.column === null || issue.column >= 1,
    ),
  ).toBe(true);
});
