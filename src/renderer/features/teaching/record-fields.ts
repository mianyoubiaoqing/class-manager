import type { TeachingKind } from '../../../shared/teaching-workbench';
export type Field = {
  key: string;
  label: string;
  type?: 'text' | 'long' | 'student' | 'date' | 'datetime' | 'number' | 'boolean' | 'select';
  options?: Array<[string, string]>;
  optional?: boolean;
  max?: number;
  min?: number;
};
const date: Field = { key: 'date', label: '日期', type: 'date' };
const student: Field = { key: 'studentId', label: '学生', type: 'student' };
const category: Field = { key: 'category', label: '类型' };
export const kindLabels: Record<TeachingKind, string> = {
  discipline: '违纪记录',
  homework: '作业',
  leave: '请假',
  trace: '工作留痕',
  talk: '谈话',
  visit: '家访',
  parentMeeting: '家长会',
  notice: '群通知草稿',
  meeting: '主题班会',
  activity: '班级活动',
  award: '荣誉',
  todo: '待办',
  reminder: '提醒',
  notes: '班级备忘',
  studentExtra: '学生扩展资料',
  examArchive: '考试归档',
};
export const recordFields: Record<TeachingKind, Field[]> = {
  examArchive: [],
  discipline: [
    student,
    category,
    date,
    { key: 'detail', label: '具体情况与处理', type: 'long', max: 4000 },
    { key: 'handler', label: '处理人' },
  ],
  homework: [
    { key: 'subject', label: '科目', max: 60 },
    { key: 'title', label: '作业内容', type: 'long', max: 1000 },
    { key: 'due', label: '截止日期', type: 'date' },
  ],
  leave: [
    student,
    category,
    { key: 'reason', label: '请假事由', type: 'long' },
    { key: 'start', label: '开始日期', type: 'date' },
    { key: 'end', label: '结束日期', type: 'date' },
    {
      key: 'status',
      label: '审批状态',
      type: 'select',
      options: [
        ['pending', '待审批'],
        ['approved', '已批准'],
        ['rejected', '未批准'],
        ['closed', '已销假'],
      ],
    },
    { key: 'note', label: '审批意见 / 销假备注', optional: true, type: 'long' },
  ],
  trace: [
    category,
    { key: 'title', label: '工作标题' },
    date,
    { key: 'content', label: '工作内容', type: 'long', max: 6000 },
    { key: 'by', label: '记录人' },
  ],
  talk: [
    student,
    category,
    date,
    { key: 'content', label: '谈话内容', type: 'long', max: 6000 },
    { key: 'followUp', label: '后续跟进', optional: true, type: 'long' },
  ],
  visit: [
    student,
    date,
    { key: 'result', label: '家访情况', type: 'long', max: 4000 },
    { key: 'note', label: '后续安排', optional: true, type: 'long' },
  ],
  parentMeeting: [
    { key: 'title', label: '会议主题' },
    date,
    { key: 'attendees', label: '参加人数', type: 'number', min: 0, max: 1000 },
    { key: 'summary', label: '会议纪要', type: 'long', max: 4000 },
  ],
  notice: [
    { key: 'title', label: '通知标题' },
    date,
    { key: 'content', label: '通知正文', type: 'long', max: 6000 },
  ],
  meeting: [
    { key: 'theme', label: '班会主题' },
    date,
    { key: 'planned', label: '尚未开展（计划中）', type: 'boolean' },
    { key: 'record', label: '班会安排与记录', type: 'long', max: 4000 },
  ],
  activity: [
    { key: 'name', label: '活动名称' },
    date,
    { key: 'description', label: '活动记录', type: 'long', max: 4000 },
  ],
  award: [student, { key: 'name', label: '荣誉名称' }, category, date],
  todo: [
    { key: 'text', label: '待办事项', type: 'long', max: 1000 },
    { key: 'dueAt', label: '截止与提醒时间', type: 'datetime' },
    {
      key: 'priority',
      label: '优先级',
      type: 'select',
      options: [
        ['high', '高'],
        ['medium', '中'],
        ['low', '低'],
      ],
    },
    { key: 'done', label: '已完成', type: 'boolean' },
  ],
  reminder: [
    { key: 'text', label: '提醒内容', type: 'long', max: 1000 },
    { key: 'dueAt', label: '提醒时间', type: 'datetime' },
    {
      key: 'priority',
      label: '优先级',
      type: 'select',
      options: [
        ['high', '高'],
        ['medium', '中'],
        ['low', '低'],
      ],
    },
    { key: 'done', label: '已处理', type: 'boolean' },
  ],
  notes: [
    { key: 'title', label: '备忘标题' },
    { key: 'content', label: '备忘内容', type: 'long', optional: true, max: 10000 },
  ],
  studentExtra: [
    student,
    { key: 'idCard', label: '身份证号', optional: true, max: 40 },
    { key: 'height', label: '身高（厘米，未填写时填 0）', type: 'number', min: 0, max: 250 },
    { key: 'group', label: '小组', type: 'number', min: 1, max: 100 },
    { key: 'note', label: '备注', optional: true, type: 'long' },
  ],
};
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function localDateTime(value: string): string {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return `${todayFor(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function todayFor(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function recordTitle(content: object): string {
  const c = content as Record<string, unknown>;
  return String(c.title ?? c.name ?? c.theme ?? c.text ?? c.category ?? '记录');
}
