import { z } from 'zod';

export const teachingReportDocument = z
  .object({
    title: z.string().min(1).max(240),
    format: z.enum(['docx', 'xlsx']),
    rows: z
      .array(z.array(z.string().max(10000)).min(1).max(30))
      .min(1)
      .max(40000),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024,
    '报表内容超过容量限制。',
  );
export type TeachingReportDocument = z.infer<typeof teachingReportDocument>;
