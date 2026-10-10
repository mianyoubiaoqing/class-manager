import type { OfficeTaskRunner } from './office-task';
import type { Snapshot } from '../shared/contracts';
import { teachingExportInput, type TeachingRecord } from '../shared/teaching-workbench';
import type { ScoreVersionView, ExamSummary } from '../shared/score-commands';
import { DomainError } from '../core/errors';
import type { WorkerClient, WorkerOperation } from './worker-client';
import { profileFieldLabels, type StudentProfile } from '../shared/pupils';
import { schoolRosterHeaders, schoolRosterValues } from '../shared/roster-fields';

const labels: Record<string, string> = {
  ...profileFieldLabels,
  studentId: '学生',
  category: '类型',
  date: '日期',
  detail: '情况',
  handler: '处理人',
  subject: '科目',
  title: '标题',
  due: '截止日期',
  submissions: '提交人数',
  reason: '事由',
  start: '开始日期',
  end: '结束日期',
  status: '状态',
  note: '备注',
  content: '内容',
  by: '记录人',
  followUp: '后续跟进',
  result: '结果',
  attendees: '参加人数',
  summary: '纪要',
  theme: '主题',
  planned: '是否计划',
  record: '记录',
  name: '名称',
  description: '说明',
  photoIds: '照片数',
  text: '事项',
  dueAt: '提醒时间',
  priority: '优先级',
  done: '完成',
  idCard: '身份证号',
  height: '身高(cm)',
  group: '小组',
  gender: '性别',
  birthDate: '出生日期',
  guardianName: '家长',
  guardianPhone: '联系电话',
  address: '地址',
  interests: '兴趣',
  strengths: '优势',
  learningNeeds: '学习需求',
  teacherNotes: '教师备注',
};
const values: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '未批准',
  closed: '已销假',
  high: '高',
  medium: '中',
  low: '低',
  male: '男',
  female: '女',
  other: '其他',
  unspecified: '未填写',
  yes: '是',
  no: '否',
};
export async function teachingReport(
  worker: WorkerClient,
  raw: unknown,
  generator: Pick<OfficeTaskRunner, 'generateTeachingReport'>,
): Promise<{ bytes: Uint8Array; name: string; extension: 'docx' | 'xlsx' }> {
  const input = teachingExportInput.parse(raw);
  async function call<T>(operation: WorkerOperation, args: unknown): Promise<T> {
    const result = await worker.call<T>(operation, args);
    if (!result.ok) throw new DomainError(result.error.code, result.error.message);
    return result.value;
  }
  const snapshot = await call<Snapshot>('snapshot', undefined);
  if (snapshot.epoch !== input.epoch)
    throw new DomainError('STALE_WORKSPACE', '工作区已变化，请刷新后导出。');
  const classroom = snapshot.classes.find((c) => c.id === input.classId);
  if (!classroom) throw new DomainError('NOT_FOUND', '班级不存在。');
  const students = snapshot.students.filter((s) => s.classId === input.classId && s.active);
  const studentName = (id: string) =>
    snapshot.students.find((s) => s.id === id)?.displayName ?? '已归档学生';
  const records = await call<TeachingRecord[]>('listTeachingRecords', {
    epoch: input.epoch,
    classId: input.classId,
  });
  let rows: string[][], title: string;
  const readable = (key: string, value: unknown): string =>
    key === 'studentId'
      ? studentName(String(value))
      : Array.isArray(value)
        ? String(value.length)
        : typeof value === 'boolean'
          ? value
            ? '是'
            : '否'
          : (values[String(value)] ?? String(value));
  if (input.kind === 'roster') {
    title = '学生花名册';
    rows = [[...schoolRosterHeaders]];
    for (const s of students) {
      const profile = await call<StudentProfile>('readStudentProfile', {
        epoch: input.epoch,
        studentId: s.id,
      });
      const extra = records.find(
        (r) =>
          r.kind === 'studentExtra' && 'studentId' in r.content && r.content.studentId === s.id,
      );
      rows.push(
        schoolRosterValues(s.studentNumber, s.displayName, {
          ...profile.content,
          idCard:
            profile.content.idCard ||
            (extra && 'idCard' in extra.content ? extra.content.idCard : ''),
        }),
      );
    }
  } else if (input.kind === 'scores') {
    title = '考试成绩';
    rows = [['考试', '日期', '学生编号', '姓名', '科目', '分数', '满分']];
    const exams = await call<ExamSummary[]>('listExams', {
      epoch: input.epoch,
      classId: input.classId,
    });
    for (const exam of exams) {
      const view = await call<ScoreVersionView>('readScoreVersion', {
        epoch: input.epoch,
        versionId: exam.versionId,
      });
      for (const entry of view.payload.analysis.entries) {
        const s = view.payload.analysis.roster.find((s) => s.studentId === entry.studentId)!;
        const subject = view.payload.analysis.subjects.find((s) => s.id === entry.subjectId)!;
        rows.push([
          exam.definition.name,
          exam.definition.date,
          s.studentNumber,
          s.displayName,
          subject.name,
          entry.score.status === 'valid'
            ? String(entry.score.hundredths / 100)
            : ({ absent: '缺考', missing: '缺失', not_selected: '未选科' } as const)[
                entry.score.status
              ],
          subject.maxScore,
        ]);
      }
    }
  } else if (input.kind === 'profile') {
    const student = students.find((s) => s.id === input.studentId);
    if (!student) throw new DomainError('NOT_FOUND', '请选择当前班级的学生。');
    title = `${student.displayName}·学生档案`;
    rows = [
      ['项目', '内容'],
      ['学生编号', student.studentNumber],
    ];
    const profile = await call<{ content: Record<string, unknown> }>('readStudentProfile', {
      epoch: input.epoch,
      studentId: student.id,
    });
    for (const [key, value] of Object.entries(profile.content))
      rows.push([labels[key] ?? key, readable(key, value)]);
    for (const r of records.filter(
      (r) => 'studentId' in r.content && r.content.studentId === student.id,
    )) {
      rows.push(['记录日期', r.updatedAt.slice(0, 10)]);
      for (const [key, value] of Object.entries(r.content))
        if (key !== 'studentId') rows.push([labels[key] ?? key, readable(key, value)]);
    }
    const exams = await call<ExamSummary[]>('listExams', {
      epoch: input.epoch,
      classId: input.classId,
    });
    for (const exam of exams) {
      const view = await call<ScoreVersionView>('readScoreVersion', {
        epoch: input.epoch,
        versionId: exam.versionId,
      });
      const entries = view.payload.analysis.entries.filter((e) => e.studentId === student.id);
      if (!entries.length) continue;
      rows.push(['考试', `${exam.definition.name} · ${exam.definition.date}`]);
      for (const entry of entries) {
        const subject = view.payload.analysis.subjects.find((s) => s.id === entry.subjectId)!;
        rows.push([
          subject.name,
          entry.score.status === 'valid'
            ? `${entry.score.hundredths / 100} / ${subject.maxScore}`
            : ({ absent: '缺考', missing: '缺失', not_selected: '未选科' } as const)[
                entry.score.status
              ],
        ]);
      }
    }
  } else {
    title = ({ leave: '请假凭证', trace: '工作留痕', talk: '谈话记录' } as const)[input.kind];
    rows = [['项目', '内容']];
    const selected = records.filter(
      (r) =>
        r.kind === input.kind &&
        (!input.recordId || r.id === input.recordId) &&
        (!input.studentId || ('studentId' in r.content && r.content.studentId === input.studentId)),
    );
    if (!selected.length) throw new DomainError('NOT_FOUND', '没有可导出的记录。');
    for (const r of selected) {
      rows.push(['记录', r.updatedAt.slice(0, 10)]);
      for (const [key, value] of Object.entries(r.content))
        rows.push([labels[key] ?? key, readable(key, value)]);
    }
  }
  if ((await call<Snapshot>('snapshot', undefined)).epoch !== input.epoch)
    throw new DomainError('STALE_WORKSPACE', '工作区已变化，请重新导出。');
  const { bytes } = await generator.generateTeachingReport({
    title: `${classroom.name} · ${title}`,
    rows,
    format: input.format,
  });
  if ((await call<Snapshot>('snapshot', undefined)).epoch !== input.epoch)
    throw new DomainError('STALE_WORKSPACE', '工作区已变化，请重新导出。');
  return {
    bytes,
    name:
      `${classroom.name}-${title}`.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100) + `.${input.format}`,
    extension: input.format,
  };
}
