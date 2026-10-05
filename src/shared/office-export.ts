import { z } from 'zod';
import { lessonContentSchema } from './lessons';

export const OFFICE_TEMPLATE_VERSION = 'chinese-lesson-v1';
export const OFFICE_LIMITS = {
  imageBytes: 32 * 1024 * 1024,
  totalImageBytes: 64 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  pages: 1000,
} as const;
export const officeExportInput = z
  .object({
    epoch: z.uuid(),
    versionId: z.uuid(),
    format: z.enum(['docx', 'pptx']),
    includeAnswers: z.boolean(),
    includeTeacherNotes: z.boolean(),
  })
  .strict();
export const officeOpenInput = z.object({ epoch: z.uuid(), token: z.uuid() }).strict();
export const officeSnapshotSchema = z
  .object({
    versionId: z.uuid(),
    lessonId: z.uuid(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    content: lessonContentSchema,
    images: z
      .array(
        z
          .object({
            sourceVersionId: z.uuid(),
            fragmentId: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            bytes: z
              .instanceof(Uint8Array)
              .refine(
                (value) => value.byteLength > 0 && value.byteLength <= OFFICE_LIMITS.imageBytes,
              ),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .refine(
    (value) =>
      value.images.reduce((sum, image) => sum + image.bytes.byteLength, 0) <=
      OFFICE_LIMITS.totalImageBytes,
    '导出图片总量超过 64 MiB',
  );
export type OfficeExportInput = z.infer<typeof officeExportInput>;
export type OfficeSnapshot = z.infer<typeof officeSnapshotSchema>;
export interface OfficeExportReceipt {
  token: string;
  name: string;
  versionId: string;
  revision: number;
  contentHash: string;
  templateVersion: typeof OFFICE_TEMPLATE_VERSION;
  format: OfficeExportInput['format'];
  sha256: string;
  pages: number | null;
  openAvailable: boolean;
  warning?: string;
}
