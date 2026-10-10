import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  classDataSelectInput,
  classDataConfigureInput,
  classDataConfirmInput,
  type ClassDataConfiguration,
  type ClassDataPreview,
  type ClassDataReceipt,
  type ClassDataRow,
} from '../shared/class-data-import';
import { studentInput, type Snapshot } from '../shared/contracts';
import { SUBJECT_CATALOG } from '../shared/score-subjects';
import type { ScoreSubject } from '../shared/scores';
import type { ScoreVersionPayload } from '../shared/score-records';
import { readClassDataTables, type ScoreTable } from './score-table';
import { parseScoreCell } from './scores';
import { validateScorePayload } from './score-record-validation';
import { transaction } from './database';
import { DomainError } from './errors';
import { MAX_EXAMS, MAX_SCORE_VERSIONS, MAX_SCORE_PAYLOAD_BYTES } from './storage-limits';
import {
  importedProfile,
  rosterHeaders,
  rosterProfileColumns,
  planImportedProfile,
  writeImportedProfile,
} from './roster-profile';
import type { StudentProfile } from '../shared/pupils';

export interface ClassDataFile {
  bytes: Uint8Array;
  format: 'xlsx' | 'csv';
  fileName: string;
}
interface Sheet {
  key: string;
  label: string;
  headers: string[];
  table: ScoreTable;
  file: ClassDataFile;
  rowOffset: number;
}
interface Pending {
  epoch: string;
  classId: string;
  fingerprint: string;
  expires: number;
  sheets: Sheet[];
  preview: ClassDataPreview;
  students: Array<{ id: string; studentNumber: string; displayName: string }>;
  payload: ScoreVersionPayload | null;
  generated: Map<string, string>;
  profiles: StudentProfile[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nameHeaders = ['姓名', '学生姓名'];
const numberHeaders = ['学生编号', '学号', '编号'];
const ignoredHeaders = new Set([
  ...Object.keys(rosterProfileColumns),
  ...nameHeaders,
  ...numberHeaders,
  '班级',
  '总分',
  '排名',
  '名次',
  '序号',
  '性别',
  '联系电话',
  '家长电话',
]);
const text = (value: string | number | null | undefined) =>
  value == null ? '' : String(value).trim();
function subjectName(header: string) {
  const name = header.replace(/[（(]\s*\d+(?:\.\d+)?\s*(?:分)?\s*[）)]$/u, '').trim();
  return { 生物: '生物学', 政治: '思想政治' }[name] ?? name;
}
function inferPrecision(sheet: Sheet, header: string): 0 | 1 | 2 {
  const column = sheet.headers.indexOf(header);
  const values = [
    header.match(/[（(]\s*(\d+(?:\.\d+)?)/u)?.[1],
    ...sheet.table.slice(1).map((row) => row[column]?.value),
  ];
  let precision = 0;
  for (const value of values) {
    const match = /^(?:0|[1-9]\d{0,4})(?:\.(\d+))?$/.exec(text(value));
    if (match) precision = Math.max(precision, Math.min(2, match[1]?.length ?? 0));
  }
  return precision as 0 | 1 | 2;
}
function subjectFor(
  header: string,
  name = subjectName(header),
  max?: string,
  precision: 0 | 1 | 2 = 0,
): ScoreSubject {
  const normal = name.normalize('NFKC').trim();
  const standard = SUBJECT_CATALOG.find((s) => s.name === normal);
  const hash = createHash('sha256')
    .update(`class-manager:subject:v1:${normal}`)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6]! & 15) | 128;
  hash[8] = (hash[8]! & 63) | 128;
  const hex = hash.toString('hex');
  return {
    id:
      standard?.id ??
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    name: normal,
    maxScore: max ?? header.match(/[（(]\s*(\d+(?:\.\d+)?)/u)?.[1] ?? standard?.maxScore ?? '100',
    precision,
  };
}

/** One preview owns its files and proposed identities; confirmation writes roster and exam atomically. */
export class ClassDataImporter {
  private pending?: Pending;
  private receipts = new Map<string, Omit<ClassDataReceipt, 'snapshot'>>();
  private sequence = 0;
  private disposed = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshot: () => Snapshot,
  ) {}
  dispose() {
    this.disposed = true;
    this.pending = undefined;
    this.sequence++;
  }
  private guard(epoch: string) {
    const snapshot = this.snapshot();
    if (this.disposed || snapshot.epoch !== epoch)
      throw new DomainError('STALE_WORKSPACE', '资料已切换，请重新导入。');
    return snapshot;
  }
  private fingerprint(snapshot: Snapshot) {
    return digest([snapshot.classes, snapshot.students]);
  }
  cancel(raw: unknown) {
    const input = classDataSelectInput.parse(raw);
    this.guard(input.epoch);
    this.pending = undefined;
    this.sequence++;
  }

  async select(files: ClassDataFile[], raw: unknown): Promise<ClassDataPreview> {
    const input = classDataSelectInput.parse(raw),
      snapshot = this.guard(input.epoch);
    const classroom = snapshot.classes.find((c) => c.id === input.classId);
    if (!classroom) throw new DomainError('NOT_FOUND', '请先创建并选择班级。');
    if (!files.length || files.length > 2)
      throw new DomainError('VALIDATION', '每次可选择一份名册和一份成绩文件，最多两份。');
    this.pending = undefined;
    const sequence = ++this.sequence,
      fingerprint = this.fingerprint(snapshot);
    const sheets: Sheet[] = [];
    for (const [index, file] of files.entries()) {
      for (const [sheetIndex, entry] of (
        await readClassDataTables(file.bytes, file.format, true)
      ).entries()) {
        const headers = rosterHeaders(entry.table[0]?.map((c) => text(c.value)) ?? []);
        sheets.push({
          key: `${index}:${sheetIndex}`,
          label: `${file.fileName} · ${entry.name}`,
          headers,
          table: entry.table,
          file,
          rowOffset: entry.rowOffset,
        });
      }
    }
    if (sequence !== this.sequence || fingerprint !== this.fingerprint(this.guard(input.epoch)))
      throw new DomainError('CONFLICT', '读取期间名册发生变化，请重新选择文件。');
    const isNamed = (s: Sheet) => s.headers.some((h) => nameHeaders.includes(h));
    const scoreSheet = sheets.find(
      (s) =>
        isNamed(s) &&
        s.headers.some((h) => SUBJECT_CATALOG.some((subject) => subject.name === subjectName(h))),
    );
    const studentSheet =
      sheets.find((s) => isNamed(s) && s !== scoreSheet) ??
      (scoreSheet ? null : sheets.find(isNamed)) ??
      null;
    const token = randomUUID(),
      now = new Date();
    const configuration: ClassDataConfiguration = {
      ...input,
      token,
      studentSheet: studentSheet?.key ?? null,
      scoreSheet: scoreSheet?.key ?? null,
      examName: scoreSheet ? '未命名考试' : '',
      examDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      subjects:
        scoreSheet?.headers
          .filter((h) => !ignoredHeaders.has(h))
          .map((header) => {
            const s = subjectFor(
              header,
              subjectName(header),
              undefined,
              inferPrecision(scoreSheet, header),
            );
            return { header, name: s.name, maxScore: s.maxScore, precision: s.precision };
          }) ?? [],
      resolutions: [],
    };
    this.pending = {
      epoch: input.epoch,
      classId: input.classId,
      fingerprint,
      expires: Date.now() + 15 * 60 * 1000,
      sheets,
      preview: {} as ClassDataPreview,
      students: [],
      payload: null,
      generated: new Map(),
      profiles: [],
    };
    return this.configure(configuration);
  }

  configure(raw: unknown): ClassDataPreview {
    const config = classDataConfigureInput.parse(raw),
      snapshot = this.guard(config.epoch),
      pending = this.pending;
    if (
      !pending ||
      pending.classId !== config.classId ||
      (pending.preview.token && pending.preview.token !== config.token) ||
      pending.expires <= Date.now()
    )
      throw new DomainError('CONFLICT', '导入预览已失效，请重新选择文件。');
    if (pending.fingerprint !== this.fingerprint(snapshot))
      throw new DomainError('CONFLICT', '名册发生变化，请重新选择文件。');
    const classroom = snapshot.classes.find((c) => c.id === config.classId)!;
    const active = snapshot.students.filter((s) => s.active && s.classId === config.classId);
    const resolutions = new Map(config.resolutions.map((r) => [r.key, r]));
    if (resolutions.size !== config.resolutions.length)
      throw new DomainError('VALIDATION', '同一行只能设置一种匹配方式。');
    const studentSheet = pending.sheets.find((s) => s.key === config.studentSheet);
    const scoreSheet = pending.sheets.find((s) => s.key === config.scoreSheet);
    if ((config.studentSheet && !studentSheet) || (config.scoreSheet && !scoreSheet))
      throw new DomainError('VALIDATION', '所选工作表不存在。');
    const subjects = config.subjects.map((s) =>
      subjectFor(s.header, s.name, s.maxScore, s.precision as 0 | 1 | 2),
    );
    const issues: string[] = [],
      rows: ClassDataRow[] = [],
      students: Pending['students'] = [];
    if (!studentSheet && !scoreSheet) issues.push('请选择一张学生信息或考试成绩工作表。');
    if (
      scoreSheet &&
      (!subjects.length ||
        subjects.length > 20 ||
        new Set(subjects.map((s) => s.id)).size !== subjects.length)
    )
      issues.push('请选择 1–20 个不同科目。');
    if (
      config.subjects.some(
        (s) => ignoredHeaders.has(s.header) || /赋分|等级|转换分/u.test(s.header),
      )
    )
      issues.push('身份、汇总和转换成绩列不能作为原始分科目导入。');
    if (scoreSheet && !config.examName.trim()) issues.push('请填写考试名称。');
    const planned = new Map<string, { id: string; studentNumber: string; displayName: string }>();
    const getIdentity = (
      sheet: Sheet,
      cells: ScoreTable[number],
      rowNumber: number,
    ): ClassDataRow => {
      const numberIndex = sheet.headers.findIndex((h) => numberHeaders.includes(h)),
        nameIndex = sheet.headers.findIndex((h) => nameHeaders.includes(h));
      const number = text(cells[numberIndex]?.value).toUpperCase(),
        name = text(cells[nameIndex]?.value),
        key = `${sheet.key}:${rowNumber}`;
      const row: ClassDataRow = {
        key,
        sheet: sheet.label,
        row: rowNumber,
        studentNumber: number,
        displayName: name,
        studentId: null,
        status: 'unresolved',
        message: '请确认对应学生',
        scores: [],
      };
      const resolution = resolutions.get(key);
      if (resolution?.action === 'skip') {
        row.status = 'skip';
        row.message = '本次跳过';
        return row;
      }
      if (
        nameIndex < 0 ||
        !name ||
        cells.some((c) => c.problem) ||
        cells.length !== sheet.headers.length
      ) {
        row.status = 'error';
        row.message = '请核对姓名、列数与单元格；不接受公式或合并单元格。';
        return row;
      }
      if (
        typeof cells[numberIndex]?.value === 'number' &&
        /0{2,}/u.test(cells[numberIndex]?.numberFormat ?? '')
      ) {
        row.status = 'error';
        row.message = '学号使用了补零显示格式，请把学号保存为文本后重新导入，以保留前导零。';
        return row;
      }
      if (
        sheet.headers.includes('班级') &&
        text(cells[sheet.headers.indexOf('班级')]?.value) &&
        text(cells[sheet.headers.indexOf('班级')]?.value) !== classroom.name
      ) {
        row.status = 'error';
        row.message = '文件班级与当前班级不同，请分别导入。';
        return row;
      }
      const byNumber = snapshot.students.find((s) => number && s.studentNumber === number);
      const byName = active.filter((s) => s.displayName === name);
      const known =
        resolution?.action === 'existing'
          ? active.find((s) => s.id === resolution.studentId)
          : number
            ? byNumber
            : byName.length === 1
              ? byName[0]
              : undefined;
      if (resolution?.action === 'existing' && !known) {
        row.status = 'error';
        row.message = '所选学生不在本班在籍名单中。';
        return row;
      }
      if (
        known &&
        (!known.active ||
          known.classId !== config.classId ||
          (!resolution && known.displayName !== name))
      ) {
        row.message = '编号与姓名、班级或在籍状态不一致，请人工核对。';
        return row;
      }
      if (known) {
        row.studentId = known.id;
        row.studentNumber = known.studentNumber;
        row.displayName = known.displayName;
        row.status = 'existing';
        row.message = '使用已有学生资料';
        return row;
      }
      const identityKey = number ? `number:${number}` : `name:${name}`;
      const plannedNames = [...planned.values()].filter((s) => s.displayName === name);
      const generatedNameMatch =
        number &&
        plannedNames.length === 1 &&
        pending.generated.get(`name:${name}`) === plannedNames[0]!.studentNumber
          ? plannedNames[0]
          : undefined;
      if (generatedNameMatch && !planned.has(identityKey) && !byNumber) {
        if (
          !studentInput.safeParse({
            epoch: config.epoch,
            classId: config.classId,
            studentNumber: number,
            displayName: name,
          }).success
        ) {
          row.status = 'error';
          row.message = '学生编号格式无效，请保存为 1–32 位字母、数字、下划线或连字符。';
          return row;
        }
        generatedNameMatch.studentNumber = number;
        planned.delete(`name:${name}`);
        planned.set(identityKey, generatedNameMatch);
        for (const earlier of rows)
          if (earlier.studentId === generatedNameMatch.id) earlier.studentNumber = number;
      }
      const previous =
        planned.get(identityKey) ??
        (!number && plannedNames.length === 1 ? plannedNames[0] : undefined);
      if (previous && previous.displayName === name) {
        row.studentId = previous.id;
        row.studentNumber = previous.studentNumber;
        row.status = 'new';
        row.message = '新增学生与成绩';
        return row;
      }
      if (resolution?.action !== 'new' && (active.length > 0 || (!number && byName.length > 1))) {
        row.message =
          byName.length > 1
            ? '本班有同名学生，请按编号确认。'
            : '未找到此人，请选择已有学生或确认新增。';
        return row;
      }
      if ((number && byNumber) || (!number && byName.length > 1)) {
        row.message = '编号已使用或姓名重复，不能直接新增。';
        return row;
      }
      let generated = pending.generated.get(identityKey);
      if (!generated) {
        generated = `CM-${randomUUID().slice(0, 8).toUpperCase()}`;
        pending.generated.set(identityKey, generated);
      }
      const studentNumber = number || generated;
      if (
        !studentInput.safeParse({
          epoch: config.epoch,
          classId: config.classId,
          studentNumber,
          displayName: name,
        }).success
      ) {
        row.status = 'error';
        row.message = '姓名须为 1–60 字；编号须为 1–32 位字母、数字、下划线或连字符。';
        return row;
      }
      const student = { id: randomUUID(), studentNumber, displayName: name };
      planned.set(identityKey, student);
      students.push(student);
      row.studentId = student.id;
      row.studentNumber = studentNumber;
      row.status = 'new';
      row.message = number ? '新增学生与成绩' : '确认后生成本地学生编号';
      return row;
    };
    for (const sheet of [...new Set([studentSheet, scoreSheet].filter((s): s is Sheet => !!s))]) {
      if (sheet.headers.some((h, i) => !h || sheet.headers.indexOf(h) !== i))
        issues.push(`${sheet.label}：表头为空或重复，请修正。`);
      const seen = new Set<string>();
      for (let i = 1; i < sheet.table.length; i++) {
        const cells = sheet.table[i]!;
        if (cells.every((c) => !c.problem && !text(c.value))) continue;
        const row = getIdentity(sheet, cells, i + 1 + sheet.rowOffset);
        if (row.status !== 'skip' && row.status !== 'error') {
          try {
            row.profile = importedProfile(sheet.headers, cells);
          } catch (error) {
            row.status = 'error';
            row.message = error instanceof Error ? error.message : '学生档案字段无效。';
          }
        }
        if (row.studentId && seen.has(row.studentId)) {
          row.status = 'error';
          row.message = '同一工作表重复出现该学生，请核对重复行。';
        }
        if (row.studentId) seen.add(row.studentId);
        if (sheet === scoreSheet && row.status !== 'skip') {
          for (const [index, subject] of subjects.entries()) {
            const column = sheet.headers.indexOf(config.subjects[index]!.header);
            try {
              if (column < 0) throw new Error(`缺少科目列：${config.subjects[index]!.header}`);
              row.scores.push({
                subjectId: subject.id,
                score: parseScoreCell(cells[column]?.value, subject),
              });
            } catch (error) {
              row.status = 'error';
              row.message = `${subject.name}：${error instanceof Error ? error.message : '成绩无效'}`;
            }
          }
        }
        rows.push(row);
      }
    }
    if (!rows.length) issues.push('所选工作表没有学生数据。');
    if (snapshot.students.length + students.length > 10000)
      issues.push('导入后学生总数超过 10000 人。');
    const profilePatches = new Map<string, Partial<StudentProfile['content']>>();
    for (const row of rows.filter(
      (r) => r.studentId && r.profile && ['new', 'existing'].includes(r.status),
    )) {
      const previous = profilePatches.get(row.studentId!) ?? {};
      if (
        Object.entries(row.profile!).some(
          ([key, value]) => key in previous && previous[key as keyof typeof previous] !== value,
        )
      ) {
        row.status = 'error';
        row.message = '两张工作表中的学生档案字段不一致，请核对后重新导入。';
      } else profilePatches.set(row.studentId!, { ...previous, ...row.profile });
    }
    const profiles = [...profilePatches]
      .map(([id, patch]) => planImportedProfile(this.db, id, patch))
      .filter((p): p is StudentProfile => !!p);
    let payload: ScoreVersionPayload | null = null;
    const unresolved = rows.filter((r) => r.status === 'unresolved').length;
    const scoreRows = rows.filter(
      (r) => r.scores.length && r.studentId && r.status !== 'skip',
    ).length;
    if (scoreSheet && !scoreRows) issues.push('所选成绩表没有可保存的成绩。');
    if (!issues.length && !unresolved && !rows.some((r) => r.status === 'error') && scoreSheet) {
      const groupId = randomUUID(),
        identities = [
          ...active.map(({ id, studentNumber, displayName }) => ({
            id,
            studentNumber,
            displayName,
          })),
          ...students,
        ];
      const year = Number(config.examDate.slice(0, 4)),
        academicYear = Number(config.examDate.slice(5, 7)) >= 8 ? year : year - 1;
      try {
        payload = validateScorePayload({
          formatVersion: 1,
          scoreBasis: 'raw',
          definition: {
            name: config.examName,
            date: config.examDate,
            academicYear: `${academicYear}-${academicYear + 1}`,
            term: Number(config.examDate.slice(5, 7)) >= 8 ? '上学期' : '下学期',
            grade: '未设置',
            className: classroom.name,
          },
          analysis: {
            subjects,
            groups: [{ id: groupId, name: '全科组', subjectIds: subjects.map((s) => s.id) }],
            roster: identities.map((s) => ({
              studentId: s.id,
              studentNumber: s.studentNumber,
              displayName: s.displayName,
              groupId,
            })),
            entries: rows
              .filter(
                (r) =>
                  r.key.startsWith(`${scoreSheet.key}:`) &&
                  r.studentId &&
                  !['skip', 'error', 'unresolved'].includes(r.status),
              )
              .flatMap((r) => r.scores.map((s) => ({ ...s, studentId: r.studentId! }))),
            includeRanks: false,
          },
          source: {
            kind: scoreSheet.file.format,
            fileHash: createHash('sha256').update(scoreSheet.file.bytes).digest('hex'),
            fileName: scoreSheet.file.fileName,
            columnMappings: config.subjects.map((s, i) => ({
              header: s.header,
              subjectId: subjects[i]!.id,
            })),
            exclusions: rows
              .filter((r) => r.key.startsWith(`${scoreSheet.key}:`) && r.status === 'skip')
              .map((r) => ({ row: r.row, reason: '教师核对后本次跳过' })),
          },
        });
        if (Buffer.byteLength(JSON.stringify(payload)) > MAX_SCORE_PAYLOAD_BYTES)
          throw new Error('成绩版本超过支持的容量。');
        this.assertDistinct(config.classId, payload);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : '成绩配置无效');
        payload = null;
      }
    }
    const preview: ClassDataPreview = {
      token: config.token,
      classId: config.classId,
      className: classroom.name,
      fileNames: [...new Set(pending.sheets.map((s) => s.file.fileName))],
      sheets: pending.sheets.map(({ key, label, headers }) => ({ key, label, headers })),
      configuration: config,
      subjects,
      rows,
      issues,
      added: students.length,
      matched: new Set(rows.filter((r) => r.status === 'existing').map((r) => r.studentId)).size,
      unresolved,
      scoreRows,
      hasScores: !!scoreSheet,
      profileRows: profiles.length,
      canConfirm:
        !issues.length &&
        !unresolved &&
        !rows.some((r) => r.status === 'error') &&
        (students.length > 0 || profiles.length > 0 || !!payload),
      expiresAt: new Date(pending.expires).toISOString(),
    };
    pending.preview = preview;
    pending.students = students;
    pending.payload = payload;
    pending.profiles = profiles;
    return preview;
  }

  private assertDistinct(classId: string, payload: ScoreVersionPayload) {
    for (const row of this.db
      .prepare(
        'SELECT v.payload FROM exams e JOIN score_versions v ON v.exam_id=e.id WHERE e.class_id=? AND v.revision=(SELECT MAX(revision) FROM score_versions WHERE exam_id=e.id)',
      )
      .all(classId)) {
      const old: ScoreVersionPayload = JSON.parse(String(row.payload));
      if (
        old.definition.name === payload.definition.name &&
        old.definition.date === payload.definition.date
      )
        throw new DomainError(
          'EXAM_DUPLICATE',
          '已有同名、同日期考试。请到成绩管理中选择原考试更正，原成绩不会被覆盖。',
        );
    }
  }
  confirm(raw: unknown): ClassDataReceipt {
    const input = classDataConfirmInput.parse(raw),
      snapshot = this.guard(input.epoch);
    const receipt = this.receipts.get(input.token);
    if (receipt) return { ...receipt, snapshot, replayed: true };
    const p = this.pending;
    if (!p || p.preview.token !== input.token || p.expires <= Date.now() || !p.preview.canConfirm)
      throw new DomainError('CONFLICT', '预览已失效或仍需核对，请重新预览。');
    if (p.fingerprint !== this.fingerprint(snapshot))
      throw new DomainError('CONFLICT', '名册已变化，请重新选择文件。');
    const examId = p.payload ? randomUUID() : null,
      now = new Date().toISOString();
    transaction(this.db, () => {
      if (p.payload) {
        this.assertDistinct(p.classId, p.payload);
        if (
          Number(this.db.prepare('SELECT COUNT(*) AS n FROM exams').get()?.n) >= MAX_EXAMS ||
          Number(this.db.prepare('SELECT COUNT(*) AS n FROM score_versions').get()?.n) >=
            MAX_SCORE_VERSIONS
        )
          throw new DomainError('STORAGE_LIMIT', '考试或版本数量已达上限。');
      }
      for (const student of p.students) {
        this.db
          .prepare('INSERT INTO students VALUES (?, ?, ?, 1, 1, ?)')
          .run(student.id, student.studentNumber, student.displayName, now);
        this.db
          .prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, NULL)')
          .run(randomUUID(), student.id, p.classId, now);
      }
      for (const profile of p.profiles) writeImportedProfile(this.db, profile);
      if (p.payload && examId) {
        this.db.prepare('INSERT INTO exams VALUES (?, ?, ?)').run(examId, p.classId, now);
        this.db
          .prepare('INSERT INTO score_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            randomUUID(),
            examId,
            1,
            input.token,
            digest(input),
            now,
            '班级资料统一导入，教师核对后确认',
            JSON.stringify(p.payload),
          );
      }
    });
    const saved = { classId: p.classId, added: p.preview.added, examId, replayed: false };
    this.receipts.set(input.token, saved);
    if (this.receipts.size > 20) this.receipts.delete(this.receipts.keys().next().value!);
    this.pending = undefined;
    return { ...saved, snapshot: this.snapshot() };
  }
}
