import type { DesktopApi, Snapshot } from '../shared/contracts';
import type { ScoreDifferences, ScoreVersionView } from '../shared/score-commands';
import type { ScoreVersionPayload } from '../shared/score-records';
import type { ScoreSubject, ScoreValue } from '../shared/scores';
import { SUBJECT_CATALOG } from '../shared/score-subjects';
export { SUBJECT_CATALOG } from '../shared/score-subjects';

export type ScoreConfiguration = Parameters<DesktopApi['previewScores']>[0];
export interface ExamDraft {
  configuration: ScoreConfiguration;
  roster: Array<{ studentId: string; studentNumber: string; displayName: string }>;
  baseline?: ScoreVersionPayload;
}

// Keep these identifiers stable: history joins subjects by ID, never by translated label.

/** Custom subjects use a namespace-specific digest so the same name survives backup/reinstall. */
export async function customSubject(name: string): Promise<ScoreSubject> {
  const normalized = name.normalize('NFKC').trim();
  if (!normalized || normalized.length > 60) throw new Error('自定义科目名称应为 1–60 个字符。');
  const standard = SUBJECT_CATALOG.find((subject) => subject.name === normalized);
  if (standard) return { ...standard };
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`class-manager:subject:v1:${normalized}`),
    ),
  ).slice(0, 16);
  hash[6] = (hash[6]! & 15) | 128;
  hash[8] = (hash[8]! & 63) | 128;
  const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    name: normalized,
    maxScore: '100',
    precision: 0,
  };
}

export function newExam(snapshot: Snapshot, classId: string): ExamDraft {
  const now = new Date();
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const groupId = crypto.randomUUID();
  const subjects = SUBJECT_CATALOG.slice(0, 3).map((subject) => ({ ...subject }));
  const roster = snapshot.students
    .filter((student) => student.active && student.classId === classId)
    .map((student) => ({
      studentId: student.id,
      studentNumber: student.studentNumber,
      displayName: student.displayName,
    }));
  return {
    roster,
    configuration: {
      epoch: snapshot.epoch,
      classId,
      expectedRevision: 0,
      definition: {
        name: '',
        date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
        academicYear: `${year}-${year + 1}`,
        term: '上学期',
        grade: '高一',
      },
      subjects,
      groups: [{ id: groupId, name: '全科组', subjectIds: subjects.map((subject) => subject.id) }],
      assignments: roster.map((student) => ({ studentId: student.studentId, groupId })),
      scoreBasis: 'unknown',
      includeRanks: false,
      columnMappings: [],
      exclusions: [],
    },
  };
}

export function correctionDraft(epoch: string, classId: string, view: ScoreVersionView): ExamDraft {
  const { className: _className, ...definition } = view.payload.definition;
  void _className;
  return {
    baseline: view.payload,
    roster: view.payload.analysis.roster.map(({ studentId, studentNumber, displayName }) => ({
      studentId,
      studentNumber,
      displayName,
    })),
    configuration: {
      epoch,
      classId,
      examId: view.record.examId,
      expectedRevision: view.record.revision,
      definition,
      subjects: view.payload.analysis.subjects,
      groups: view.payload.analysis.groups,
      assignments: view.payload.analysis.roster.map(({ studentId, groupId }) => ({
        studentId,
        groupId,
      })),
      scoreBasis: 'raw',
      includeRanks: view.payload.analysis.includeRanks,
      columnMappings: [],
      exclusions: [],
    },
  };
}

/** Translate persisted configuration differences using both versions, including removed subjects. */
export function configurationDifference(
  difference: ScoreDifferences['configuration'][number],
  draft: ExamDraft,
): { label: string; before: string; after: string } {
  const labels: Record<string, string> = {
    name: '考试名称',
    date: '考试日期',
    academicYear: '学年',
    term: '学期',
    grade: '年级',
    className: '班级',
  };
  const [kind, id = ''] = difference.key.split('.');
  function describe(before: boolean): string {
    const raw = before ? difference.before : difference.after;
    if (raw === null) return '无';
    const source = before ? draft.baseline?.analysis : draft.configuration;
    if (kind === 'exam') return raw;
    if (kind === 'includeRanks') return raw === 'true' ? '开启' : '关闭';
    if (!source) return '原配置未加载';
    if (kind === 'subject') {
      const subject = source.subjects.find((item) => item.id === id);
      return subject
        ? `${subject.name}；满分 ${subject.maxScore}；小数 ${subject.precision} 位；目标 ${subject.targetScore ?? '未设置'}`
        : '无';
    }
    if (kind === 'group') {
      const group = source.groups.find((item) => item.id === id);
      return group
        ? `${group.name}：${group.subjectIds.map((subjectId) => source.subjects.find((subject) => subject.id === subjectId)?.name ?? '已移除科目').join('、')}`
        : '无';
    }
    if (kind === 'student') {
      const roster = before ? draft.baseline?.analysis.roster : draft.configuration.assignments;
      const groupId = roster?.find((student) => student.studentId === id)?.groupId;
      return source.groups.find((group) => group.id === groupId)?.name ?? '无';
    }
    return '配置变化';
  }
  return {
    label: kind === 'exam' ? (labels[id] ?? difference.label) : difference.label,
    before: describe(true),
    after: describe(false),
  };
}

export function scoreText(value: ScoreValue | null): string {
  if (!value) return '不在范围';
  if (value.status === 'valid')
    return (value.hundredths / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
  return { absent: '缺考', missing: '未录入', not_selected: '未选考' }[value.status];
}
