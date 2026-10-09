import { z } from 'zod';
import catalog from './resource-library/catalog.json';
import type { PrintReceipt } from './printing';
import type { Result, Receipt } from './contracts';
import {
  folderScanInput,
  folderReadInput,
  resourceLinkInput,
  type FolderInventory,
  type FolderReadReceipt,
} from './material-folders';
export const resourceSubjects = catalog.subjects;
export const resourceTypes = {
  courseware: '课件',
  design: '教学设计',
  review: '复习资料',
} as const;
export const resourceReadInput = z
  .object({
    epoch: z.uuid(),
    key: z.string().max(160),
    type: z.enum(['courseware', 'design', 'review']),
  })
  .strict();
export const resourceSaveInput = resourceReadInput.extend({
  expectedRevision: z.number().int().nonnegative(),
  requestId: z.uuid(),
  body: z.string().max(50000),
});
export type ResourceReadInput = z.infer<typeof resourceReadInput>;
export const resourceFileExtensions = [
  'ppt',
  'pptx',
  'pdf',
  'doc',
  'docx',
  'key',
  'mp4',
  'txt',
  'png',
  'jpg',
  'jpeg',
];
export const resourceAttachmentInput = resourceReadInput.extend({ id: z.uuid() });
export const resourceLinkSaveInput = resourceReadInput.extend({
  name: z.string().trim().min(1).max(200),
  url: resourceLinkInput.shape.url,
});
export const resourceExportInput = resourceReadInput.extend({ body: resourceSaveInput.shape.body });
export const resourceFolderReadInput = folderReadInput.extend({
  key: resourceReadInput.shape.key,
  type: resourceReadInput.shape.type,
});
export interface ResourceAttachment {
  id: string;
  name: string;
  bytes: number;
  url: string | null;
  createdAt: string;
}
export interface ResourceApi {
  previewResourcePrint(input: z.input<typeof resourceExportInput>): Promise<Result<PrintReceipt>>;
  readResourceDocument(input: ResourceReadInput): Promise<Result<ResourceDocument>>;
  saveResourceDocument(input: z.input<typeof resourceSaveInput>): Promise<Result<ResourceDocument>>;
  listResourceAttachments(input: ResourceReadInput): Promise<Result<ResourceAttachment[]>>;
  selectResourceFiles(input: ResourceReadInput): Promise<Result<FolderReadReceipt>>;
  scanResourceFolder(
    input: z.input<typeof folderScanInput>,
  ): Promise<Result<FolderInventory | null>>;
  readResourceFolder(
    input: z.input<typeof resourceFolderReadInput>,
  ): Promise<Result<FolderReadReceipt>>;
  addResourceLink(
    input: z.input<typeof resourceLinkSaveInput>,
  ): Promise<Result<ResourceAttachment>>;
  removeResourceAttachment(input: z.input<typeof resourceAttachmentInput>): Promise<Result<void>>;
  openResourceAttachment(input: z.input<typeof resourceAttachmentInput>): Promise<Result<void>>;
  exportResourceDocument(
    input: z.input<typeof resourceExportInput>,
  ): Promise<Result<Receipt | null>>;
}
export interface ResourceDocument {
  key: string;
  type: ResourceReadInput['type'];
  revision: number;
  body: string;
  updatedAt: string | null;
}
export function resourceSection(key: string) {
  const m = /^([a-z]+):([a-z0-9]+):b(\d+):u(\d+):l(\d+):s(\d+)$/.exec(key);
  if (!m) throw new Error('课程不存在，请重新选择教材章节。');
  const subject = resourceSubjects.find((s) => s.id === m[1]);
  const version = subject?.versions.find((v) => v.id === m[2]);
  const book = version?.books[Number(m[3])],
    unit = book?.units[Number(m[4])],
    lesson = unit?.lessons[Number(m[5])],
    section = lesson?.sections[Number(m[6])];
  if (!subject || !version || !book || !unit || !lesson || !section)
    throw new Error('课程不存在，请重新选择教材章节。');
  return { subject, version, book, unit, lesson, section };
}
const pedagogy: Record<string, { goals: string; activity: string; practice: string }> = {
  zz: {
    goals: '政治认同、科学精神、法治意识、公共参与。结合具体议题形成有依据的判断。',
    activity: '用社会生活情境设置议题，辨析观点，依据概念与材料展开论证。',
    practice: '材料分析：提取有效信息，联系相关概念，写出观点、依据与结论。',
  },
  yw: {
    goals: '语言建构与运用、思维发展与提升、审美鉴赏与创造、文化传承与理解。',
    activity: '阅读与朗读文本，圈点语句，分析语言、结构和表达效果，再组织讨论与写作。',
    practice: '结合文本证据回答阅读问题，完成短文写作并修改语言表达。',
  },
  sx: {
    goals: '数学抽象、逻辑推理、数学建模、直观想象、数学运算、数据分析。',
    activity: '从实例提出数学问题，抽象定义，用图形或符号表示，推理证明并检验结果。',
    practice: '概念辨析 → 基础计算或证明 → 变式应用；记录关键步骤和适用条件。',
  },
  yy: {
    goals: '语言能力、文化意识、思维品质、学习能力。围绕主题开展英语理解与表达。',
    activity: '导入主题语境，开展听读理解，归纳词汇和语言结构，组织口语互动与写作。',
    practice: '在真实语境中使用目标词汇与句式，完成理解、口头表达及写作任务。',
  },
  ls: {
    goals: '唯物史观、时空观念、史料实证、历史解释、家国情怀。',
    activity: '建立时间线和空间背景，对照不同史料，辨析事实与解释，论证历史因果。',
    practice: '阅读史料，说明背景、证据、变化与影响；每一结论对应史料依据。',
  },
  dl: {
    goals: '人地协调观、综合思维、区域认知、地理实践力。',
    activity: '读图定位，观察地理现象，分析自然与人文因素，比较区域并讨论解决方案。',
    practice: '从地图、图表和区域材料中提取信息，解释过程并评价人地关系。',
  },
  wl: {
    goals: '物理观念、科学思维、科学探究、科学态度与责任。',
    activity: '观察物理现象，提出假设，设计实验与变量控制，建模分析并说明适用条件。',
    practice: '画出受力或过程示意图，选择规律、列式、检查单位并解释结果。',
  },
  hx: {
    goals:
      '宏观辨识与微观探析、变化观念与平衡思想、证据推理与模型认知、科学探究与创新意识、科学态度与社会责任。',
    activity: '联系宏观现象与微观模型，依据实验现象和数据解释反应，落实实验安全。',
    practice: '核对物质、条件与现象，用方程式或模型解释变化，并设计验证实验。',
  },
  sw: {
    goals: '生命观念、科学思维、科学探究、社会责任。',
    activity: '观察生命现象，分析结构与功能，提出问题，设计对照实验，解释数据与模型。',
    practice: '用概念图梳理生命过程，根据实验数据分析变量、证据和结论。',
  },
  ry: {
    goals: '语言能力、文化意识、思维品质、学习能力。围绕主题开展日语交流。',
    activity: '设置交际情境，练习假名、词汇和句型，开展听读理解、对话及书面表达。',
    practice: '使用目标词汇、助词和句型完成情境对话，检查语体与表达准确性。',
  },
};
export function resourceTemplate(key: string, type: ResourceReadInput['type']): string {
  const { subject, version, book, section } = resourceSection(key),
    p = pedagogy[subject.id]!;
  const knowledge = section.points.length
    ? section.points.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '请结合正在使用的教材，填写本课概念、知识点或语言项目。';
  const head = `${section.title} · ${resourceTypes[type]}\n高中${subject.name} · ${version.name} · ${book.code} ${book.title}\n`;
  if (type === 'review')
    return `${head}\n一、知识梳理\n${knowledge}\n\n二、方法与练习\n${p.practice}\n\n三、易错点与订正\n填写本课实际出现的错误、原因和订正步骤。\n\n四、自测与答案\n补充经过核对的题目、答案及解析。`;
  return `${head}\n一、教学目标\n${p.goals}\n\n二、核心内容\n${section.text || '请根据实际教材填写本课内容摘要。'}\n${knowledge}\n\n三、重点与难点\n结合班级学情填写，说明需要理解的概念、方法与常见困难。\n\n四、${type === 'courseware' ? '课件页面安排' : '教学过程'}\n1. 情境导入：联系本课主题，提出具体问题。\n2. 核心学习：${p.activity}\n3. 练习与反馈：${p.practice}\n4. 小结：归纳本课知识与方法。\n\n五、作业与评价\n填写分层任务、完成标准和反馈安排。\n\n六、${type === 'courseware' ? '展示素材与讲解备注' : '板书设计与教学反思'}\n在此补充。`;
}
