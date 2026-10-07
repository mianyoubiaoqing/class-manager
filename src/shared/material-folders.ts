import { z } from 'zod';

export const folderScanInput = z
  .object({
    epoch: z.uuid(),
    choose: z.boolean().default(false),
    remove: z.boolean().default(false),
    includeChildren: z.boolean().default(false),
  })
  .strict();
export const folderReadInput = z
  .object({
    epoch: z.uuid(),
    token: z.uuid(),
    ids: z
      .array(z.uuid())
      .min(1)
      .max(25)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const resourceLinkInput = z
  .object({
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      }, '请选择不含账号密码的 HTTPS 网站地址'),
  })
  .strict();
export interface FolderEntry {
  id: string;
  name: string;
  bytes: number;
  status: 'ready' | 'unsupported' | 'tooLarge' | 'empty';
}
export interface FolderInventory {
  token: string;
  folderName: string;
  scannedAt: string;
  includeChildren: boolean;
  entries: FolderEntry[];
  warnings: string[];
}
export interface FolderReadReceipt {
  cancelled: boolean;
  files: { name: string; id?: string; error?: string }[];
}
