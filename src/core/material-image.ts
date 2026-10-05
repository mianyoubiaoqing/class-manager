import sharp from 'sharp';
import { LESSON_LIMITS, MATERIAL_IMAGE_LIMITS, LESSON_MODEL_IMAGE_LIMITS } from '../shared/lessons';
import { createHash } from 'node:crypto';
import { DomainError } from './errors';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function invalid(message: string): never {
  throw new DomainError('MATERIAL_INVALID', message);
}

function checkSinglePng(bytes: Buffer) {
  // libvips reads one PNG frame; reject APNG rather than silently losing animation frames.
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) invalid('PNG 图片数据不完整。');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (kind === 'acTL') invalid('不支持动画 PNG，请将所需帧另存为静态图片。');
    if (kind === 'IEND') {
      if (length !== 0 || end !== bytes.length) invalid('PNG 图片尾部数据无效。');
      return;
    }
    offset = end;
  }
  invalid('PNG 图片数据不完整。');
}

/** 登记的模型输入必须为单帧标准化 PNG；按字节及像素上限继续由解码器校验。 */
export function assertCanonicalPng(bytes: Buffer) {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > MATERIAL_IMAGE_LIMITS.outputBytes ||
    !bytes.subarray(0, 8).equals(pngSignature)
  )
    invalid('模型图像必须是受限标准化 PNG。');
  checkSinglePng(bytes);
}

/**
 * Fully decode bounded PNG/JPEG, apply EXIF orientation, and emit static PNG without source
 * metadata. This is not OCR or a model call. Must run in a terminable material process because
 * native decoder memory is not covered by the JS heap limit. Throws MATERIAL_INVALID atomically.
 */
export async function decodeMaterialImage(bytes: Buffer, format: 'png' | 'jpg') {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LESSON_LIMITS.fileBytes)
    invalid('图片为空或超过 10 MiB。');
  if (format === 'png') {
    if (!bytes.subarray(0, 8).equals(pngSignature)) invalid('图片内容与 PNG 格式不一致。');
    checkSinglePng(bytes);
  } else if (format !== 'jpg' || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    invalid('图片内容与 JPG 格式不一致。');
  }
  const image = sharp(bytes, {
    limitInputPixels: MATERIAL_IMAGE_LIMITS.pixels,
    failOn: 'warning',
    sequentialRead: true,
  });
  try {
    const metadata = await image.metadata();
    if (metadata.format !== (format === 'jpg' ? 'jpeg' : 'png')) invalid('图片解码格式不一致。');
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MATERIAL_IMAGE_LIMITS.pixels
    )
      invalid('图片超过 2000 万像素或尺寸无效。');
    if ((metadata.pages ?? 1) !== 1) invalid('不支持多帧图片，请分别上传静态图片。');
    const { data, info } = await image.autoOrient().png().toBuffer({ resolveWithObject: true });
    if (data.length > MATERIAL_IMAGE_LIMITS.outputBytes)
      invalid('图片标准化结果超过 32 MiB，请缩小图片。');
    return { bytes: data, width: info.width, height: info.height, mime: 'image/png' as const };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalid('图片损坏、尺寸超限或无法完整解码，未保留部分结果。');
  } finally {
    image.destroy();
  }
}

/** Private bounded task: transform an already registered canonical PNG for model use. Its input
 * can be a 32 MiB rendered PDF page. Must run in the same terminable decoder process as imports. */
export async function prepareModelImage(bytes: Buffer) {
  assertCanonicalPng(bytes);
  const image = sharp(bytes, {
    limitInputPixels: MATERIAL_IMAGE_LIMITS.pixels,
    failOn: 'warning',
    sequentialRead: true,
  });
  try {
    const { data, info } = await image
      .resize({
        width: LESSON_MODEL_IMAGE_LIMITS.edge,
        height: LESSON_MODEL_IMAGE_LIMITS.edge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    if (!data.length || data.length > LESSON_MODEL_IMAGE_LIMITS.imageBytes)
      invalid('模型图像副本超过 1 MiB，请缩小或拆分资料。');
    return {
      inputHash: createHash('sha256').update(bytes).digest('hex'),
      bytes: data,
      width: info.width,
      height: info.height,
      mime: 'image/jpeg' as const,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalid('模型图像损坏或转换失败。');
  } finally {
    image.destroy();
  }
}
