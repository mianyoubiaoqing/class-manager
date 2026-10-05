import type { ScoreVersionPayload } from '../shared/score-records';
import type { ScoreDifferences } from '../shared/score-commands';
import type { ScoreValue } from '../shared/scores';

function configuration(payload: ScoreVersionPayload) {
  const values = new Map<string, { label: string; value: string }>();
  for (const [key, value] of Object.entries(payload.definition)) {
    values.set(`exam.${key}`, { label: key, value });
  }
  for (const subject of payload.analysis.subjects) {
    values.set(`subject.${subject.id}`, { label: subject.name, value: JSON.stringify(subject) });
  }
  for (const group of payload.analysis.groups) {
    values.set(`group.${group.id}`, { label: group.name, value: JSON.stringify(group) });
  }
  for (const student of payload.analysis.roster) {
    values.set(`student.${student.studentId}`, {
      label: student.displayName,
      value: JSON.stringify(student),
    });
  }
  values.set('includeRanks', {
    label: '教师私有排名',
    value: String(payload.analysis.includeRanks),
  });
  return values;
}

/** 空成绩按“未录入”比较；不存在的科目/学生用 null 表示，不与零分混同。 */
export function scoreDifferences(
  before: ScoreVersionPayload,
  after: ScoreVersionPayload,
): ScoreDifferences {
  const oldValues = new Map(
    before.analysis.entries.map((entry) => [`${entry.studentId}:${entry.subjectId}`, entry.score]),
  );
  const newValues = new Map(
    after.analysis.entries.map((entry) => [`${entry.studentId}:${entry.subjectId}`, entry.score]),
  );
  const oldStudents = new Set(before.analysis.roster.map((student) => student.studentId));
  const newStudents = new Set(after.analysis.roster.map((student) => student.studentId));
  const oldSubjects = new Set(before.analysis.subjects.map((subject) => subject.id));
  const newSubjects = new Set(after.analysis.subjects.map((subject) => subject.id));
  const scores: ScoreDifferences['scores'] = [];
  for (const studentId of new Set([...oldStudents, ...newStudents])) {
    for (const subjectId of new Set([...oldSubjects, ...newSubjects])) {
      const key = `${studentId}:${subjectId}`;
      const old: ScoreValue | null =
        oldStudents.has(studentId) && oldSubjects.has(subjectId)
          ? (oldValues.get(key) ?? { status: 'missing' })
          : null;
      const next: ScoreValue | null =
        newStudents.has(studentId) && newSubjects.has(subjectId)
          ? (newValues.get(key) ?? { status: 'missing' })
          : null;
      if (JSON.stringify(old) !== JSON.stringify(next))
        scores.push({ studentId, subjectId, before: old, after: next });
    }
  }
  const oldConfig = configuration(before);
  const newConfig = configuration(after);
  const changes: ScoreDifferences['configuration'] = [];
  for (const key of new Set([...oldConfig.keys(), ...newConfig.keys()])) {
    const old = oldConfig.get(key);
    const next = newConfig.get(key);
    if (old?.value !== next?.value)
      changes.push({
        key,
        label: (next ?? old)!.label,
        before: old?.value ?? null,
        after: next?.value ?? null,
      });
  }
  return { scores, configuration: changes };
}
