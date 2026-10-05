import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { gradingTransformSchema } from '../shared/grading';
import { MATERIAL_IMAGE_LIMITS } from '../shared/lessons';
import { assertCanonicalPng, prepareModelImage } from './material-image';
import {
  gradingEffectiveCrop,
  gradingPixelRectangle,
  gradingTransformHash,
} from './grading-geometry';
import { DomainError } from './errors';

/**
 * 在可终止材料子进程内解码受限原图，将遮盖写入 RGB 像素后裁剪/顺时针旋转。
 * 返回无源元数据的 JPEG，以及真实裁剪范围和绑定指纹；原图不修改、不落盘、不调用云。
 * 外发预览须使用返回的同一份 bytes，不能用 CSS 遮盖冒充脱敏。无法解码/尺寸不符时
 * MATERIAL_INVALID 拒绝全部输出。取消和超时由 MaterialTaskRunner 杀子进程，无自动重试。
 */
export async function prepareGradingImage(bytes: Buffer, raw: unknown) {
  const transform = gradingTransformSchema.parse(raw);
  assertCanonicalPng(bytes);
  const image = sharp(bytes, {
    limitInputPixels: MATERIAL_IMAGE_LIMITS.pixels,
    failOn: 'warning',
    sequentialRead: true,
  });
  try {
    const metadata = await image.metadata();
    if (
      metadata.width !== transform.width ||
      metadata.height !== transform.height ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.orientation !== undefined
    )
      throw new DomainError('MATERIAL_INVALID', '原图尺寸或方向与登记版本不一致。');
    const { data, info } = await image
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || info.width !== transform.width || info.height !== transform.height)
      throw new DomainError('MATERIAL_INVALID', '原图像素结构不一致。');
    for (const rectangle of transform.page.redactions) {
      const mask = gradingPixelRectangle(rectangle, info.width, info.height);
      for (let y = mask.top; y < mask.top + mask.height; y++) {
        const start = (y * info.width + mask.left) * 3;
        data.fill(0, start, start + mask.width * 3);
      }
    }
    const transformed = sharp(data, {
      raw: { width: info.width, height: info.height, channels: 3 },
    });
    let canonical: Buffer;
    try {
      canonical = await transformed
        .extract(gradingPixelRectangle(transform.page.crop, info.width, info.height))
        .rotate(transform.page.rotation)
        .png()
        .toBuffer();
    } finally {
      transformed.destroy();
    }
    const result = await prepareModelImage(canonical);
    const inputHash = createHash('sha256').update(bytes).digest('hex');
    return {
      ...result,
      inputHash,
      transformHash: gradingTransformHash(inputHash, transform),
      crop: gradingEffectiveCrop(transform.page, info.width, info.height),
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('MATERIAL_INVALID', '答卷图像转换失败，未生成可外发副本。');
  } finally {
    image.destroy();
  }
}
