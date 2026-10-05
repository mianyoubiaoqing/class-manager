import { createHash } from 'node:crypto';
import type { LessonVersionView } from '../shared/lesson-records';
import type { LessonBlock } from '../shared/lessons';
import {
  OFFICE_LIMITS,
  officeSnapshotSchema,
  type OfficeExportInput,
  type OfficeSnapshot,
} from '../shared/office-export';
import { DomainError } from './errors';

export function exportedBlocks(
  content: OfficeSnapshot['content'],
  options: Pick<OfficeExportInput, 'format' | 'includeAnswers'>,
): LessonBlock[] {
  return options.format === 'docx'
    ? [
        ...content.objectives,
        ...content.keyPoints,
        ...content.difficulties,
        ...content.sections.flatMap((section) => [
          ...section.content,
          ...section.questions,
          ...(options.includeAnswers ? section.answers : []),
        ]),
      ]
    : content.slides.flatMap((slide) => [
        ...slide.content,
        ...(options.includeAnswers ? slide.answers : []),
      ]);
}

/** Project a trusted, immutable saved version. Only images actually exported are read; no original
 * files, provider wire content, credentials or unrelated assets enter the export process. */
export function createOfficeSnapshot(
  version: LessonVersionView,
  options: OfficeExportInput,
  readImage: (sourceVersionId: string, fragmentId: number) => OfficeSnapshot['images'][number],
): OfficeSnapshot {
  if (version.record.id !== options.versionId)
    throw new DomainError('CONFLICT', '导出版本不匹配。');
  const images: OfficeSnapshot['images'] = [];
  const keys = new Set<string>();
  let total = 0;
  for (const block of exportedBlocks(version.payload.content, options)) {
    if (block.kind !== 'image') continue;
    const key = `${block.source.sourceVersionId}:${block.source.fragmentId}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const image = readImage(block.source.sourceVersionId, block.source.fragmentId);
    total += image.bytes.byteLength;
    if (total > OFFICE_LIMITS.totalImageBytes)
      throw new DomainError('EXPORT_LIMIT', '导出图片超过 64 MiB，请创建精简备课版本。');
    images.push(image);
  }
  return officeSnapshotSchema.parse({
    versionId: version.record.id,
    lessonId: version.record.lessonId,
    revision: version.record.revision,
    createdAt: version.record.createdAt,
    contentHash: createHash('sha256').update(JSON.stringify(version.payload.content)).digest('hex'),
    content: version.payload.content,
    images,
  });
}
