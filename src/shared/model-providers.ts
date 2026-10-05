import { z } from 'zod';
import type { DeepSeekCredentialStatus, DeepSeekCheckResult } from '../core/deepseek/types';
import type { DeepSeekLedgerSummary } from '../core/deepseek/ledger';

export const modelProviderId = z.enum(['deepseek', 'kimi', 'doubao']);
export type ModelProviderId = z.infer<typeof modelProviderId>;
export type ModelKind = 'text' | 'vision';
export const modelName = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:/-]+$/);
export const modelConfigurationInput = z
  .object({
    provider: modelProviderId,
    expectedRevision: z.uuid(),
    textModel: modelName,
    visionModel: z.union([modelName, z.literal('')]),
    contextWindowTokens: z.number().int().min(32768).max(1_000_000).optional(),
  })
  .strict();
export const modelProviderInput = z.object({ provider: modelProviderId }).strict();
export const selectModelProviderInput = modelProviderInput.extend({ expectedRevision: z.uuid() });
export const modelKeyInput = modelProviderInput.extend({
  apiKey: z.string().trim().min(5).max(200),
});
export const modelCheckPreparationInput = z
  .object({ type: z.enum(['text', 'vision']), expectedRevision: z.uuid() })
  .strict();
export const modelCheckConfirmationInput = z
  .object({
    token: z.uuid(),
    revision: z.uuid(),
    wireHash: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledgeOutboundPreview: z.literal(true),
  })
  .strict();
export interface ModelProviderView {
  provider: ModelProviderId;
  label: string;
  baseUrl: string;
  textModel: string;
  visionModel: string;
  contextWindowTokens?: number;
  credentials: DeepSeekCredentialStatus;
  capabilities: { text: 'unconfigured' | 'unverified'; vision: 'disabled' | 'unverified' };
}
export interface ModelSettingsView {
  revision: string;
  selectedProvider: ModelProviderId;
  providers: ModelProviderView[];
}
export interface ModelSelection {
  provider: ModelProviderId;
  requestModel: string;
  configurationRevision?: string;
  contextWindowTokens?: number;
}
export interface ModelCheckPreparation {
  token: string;
  revision: string;
  provider: ModelProviderId;
  model: string;
  endpoint: string;
  type: ModelKind;
  body: string;
  wireHash: string;
}
export interface ModelCheckReceipt {
  provider: ModelProviderId;
  revision: string;
  result: DeepSeekCheckResult;
}
export type ModelLedgerView = { provider: ModelProviderId; summary: DeepSeekLedgerSummary };
