import { z } from 'zod';
import { LESSON_LIMITS, MATERIAL_IMAGE_LIMITS } from '../shared/lessons';
import { prepareModelImage } from '../core/material-image';
import { parseMaterial } from '../core/material-parser';
import { DomainError } from '../core/errors';
import { gradingTransformSchema } from '../shared/grading';
import { prepareGradingImage } from '../core/grading-image';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

const parseInputSchema = z
  .object({
    format: z.enum(['txt', 'docx', 'png', 'jpg', 'pdf']),
    bytes: z
      .instanceof(Buffer)
      .refine((value) => value.length > 0 && value.length <= LESSON_LIMITS.fileBytes),
  })
  .strict();
const inputSchema = z.union([
  parseInputSchema,
  z
    .object({
      operation: z.literal('teaching-photo'),
      bytes: z
        .instanceof(Buffer)
        .refine((value) => value.length > 0 && value.length <= 10 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      operation: z.literal('model-image'),
      bytes: z
        .instanceof(Buffer)
        .refine((value) => value.length > 0 && value.length <= MATERIAL_IMAGE_LIMITS.outputBytes),
    })
    .strict(),
  z
    .object({
      operation: z.literal('grading-image'),
      bytes: z
        .instanceof(Buffer)
        .refine((value) => value.length > 0 && value.length <= MATERIAL_IMAGE_LIMITS.outputBytes),
      transform: gradingTransformSchema,
    })
    .strict(),
]);

process.once('disconnect', () => process.exit(0));
process.once('message', async (input: unknown) => {
  let reply: unknown;
  try {
    const request = inputSchema.parse(input);
    reply = {
      ok: true,
      value:
        'operation' in request
          ? request.operation === 'teaching-photo'
            ? await teachingPhoto(request.bytes)
            : request.operation === 'grading-image'
              ? await prepareGradingImage(request.bytes, request.transform)
              : await prepareModelImage(request.bytes)
          : await parseMaterial(request.bytes, request.format),
    };
  } catch (error) {
    reply = {
      ok: false,
      error:
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : { code: 'MATERIAL_INVALID', message: '资料解析失败，未保存部分结果。' },
    };
  }
  // One process handles one source. It cannot receive follow-up commands or survive its parent.
  if (!process.connected || !process.send) process.exit(1);
  process.send(reply, (error) => process.exit(error ? 1 : 0));
});

async function teachingPhoto(original: Buffer) {
  const image = sharp(original, { limitInputPixels: 40000000, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
    throw new DomainError('MATERIAL_INVALID', '请选择静态 PNG、JPG 或 WebP 照片。');
  const { data, info } = await image
    .rotate()
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (data.length > 5 * 1024 * 1024)
    throw new DomainError('MATERIAL_INVALID', '照片处理结果超过 5 MiB，请缩小后重试。');
  return {
    bytes: data,
    inputHash: createHash('sha256').update(original).digest('hex'),
    width: info.width,
    height: info.height,
    mime: 'image/png',
  };
}
