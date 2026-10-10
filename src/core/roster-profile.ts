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
  return headers.length === schoolRosterHeaders.length &&
    headers.every((h, i) => h === schoolRosterHeaders[i])
    ? [...schoolRosterUniqueHeaders]
    : headers;
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
      (!Number.isSafeInteger(value) || /IdCard|^idCard$|Registration|Number/u.test(key))
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
      const boarding = { 是: 'yes', 否: 'no', 住校: 'yes', 不住校: 'no', '1': 'yes', '0': 'no' }[
        text
      ];
      if (!boarding) throw new DomainError('VALIDATION', '是否住校请填写是、否或留空。');
      text = boarding;
    }
    if (key === 'birthMonth') {
      const match = /^(\d{4})[年./-](\d{1,2})(?:月|[./-]\d{1,2}日?)?$/.exec(text);
      if (!match) throw new DomainError('VALIDATION', '出生年月请填写 YYYY-MM，例如 2010-09。');
      text = `${match[1]}-${match[2]!.padStart(2, '0')}`;
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
