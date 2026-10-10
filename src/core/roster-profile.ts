import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { profileContent, profileRecord, type StudentProfile } from '../shared/pupils';
import { schoolRosterHeaders, schoolRosterUniqueHeaders } from '../shared/roster-fields';
import type { ScoreTable } from './score-table';
import { DomainError } from './errors';
import { pupilHash } from './pupil-records';

export const rosterProfileColumns: Record<string, keyof StudentProfile['content']> = {
  性别: 'gender',
  出生年月: 'birthMonth',
  出生日期: 'birthDate',
  身份证号: 'idCard',
  学生身份证号: 'idCard',
  学籍号: 'studentRegistration',
  考籍号: 'examRegistration',
  报考序号: 'applicationNumber',
  学生联系电话: 'studentPhone',
  联系电话: 'studentPhone',
  父亲姓名: 'fatherName',
  父亲身份证号码: 'fatherIdCard',
  父亲联系电话: 'fatherPhone',
  母亲姓名: 'motherName',
  母亲身份证号码: 'motherIdCard',
  母亲联系电话: 'motherPhone',
  '家庭详细住址（具体到门牌号）': 'address',
  家庭住址: 'address',
  是否住校: 'boarding',
  是否贫困生及类型: 'povertyStatus',
  家长姓名: 'guardianName',
  家长电话: 'guardianPhone',
};
export function rosterHeaders(headers: string[]): string[] {
  const normalized = headers.map((h) =>
    h.replace(/\s/gu, '').replace(/[()]/gu, (p) => (p === '(' ? '（' : '）')),
  );
  if (
    normalized.length === schoolRosterHeaders.length &&
    normalized.every((h, i) => h === schoolRosterHeaders[i])
  )
    return [...schoolRosterUniqueHeaders];
  // Parent columns in school forms repeat “身份证号码/联系电话”. Use explicit
  // parent-name anchors rather than guessing from the position of a duplicate.
  let parent = '';
  return normalized.map((header) => {
    if (header === '父亲姓名') parent = '父亲';
    else if (header === '母亲姓名') parent = '母亲';
    else if (!['身份证号码', '联系电话'].includes(header)) parent = '';
    if (parent && ['身份证号码', '联系电话'].includes(header)) return parent + header;
    return header === '身份证号码' ? '身份证号' : header;
  });
}
export function importedProfile(headers: string[], cells: ScoreTable[number]) {
  const patch: Partial<StudentProfile['content']> = {};
  const seen = new Set<string>();
  for (const [i, header] of headers.entries()) {
    const key = rosterProfileColumns[header];
    if (!key) continue;
    if (seen.has(key))
      throw new DomainError('VALIDATION', `${header}对应资料字段重复，请核对表头。`);
    seen.add(key);
    const value = cells[i]?.value;
    if (value == null || value === '') continue;
    let text = String(value).trim();
    if (!text) continue;
    if (
      typeof value === 'number' &&
      (!Number.isSafeInteger(value) || String(Math.abs(value)).length > 15)
    )
      throw new DomainError(
        'VALIDATION',
        `${header}请保存为文本，避免长编号精度丢失或前导零丢失。`,
      );
    if (key === 'gender') {
      const gender = { 男: 'male', 女: 'female', 未填写: 'unspecified', 其他: 'other' }[text];
      if (!gender) throw new DomainError('VALIDATION', '性别请填写男、女、其他或留空。');
      text = gender;
    }
    if (key === 'boarding') {
      const boarding: Record<string, string> = {
        是: 'yes',
        否: 'no',
        住校: 'yes',
        不住校: 'no',
        '1': 'yes',
        '0': 'no',
        住宿: 'yes',
        寄宿: 'yes',
        住校生: 'yes',
        住宿生: 'yes',
        走读: 'no',
        走读生: 'no',
        不住宿: 'no',
        '√': 'yes',
        '✓': 'yes',
        '✔': 'yes',
        '×': 'no',
        '✗': 'no',
        '✘': 'no',
        yes: 'yes',
        no: 'no',
        true: 'yes',
        false: 'no',
      };
      const resolved = boarding[text.toLowerCase()];
      if (!resolved)
        throw new DomainError(
          'VALIDATION',
          `是否住校“${text}”含义不明确，请填写是/否、住校/走读、√/×或留空。`,
        );
      text = resolved;
    }
    if (key === 'birthMonth' || key === 'birthDate') {
      const match =
        /^(\d{4})(?:[./-](\d{1,2})(?:[./-](\d{1,2}))?|年(\d{1,2})月(?:(\d{1,2})日?)?|(\d{2})(\d{2})?)$/u.exec(
          text,
        );
      const month = match?.[2] ?? match?.[4] ?? match?.[6];
      const day = match?.[3] ?? match?.[5] ?? match?.[7];
      if (!match || !month || (key === 'birthDate' && !day))
        throw new DomainError(
          'VALIDATION',
          `${header}请填写年在前的日期，例如 2010-09${key === 'birthDate' ? '-01' : ''}。`,
        );
      text = `${match[1]}-${month.padStart(2, '0')}${key === 'birthDate' ? '-' + day!.padStart(2, '0') : ''}`;
      // Validate an optional day even when importing only a birth month.
      if (
        day &&
        !profileContent.shape.birthDate.safeParse(
          `${match[1]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
        ).success
      )
        throw new DomainError('VALIDATION', `${header}不是有效日期，请核对。`);
    }
    const result = profileContent.shape[key].safeParse(text);
    if (!result.success)
      throw new DomainError('VALIDATION', `${header}：${result.error.issues[0]!.message}`);
    Object.assign(patch, { [key]: result.data });
  }
  return patch;
}
export function planImportedProfile(
  db: DatabaseSync,
  studentId: string,
  patch: Partial<StudentProfile['content']>,
): StudentProfile | null {
  if (!Object.keys(patch).length) return null;
  const row = db.prepare('SELECT payload FROM student_profiles WHERE id=?').get(studentId);
  const old = row ? profileRecord.parse(JSON.parse(String(row.payload))) : null;
  const content = profileContent.parse({ ...(old?.content ?? {}), ...patch });
  if (old && JSON.stringify(content) === JSON.stringify(old.content)) return null;
  return profileRecord.parse({
    id: studentId,
    studentId,
    revision: (old?.revision ?? 0) + 1,
    content,
    updatedAt: new Date(Math.max(Date.now(), Date.parse(old?.updatedAt ?? '') || 0)).toISOString(),
  });
}
/** Called inside the owning roster/exam transaction: profile and revision history are atomic. */
export function writeImportedProfile(db: DatabaseSync, record: StudentProfile) {
  const current = db.prepare('SELECT revision FROM student_profiles WHERE id=?').get(record.id);
  if (Number(current?.revision ?? 0) !== record.revision - 1)
    throw new DomainError('CONFLICT', '学生档案已变化，请重新预览后导入。');
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM student_profile_revisions').get()?.n) >= 20000)
    throw new DomainError('STORAGE_LIMIT', '学生档案历史容量已达上限，请先备份。');
  const payload = JSON.stringify(record);
  db.prepare(
    'INSERT INTO student_profiles VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',
  ).run(record.id, record.revision, payload);
  db.prepare('INSERT INTO student_profile_revisions VALUES (?,?,?,?,?,?,?)').run(
    record.id,
    record.revision,
    randomUUID(),
    pupilHash(record),
    '花名册字段导入，教师核对后确认',
    record.updatedAt,
    payload,
  );
}
