import { useState } from 'react';

const toolLabels: Record<string, string> = {
  createClass: '创建班级',
  renameClass: '修改班级名称',
  saveStudent: '保存学生资料',
  saveStudentProfile: '保存学生档案',
  saveAttendance: '保存课堂点名',
  setStudentActive: '调整学生在籍状态',
  saveGrowthEvent: '记录成长事实',
  createGrowthSummary: '创建阶段总结',
  editGrowthSummary: '保存总结复核稿',
  discardGrowthSummary: '撤销总结草稿',
  confirmGrowthSummary: '确认总结入档',
  createRubric: '创建评分细则',
  createGrading: '创建答卷复核',
  editGrading: '保存答卷复核',
  rebindGrading: '调整答卷归属',
  freezeGrading: '冻结复核结果',
  confirmScorePublication: '正式入分',
  createClassroom: '创建课堂',
  controlClassroom: '调整课堂展示',
  setCountdown: '设置倒计时',
  openClassroomDisplay: '打开课堂展示窗口',
  closeClassroomDisplay: '关闭课堂展示窗口',
  editLessonDraft: '保存课时修改',
  createLessonDraft: '新建课时',
  discardLessonDraft: '撤销课时草稿',
  freezeLessonDraft: '冻结课时版本',
  reviseLessonVersion: '创建课时修订稿',
  confirmDuty: '保存值日安排',
  confirmSeating: '保存座位安排',
  editExplanation: '保存成绩分析',
  discardExplanation: '撤销分析草稿',
  previewSeatingPrint: '座位表打印预览',
  previewDutyPrint: '值日表打印预览',
  exportLessonOffice: '导出教案或课件',
  saveMaterialOriginal: '保存资料原文件',
  saveBackup: '备份班级资料',
  previewRestore: '查看备份恢复范围',
  commitRestore: '恢复班级资料',
  exportDiagnostics: '导出诊断报告',
  measureNoise: '测量课堂噪声',
  requestStudentCall: '发起点名',
  cancelDeviceTask: '停止外设任务',
};
export const teacherToolLabel = (tool: string) => toolLabels[tool] ?? '处理教学事务';
export const teacherReceipt = (text: string) =>
  text.replace(
    /已获得 (\w+) 的业务回执。?/g,
    (_, tool: string) => `${teacherToolLabel(tool)}已完成。`,
  );
const fields: Record<string, string> = {
  name: '名称',
  title: '标题',
  displayName: '姓名',
  studentNumber: '学号',
  classId: '班级',
  studentId: '学生',
  active: '在籍状态',
  marks: '逐人点名结果',
  note: '备注',
  gender: '性别',
  birthDate: '出生日期',
  guardianName: '监护人姓名',
  guardianPhone: '联系电话',
  address: '联系地址',
  interests: '兴趣与特长',
  strengths: '学习优势',
  learningNeeds: '学习支持需求',
  classroomId: '对应课堂',
  request: '备课要求',
  content: '内容',
  payload: '业务内容',
  record: '原记录',
  reason: '说明',
  subject: '科目',
  grade: '年级',
  topic: '课题',
  durationMinutes: '课时长度（分钟）',
  objectives: '教学目标',
  keyPoints: '重点',
  difficulties: '难点',
  sections: '教学环节',
  slides: '课件页面',
  slideIds: '选用页面',
  slideId: '展示页面',
  versionId: '课时版本',
  draftId: '课时草稿',
  planId: '值日计划',
  examId: '考试',
  rubricId: '评分细则',
  subjectId: '科目',
  exercises: '练习',
  notes: '教师备注',
  description: '描述',
  source: '来源',
  action: '操作',
  result: '结果',
  summaryFact: '总结依据',
  happenedOn: '发生日期',
  kind: '类型',
  text: '正文',
  origin: '来源说明',
  rows: '行',
  cols: '列',
  row: '行',
  col: '列',
  positions: '座位',
  layout: '布局',
  groups: '小组',
  members: '成员',
  assignments: '安排',
  arrangement: '轮换安排',
  days: '日期安排',
  date: '日期',
  startDate: '开始日期',
  endDate: '结束日期',
  tasks: '任务',
  duties: '值日岗位',
  roles: '岗位',
  rotation: '轮换',
  completed: '已完成',
  present: '出勤',
  absent: '缺勤',
  setting: '倒计时设置',
  targetAt: '截止时间',
  label: '名称',
  answer: '答案',
  answers: '答案',
  solution: '解题说明',
  prompt: '题目',
  questions: '题目',
  score: '分数',
  maxScore: '满分',
  summary: '总结',
  reviewed: '已复核',
  feedback: '反馈',
  comment: '评语',
  format: '文件格式',
  includeAnswers: '包含答案',
  includeNotes: '包含教师备注',
  includeTeacherNotes: '包含教师备注',
  acknowledgeComplete: '已完成复核',
  acknowledgePublish: '确认入分',
  acknowledgeReplacement: '确认替换已有分数',
  acknowledgeReviewed: '已复核总结',
  acknowledgeSources: '已核对事实依据',
  acknowledgeScope: '已核对展示范围',
  acknowledgeDifferences: '已核对分数差异',
  visible: '显示',
  change: '调整内容',
  page: '页面',
  offset: '起始位置',
  limit: '查看数量',
  count: '数量',
  total: '总数',
  classes: '班级',
  students: '学生',
  assets: '资料',
  lessons: '课时',
  examinations: '考试',
  exams: '考试',
  noise: '噪声设备',
  studentCall: '点名设备',
  availability: '连接状态',
  status: '状态',
  durationSeconds: '时长（秒）',
  seconds: '秒',
  minutes: '分钟',
  path: '文件位置',
  filePath: '文件位置',
  pages: '页面',
  items: '内容',
  mode: '方式',
  size: '大小',
  createdAt: '创建时间',
  updatedAt: '更新时间',
  locked: '锁定',
  followUp: '跟进状态',
  timeZone: '时区',
  targetDate: '目标日期',
  teacherNotes: '教师备注',
  weights: '计分权重',
  scores: '分数',
  cells: '记录',
  ranks: '排名',
  criterion: '评分标准',
};
const hidden =
  /^(?:epoch|token|operationRef|operationId|requestId|expected\w*|revision|configurationRevision|wireHash|sourceHash|inputHash|\w*(?:Digest|Hash)|responseId|responseModel|promptVersion|provider|authoring|nextOffset)$/u;
const enums: Record<string, string> = {
  unmarked: '未点名',
  present: '到课',
  late: '迟到',
  excused: '请假',
  absent: '缺席',
  unspecified: '未填写',
  female: '女',
  male: '男',
  other: '其他',
  unavailable: '未连接',
  available: '可用',
  disconnected: '未连接',
  connected: '已连接',
  draft: '草稿',
  frozen: '已冻结',
  supplement: '补充内容',
  paragraph: '文字',
  fresh: '重新安排',
  latest: '沿用已有安排',
  rotate: '轮换',
  randomize: '随机编排',
  none: '无需跟进',
  planned: '待跟进',
  event: '成长事件',
  conversation: '师生谈话',
  pause: '暂停',
  resume: '继续',
  reset: '重新开始',
  finish: '结束',
  slide: '跳转页面',
  questions: '题目显示',
  move: '调整位置',
  lock: '锁定位置',
  answers: '答案显示',
  next: '下一页',
  previous: '上一页',
  pptx: 'PowerPoint课件',
  docx: 'Word教案',
};
export function teacherValue(value: unknown, field = ''): string {
  if (value === null || value === undefined) return '暂无';
  if (typeof value === 'boolean')
    return field === 'active' ? (value ? '在籍' : '停用') : value ? '是' : '否';
  if (typeof value === 'string')
    return (
      enums[value] ?? value.replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/giu, '内部记录')
    );
  return String(value);
}
function ArrayPreview({ values }: { values: unknown[] }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(values.length / 20));
  const selected = Math.min(page, pages - 1);
  return (
    <div className="teacher-array">
      <small>共{values.length}项</small>
      <ol start={selected * 20 + 1}>
        {values.slice(selected * 20, selected * 20 + 20).map((value, index) => (
          <li key={index}>
            <BusinessPreview value={value} />
          </li>
        ))}
      </ol>
      {pages > 1 && (
        <div className="teacher-preview-pages">
          <button disabled={selected === 0} onClick={() => setPage(selected - 1)}>
            上一组
          </button>
          <span>
            第{selected + 1}/{pages}组
          </span>
          <button disabled={selected === pages - 1} onClick={() => setPage(selected + 1)}>
            下一组
          </button>
        </div>
      )}
    </div>
  );
}
export function BusinessPreview({ value, field = '' }: { value: unknown; field?: string }) {
  if (Array.isArray(value)) return <ArrayPreview values={value} />;
  if (value && typeof value === 'object') {
    // Identity labels already restored by Main are useful to teachers; internal IDs are omitted.
    const visible = Object.entries(value).filter(
      ([key, item]) =>
        !hidden.test(key) &&
        ((key !== 'id' && !/Id$/.test(key)) ||
          (typeof item === 'string' &&
            !/^[0-9a-f-]{36}$/i.test(item) &&
            !/^\[记录\d+\]$/.test(item))),
    );
    return visible.length ? (
      <dl className="teacher-preview">
        {visible.map(([key, item]) => (
          <div key={key}>
            <dt>{fields[key] ?? (key === 'id' ? '对象' : '补充内容')}</dt>
            <dd>
              <BusinessPreview value={item} field={key} />
            </dd>
          </div>
        ))}
      </dl>
    ) : (
      <span>暂无业务内容</span>
    );
  }
  return <span className="teacher-value">{teacherValue(value, field)}</span>;
}
export function ChangeValue({ text }: { text: string }) {
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* Plain teacher-facing descriptions are also valid. */
  }
  return <BusinessPreview value={value} />;
}
