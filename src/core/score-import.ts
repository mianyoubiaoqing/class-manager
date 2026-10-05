import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  scoreImportContextSchema,
  type ImportIssue,
  type ScoreImportPreview,
  type ScoreImportRow,
} from '../shared/score-import';
import { calculateScoreStatistics, parseScoreCell } from './scores';
import { DomainError } from './errors';
import { readScoreTable } from './score-table';

const reservedHeaders = ['学生编号', '姓名', '班级'];

function contextFor(raw: unknown) {
  const context = scoreImportContextSchema.parse(raw);
  calculateScoreStatistics({
    subjects: context.subjects,
    groups: context.groups,
    roster: context.roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
    entries: [],
  });
  if (
    new Set(context.roster.map((student) => student.studentNumber)).size !== context.roster.length
  ) {
    throw new DomainError('SCORE_CONFIG', '应考名册中的学生编号重复，请先修正名册。');
  }
  if (context.subjects.some((subject) => reservedHeaders.includes(subject.name))) {
    throw new DomainError('SCORE_CONFIG', '科目名称不能与学生编号、姓名或班级列重名。');
  }
  return context;
}

/** Undo our CSV escape only when the exact unescaped identity is already known locally. */
function knownText(text: string, format: string, known: ReadonlySet<string>): string {
  if (format !== 'csv' || known.has(text)) return text;
  return /^'[=+\-@]/u.test(text) && known.has(text.slice(1)) ? text.slice(1) : text;
}

/** Pure preview: persistence must later confirm its token, roster epoch and score revision. */
export async function previewScoreImport(
  bytes: Uint8Array,
  format: 'csv' | 'xlsx',
  rawContext: unknown,
): Promise<ScoreImportPreview> {
  const context = contextFor(rawContext);
  const table = await readScoreTable(bytes, format);
  if (!table.length) throw new DomainError('SCORE_HEADER', '文件缺少表头。');
  let issueCount = 0;
  const issues: ImportIssue[] = [];
  const addIssue = (
    target: ImportIssue[],
    row: number,
    column: number | null,
    code: string,
    message: string,
  ) => {
    if (++issueCount > 2000) {
      throw new DomainError('SCORE_ERROR_LIMIT', '错误超过 2000 项，请先按标准模板整理文件。');
    }
    target.push({ row, column, code, message });
  };
  if (context.scoreBasis !== 'raw') {
    addIssue(issues, 0, null, 'SCORE_BASIS', '请确认原始分口径；本模板不接受赋分或等级分。');
  }
  const knownHeaders = new Set([
    ...reservedHeaders,
    ...context.subjects.map((subject) => subject.name),
    ...context.columnMappings.map((item) => item.header),
  ]);
  const headers = table[0]!.map((entry, index) => {
    if (entry.problem || typeof entry.value !== 'string' || !entry.value.trim()) {
      addIssue(issues, 1, index + 1, 'SCORE_HEADER', '表头必须是非空普通文本。');
    }
    return typeof entry.value === 'string'
      ? knownText(entry.value.trim(), format, knownHeaders)
      : '';
  });
  const mapping = new Map(context.columnMappings.map((item) => [item.header, item.subjectId]));
  if (mapping.size !== context.columnMappings.length) {
    throw new DomainError('SCORE_CONFIG', '同一表头不能配置多个映射。');
  }
  const subjectColumns = new Map<number, (typeof context.subjects)[number]>();
  const seenHeaders = new Set<string>();
  const mappedSubjects = new Set<string>();
  for (const [index, header] of headers.entries()) {
    if (seenHeaders.has(header)) {
      addIssue(issues, 1, index + 1, 'SCORE_HEADER_DUPLICATE', '表头重复。');
    }
    seenHeaders.add(header);
    if (/赋分|等级|转换分/u.test(header)) {
      addIssue(issues, 1, index + 1, 'SCORE_BASIS', '表头标记为转换成绩，不适用原始分模板。');
    }
    if (reservedHeaders.includes(header)) {
      if (mapping.has(header)) {
        addIssue(issues, 1, index + 1, 'SCORE_MAPPING', '身份列不能映射为科目。');
      }
      continue;
    }
    const subject = context.subjects.find((item) =>
      mapping.has(header) ? item.id === mapping.get(header) : item.name === header,
    );
    if (!subject) {
      addIssue(
        issues,
        1,
        index + 1,
        'SCORE_UNKNOWN_COLUMN',
        '未知列，请明确映射科目或使用标准模板。',
      );
    } else {
      if (mappedSubjects.has(subject.id)) {
        addIssue(issues, 1, index + 1, 'SCORE_MAPPING', '同一科目对应多个列。');
      }
      mappedSubjects.add(subject.id);
      subjectColumns.set(index, subject);
    }
  }
  for (const header of mapping.keys()) {
    if (!headers.includes(header)) {
      addIssue(issues, 1, null, 'SCORE_MAPPING', `已配置的表头“${header}”不存在。`);
    }
  }
  for (const subject of context.subjects) {
    if (!mappedSubjects.has(subject.id)) {
      addIssue(issues, 1, null, 'SCORE_MISSING_COLUMN', `缺少科目列：${subject.name}。`);
    }
  }
  const numberColumn = headers.indexOf('学生编号');
  const numberPosition = numberColumn < 0 ? null : numberColumn + 1;
  const nameColumn = headers.indexOf('姓名');
  const classColumn = headers.indexOf('班级');
  if (numberColumn < 0) addIssue(issues, 1, null, 'SCORE_HEADER', '缺少学生编号列。');
  const exclusions = new Map(context.exclusions.map((item) => [item.row, item.reason]));
  if (exclusions.size !== context.exclusions.length) {
    throw new DomainError('SCORE_CONFIG', '同一行不能重复配置排除原因。');
  }
  const students = new Map(context.roster.map((student) => [student.studentNumber, student]));
  const knownNumbers = new Set(students.keys());
  const rows: ScoreImportRow[] = [];
  for (let index = 1; index < table.length; index++) {
    const values = table[index]!;
    if (
      values.every(
        (item) =>
          !item.problem &&
          (item.value === null || (typeof item.value === 'string' && !item.value.trim())),
      )
    )
      continue;
    const rowNumber = index + 1;
    const rawNumber = values[numberColumn]?.value;
    const rawName = values[nameColumn]?.value;
    const studentNumber =
      typeof rawNumber === 'string'
        ? knownText(rawNumber.trim().toUpperCase(), format, knownNumbers)
        : '';
    const student = students.get(studentNumber);
    const displayName =
      typeof rawName === 'string'
        ? knownText(rawName.trim(), format, new Set(student ? [student.displayName] : []))
        : '';
    const row: ScoreImportRow = {
      row: rowNumber,
      studentId: student?.studentId ?? null,
      studentNumber,
      displayName,
      excluded: exclusions.has(rowNumber),
      exclusionReason: exclusions.get(rowNumber) ?? null,
      issues: [],
      scores: [],
    };
    rows.push(row);
    if (values.length !== headers.length) {
      addIssue(row.issues, rowNumber, null, 'SCORE_COLUMNS', '本行列数与表头不一致。');
    }
    for (const [column, entry] of values.entries()) {
      if (entry.problem) addIssue(row.issues, rowNumber, column + 1, 'SCORE_CELL', entry.problem);
    }
    if (!/^[A-Z0-9_-]{1,32}$/.test(studentNumber)) {
      addIssue(
        row.issues,
        rowNumber,
        numberPosition,
        'SCORE_STUDENT_NUMBER',
        '学生编号必须是文本，保留前导零。',
      );
    } else if (!student) {
      addIssue(
        row.issues,
        rowNumber,
        numberPosition,
        'SCORE_STUDENT_UNKNOWN',
        '编号不在本次应考名册中。',
      );
    }
    if (
      rawName !== null &&
      rawName !== undefined &&
      rawName !== '' &&
      typeof rawName !== 'string'
    ) {
      addIssue(row.issues, rowNumber, nameColumn + 1, 'SCORE_NAME', '姓名必须为文本。');
    } else if (student && displayName && displayName !== student.displayName) {
      addIssue(
        row.issues,
        rowNumber,
        nameColumn + 1,
        'SCORE_NAME_CONFLICT',
        '编号与名册姓名不一致。',
      );
    }
    const className = values[classColumn]?.value;
    if (
      classColumn >= 0 &&
      className !== null &&
      className !== undefined &&
      className !== '' &&
      (typeof className !== 'string' ||
        knownText(className.trim(), format, new Set([context.className])) !== context.className)
    ) {
      addIssue(row.issues, rowNumber, classColumn + 1, 'SCORE_CLASS', '班级与当前导入范围不一致。');
    }
    for (const [column, subject] of subjectColumns) {
      if (values[column]?.problem) continue;
      try {
        row.scores.push({
          subjectId: subject.id,
          score: parseScoreCell(values[column]?.value, subject),
        });
      } catch (error) {
        addIssue(
          row.issues,
          rowNumber,
          column + 1,
          'SCORE_VALUE',
          error instanceof DomainError ? error.message : '成绩不符合科目配置。',
        );
      }
    }
  }
  const importedRows = new Set(rows.map((row) => row.row));
  for (const row of exclusions.keys()) {
    if (!importedRows.has(row)) {
      addIssue(issues, row, null, 'SCORE_EXCLUSION', '待排除行不存在或是空行。');
    }
  }
  const byNumber = new Map<string, ScoreImportRow[]>();
  for (const row of rows.filter((item) => !item.excluded && item.studentNumber)) {
    const matches = byNumber.get(row.studentNumber) ?? [];
    matches.push(row);
    byNumber.set(row.studentNumber, matches);
  }
  for (const matches of byNumber.values()) {
    if (matches.length > 1) {
      for (const row of matches) {
        addIssue(
          row.issues,
          row.row,
          numberPosition,
          'SCORE_DUPLICATE_ROW',
          '同一学生重复出现，请明确排除多余行。',
        );
      }
    }
  }
  const accepted = rows.filter((row) => !row.excluded && !row.issues.length && row.studentId);
  const includedStudents = new Set(accepted.map((row) => row.studentId));
  const canConfirm =
    issues.length === 0 &&
    accepted.length > 0 &&
    rows.every((row) => row.excluded || row.issues.length === 0);
  return {
    fileHash: createHash('sha256').update(bytes).digest('hex'),
    format,
    headers,
    issues,
    rows,
    missingStudentIds: context.roster
      .filter((student) => !includedStudents.has(student.studentId))
      .map((student) => student.studentId),
    canConfirm,
    entries: canConfirm
      ? accepted.flatMap((row) =>
          row.scores.map((score) => ({ studentId: row.studentId!, ...score })),
        )
      : [],
  };
}

function csvField(value: string): string {
  // Only identity fields use this escape; score columns in templates are deliberately empty.
  const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function createScoreTemplate(
  rawContext: unknown,
  format: 'csv' | 'xlsx',
): Promise<Buffer> {
  const context = contextFor(rawContext);
  const rows = [
    ['学生编号', '姓名', '班级', ...context.subjects.map((subject) => subject.name)],
    ...context.roster.map((student) => [
      student.studentNumber,
      student.displayName,
      context.className,
      ...context.subjects.map(() => ''),
    ]),
  ];
  if (format === 'csv') {
    return Buffer.from(
      `\uFEFF${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`,
      'utf8',
    );
  }
  if (format !== 'xlsx') throw new DomainError('SCORE_FILE_TYPE', '模板仅支持 CSV/XLSX。');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('成绩');
  worksheet.addRows(rows);
  worksheet.getRow(1).font = { bold: true };
  worksheet.getColumn(1).numFmt = '@';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
