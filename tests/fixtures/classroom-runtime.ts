import { randomUUID } from 'node:crypto';
import { Workspace } from '../../src/core/workspace';
import { seedOfficeWorkspace } from './office-runtime';
export async function seedClassroomWorkspace(root: string, longTitles = false) {
  const seeded = await seedOfficeWorkspace(root);
  const workspace = new Workspace(root);
  try {
    const { epoch } = workspace.snapshot();
    workspace.createClass({ epoch, name: '合成课堂班级' });
    const classId = workspace.snapshot().classes[0]!.id;
    workspace.saveStudent({
      epoch,
      classId,
      studentNumber: 'PRIVATE001',
      displayName: 'CLASSROOM_PRIVATE_STUDENT',
    });
    const base = workspace.lessons.readVersion({ epoch, versionId: seeded.latestVersionId });
    const revised = workspace.lessons.revise({
      epoch,
      versionId: seeded.latestVersionId,
      requestId: randomUUID(),
    });
    const content = structuredClone(base.payload.content);
    content.title = '课堂离线合成版本';
    content.sections[0]!.durationMinutes = 20;
    const question = {
      kind: 'paragraph' as const,
      text: 'CLASSROOM_QUESTION_PROMPT：请说明力的三个要素。',
      origin: { kind: 'supplement' as const },
    };
    content.sections[0]!.questions = [question];
    content.sections.push({
      id: 'practice',
      title: '练习环节',
      durationMinutes: 20,
      content: [{ ...question, text: '公开练习材料' }],
      questions: [question],
      answers: [],
      teacherNotes: 'CLASSROOM_PRIVATE_NOTE_SECOND',
    });
    content.slides.push({
      id: 'practice-slide',
      sectionId: 'practice',
      title: '练习公开题目',
      content: [{ ...question, text: '请观察并讨论。' }],
      answers: [{ ...question, text: 'CLASSROOM_EXPLICIT_ANSWER' }],
      teacherNotes: 'CLASSROOM_PRIVATE_SLIDE_NOTE',
    });
    if (longTitles) {
      content.title = '课堂主题'.repeat(50);
      content.sections[0]!.title = '环节标题'.repeat(50);
      content.slides[0]!.title = '课件标题'.repeat(50);
      content.slides[0]!.content.push({
        ...question,
        text: `${'这是可滚动阅读的课堂正文。'.repeat(200)}正文末尾可见标记`,
      });
    }
    workspace.lessons.edit({ epoch, id: revised.id, expectedRevision: 1, content });
    const frozen = workspace.lessons.freeze({
      epoch,
      id: revised.id,
      expectedRevision: 2,
      requestId: randomUUID(),
      reason: '课堂离线与权限验收',
    });
    return {
      epoch,
      classId,
      draftId: revised.id,
      versionId: frozen.versionId,
      versionRevision: frozen.revision,
      content,
    };
  } finally {
    workspace.close();
  }
}
