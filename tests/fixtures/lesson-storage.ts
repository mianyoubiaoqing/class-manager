import type { LessonContent, LessonRequest } from '../../src/shared/lessons';

export const lessonProvider = {
  provider: 'deepseek' as const,
  requestModel: 'synthetic',
  responseModel: 'synthetic',
  responseId: 'synthetic-lesson',
  generatedAt: '2026-09-30T00:00:00.000Z',
  durationMs: 0,
  usage: null,
};
export function lessonFixture(sourceVersionId: string) {
  const request: LessonRequest = {
    topic: '力的三要素',
    subject: '物理',
    grade: '高中',
    durationMinutes: 40,
    instructions: '使用合成例题',
    acknowledgePartial: false,
    selection: [{ sourceVersionId, fragmentId: 1 }],
  };
  const block = {
    kind: 'paragraph' as const,
    text: '力有大小、方向和作用点。',
    origin: {
      kind: 'source' as const,
      citations: [{ sourceVersionId, fragmentId: 1, quote: '力有大小、方向和作用点。' }],
    },
  };
  const answer = {
    kind: 'paragraph' as const,
    text: 'PRIVATE_ANSWER',
    origin: { kind: 'supplement' as const },
  };
  const content: LessonContent = {
    formatVersion: 1,
    title: request.topic,
    objectives: [block],
    keyPoints: [block],
    difficulties: [block],
    sections: [
      {
        id: 'introduction',
        title: '引入与练习',
        durationMinutes: 40,
        content: [block],
        questions: [],
        answers: [answer],
        teacherNotes: 'PRIVATE_NOTE',
      },
    ],
    slides: [
      {
        id: 'slide-1',
        sectionId: 'introduction',
        title: request.topic,
        content: [block],
        answers: [answer],
        teacherNotes: 'PRIVATE_SLIDE_NOTE',
      },
    ],
  };
  return { request, content };
}
