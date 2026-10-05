import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createOfficeDocument } from '../../src/core/office-document';
import type { LessonBlock, LessonContent } from '../../src/shared/lessons';
import type { OfficeSnapshot, OfficeExportInput } from '../../src/shared/office-export';
import { Workspace } from '../../src/core/workspace';
import { parseMaterial } from '../../src/core/material-parser';
import { lessonProvider } from './lesson-storage';

const uuid = (index: number) => `90000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
const paragraph = (text: string): LessonBlock => ({
  kind: 'paragraph',
  text,
  origin: { kind: 'supplement' },
});
export async function officeRuntimeFixture(long = true) {
  const png = await sharp({
    create: { width: 480, height: 240, channels: 3, background: '#c5e5f4' },
  })
    .png()
    .toBuffer();
  const image: LessonBlock = {
    kind: 'image',
    source: { sourceVersionId: uuid(5), fragmentId: 1 },
    caption: '合成图片：此矩形仅用于原生图片移动与替换验收。',
  };
  const contentBlocks: LessonBlock[] = [
    paragraph('力是物体间的相互作用。力的大小、方向和作用点共同决定作用效果。'),
    {
      kind: 'list',
      items: ['观察力的作用点', '比较两种合成情境', '用规范语言描述证据'],
      origin: { kind: 'supplement' },
    },
    {
      kind: 'table',
      columns: ['情境', '大小', '方向', '作用点'],
      rows: [
        ['推门', '10 N（合成）', '向内', '门把手附近'],
        ['推门', '10 N（合成）', '向内', '门轴附近'],
      ],
      origin: { kind: 'supplement' },
    },
    image,
  ];
  const extended: LessonBlock[] = long
    ? [
        paragraph(
          '长段落核验：'.repeat(4) +
            '这是合成长文本，用于检查中文段落的自动分页、字形完整和标点换行。English words and 1234567890；内容不得被截断。'.repeat(
              25,
            ),
        ),
        {
          kind: 'table',
          columns: ['比较项目', '观察记录', '证据与解释', '课堂讨论'],
          rows: Array.from({ length: 12 }, (_, i) => [
            `记录 ${i + 1}`,
            '物体相互作用方向的合成观察记录。'.repeat(i === 5 ? 25 : 4),
            '以记录描述大小、方向和作用点，明确数据为合成例子。'.repeat(4),
            '先观察，后比较，最后解释。'.repeat(4),
          ]),
          origin: { kind: 'supplement' },
        },
      ]
    : [];
  const content: LessonContent = {
    formatVersion: 1,
    title: long
      ? '物理合成备课：力的三要素、作用效果与课堂观察记录的完整表达'.repeat(4)
      : '合成备课验收',
    objectives: [paragraph('能用大小、方向和作用点描述力；区分资料信息和补充例子。')],
    keyPoints: [paragraph('三要素共同决定力的作用效果。')],
    difficulties: [paragraph('用对照情境解释作用点差异。')],
    sections: [
      {
        id: 'intro',
        title: '观察、讨论与练习',
        durationMinutes: 40,
        content: [...contentBlocks, ...extended],
        questions: [paragraph('问题标记：为什么在门把手处推门更容易？')],
        answers: [paragraph('TEACHER_ANSWER：这只是合成参考答案，请教师复核。')],
        teacherNotes: 'TEACHER_SECTION_NOTE：只应显式出现在教师教案。',
      },
    ],
    slides: [
      {
        id: 'opening',
        sectionId: 'intro',
        title: '学习目标',
        content: [paragraph('认识力的大小、方向和作用点。')],
        answers: [],
        teacherNotes: '',
      },
      {
        id: 'main',
        sectionId: 'intro',
        title: long ? '力的三要素与合成观察对比：长标题排版核验'.repeat(5) : '力的三要素',
        content: contentBlocks,
        answers: [paragraph('TEACHER_SLIDE_ANSWER：合成参考答案。')],
        teacherNotes: 'TEACHER_SLIDE_NOTE：演讲者备注示例，不在画布。',
      },
      ...(long
        ? [
            {
              id: 'long',
              sectionId: 'intro',
              title: '长段落与多页原生表格',
              content: extended,
              answers: [],
              teacherNotes: '',
            },
          ]
        : []),
    ],
  };
  const snapshot: OfficeSnapshot = {
    versionId: uuid(1),
    lessonId: uuid(2),
    revision: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    content,
    contentHash: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    images: [
      {
        sourceVersionId: uuid(5),
        fragmentId: 1,
        bytes: png,
        width: 480,
        height: 240,
        sha256: createHash('sha256').update(png).digest('hex'),
      },
    ],
  };
  const options: OfficeExportInput = {
    epoch: uuid(3),
    versionId: uuid(1),
    format: 'docx',
    includeAnswers: false,
    includeTeacherNotes: false,
  };
  return { snapshot, options };
}

async function writeRuntimeFixture() {
  const output = resolve(process.env.CLASS_MANAGER_OFFICE_OUTPUT ?? 'output/office-layout');
  mkdirSync(output, { recursive: true });
  const { snapshot, options } = await officeRuntimeFixture();
  const reports = [];
  for (const format of ['docx', 'pptx'] as const) {
    const result = await createOfficeDocument(snapshot, { ...options, format });
    const path = join(output, `lesson.${format}`);
    writeFileSync(path, result.bytes);
    reports.push({
      format,
      path,
      bytes: result.bytes.length,
      pages: result.pages,
      sha256: createHash('sha256').update(result.bytes).digest('hex'),
    });
  }
  writeFileSync(
    join(output, 'source.json'),
    JSON.stringify(
      {
        ...snapshot,
        images: snapshot.images.map(({ bytes, ...image }) => ({
          ...image,
          byteLength: bytes.byteLength,
        })),
      },
      null,
      2,
    ),
  );
  writeFileSync(join(output, 'report.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
}
if (process.argv.includes('--write-office-fixture'))
  void writeRuntimeFixture().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

export async function seedOfficeWorkspace(root: string) {
  const workspace = new Workspace(root);
  try {
    const { snapshot } = await officeRuntimeFixture(false);
    const epoch = workspace.snapshot().epoch;
    const text = await parseMaterial(Buffer.from('合成资料：力的大小、方向和作用点。'), 'txt');
    const image = await parseMaterial(Buffer.from(snapshot.images[0]!.bytes), 'png');
    workspace.materials.store({
      epoch,
      requestId: randomUUID(),
      name: '合成资料.txt',
      parsed: text,
    });
    workspace.materials.store({
      epoch,
      requestId: randomUUID(),
      name: '合成资料.png',
      parsed: image,
    });
    for (const block of [
      ...snapshot.content.sections.flatMap((section) => section.content),
      ...snapshot.content.slides.flatMap((slide) => slide.content),
    ])
      if (block.kind === 'image')
        block.source = { sourceVersionId: image.version.id, fragmentId: 1 };
    const prepared = workspace.lessons.prepare({
      epoch,
      request: {
        topic: snapshot.content.title,
        subject: '物理',
        grade: '高中',
        durationMinutes: 40,
        instructions: '合成验收资料',
        acknowledgePartial: false,
        selection: [
          { sourceVersionId: text.version.id, fragmentId: 1 },
          { sourceVersionId: image.version.id, fragmentId: 1 },
        ],
      },
    });
    const requestId = randomUUID();
    workspace.lessons.claim({ epoch, token: prepared.token, requestId });
    const draft = workspace.lessons.complete({
      epoch,
      token: prepared.token,
      requestId,
      provider: lessonProvider,
      output: JSON.stringify(snapshot.content),
    });
    const frozen = workspace.lessons.freeze({
      epoch,
      id: draft.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      reason: 'Office 导出合成验收',
    });
    const version = workspace.lessons.readVersion({ epoch, versionId: frozen.versionId });
    const newerDraft = workspace.lessons.revise({
      epoch,
      versionId: frozen.versionId,
      requestId: randomUUID(),
    });
    workspace.lessons.edit({
      epoch,
      id: newerDraft.id,
      expectedRevision: 1,
      content: { ...version.payload.content, title: '较新版本标题不得混入首版导出' },
    });
    const newer = workspace.lessons.freeze({
      epoch,
      id: newerDraft.id,
      expectedRevision: 2,
      requestId: randomUUID(),
      reason: '较新合成冻结版',
    });
    return {
      epoch,
      draftId: newerDraft.id,
      latestVersionId: newer.versionId,
      versionId: version.record.id,
      contentHash: createHash('sha256')
        .update(JSON.stringify(version.payload.content))
        .digest('hex'),
    };
  } finally {
    workspace.close();
  }
}
