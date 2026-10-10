import ExcelJS from 'exceljs';
import { parse, CsvError } from 'csv-parse/sync';
import { DomainError } from './errors';
import { inspectScoreWorkbook } from './score-workbook-guard';
import { SCORE_FILE_LIMITS } from '../shared/score-import';
import { rosterCell } from './roster-cell';
import { rosterHeaders, rosterProfileColumns } from './roster-profile';

export interface ScoreCell {
  value: string | number | null;
  problem?: string;
  numberFormat?: string;
  notice?: string;
}
export type ScoreTable = ScoreCell[][];

function cell(value: unknown): ScoreCell {
  if (value === null || value === undefined) return { value: null };
  if (typeof value === 'number' && Number.isFinite(value)) return { value };
  if (typeof value === 'string') {
    if (value.length > SCORE_FILE_LIMITS.cellCharacters) {
      return { value: null, problem: '单元格超过 512 字符，请缩短内容。' };
    }
    return { value };
  }
  return { value: null, problem: '不接受公式、链接、日期、错误值或其他复杂单元格。' };
}

function validateTableSize(rows: number, columns: number): void {
  if (rows > SCORE_FILE_LIMITS.rows + 1 || columns > SCORE_FILE_LIMITS.columns) {
    throw new DomainError('SCORE_FILE_LIMIT', '成绩表超过 10000 行数据或 23 列，未截断导入。');
  }
}

function csvTable(bytes: Uint8Array): ScoreTable {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError('SCORE_FILE_ENCODING', 'CSV 必须保存为 UTF-8 编码。');
  }
  try {
    const rows = parse(text, {
      bom: true,
      cast: false,
      skip_empty_lines: false,
      relax_column_count: true,
      max_record_size: SCORE_FILE_LIMITS.columns * (SCORE_FILE_LIMITS.cellCharacters + 4),
      on_record: (record: string[], info) => {
        validateTableSize(info.records, record.length);
        return record;
      },
    });
    validateTableSize(rows.length, Math.max(0, ...rows.map((row) => row.length)));
    return rows.map((row) => row.map(cell));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof CsvError) {
      throw new DomainError(
        'SCORE_CSV_INVALID',
        `CSV 第 ${error.lines ?? '?'} 行格式错误或内容过长，请检查引号与分隔符。`,
      );
    }
    throw new DomainError('SCORE_CSV_INVALID', 'CSV 无法解析，请使用标准模板。');
  }
}

export async function readScoreTable(
  bytes: Uint8Array,
  format: 'csv' | 'xlsx',
): Promise<ScoreTable> {
  const tables = await readClassDataTables(bytes, format);
  if (tables.length !== 1) {
    throw new DomainError('SCORE_WORKSHEETS', '请仅保留一张成绩工作表，不能自动猜测导入范围。');
  }
  return tables[0]!.table;
}

/** Multiple worksheets are exposed for explicit selection in the shared class import. */
export async function readClassDataTables(
  bytes: Uint8Array,
  format: 'csv' | 'xlsx',
  allowRosterLayout = false,
): Promise<Array<{ name: string; table: ScoreTable; rowOffset: number }>> {
  if (bytes.byteLength === 0 || bytes.byteLength > SCORE_FILE_LIMITS.bytes) {
    throw new DomainError('SCORE_FILE_LIMIT', '成绩文件为空或超过 5 MiB，未导入任何数据。');
  }
  if (format === 'csv') return [{ name: 'CSV', table: csvTable(bytes), rowOffset: 0 }];
  if (format !== 'xlsx') throw new DomainError('SCORE_FILE_TYPE', '只接受 XLSX 或 UTF-8 CSV。');
  await inspectScoreWorkbook(Buffer.from(bytes), allowRosterLayout);
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    if (!workbook.worksheets.length || workbook.worksheets.length > 10)
      throw new DomainError('SCORE_WORKSHEETS', '工作簿需包含 1–10 张工作表。');
    const tables: Array<{ name: string; table: ScoreTable; rowOffset: number }> = [];
    for (const sheet of workbook.worksheets) {
      if (sheet.state !== 'visible') {
        throw new DomainError('SCORE_WORKSHEETS', '成绩工作表必须可见。');
      }
      validateTableSize(sheet.rowCount, sheet.columnCount);
      let headerRow = 1;
      if (allowRosterLayout) {
        for (let i = 1; i <= Math.min(10, sheet.rowCount); i++) {
          if (
            Array.from(
              { length: sheet.columnCount },
              (_, j) => rosterCell(sheet.getRow(i).getCell(j + 1).value, 'text').value,
            ).some(
              (v) => typeof v === 'string' && ['姓名', '学生姓名'].includes(v.replace(/\s/gu, '')),
            )
          ) {
            headerRow = i;
            break;
          }
        }
      }
      const headerValues = Array.from(
        { length: sheet.columnCount },
        (_, j) => rosterCell(sheet.getRow(headerRow).getCell(j + 1).value, 'text').value,
      );
      const headers = rosterHeaders(headerValues.map((v) => String(v ?? '').trim()));
      const schoolRoster =
        allowRosterLayout &&
        headers.some((v) => v === '学籍号' || v === '父亲姓名' || v === '出生年月');
      let lastDataRow = headerRow;
      for (let i = headerRow + 1; i <= sheet.rowCount; i++)
        if (
          Array.from(
            { length: sheet.columnCount },
            (_, j) => sheet.getRow(i).getCell(j + 1).value,
          ).some((v) => v !== null)
        )
          lastDataRow = i;
      const rows: ScoreTable = [];
      for (let rowIndex = 1; rowIndex <= sheet.rowCount; rowIndex++) {
        const row = sheet.getRow(rowIndex);
        if (row.hidden) {
          throw new DomainError('SCORE_HIDDEN_ROWS', `第 ${rowIndex} 行被隐藏，请先取消隐藏。`);
        }
        const values: ScoreCell[] = [];
        for (let column = 1; column <= sheet.columnCount; column++) {
          if (sheet.getColumn(column).hidden) {
            throw new DomainError('SCORE_HIDDEN_COLUMNS', `第 ${column} 列被隐藏，请先取消隐藏。`);
          }
          const current = row.getCell(column);
          if (
            current.isMerged &&
            !(schoolRoster && (rowIndex < headerRow || rowIndex > lastDataRow))
          ) {
            throw new DomainError(
              'SCORE_MERGED',
              `第 ${rowIndex} 行存在合并单元格，请使用单行表头。`,
            );
          }
          const header = headers[column - 1] ?? '';
          const profileKey = rosterProfileColumns[header];
          const rosterField =
            profileKey || ['学生编号', '学号', '编号', '姓名', '学生姓名', '班级'].includes(header);
          const kind =
            profileKey === 'birthDate' || profileKey === 'birthMonth'
              ? 'date'
              : profileKey === 'boarding'
                ? 'boarding'
                : /IdCard|^idCard$|Registration|Number|Phone/u.test(profileKey ?? '') ||
                    ['学生编号', '学号', '编号'].includes(header)
                  ? 'identifier'
                  : 'text';
          values.push({
            ...(allowRosterLayout && (rowIndex === headerRow || rosterField)
              ? rosterCell(
                  current.value,
                  rowIndex === headerRow ? 'text' : kind,
                  current.numFmt,
                  workbook.properties.date1904,
                )
              : cell(current.value)),
            ...(current.numFmt ? { numberFormat: current.numFmt } : {}),
          });
        }
        if (rowIndex >= headerRow) rows.push(values);
      }
      tables.push({ name: sheet.name, table: rows, rowOffset: headerRow - 1 });
    }
    return tables;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'SCORE_XLSX_INVALID',
      'XLSX 内容不受支持或已损坏，请重新保存为标准模板。',
    );
  }
}
