import type {
  ClassroomBlock,
  ClassroomProjection,
  ClassroomTeacherView,
  CountdownView,
} from '../shared/classroom';
import { CLASSROOM_LIMITS } from '../shared/classroom';
import type { LessonBlock, LessonContent } from '../shared/lessons';
import { DomainError } from './errors';

/** Build a fresh allowlist object; stripping one sensitive property from a lesson is insufficient. */
export function createClassroomProjection(
  view: ClassroomTeacherView,
  content: LessonContent,
  countdown: CountdownView | null,
  readImage: (sourceVersionId: string, fragmentId: number) => Uint8Array,
): ClassroomProjection {
  const slide = content.slides.find(
    (value) => value.id === view.record.payload.slideIds[view.record.payload.index],
  );
  const section = content.sections.find((value) => value.id === slide?.sectionId);
  if (!slide || !section) throw new DomainError('VALIDATION', '课堂版本或环节不一致。');
  let imageBytes = 0;
  const images = new Map<string, string>();
  const block = (value: LessonBlock): ClassroomBlock => {
    switch (value.kind) {
      case 'paragraph':
        return { kind: 'paragraph', text: value.text };
      case 'list':
        return { kind: 'list', items: [...value.items] };
      case 'table':
        return {
          kind: 'table',
          columns: [...value.columns],
          rows: value.rows.map((row) => [...row]),
        };
      case 'image': {
        const key = `${value.source.sourceVersionId}:${value.source.fragmentId}`;
        let dataUrl = images.get(key);
        if (!dataUrl) {
          const bytes = readImage(value.source.sourceVersionId, value.source.fragmentId);
          imageBytes += bytes.byteLength;
          if (imageBytes > CLASSROOM_LIMITS.projectionImageBytes)
            throw new DomainError('STORAGE_LIMIT', '当前展示图片超过 64 MiB 上限。');
          dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
          images.set(key, dataUrl);
        }
        return { kind: 'image', dataUrl, caption: value.caption };
      }
    }
  };
  return {
    title: content.title,
    versionRevision: view.versionRevision,
    sectionTitle: section.title,
    slideTitle: slide.title,
    position: view.record.payload.index + 1,
    total: view.record.payload.slideIds.length,
    content: slide.content.map(block),
    questions: view.record.payload.questionsVisible ? section.questions.map(block) : [],
    answers: view.record.payload.answersVisible ? slide.answers.map(block) : [],
    elapsedMs: view.record.elapsedMs,
    status: view.record.status,
    durationMinutes: section.durationMinutes,
    countdown,
  };
}
