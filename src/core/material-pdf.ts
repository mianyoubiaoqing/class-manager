import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { LESSON_LIMITS, MATERIAL_IMAGE_LIMITS, MATERIAL_PDF_LIMITS } from '../shared/lessons';
import { DomainError } from './errors';

type CanvasPair = { canvas: Canvas; context: SKRSContext2D };
function invalid(message: string): never {
  throw new DomainError('MATERIAL_INVALID', message);
}
function dimensions(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    Math.ceil(width) * Math.ceil(height) > MATERIAL_IMAGE_LIMITS.pixels
  )
    invalid('PDF 页面或中间图像超过 2000 万像素，请拆分或调整原文件。');
}

/** Bounds both page and intermediate canvases before allocating native pixel storage. */
class BoundedCanvasFactory {
  create(width: number, height: number): CanvasPair {
    dimensions(width, height);
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(pair: CanvasPair, width: number, height: number) {
    dimensions(width, height);
    pair.canvas.width = Math.ceil(width);
    pair.canvas.height = Math.ceil(height);
  }
  destroy(pair: CanvasPair) {
    pair.canvas.width = 0;
    pair.canvas.height = 0;
  }
}

// Only PDF.js's shipped font/CMap/decoder files are readable. PDF content cannot choose a path.
const requireDependency = createRequire(
  typeof __filename === 'string' ? __filename : resolve('package.json'),
);
const dependencyRoot = dirname(requireDependency.resolve('pdfjs-dist/package.json'));
const binaryKinds = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
} as const;
class BundledBinaryFactory {
  async fetch({ kind, filename: name }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (!Object.hasOwn(binaryKinds, kind) || !/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..'))
      invalid('PDF 请求了不支持的外部资源。');
    const directory = join(dependencyRoot, binaryKinds[kind as keyof typeof binaryKinds]);
    if (!readdirSync(directory).includes(name)) invalid('PDF 所需内置资源不可用。');
    const path = join(directory, name);
    if (!statSync(path).isFile() || statSync(path).size > 8 * 1024 * 1024)
      invalid('PDF 内置资源超过限制。');
    return new Uint8Array(readFileSync(path));
  }
}

export interface PdfMaterial {
  parts: (
    | { kind: 'text'; page: number; text: string }
    | { kind: 'image'; page: number; bytes: Buffer; width: number; height: number }
  )[];
  completeness: 'partial';
  warnings: string[];
}

let pdfActive = false;

/**
 * Parse byte-only PDFs inside MaterialTaskRunner, with page/text/pixel/output bounds and local
 * bundled decoding resources. Never run scripts, actions, links, OCR or remote requests. Every
 * page is rendered for original comparison, including scans and mixed text/image content.
 * Extracted text has uncertain reading order, so partial status requires teacher acknowledgement.
 * Invalid/active/encrypted/oversized input fails without a successful prefix. Parent cancellation
 * terminates this process; no persistence or automatic retry happens here.
 */
export async function extractPdfMaterial(bytes: Buffer): Promise<PdfMaterial> {
  if (pdfActive) invalid('已有 PDF 正在处理，请等待或取消。');
  pdfActive = true;
  const previousWarning = console.warn;
  let decoderWarning = false;
  // PDF.js has no warning callback. In this single-task isolated process, capture its diagnostics
  // without disclosing document-controlled messages. Some invalid images only warn and disappear.
  console.warn = (...values: unknown[]) => {
    if (typeof values[0] === 'string' && values[0].startsWith('Warning:')) decoderWarning = true;
    else previousWarning(...values);
  };
  const checkWarnings = () => {
    if (decoderWarning)
      invalid('PDF 含损坏或不能完整解析的内容，请先另存为静态 PDF；未保存部分结果。');
  };
  try {
    const result = await decodePdf(bytes, checkWarnings);
    checkWarnings();
    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('MATERIAL_INVALID', 'PDF 解码组件无法使用或资料损坏，未保存部分结果。');
  } finally {
    console.warn = previousWarning;
    pdfActive = false;
  }
}

async function decodePdf(bytes: Buffer, checkWarnings: () => void): Promise<PdfMaterial> {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > LESSON_LIMITS.fileBytes ||
    !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(bytes.subarray(0, 20).toString('latin1')) ||
    !/%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'))
  )
    invalid('PDF 为空、格式损坏或超过 10 MiB。');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    enableXfa: false,
    stopAtErrors: true,
    maxImageSize: MATERIAL_IMAGE_LIMITS.pixels,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    CanvasFactory: BoundedCanvasFactory,
    BinaryDataFactory: BundledBinaryFactory,
    verbosity: 1,
  });
  try {
    const document = await loading.promise;
    checkWarnings();
    if (document.numPages < 1 || document.numPages > MATERIAL_PDF_LIMITS.pages)
      invalid('PDF 最多 20 页，请拆分资料。');
    const metadata = await document.getMetadata();
    if (
      document.isPureXfa ||
      ('IsXFAPresent' in metadata.info && metadata.info.IsXFAPresent) ||
      ('IsAcroFormPresent' in metadata.info && metadata.info.IsAcroFormPresent) ||
      (await document.hasJSActions()) ||
      (await document.getAttachments())?.size
    )
      invalid('PDF 含脚本、表单或嵌入附件，请先另存为静态 PDF。');
    const parts: PdfMaterial['parts'] = [];
    let totalCharacters = 0;
    let totalPixels = 0;
    let totalBytes = 0;
    const canvasFactory = new BoundedCanvasFactory();
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      try {
        if ((await page.getJSActions())?.size) invalid('PDF 页面含脚本，请先另存为静态 PDF。');
        const viewport = page.getViewport({ scale: MATERIAL_PDF_LIMITS.renderScale });
        dimensions(viewport.width, viewport.height);
        const width = Math.ceil(viewport.width),
          height = Math.ceil(viewport.height);
        totalPixels += width * height;
        if (totalPixels > MATERIAL_PDF_LIMITS.totalPixels)
          invalid('PDF 页面累计像素超过限制，请拆分资料。');
        // Explicitly await stream validation; render completion alone can miss late stream errors.
        await page.getOperatorList();
        checkWarnings();
        const textContent = await page.getTextContent();
        if (textContent.items.length > MATERIAL_PDF_LIMITS.pageTextItems)
          invalid('PDF 单页文字结构超过限制。');
        let text = '';
        for (const item of textContent.items) {
          if (!('str' in item)) continue;
          text += item.str + (item.hasEOL ? '\n' : ' ');
          if (totalCharacters + text.length > LESSON_LIMITS.sourceCharacters)
            invalid('PDF 文字超过 200000 字符，请拆分资料。');
        }
        text = text.trim();
        totalCharacters += text.length;
        for (let start = 0; start < text.length; start += LESSON_LIMITS.fragmentCharacters)
          parts.push({
            kind: 'text',
            page: index,
            text: text.slice(start, start + LESSON_LIMITS.fragmentCharacters),
          });
        const pair = canvasFactory.create(width, height);
        try {
          // PDF.js publishes DOM canvas types; this adapter supplies the compatible Node API.
          await page.render({
            canvas: null,
            canvasContext: pair.context as unknown as CanvasRenderingContext2D,
            viewport,
          }).promise;
          checkWarnings();
          const image = pair.canvas.toBuffer('image/png');
          totalBytes += image.length;
          if (
            image.length > MATERIAL_IMAGE_LIMITS.outputBytes ||
            totalBytes > MATERIAL_IMAGE_LIMITS.totalOutputBytes
          )
            invalid('PDF 页面图像超过存储限制，请拆分资料。');
          parts.push({ kind: 'image', page: index, bytes: image, width, height });
        } finally {
          canvasFactory.destroy(pair);
        }
      } finally {
        page.cleanup();
      }
      if (parts.length > LESSON_LIMITS.sourceFragments) invalid('PDF 资料片段超过限制。');
    }
    return {
      parts,
      completeness: 'partial',
      warnings: [
        'PDF 文本提取可能改变阅读顺序；图表、扫描页及不能提取的文字保留为页面图像，尚未进行 OCR 或内容识别，请对照原文确认选中范围。',
      ],
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'MATERIAL_INVALID',
      'PDF 解析失败、受密码保护或内容损坏，未保存部分结果。',
    );
  } finally {
    await loading.destroy();
  }
}
