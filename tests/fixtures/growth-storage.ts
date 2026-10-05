import { randomUUID } from 'node:crypto';
import { Workspace } from '../../src/core/workspace';

/** 成长专用合成名册和成绩；不读取凭据、不请求模型，事件默认由调用方实际创建。 */
export async function growthStorageFixture(workspace: Workspace) {
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成成长班' });
  const classId = workspace.snapshot().classes[0]!.id;
  workspace.saveStudent({ epoch, classId, studentNumber: 'GROWTH_001', displayName: '合成成长甲' });
  workspace.saveStudent({ epoch, classId, studentNumber: 'GROWTH_002', displayName: '合成成长乙' });
  const students = workspace.snapshot().students,
    studentId = students[0]!.id,
    subjectId = randomUUID(),
    groupId = randomUUID();
  const scoreInput = {
    epoch,
    classId,
    expectedRevision: 0,
    definition: {
      name: '合成成长测验',
      date: '2026-10-01',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id: subjectId, name: '合成学科', maxScore: '10', precision: 0 as const }],
    groups: [{ id: groupId, name: '合成计分组', subjectIds: [subjectId] }],
    assignments: students.map((s) => ({ studentId: s.id, groupId })),
    scoreBasis: 'raw' as const,
    format: 'csv' as const,
    fileName: 'growth-synthetic.csv',
  };
  const preview = await workspace.scores.preview(
    Buffer.from('学生编号,合成学科\nGROWTH_001,7\nGROWTH_002,8'),
    scoreInput,
  );
  const score = workspace.scores.confirm({
    epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '合成成长测验初版',
  });
  return { epoch, classId, studentId, subjectId, score, scoreInput };
}
export async function seedGrowthWorkspace(root: string) {
  const workspace = new Workspace(root);
  try {
    return await growthStorageFixture(workspace);
  } finally {
    workspace.close();
  }
}
