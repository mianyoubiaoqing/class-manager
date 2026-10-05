import { createHash } from 'node:crypto';
import sharp from 'sharp';
import PptxGenJS from 'pptxgenjs';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { LessonBlock } from '../shared/lessons';
import {
  OFFICE_LIMITS,
  OFFICE_TEMPLATE_VERSION,
  officeExportInput,
  officeSnapshotSchema,
  type OfficeExportInput,
  type OfficeSnapshot,
} from '../shared/office-export';
import { DomainError } from './errors';
import { paginateOfficeSlide, textLines } from './office-layout';
import { matchesMaterialImage } from './material-records';
import { exportedBlocks } from './office-snapshot';

const font = 'Microsoft YaHei';
const key = (reference: { sourceVersionId: string; fragmentId: number }) =>
  `${reference.sourceVersionId}:${reference.fragmentId}`;
type Image = { bytes: Buffer; width: number; height: number };

function assertXmlText(value: unknown): void {
  if (typeof value === 'string') {
    if (
      // eslint-disable-next-line no-control-regex -- XML 1.0 cannot represent these controls.
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value) ||
      /[\ud800-\udfff]/u.test(value)
    )
      throw new DomainError(
        'EXPORT_INVALID_TEXT',
        '正文含 Office 无法表示的字符，请修订后创建新版本。',
      );
  } else if (Array.isArray(value)) value.forEach(assertXmlText);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertXmlText);
}

export async function createOfficeDocument(
  rawSnapshot: OfficeSnapshot,
  rawOptions: OfficeExportInput,
): Promise<{ bytes: Buffer; pages: number | null }> {
  const snapshot = officeSnapshotSchema.parse(rawSnapshot);
  const options = officeExportInput.parse(rawOptions);
  if (
    snapshot.versionId !== options.versionId ||
    createHash('sha256').update(JSON.stringify(snapshot.content)).digest('hex') !==
      snapshot.contentHash
  )
    throw new DomainError('EXPORT_INVALID', '冻结版内容校验失败。');
  // Validate only strings actually written to OOXML. Excluded answers, citations and private
  // notes cannot make an otherwise valid student-facing export fail.
  const visible = exportedBlocks(snapshot.content, options).flatMap((block) =>
    block.kind === 'paragraph'
      ? [block.text]
      : block.kind === 'list'
        ? block.items
        : block.kind === 'table'
          ? [...block.columns, ...block.rows.flat()]
          : [block.caption],
  );
  const parts = options.format === 'docx' ? snapshot.content.sections : snapshot.content.slides;
  assertXmlText([
    snapshot.content.title,
    ...visible,
    ...parts.map((part) => part.title),
    ...(options.includeTeacherNotes ? parts.map((part) => part.teacherNotes) : []),
  ]);
  const images = new Map<string, Image>();
  for (const image of snapshot.images) {
    if (
      images.has(key(image)) ||
      !matchesMaterialImage(Buffer.from(image.bytes), image) ||
      createHash('sha256').update(image.bytes).digest('hex') !== image.sha256 ||
      image.width * image.height > 20_000_000
    )
      throw new DomainError('EXPORT_INVALID', '资料图像校验失败。');
    const normalized = await sharp(image.bytes, { limitInputPixels: 20_000_000 })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    images.set(key(image), {
      bytes: normalized.data,
      width: normalized.info.width,
      height: normalized.info.height,
    });
  }
  const getImage = (block: Extract<LessonBlock, { kind: 'image' }>) => {
    const image = images.get(key(block.source));
    if (!image) throw new DomainError('EXPORT_INVALID', '冻结版本引用的图片缺失。');
    return image;
  };
  const metadata = JSON.stringify({
    versionId: snapshot.versionId,
    lessonId: snapshot.lessonId,
    revision: snapshot.revision,
    contentHash: snapshot.contentHash,
    templateVersion: OFFICE_TEMPLATE_VERSION,
    includeAnswers: options.includeAnswers,
    includeTeacherNotes: options.includeTeacherNotes,
  });
  const result =
    options.format === 'docx'
      ? { bytes: await createWord(snapshot, options, metadata, getImage), pages: null }
      : await createDeck(snapshot, options, metadata, getImage);
  if (!result.bytes.length || result.bytes.length > OFFICE_LIMITS.outputBytes)
    throw new DomainError('EXPORT_LIMIT', '导出文件超过 64 MiB，请创建精简备课版本。');
  return result;
}

async function createWord(
  snapshot: OfficeSnapshot,
  options: OfficeExportInput,
  metadata: string,
  getImage: (block: Extract<LessonBlock, { kind: 'image' }>) => Image,
): Promise<Buffer> {
  const content = snapshot.content;
  const children: (Paragraph | Table)[] = [];
  const paragraph = (text: string, heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel]) =>
    new Paragraph({
      children: [new TextRun({ text })],
      ...(heading ? { heading, keepNext: true } : {}),
      spacing: { after: 120, line: 360 },
      widowControl: true,
    });
  const blocks = (values: LessonBlock[]) => {
    for (const block of values) {
      if (block.kind === 'paragraph') children.push(paragraph(block.text));
      else if (block.kind === 'list')
        children.push(
          ...block.items.map(
            (text) =>
              new Paragraph({
                text,
                bullet: { level: 0 },
                spacing: { after: 100, line: 360 },
                widowControl: true,
              }),
          ),
        );
      else if (block.kind === 'image') {
        const image = getImage(block);
        const scale = Math.min(600 / image.width, 380 / image.height, 1);
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: 'png',
                data: image.bytes,
                transformation: {
                  width: Math.max(1, Math.round(image.width * scale)),
                  height: Math.max(1, Math.round(image.height * scale)),
                },
                altText: { title: block.caption, description: block.caption, name: '资料图片' },
              }),
            ],
            keepNext: true,
          }),
        );
        children.push(paragraph(block.caption));
      } else {
        const widths = block.columns.map(() => Math.floor(9360 / block.columns.length));
        const headerLines = Math.max(
          ...block.columns.map(
            (cell, column) => textLines(cell, widths[column]! / 1440, 12).length,
          ),
        );
        const rowCapacity = Math.max(1, Math.min(18, 36 - headerLines));
        // WPS does not reliably repeat a header in the middle of a single row spanning several
        // pages. Split oversized rows into bounded native continuation rows before pagination.
        const continuedRows = block.rows.flatMap((row) => {
          const cells = row.map((cell, column) => textLines(cell, widths[column]! / 1440, 12));
          const count = Math.max(...cells.map((cell) => cell.length));
          return Array.from({ length: Math.ceil(count / rowCapacity) }, (_, part) =>
            cells.map((cell) => cell.slice(part * rowCapacity, (part + 1) * rowCapacity).join('')),
          );
        });
        const edge = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
        children.push(
          new Table({
            width: { size: 9360, type: WidthType.DXA },
            columnWidths: widths,
            layout: TableLayoutType.FIXED,
            margins: { top: 100, bottom: 100, left: 100, right: 100 },
            borders: {
              top: edge,
              bottom: edge,
              left: edge,
              right: edge,
              insideHorizontal: edge,
              insideVertical: edge,
            },
            rows: [block.columns, ...continuedRows].map(
              (row, index) =>
                new TableRow({
                  tableHeader: index === 0,
                  cantSplit: index !== 0,
                  children: row.map(
                    (text, column) =>
                      new TableCell({
                        width: { size: widths[column]!, type: WidthType.DXA },
                        shading: index === 0 ? { fill: 'F2F2F2' } : undefined,
                        children: [paragraph(text)],
                      }),
                  ),
                }),
            ),
          }),
        );
        children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      }
    }
  };
  children.push(paragraph(content.title, HeadingLevel.TITLE));
  children.push(paragraph(`冻结版本 ${snapshot.revision} · ${snapshot.versionId}`));
  for (const [title, values] of [
    ['教学目标', content.objectives],
    ['教学重点', content.keyPoints],
    ['教学难点', content.difficulties],
  ] as const) {
    children.push(paragraph(title, HeadingLevel.HEADING_1));
    blocks(values);
  }
  for (const section of content.sections) {
    children.push(
      paragraph(`${section.title}（${section.durationMinutes} 分钟）`, HeadingLevel.HEADING_1),
    );
    blocks(section.content);
    if (section.questions.length) {
      children.push(paragraph('课堂问题', HeadingLevel.HEADING_2));
      blocks(section.questions);
    }
    if (options.includeAnswers && section.answers.length) {
      children.push(paragraph('参考答案（教师选择导出）', HeadingLevel.HEADING_2));
      blocks(section.answers);
    }
    if (options.includeTeacherNotes && section.teacherNotes) {
      children.push(paragraph('教师私有备注（教师选择导出）', HeadingLevel.HEADING_2));
      children.push(paragraph(section.teacherNotes));
    }
  }
  return Packer.toBuffer(
    new Document({
      title: content.title,
      creator: 'Class Manager',
      subject: metadata,
      description: metadata,
      revision: snapshot.revision,
      customProperties: [{ name: 'ClassManagerVersion', value: metadata }],
      styles: {
        default: {
          document: {
            run: {
              font: { ascii: font, hAnsi: font, eastAsia: font },
              size: 24,
              color: '000000',
              language: { eastAsia: 'zh-CN' },
            },
          },
          title: { run: { font, size: 36, bold: true, color: '000000' } },
          heading1: { run: { font, size: 30, bold: true, color: '000000' } },
          heading2: { run: { font, size: 26, bold: true, color: '000000' } },
        },
      },
      sections: [
        {
          properties: {
            page: {
              size: { width: 11906, height: 16838 },
              margin: {
                top: 1000,
                bottom: 1000,
                left: 1273,
                right: 1273,
                header: 400,
                footer: 450,
              },
            },
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: `冻结版本 ${snapshot.revision} · ${OFFICE_TEMPLATE_VERSION} · 第 `,
                      size: 18,
                    }),
                    new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
                    new TextRun({ text: ' 页', size: 18 }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    }),
  );
}

async function createDeck(
  snapshot: OfficeSnapshot,
  options: OfficeExportInput,
  metadata: string,
  getImage: (block: Extract<LessonBlock, { kind: 'image' }>) => Image,
): Promise<{ bytes: Buffer; pages: number }> {
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'Class Manager';
  deck.subject = metadata;
  deck.title = snapshot.content.title;
  deck.company = 'Class Manager';
  deck.theme = { headFontFace: font, bodyFontFace: font };
  let count = 0;
  for (const logical of snapshot.content.slides) {
    const values = [
      ...logical.content,
      ...(options.includeAnswers && logical.answers.length
        ? [
            {
              kind: 'paragraph' as const,
              text: '参考答案（教师选择导出）',
              origin: { kind: 'supplement' as const },
            },
            ...logical.answers,
          ]
        : []),
    ];
    const pages = paginateOfficeSlide(logical.title, values);
    for (const [index, page] of pages.entries()) {
      if (++count > OFFICE_LIMITS.pages)
        throw new DomainError('EXPORT_LIMIT', '课件超过 1000 页，请创建精简备课版本。');
      const slide = deck.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addText(page.title, {
        x: 0.55,
        y: 0.3,
        w: 12.05,
        h: page.titleHeight,
        fontFace: font,
        fontSize: 26,
        color: '17212B',
        bold: true,
        margin: 0,
        breakLine: false,
        valign: 'top',
        fit: 'none',
        lang: 'zh-CN',
      });
      for (const object of page.objects) {
        if (object.kind === 'text')
          slide.addText(object.text, {
            x: 0.55,
            y: object.y,
            w: 12.05,
            h: object.h,
            fontFace: font,
            fontSize: object.fontSize,
            color: '17212B',
            margin: 0,
            valign: 'top',
            fit: 'none',
            lineSpacingMultiple: 1.12,
            ...(object.bullet ? { bullet: { indent: 16 }, hanging: 4 } : {}),
            lang: 'zh-CN',
          });
        else if (object.kind === 'table')
          slide.addTable(
            object.rows.map((row) => row.map((text) => ({ text }))),
            {
              x: 0.55,
              y: object.y,
              w: 12.05,
              h: object.h,
              colW: object.rows[0]!.map(() => 12.05 / object.rows[0]!.length),
              rowH: object.rowHeights,
              fontFace: font,
              fontSize: 16,
              color: '17212B',
              margin: [3, 5, 3, 5],
              valign: 'top',
              border: { type: 'solid', color: 'D9D9D9', pt: 0.5 },
              autoPage: false,
            },
          );
        else {
          const image = getImage(object.block);
          const scale = Math.min(12.05 / image.width, object.h / image.height);
          slide.addImage({
            data: `image/png;base64,${image.bytes.toString('base64')}`,
            x: 0.55,
            y: object.y,
            w: image.width * scale,
            h: image.height * scale,
            altText: object.block.caption,
          });
        }
      }
      slide.addText(
        `冻结版本 ${snapshot.revision} · ${logical.id}${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''} · ${count}`,
        {
          x: 0.55,
          y: 7.05,
          w: 12.05,
          h: 0.2,
          fontFace: font,
          fontSize: 10,
          color: '626B73',
          margin: 0,
          lang: 'zh-CN',
        },
      );
      slide.addNotes(
        [
          `Class Manager 来源：${metadata}`,
          `逻辑页 ${logical.id}；环节 ${logical.sectionId}`,
          ...(options.includeTeacherNotes && logical.teacherNotes
            ? [`教师私有备注：${logical.teacherNotes}`]
            : []),
        ].join('\n'),
      );
    }
  }
  const result = await deck.write({ outputType: 'nodebuffer', compression: true });
  if (!(result instanceof Uint8Array)) throw new DomainError('EXPORT_FAILED', '课件生成失败。');
  return { bytes: Buffer.from(result), pages: count };
}
