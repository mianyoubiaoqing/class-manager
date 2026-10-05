import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { fromBufferPromise } from 'yauzl';
import { LESSON_LIMITS } from '../shared/lessons';
import { DomainError } from './errors';

const WORD = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const DRAWING = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE_REL = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
export const DOCX_LIMITS = {
  entries: 256,
  entryBytes: 8 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  xmlNodes: 100_000,
  depth: 64,
} as const;

export type DocxPart =
  | { kind: 'text'; paragraph: number; text: string }
  | { kind: 'image'; paragraph: number; bytes: Buffer; format: 'png' | 'jpg' };
interface Relationship {
  type: string;
  target: string;
  external: boolean;
}
function invalid(message: string): never {
  throw new DomainError('MATERIAL_INVALID', message);
}
const attribute = (tag: SaxesTagNS, local: string) => tag.attributes[local]?.value;

/** XML is data: no DTD, entity expansion, network, external parsers or permissive repair. */
function parseXml(
  bytes: Buffer,
  budget: { nodes: number },
  open: (tag: SaxesTagNS, depth: number) => void,
  close: (tag: SaxesTagNS) => void = () => {},
  text: (value: string) => void = () => {},
) {
  let depth = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => invalid('DOCX 不接受 DTD 或实体声明。'));
  parser.on('opentag', (tag) => {
    if (++depth > DOCX_LIMITS.depth || ++budget.nodes > DOCX_LIMITS.xmlNodes)
      invalid('DOCX XML 结构超过复杂度上限。');
    open(tag, depth);
  });
  parser.on('closetag', (tag) => {
    close(tag);
    depth--;
  });
  parser.on('text', text);
  parser.on('cdata', text);
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
}

function relationshipTarget(file: string, target: string): string {
  // eslint-disable-next-line no-control-regex -- Reject control characters in archive references.
  if (!target || /[\\%?#\u0000-\u0020]/u.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target))
    invalid('DOCX 内部引用路径无效。');
  const base = file === '_rels/.rels' ? '' : posix.dirname(posix.dirname(file));
  const resolved = target.startsWith('/')
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(base, target));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/'))
    invalid('DOCX 内部引用越出文件范围。');
  return resolved;
}

/**
 * Extract bounded DOCX body paragraphs and embedded image bytes, preserving document order.
 * Images are NOT yet decoded/trusted: the caller must validate and re-encode them in an isolated
 * material task before preview, persistence or model use. No files, network, writes or retries.
 * Unsupported presentation semantics produce explicit partial warnings, never silent completeness.
 * Malformed/unsafe archives reject atomically as MATERIAL_INVALID. Run off the Main/DB thread.
 */
export async function extractDocxMaterial(bytes: Buffer): Promise<{
  parts: DocxPart[];
  completeness: 'complete' | 'partial';
  warnings: string[];
}> {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LESSON_LIMITS.fileBytes)
    invalid('资料为空或超过 10 MiB。');
  const zip = await fromBufferPromise(bytes, {
    lazyEntries: true,
    validateEntrySizes: true,
    strictFileNames: true,
  }).catch(() => invalid('文件不是有效的 DOCX 压缩包。'));
  const files = new Map<string, Buffer>();
  const names = new Set<string>();
  const relationships = new Map<string, Map<string, Relationship>>();
  const warnings = new Set<string>();
  const budget = { nodes: 0 };
  let total = 0;
  try {
    if (zip.entryCount > DOCX_LIMITS.entries) invalid('DOCX 内部文件数量超过限制。');
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (
        !name ||
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').includes('..') ||
        name.split('/').includes('.') ||
        // eslint-disable-next-line no-control-regex -- Archive names must not contain controls.
        /[%\u0000-\u0020]/u.test(name) ||
        names.has(name.toLowerCase()) ||
        entry.isEncrypted() ||
        ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
      )
        invalid('DOCX 含重复、加密、链接或无效内部文件。');
      names.add(name.toLowerCase());
      const local = await zip.readLocalFileHeaderPromise(entry);
      if (!local.fileName.equals(entry.fileNameRaw)) invalid('DOCX 内部文件路径不一致。');
      if (/(?:^|\/)(?:embeddings|activeX)(?:\/|$)|vbaProject|\.bin$/i.test(name))
        invalid('DOCX 不接受宏、活动控件或嵌入程序。');
      if (
        entry.uncompressedSize > DOCX_LIMITS.entryBytes ||
        total + entry.uncompressedSize > DOCX_LIMITS.expandedBytes
      )
        invalid('DOCX 解压内容超过限制。');
      const chunks: Buffer[] = [];
      const stream = await zip.openReadStreamPromise(entry);
      let size = 0;
      let checksum = 0;
      try {
        for await (const chunk of stream) {
          const data = Buffer.from(chunk);
          size += data.length;
          total += data.length;
          if (size > DOCX_LIMITS.entryBytes || total > DOCX_LIMITS.expandedBytes)
            invalid('DOCX 实际解压内容超过限制。');
          checksum = crc32(data, checksum);
          chunks.push(data);
        }
      } finally {
        stream.destroy();
      }
      if (checksum !== entry.crc32) invalid('DOCX 内部文件校验失败。');
      if (name.endsWith('/')) continue;
      files.set(name, Buffer.concat(chunks));
    }

    let mainType: string | undefined;
    const overrides = new Set<string>();
    for (const [file, content] of files) {
      if (!file.endsWith('.xml') && !file.endsWith('.rels')) continue;
      if (file.endsWith('.rels')) {
        const refs = new Map<string, Relationship>();
        let rootSeen = false;
        parseXml(content, budget, (tag, depth) => {
          if (!rootSeen) {
            rootSeen = true;
            if (tag.uri !== REL || tag.local !== 'Relationships') invalid('DOCX 关系根节点无效。');
            return;
          }
          if (depth !== 2 || tag.uri !== REL || tag.local !== 'Relationship')
            invalid('DOCX 关系结构无效。');
          const id = attribute(tag, 'Id');
          const type = attribute(tag, 'Type');
          const target = attribute(tag, 'Target');
          const mode = attribute(tag, 'TargetMode');
          if (
            !id ||
            !type ||
            !target ||
            refs.has(id) ||
            (mode && mode !== 'Internal' && mode !== 'External')
          )
            invalid('DOCX 关系缺失、重复或无效。');
          const external = mode === 'External';
          if (external && !type.endsWith('/hyperlink'))
            invalid('DOCX 不接受外部模板、图片或数据引用。');
          if (external) warnings.add('外部超链接只保留显示文字，不访问链接目标。');
          if (/\/(?:oleObject|package|control|aFChunk|vbaProject)$/.test(type))
            invalid('DOCX 含不支持的活动或嵌入内容。');
          const resolved = external ? target : relationshipTarget(file, target);
          if (!external && !files.has(resolved)) invalid('DOCX 内部引用的文件不存在。');
          refs.set(id, { type, target: resolved, external });
        });
        relationships.set(file, refs);
      } else if (file === '[Content_Types].xml') {
        parseXml(content, budget, (tag, depth) => {
          if (tag.uri !== TYPES) invalid('DOCX 内容类型命名空间无效。');
          if (depth === 1) {
            if (tag.local !== 'Types') invalid('DOCX 内容类型根节点无效。');
            return;
          }
          if (depth !== 2 || !['Default', 'Override'].includes(tag.local))
            invalid('DOCX 内容类型结构无效。');
          const type = attribute(tag, 'ContentType') ?? '';
          if (/macroenabled|vbaproject|activex/i.test(type)) invalid('DOCX 不接受宏格式。');
          if (tag.local === 'Override') {
            const part = attribute(tag, 'PartName');
            if (!part || overrides.has(part)) invalid('DOCX 内容类型重复或缺失。');
            overrides.add(part);
            if (part === '/word/document.xml') mainType = type;
          }
        });
      } else if (file !== 'word/document.xml') {
        // Validate even unused XML so malformed or hostile side parts cannot hide behind selection.
        parseXml(content, budget, () => {});
        if (/^word\/(?:header|footer|footnotes|endnotes|comments)/.test(file))
          warnings.add('页眉、页脚、脚注、尾注和批注未纳入正文，请对照原文件。');
        if (file === 'word/styles.xml')
          warnings.add('样式继承、隐藏规则和分页未还原，请对照原文件确认可用文字。');
      }
    }
    const main = files.get('word/document.xml');
    const office = [...(relationships.get('_rels/.rels')?.values() ?? [])].filter((ref) =>
      ref.type.endsWith('/officeDocument'),
    );
    if (
      !main ||
      mainType !==
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' ||
      office.length !== 1 ||
      office[0]!.external ||
      office[0]!.target !== 'word/document.xml'
    )
      invalid('DOCX 缺少标准正文或正文身份不一致。');

    const parts: DocxPart[] = [];
    const refs = relationships.get('word/_rels/document.xml.rels');
    let paragraph = 0;
    let current = 0;
    let body = false;
    let bodyCount = 0;
    let rootSeen = false;
    let inText = false;
    let skipped = 0;
    let runHidden = false;
    let characters = 0;
    let imageBytes = 0;
    let text = '';
    const flush = () => {
      if (text.trim()) parts.push({ kind: 'text', paragraph: current, text });
      text = '';
      if (parts.length > LESSON_LIMITS.sourceFragments) invalid('DOCX 资料片段超过 500 个。');
    };
    const append = (value: string) => {
      text += value;
      characters += value.length;
      if (text.length > LESSON_LIMITS.fragmentCharacters)
        invalid('DOCX 单段超过 8000 字符，请先分段。');
      if (characters > LESSON_LIMITS.sourceCharacters) invalid('DOCX 文字超过 200000 字符。');
    };
    parseXml(
      main,
      budget,
      (tag, depth) => {
        if (!rootSeen) {
          rootSeen = true;
          if (!WORD.has(tag.uri) || tag.local !== 'document') invalid('DOCX 正文根节点无效。');
          return;
        }
        if (skipped) {
          skipped++;
          return;
        }
        if (WORD.has(tag.uri) && tag.local === 'body') {
          if (depth !== 2 || ++bodyCount !== 1) invalid('DOCX 正文区域重复或嵌套无效。');
          body = true;
          return;
        }
        if (!body) return;
        if (WORD.has(tag.uri)) {
          if (['del', 'moveFrom', 'txbxContent'].includes(tag.local) || tag.local === 'altChunk') {
            warnings.add('删除修订、文本框或外部片段未纳入正文，请对照原文件。');
            skipped = 1;
            return;
          }
          if (['tbl', 'numPr', 'fldChar', 'instrText', 'sym'].includes(tag.local))
            warnings.add('表格按段落提取；自动编号、字段及特殊符号不保证还原，请对照原文件。');
          if (tag.local === 'p') {
            if (current) invalid('DOCX 段落结构嵌套无效。');
            current = ++paragraph;
          }
          if (tag.local === 'r') runHidden = false;
          if (tag.local === 'vanish' || tag.local === 'webHidden') {
            const value = Object.values(tag.attributes).find(
              (attr) => WORD.has(attr.uri) && attr.local === 'val',
            )?.value;
            if (!['false', '0', 'off'].includes(value ?? '')) {
              runHidden = true;
              warnings.add('隐藏文字未纳入正文；原文样式及分页未还原。');
            }
          }
          if (tag.local === 't' && current && !runHidden) inText = true;
          if (current && !runHidden && tag.local === 'tab') append('\t');
          if (current && !runHidden && (tag.local === 'br' || tag.local === 'cr')) append('\n');
        } else if (DRAWING.has(tag.uri) && tag.local === 'blip' && current && !runHidden) {
          const embed = Object.values(tag.attributes).find(
            (attr) => OFFICE_REL.has(attr.uri) && attr.local === 'embed',
          )?.value;
          const ref = embed ? refs?.get(embed) : undefined;
          if (!ref || ref.external || !ref.type.endsWith('/image'))
            invalid('DOCX 图片来源缺失或无效。');
          const image = files.get(ref.target);
          if (!image) invalid('DOCX 图片数据缺失。');
          const extension = posix.extname(ref.target).toLowerCase();
          if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
            warnings.add('非 PNG/JPG 的插图未提取，请转换格式或单独上传图片。');
            return;
          }
          flush();
          imageBytes += image.length;
          if (imageBytes > DOCX_LIMITS.expandedBytes)
            invalid('DOCX 引用图片累计超过 32 MiB 上限。');
          if (parts.length >= LESSON_LIMITS.sourceFragments) invalid('DOCX 资料片段超过 500 个。');
          parts.push({
            kind: 'image',
            paragraph: current,
            bytes: Buffer.from(image),
            format: extension === '.png' ? 'png' : 'jpg',
          });
        } else if (DRAWING.has(tag.uri) && ['srcRect', 'xfrm', 't'].includes(tag.local)) {
          warnings.add('图形中的文字、裁剪和变换未还原；插图采用嵌入原图，请对照原文件。');
        } else if (
          tag.local === 'AlternateContent' ||
          tag.uri === 'urn:schemas-microsoft-com:vml'
        ) {
          warnings.add('兼容绘图或旧式图形未提取，请对照原文件并单独上传。');
          skipped = 1;
        } else if (
          !DRAWING.has(tag.uri) &&
          ![
            'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
            'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
            'http://schemas.openxmlformats.org/drawingml/2006/picture',
            'http://purl.oclc.org/ooxml/drawingml/picture',
          ].includes(tag.uri)
        ) {
          warnings.add('不支持的公式、图表或扩展内容未提取，请对照原文件。');
        }
      },
      (tag) => {
        if (skipped) {
          skipped--;
          return;
        }
        if (!WORD.has(tag.uri)) return;
        if (tag.local === 't') inText = false;
        if (tag.local === 'r') runHidden = false;
        if (tag.local === 'p' && body) {
          flush();
          current = 0;
        }
        if (tag.local === 'body') body = false;
      },
      (value) => {
        if (inText && !skipped && !runHidden) append(value);
      },
    );
    if (bodyCount !== 1 || !parts.length) invalid('DOCX 没有可用正文或支持的图片。');
    if (parts.length > LESSON_LIMITS.sourceFragments) invalid('DOCX 资料片段超过 500 个。');
    return { parts, completeness: warnings.size ? 'partial' : 'complete', warnings: [...warnings] };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalid('DOCX 压缩或 XML 结构损坏，未导入部分结果。');
  } finally {
    zip.close();
  }
}
