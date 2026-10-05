import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { createOfficeDocument } from '../src/core/office-document';
import { paginateOfficeSlide, textLines } from '../src/core/office-layout';
import { createOfficeSnapshot } from '../src/core/office-snapshot';
import type { OfficeExportInput, OfficeSnapshot } from '../src/shared/office-export';
import type { LessonBlock, LessonContent } from '../src/shared/lessons';

const paragraph = (text: string): LessonBlock => ({
  kind: 'paragraph',
  text,
  origin: { kind: 'supplement' },
});
export async function officeFixture() {
  const sourceVersionId = randomUUID();
  const png = await sharp({
    create: { width: 300, height: 150, channels: 3, background: '#146c94' },
  })
    .png()
    .toBuffer();
  const blocks: LessonBlock[] = [
    paragraph('甲与乙：力的大小、方向与作用点。'),
    { kind: 'list', items: ['观察合成示意图', '讨论推门的作用点'], origin: { kind: 'supplement' } },
    {
      kind: 'table',
      columns: ['要素', '说明'],
      rows: [
        ['大小', '合成数值 10 N'],
        ['方向', '向右'],
      ],
      origin: { kind: 'supplement' },
    },
    {
      kind: 'image',
      source: { sourceVersionId, fragmentId: 1 },
      caption: '合成资料图，非真实课堂数据',
    },
  ];
  const content: LessonContent = {
    formatVersion: 1,
    title: '合成物理教案',
    objectives: [paragraph('教学目标')],
    keyPoints: [paragraph('重点')],
    difficulties: [paragraph('难点')],
    sections: [
      {
        id: 'intro',
        title: '观察与练习',
        durationMinutes: 10,
        content: blocks,
        questions: [paragraph('问题标记')],
        answers: [paragraph('PRIVATE_ANSWER')],
        teacherNotes: 'PRIVATE_SECTION_NOTE',
      },
    ],
    slides: [
      {
        id: 'slide-1',
        sectionId: 'intro',
        title: '力的三要素',
        content: blocks,
        answers: [paragraph('PRIVATE_SLIDE_ANSWER')],
        teacherNotes: 'PRIVATE_SLIDE_NOTE',
      },
    ],
  };
  const snapshot: OfficeSnapshot = {
    versionId: randomUUID(),
    lessonId: randomUUID(),
    revision: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    content,
    contentHash: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    images: [
      {
        sourceVersionId,
        fragmentId: 1,
        bytes: png,
        width: 300,
        height: 150,
        sha256: createHash('sha256').update(png).digest('hex'),
      },
    ],
  };
  const options: OfficeExportInput = {
    epoch: randomUUID(),
    versionId: snapshot.versionId,
    format: 'docx',
    includeAnswers: false,
    includeTeacherNotes: false,
  };
  return { snapshot, options, blocks };
}

async function xmlParts(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => name.endsWith('.xml'))
      .map(async (name) => [name, await zip.file(name)!.async('string')] as const),
  );
  return {
    zip,
    entries: Object.fromEntries(entries),
    all: entries.map(([, xml]) => xml).join('\n'),
  };
}

test('DOCX uses native paragraphs, bullets, editable tables and individual images with exact version metadata', async () => {
  const { snapshot, options } = await officeFixture();
  const result = await createOfficeDocument(snapshot, options);
  const { entries, all } = await xmlParts(result.bytes);
  const document = entries['word/document.xml']!;
  expect(document).toContain('<w:tbl>');
  expect(document).toContain('<w:numPr>');
  expect(document).toContain('<w:drawing>');
  expect(document).toContain('合成数值 10 N');
  expect(document).toContain('问题标记');
  expect(entries['docProps/custom.xml']).toContain(snapshot.contentHash);
  expect(all).toContain(snapshot.versionId);
  expect(all).not.toContain('PRIVATE_');
  expect(document).not.toContain('<w:trHeight');
  expect(document).toContain('<w:tblHeader');
});

test('PPTX remains native and wide; default answers/notes absent, opt-in notes stay off the canvas', async () => {
  const { snapshot, options } = await officeFixture();
  options.format = 'pptx';
  const clean = await xmlParts((await createOfficeDocument(snapshot, options)).bytes);
  expect(clean.entries['ppt/presentation.xml']).toContain('cx="12192000" cy="6858000"');
  expect(clean.all).toContain('<a:tbl>');
  expect(clean.all).toContain('<p:pic>');
  expect(clean.all).toContain('<a:buChar');
  expect(clean.all).not.toContain('PRIVATE_');
  const explicit = await xmlParts(
    (
      await createOfficeDocument(snapshot, {
        ...options,
        includeAnswers: true,
        includeTeacherNotes: true,
      })
    ).bytes,
  );
  const slides = Object.entries(explicit.entries)
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .map(([, xml]) => xml)
    .join('');
  expect(slides).toContain('PRIVATE_SLIDE_ANSWER');
  expect(slides).not.toContain('PRIVATE_SLIDE_NOTE');
  expect(explicit.all).toContain('PRIVATE_SLIDE_NOTE');
  expect(explicit.all).toContain(snapshot.contentHash);
  expect(explicit.all).not.toContain('PRIVATE_SECTION_NOTE');
});

test('long paragraphs, list items and oversized table rows continue without losing any original text', () => {
  const body = '中文测试 English  中文\n第二段文字。'.repeat(100);
  expect(textLines(body, 3, 19).join('')).toBe(body);
  const rows = [['甲'.repeat(500), '乙'.repeat(500)]];
  const pages = paginateOfficeSlide('长标题'.repeat(60), [
    paragraph(body),
    { kind: 'list', items: [body], origin: { kind: 'supplement' } },
    { kind: 'table', columns: ['表头', '说明'], rows, origin: { kind: 'supplement' } },
  ]);
  expect(pages.length).toBeGreaterThan(3);
  const text = pages
    .flatMap((page) =>
      page.objects.filter((object) => object.kind === 'text').map((object) => object.text),
    )
    .join('');
  expect(text).toBe(body + body);
  const tables = pages.flatMap((page) => page.objects.filter((object) => object.kind === 'table'));
  expect(tables.flatMap((table) => table.rows.slice(1).map((row) => row[0])).join('')).toBe(
    rows[0]![0],
  );
  for (const page of pages)
    for (const object of page.objects) {
      expect(object.y).toBeGreaterThanOrEqual(0);
      expect(object.y + object.h).toBeLessThanOrEqual(6.83);
    }
});

test('oversized headers use a numbered mapping and preserve full column labels across pages', () => {
  const columns = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(100));
  const pages = paginateOfficeSlide('标题'.repeat(100), [
    { kind: 'table', columns, rows: [columns.map(() => '值')], origin: { kind: 'supplement' } },
  ]);
  const tables = pages.flatMap((page) => page.objects.filter((object) => object.kind === 'table'));
  for (let column = 0; column < columns.length; column++) {
    expect(tables.flatMap((table) => table.rows.slice(1).map((row) => row[column])).join('')).toBe(
      columns[column] + '值',
    );
  }
});

test('hash mismatches, missing or corrupted images and invalid XML characters fail as a whole', async () => {
  const { snapshot, options } = await officeFixture();
  await expect(
    createOfficeDocument({ ...snapshot, contentHash: 'a'.repeat(64) }, options),
  ).rejects.toThrow(/校验/);
  await expect(createOfficeDocument({ ...snapshot, images: [] }, options)).rejects.toThrow(/缺失/);
  const corrupted = structuredClone(snapshot);
  corrupted.images[0]!.sha256 = 'b'.repeat(64);
  await expect(createOfficeDocument(corrupted, options)).rejects.toThrow(/图像校验/);
  const invalid = structuredClone(snapshot);
  invalid.content.title += '\u0000';
  invalid.contentHash = createHash('sha256').update(JSON.stringify(invalid.content)).digest('hex');
  await expect(createOfficeDocument(invalid, options)).rejects.toThrow(/字符/);
});

test('snapshot reads only actual selected export images and refuses a different immutable version', async () => {
  const { snapshot, options } = await officeFixture();
  let reads = 0;
  const version = {
    record: {
      id: snapshot.versionId,
      lessonId: snapshot.lessonId,
      revision: snapshot.revision,
      createdAt: snapshot.createdAt,
    },
    payload: { content: snapshot.content },
  };
  // The projection deliberately needs only these fields; a full domain record adds no authority.
  const project = (input: OfficeExportInput) =>
    createOfficeSnapshot(version as Parameters<typeof createOfficeSnapshot>[0], input, () => {
      reads++;
      return snapshot.images[0]!;
    });
  expect(project(options).images).toHaveLength(1);
  expect(reads).toBe(1);
  expect(() => project({ ...options, versionId: randomUUID() })).toThrow(/不匹配/);
  expect(reads).toBe(1);
});

test('excluded private notes cannot block a clean export; explicitly including XML-invalid notes rejects', async () => {
  const { snapshot, options } = await officeFixture();
  snapshot.content.sections[0]!.teacherNotes = 'private\u0000note';
  snapshot.content.slides[0]!.teacherNotes = 'private\u0000note';
  snapshot.contentHash = createHash('sha256')
    .update(JSON.stringify(snapshot.content))
    .digest('hex');
  for (const format of ['docx', 'pptx'] as const) {
    expect(
      (await createOfficeDocument(snapshot, { ...options, format })).bytes.length,
    ).toBeGreaterThan(0);
    await expect(
      createOfficeDocument(snapshot, { ...options, format, includeTeacherNotes: true }),
    ).rejects.toThrow(/字符/);
  }
});
