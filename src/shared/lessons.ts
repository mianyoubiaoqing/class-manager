import { z } from 'zod';

export const LESSON_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  sourceCharacters: 200_000,
  fragmentCharacters: 8_000,
  sourceFragments: 500,
  selectedSources: 8,
  selectedFragments: 80,
  selectedCharacters: 80_000,
  contentBytes: 1024 * 1024,
  blocks: 200,
} as const;

export const MATERIAL_IMAGE_LIMITS = {
  pixels: 20_000_000,
  outputBytes: 32 * 1024 * 1024,
  totalOutputBytes: 64 * 1024 * 1024,
} as const;

export const MATERIAL_PDF_LIMITS = {
  pages: 20,
  renderScale: 1.5,
  totalPixels: 100_000_000,
  pageTextItems: 50_000,
} as const;
export const LESSON_MODEL_IMAGE_LIMITS = {
  images: 8,
  edge: 2048,
  imageBytes: 1024 * 1024,
  totalImageBytes: 8 * 1024 * 1024,
} as const;

export const MATERIAL_MIME = {
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
} as const;

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, '内容不能为空');
const reference = z
  .object({ sourceVersionId: z.uuid(), fragmentId: z.number().int().positive() })
  .strict();
const locator = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('lines'),
      first: z.number().int().positive(),
      last: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.first <= value.last, '资料行号范围无效'),
  z.object({ kind: z.literal('paragraph'), index: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('page'), index: z.number().int().min(1).max(20) }).strict(),
]);
export const materialFragmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.number().int().positive(),
      kind: z.literal('text'),
      locator,
      text: text(LESSON_LIMITS.fragmentCharacters),
    })
    .strict(),
  z
    .object({
      id: z.number().int().positive(),
      kind: z.literal('image'),
      locator,
      assetId: z.uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.width * value.height <= 20_000_000, '图片超过像素上限'),
]);

/** Backend material snapshot. File paths and credentials never belong to source references. */
export const materialVersionSchema = z
  .object({
    id: z.uuid(),
    format: z.enum(['txt', 'docx', 'pdf', 'jpg', 'png']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    originalAssetId: z.uuid(),
    bytes: z.number().int().min(1).max(LESSON_LIMITS.fileBytes),
    completeness: z.enum(['complete', 'partial']),
    warnings: z.array(text(500)).max(20),
    fragments: z.array(materialFragmentSchema).min(1).max(LESSON_LIMITS.sourceFragments),
  })
  .strict()
  .refine(
    (value) => value.completeness !== 'partial' || value.warnings.length > 0,
    '部分解析必须说明原因',
  )
  .refine(
    (value) =>
      new Set(value.fragments.map((fragment) => fragment.id)).size === value.fragments.length,
    '资料片段编号重复',
  )
  .refine(
    (value) =>
      value.fragments.reduce(
        (sum, fragment) => sum + (fragment.kind === 'text' ? fragment.text.length : 0),
        0,
      ) <= LESSON_LIMITS.sourceCharacters,
    '资料文字超过 200000 字符',
  );

export const lessonRequestSchema = z
  .object({
    topic: text(200),
    subject: text(80),
    grade: text(80),
    durationMinutes: z.number().int().min(1).max(240),
    instructions: z.string().max(4000),
    selection: z.array(reference).min(1).max(LESSON_LIMITS.selectedFragments),
    acknowledgePartial: z.boolean(),
  })
  .strict();

/** Conversation/local authoring can start without imported material. Model generation still requires selection. */
export const localLessonRequestSchema = lessonRequestSchema.extend({
  selection: z.array(reference).max(LESSON_LIMITS.selectedFragments),
});

const citation = reference.extend({ quote: text(2000).optional() });
const origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), citations: z.array(citation).min(1).max(8) }).strict(),
  z.object({ kind: z.literal('supplement') }).strict(),
]);
export const lessonBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paragraph'), text: text(4000), origin }).strict(),
  z.object({ kind: z.literal('list'), items: z.array(text(1000)).min(1).max(20), origin }).strict(),
  z
    .object({
      kind: z.literal('table'),
      columns: z.array(text(100)).min(1).max(8),
      rows: z
        .array(z.array(text(500)).min(1).max(8))
        .min(1)
        .max(30),
      origin,
    })
    .strict(),
  z.object({ kind: z.literal('image'), source: reference, caption: text(500) }).strict(),
]);
const blocks = z.array(lessonBlockSchema).min(1).max(30);
const section = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    title: text(200),
    durationMinutes: z.number().int().min(1).max(240),
    content: blocks,
    questions: z.array(lessonBlockSchema).max(10),
    answers: z.array(lessonBlockSchema).max(10),
    teacherNotes: z.string().max(4000),
  })
  .strict();
const slide = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    sectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    title: text(200),
    content: blocks,
    answers: z.array(lessonBlockSchema).max(10),
    teacherNotes: z.string().max(4000),
  })
  .strict();

/** One structured version feeds editable lesson notes, slides and a filtered classroom view. */
export const lessonContentSchema = z
  .object({
    formatVersion: z.literal(1),
    title: text(200),
    objectives: blocks,
    keyPoints: blocks,
    difficulties: blocks,
    sections: z.array(section).min(1).max(30),
    slides: z.array(slide).min(1).max(60),
  })
  .strict();

export type MaterialVersion = z.infer<typeof materialVersionSchema>;
export type MaterialFragment = z.infer<typeof materialFragmentSchema>;
export type LessonRequest = z.infer<typeof lessonRequestSchema>;
export type LessonContent = z.infer<typeof lessonContentSchema>;
export type LessonBlock = z.infer<typeof lessonBlockSchema>;
