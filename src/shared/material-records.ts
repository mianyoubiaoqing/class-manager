import { z } from 'zod';
import { materialVersionSchema } from './lessons';

// eslint-disable-next-line no-control-regex -- Reject controls in labels used for original-file comparison.
const controls = /[\u0000-\u001f\u007f]/u;
export const materialNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !controls.test(value), '资料名称含控制字符');
export const materialRecordSchema = z
  .object({
    id: z.uuid(),
    name: materialNameSchema,
    createdAt: z.iso.datetime(),
    importRequestId: z.uuid(),
    importHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const materialReadInput = z.object({ epoch: z.uuid(), id: z.uuid() }).strict();
export const materialListInput = z.object({ epoch: z.uuid() }).strict();
export const materialAssetReadInput = materialReadInput.extend({ assetId: z.uuid() });
export const materialImageReadInput = materialReadInput.extend({
  fragmentId: z.number().int().positive(),
});
export const materialPreviewInput = materialListInput;
export const materialPreviewTokenInput = materialListInput.extend({ token: z.uuid() });
export const materialConfirmInput = materialPreviewTokenInput.extend({ requestId: z.uuid() });
export const materialPreviewImageInput = materialPreviewTokenInput.extend({
  fragmentId: z.number().int().positive(),
});
export interface MaterialPreview {
  token: string;
  name: string;
  version: z.infer<typeof materialVersionSchema>;
}
export const storedMaterialSchema = z
  .object({ record: materialRecordSchema, version: materialVersionSchema })
  .strict();
export type StoredMaterial = z.infer<typeof storedMaterialSchema>;
export type MaterialRecord = z.infer<typeof materialRecordSchema>;
export interface MaterialSummary {
  record: MaterialRecord;
  format: StoredMaterial['version']['format'];
  fragments: number;
  completeness: StoredMaterial['version']['completeness'];
}
