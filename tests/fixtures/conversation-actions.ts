import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workspace } from '../../src/core/workspace';
import { gradingStorageFixture } from './grading-storage';
import { lessonFixture } from './lesson-storage';

async function main() {
  const [data, output] = process.argv.slice(2);
  if (!data || !output) throw new Error('Synthetic data and fixture output required');
  const workspace = new Workspace(join(data, 'workspace-data'));
  try {
    const g = await gradingStorageFixture(workspace, { additionalStudentScore: '7' });
    const classId = workspace
      .snapshot()
      .students.find((student) => student.id === g.request.studentId)!.classId;
    for (let i = 2; i < 400; i++)
      workspace.saveStudent({
        epoch: g.epoch,
        classId,
        studentNumber: `SYN-L-${String(i).padStart(4, '0')}`,
        displayName: `合成成员${i}`,
      });
    const event = workspace.growth.saveEvent({
      epoch: g.epoch,
      requestId: randomUUID(),
      studentId: g.request.studentId,
      reason: '合成测试',
      content: {
        date: '2026-10-03',
        kind: 'event',
        description: '已完成课堂合成任务',
        source: '教师观察',
        action: '',
        result: '',
        followUp: 'none',
        summaryFact: '已完成课堂任务',
      },
    });
    const summary = workspace.growth.createManual({
      epoch: g.epoch,
      requestId: randomUUID(),
      selection: {
        studentId: g.request.studentId,
        from: '2026-10-01',
        to: '2026-10-03',
        events: [{ id: event.id, revision: 1 }],
        scores: [],
      },
      acknowledgeSyntheticOnly: true,
      acknowledgeRedacted: true,
      content: '已完成课堂任务；继续观察学习情况。',
    });
    const { request, content } = lessonFixture(randomUUID());
    request.selection = [];
    const block = {
      kind: 'paragraph' as const,
      text: '力的大小、方向和作用点。',
      origin: { kind: 'supplement' as const },
    };
    content.objectives = [block];
    content.keyPoints = [block];
    content.difficulties = [block];
    content.sections[0]!.content = [block];
    content.slides[0]!.content = [block];
    content.slides.push({
      ...structuredClone(content.slides[0]!),
      id: 'slide-2',
      title: '合成练习',
    });
    writeFileSync(
      output,
      JSON.stringify(
        {
          epoch: g.epoch,
          classId: workspace
            .snapshot()
            .students.find((student) => student.id === g.request.studentId)!.classId,
          studentId: g.request.studentId,
          gradingId: g.draft.id,
          examId: g.score.examId,
          summaryId: summary.id,
          lesson: { request, content },
          edits: g.edits,
        },
        null,
        2,
      ),
    );
  } finally {
    workspace.close();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
