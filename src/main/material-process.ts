import { z } from 'zod';
import { LESSON_LIMITS, MATERIAL_IMAGE_LIMITS } from '../shared/lessons';
import { prepareModelImage } from '../core/material-image';
import { parseMaterial } from '../core/material-parser';
import { DomainError } from '../core/errors';
import { gradingTransformSchema } from '../shared/grading';
import { prepareGradingImage } from '../core/grading-image';

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
          ? request.operation === 'grading-image'
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
