import type { StudentProfile } from './pupils';

/** Exact school roster layout; repeated labels are disambiguated only in this known layout. */
export const schoolRosterHeaders = [
  '学号',
  '姓名',
  '性别',
  '出生年月',
  '身份证号',
  '学籍号',
  '考籍号',
  '报考序号',
  '联系电话',
  '父亲姓名',
  '身份证号码',
  '联系电话',
  '母亲姓名',
  '身份证号码',
  '联系电话',
  '家庭详细住址（具体到门牌号）',
  '是否住校',
  '是否贫困生及类型',
];
export const schoolRosterUniqueHeaders = schoolRosterHeaders.map(
  (header, index) =>
    ({
      8: '学生联系电话',
      10: '父亲身份证号码',
      11: '父亲联系电话',
      13: '母亲身份证号码',
      14: '母亲联系电话',
    })[index] ?? header,
);

/** The same field order is used by the roster, import previews and Excel exports. */
export function schoolRosterValues(
  studentNumber: string,
  displayName: string,
  content: Partial<StudentProfile['content']> = {},
): string[] {
  return [
    studentNumber,
    displayName,
    ({ male: '男', female: '女', other: '其他', unspecified: '' } as const)[
      content.gender ?? 'unspecified'
    ],
    content.birthMonth || content.birthDate?.slice(0, 7) || '',
    ...(
      [
        'idCard',
        'studentRegistration',
        'examRegistration',
        'applicationNumber',
        'studentPhone',
        'fatherName',
        'fatherIdCard',
        'fatherPhone',
        'motherName',
        'motherIdCard',
        'motherPhone',
        'address',
      ] as const
    ).map((key) => content[key] ?? ''),
    ({ yes: '住校', no: '走读', unspecified: '' } as const)[content.boarding ?? 'unspecified'],
    content.povertyStatus ?? '',
  ];
}
