import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  LESSON_LIMITS,
  lessonContentSchema,
  lessonRequestSchema,
  localLessonRequestSchema,
  materialVersionSchema,
  type LessonBlock,
  type LessonContent,
  type LessonRequest,
  type MaterialFragment,
  type MaterialVersion,
} from '../shared/lessons';
import { DomainError } from './errors';

export interface LessonPreparation {
  request: LessonRequest;
  sources: (Pick<MaterialVersion, 'sha256' | 'completeness' | 'warnings'> & {
    sourceVersionId: string;
    fragments: MaterialFragment[];
  })[];
  fingerprint: string;
}
const key = (sourceVersionId: string, fragmentId: number) => `${sourceVersionId}:${fragmentId}`;

export function prepareLocalLesson(input: unknown): LessonPreparation {
  const request = localLessonRequestSchema.parse(input);
  if (request.selection.length)
    throw new DomainError('LESSON_INVALID', '有资料引用时必须读取实际资料。');
  const sources: LessonPreparation['sources'] = [];
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ request, sources }))
    .digest('hex');
  return { request, sources, fingerprint };
}
function invalid(message: string): never {
  throw new DomainError('LESSON_INVALID', message);
}

/**
 * Select explicit fragments from backend snapshots; never accept untrusted Renderer snapshots.
 * Returns detached, bounded context and its hash, with no filenames, paths or unselected content.
 * Parser warnings are kept privately for review; this is not a provider request payload.
 * Partial parsing requires acknowledgement. No persistence, network, model execution or retry.
 * ZodError rejects structure; LESSON_INVALID rejects missing/duplicate sources and quota violations.
 */
export function prepareLesson(
  requestInput: unknown,
  sourceInputs: readonly unknown[],
): LessonPreparation {
  const request = lessonRequestSchema.parse(requestInput);
  if (sourceInputs.length > LESSON_LIMITS.selectedSources) invalid('一次最多选择 8 份资料。');
  const sources = sourceInputs.map((input) => materialVersionSchema.parse(input));
  if (new Set(sources.map((source) => source.id)).size !== sources.length)
    invalid('资料版本重复。');
  const chosen = new Set<string>();
  const selected: LessonPreparation['sources'] = [];
  let characters = 0;
  for (const ref of request.selection) {
    const refKey = key(ref.sourceVersionId, ref.fragmentId);
    if (chosen.has(refKey)) invalid('资料片段不能重复选择。');
    chosen.add(refKey);
    const source = sources.find((item) => item.id === ref.sourceVersionId);
    if (!source) invalid('所选资料版本不存在，请重新选择。');
    if (source.completeness === 'partial' && !request.acknowledgePartial)
      invalid('资料未完整解析，请核对警告并明确确认选用可读部分。');
    const fragment = source.fragments.find((item) => item.id === ref.fragmentId);
    if (!fragment) invalid('所选资料片段不存在。');
    characters += fragment.kind === 'text' ? fragment.text.length : 0;
    if (characters > LESSON_LIMITS.selectedCharacters)
      invalid('所选文字超过 80000 字符，请缩小范围。');
    let target = selected.find((item) => item.sourceVersionId === source.id);
    if (!target) {
      target = {
        sourceVersionId: source.id,
        sha256: source.sha256,
        completeness: source.completeness,
        warnings: source.warnings,
        fragments: [],
      };
      selected.push(target);
    }
    target.fragments.push(fragment);
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ request, sources: selected }))
    .digest('hex');
  return { request, sources: selected, fingerprint };
}

/**
 * Validate model JSON before it can be a saved draft; no writes and no automatic repair/retry.
 * Enforces dimensions, section links, duration, selected citations and verbatim text quotations.
 * Cannot prove semantic accuracy of paraphrases or interpret images; these remain teacher review.
 * Preparation is a private backend result, never an IPC parameter.
 */
export function validateLessonOutput(raw: string, preparation: LessonPreparation): LessonContent {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > LESSON_LIMITS.contentBytes)
    invalid('备课结果超过大小上限。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid('备课结果不是有效 JSON，原版本未改变。');
  }
  return validateLessonContent(parsed, preparation);
}

/** Apply the same structural/source checks to teacher edits and model output; return a detached version. */
export function validateLessonContent(
  input: unknown,
  preparation: LessonPreparation,
): LessonContent {
  const content = lessonContentSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > LESSON_LIMITS.contentBytes)
    invalid('备课内容超过大小上限。');
  const sectionIds = new Set(content.sections.map((item) => item.id));
  if (
    sectionIds.size !== content.sections.length ||
    new Set(content.slides.map((item) => item.id)).size !== content.slides.length
  )
    invalid('教学环节或课件页标识重复。');
  if (
    content.sections.reduce((sum, item) => sum + item.durationMinutes, 0) !==
    preparation.request.durationMinutes
  )
    invalid('教学环节时长总和须与选定课时一致。');
  if (content.slides.some((item) => !sectionIds.has(item.sectionId)))
    invalid('课件引用了不存在的教学环节。');
  if (
    content.sections.some(
      (section) => !content.slides.some((slide) => slide.sectionId === section.id),
    )
  )
    invalid('每个教学环节至少需要一页课件。');
  const fragments = new Map(
    preparation.sources.flatMap((source) =>
      source.fragments.map(
        (fragment) => [key(source.sourceVersionId, fragment.id), fragment] as const,
      ),
    ),
  );
  const allBlocks: LessonBlock[] = [
    ...content.objectives,
    ...content.keyPoints,
    ...content.difficulties,
    ...content.sections.flatMap((item) => [...item.content, ...item.questions, ...item.answers]),
    ...content.slides.flatMap((item) => [...item.content, ...item.answers]),
  ];
  if (allBlocks.length > LESSON_LIMITS.blocks) invalid('备课内容超过 200 个内容块，请分课时处理。');
  for (const block of allBlocks) {
    if (block.kind === 'image') {
      if (
        fragments.get(key(block.source.sourceVersionId, block.source.fragmentId))?.kind !== 'image'
      )
        invalid('课件图片必须来自已选择的图像片段。');
      continue;
    }
    if (block.kind === 'table' && block.rows.some((row) => row.length !== block.columns.length))
      invalid('教学表格行列不一致。');
    if (block.origin.kind !== 'source') continue;
    const seen = new Set<string>();
    for (const ref of block.origin.citations) {
      const refKey = key(ref.sourceVersionId, ref.fragmentId);
      const fragment = fragments.get(refKey);
      if (!fragment || seen.has(refKey)) invalid('引用未选择的资料片段或引用重复。');
      seen.add(refKey);
      if (
        ref.quote !== undefined &&
        (fragment.kind !== 'text' || !fragment.text.includes(ref.quote))
      )
        invalid('引用原文无法在所选文字中逐字核实；图像原文须经识别核对后引用。');
    }
  }
  return content;
}

/**
 * Explicit classroom projection of a validated version. Drop private notes, questions and answers
 * by default; expose no sources, file IDs, prompts or raw model response. No I/O or state change.
 * Image references are retained for a later limited media resolver, not turned into file paths.
 */
export function lessonPresentation(content: LessonContent, showAnswers = false) {
  const answersAllowed = z.boolean().parse(showAnswers);
  const validated = lessonContentSchema.parse(content);
  return {
    title: validated.title,
    slides: validated.slides.map((slide) => ({
      id: slide.id,
      sectionId: slide.sectionId,
      title: slide.title,
      content: [...slide.content, ...(answersAllowed ? slide.answers : [])].map((block) => {
        if (block.kind === 'image')
          return { kind: block.kind, source: block.source, caption: block.caption };
        if (block.kind === 'paragraph') return { kind: block.kind, text: block.text };
        if (block.kind === 'list') return { kind: block.kind, items: block.items };
        return { kind: block.kind, columns: block.columns, rows: block.rows };
      }),
    })),
  };
}
