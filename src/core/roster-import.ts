import ExcelJS from 'exceljs';
import { readScoreTable } from './score-table';
import { studentInput, type Snapshot } from '../shared/contracts';
import type { RosterImportRow } from '../shared/roster-import';

export async function parseRosterImport(
  bytes: Uint8Array,
  format: 'csv' | 'xlsx',
  snapshot: Snapshot,
  classId: string,
) {
  const table = await readScoreTable(bytes, format);
  const headers =
    table[0]?.map((c) => (typeof c.value === 'string' && !c.problem ? c.value.trim() : '')) ?? [];
  const issues: string[] = [];
  const numberColumns = headers
    .map((h, i) => (['学生编号', '学号', '编号'].includes(h) ? i : -1))
    .filter((i) => i >= 0);
  const nameColumns = headers
    .map((h, i) => (['姓名', '学生姓名'].includes(h) ? i : -1))
    .filter((i) => i >= 0);
  if (numberColumns.length !== 1 || nameColumns.length !== 1)
    issues.push('表头须包含一列“学生编号”（或“学号”）和一列“姓名”，不能重复。');
  if (headers.some((h, i) => !h || headers.indexOf(h) !== i))
    issues.push('表头为空或重复，请整理后重新选择文件。');
  const numberCol = numberColumns[0] ?? -1,
    nameCol = nameColumns[0] ?? -1;
  const classCol = headers.indexOf('班级');
  const classroom = snapshot.classes.find((c) => c.id === classId);
  const existing = new Map(snapshot.students.map((s) => [s.studentNumber, s]));
  const rows: RosterImportRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    if (cells.every((c) => !c.problem && (c.value === null || c.value === ''))) continue;
    const number = cells[numberCol]?.value,
      name = cells[nameCol]?.value;
    const studentNumber = typeof number === 'string' ? number.trim().toUpperCase() : '';
    const displayName = typeof name === 'string' ? name.trim() : '';
    const row: RosterImportRow = {
      row: i + 1,
      studentNumber,
      displayName,
      status: 'new',
      message: '新增学生',
    };
    const problems = cells.filter((c) => c.problem).map((c) => c.problem!);
    if (typeof number !== 'string')
      problems.push('学生编号须为文本；请将 Excel 编号列设为文本，保留前导零。');
    if (
      !studentInput.safeParse({ epoch: snapshot.epoch, classId, studentNumber, displayName })
        .success
    )
      problems.push('编号需为 1–32 位字母、数字、下划线或连字符；姓名需为 1–60 字。');
    if (cells.length !== headers.length) problems.push('本行列数与表头不一致。');
    const className = cells[classCol]?.value;
    if (classCol >= 0 && className !== null && className !== '' && className !== classroom?.name)
      problems.push('文件班级与所选班级不一致。');
    const old = existing.get(studentNumber);
    if (old) {
      if (old.active && old.classId === classId && old.displayName === displayName) {
        row.status = 'skip';
        row.message = '本班已有同编号、同姓名的在籍学生，跳过';
      } else problems.push('编号已被其他学生、班级或停用记录使用，请先核对名册。');
    }
    if (problems.length) {
      row.status = 'error';
      row.message = [...new Set(problems)].join(' ');
    }
    rows.push(row);
  }
  const duplicates = new Map<string, RosterImportRow[]>();
  for (const row of rows)
    if (row.studentNumber)
      duplicates.set(row.studentNumber, [...(duplicates.get(row.studentNumber) ?? []), row]);
  for (const group of duplicates.values())
    if (group.length > 1)
      for (const row of group) {
        row.status = 'error';
        row.message = '文件内编号重复，请删除多余行后重新导入。';
      }
  if (!rows.length) issues.push('文件没有学生数据。');
  const added = rows.filter((r) => r.status === 'new').length;
  if (snapshot.students.length + added > 10000) issues.push('导入后学生总数超过 10000 人。');
  return {
    rows,
    issues,
    added,
    skipped: rows.filter((r) => r.status === 'skip').length,
    canConfirm: !issues.length && !rows.some((r) => r.status === 'error') && added > 0,
  };
}

export async function createRosterTemplate(format: 'csv' | 'xlsx'): Promise<Buffer> {
  if (format === 'csv') return Buffer.from('\uFEFF学生编号,姓名\r\n', 'utf8');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('班级名册');
  sheet.columns = [
    { header: '学生编号', key: 'number', width: 24, style: { numFmt: '@' } },
    { header: '姓名', key: 'name', width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
