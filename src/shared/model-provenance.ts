import { z } from 'zod';
import { modelProviderId } from './model-providers';

const label = z.string().trim().min(1).max(200);
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
/** Observed generation metadata, without credentials, prompts or request bodies. */
export const generationProviderSchema = z
  .object({
    provider: modelProviderId,
    configurationRevision: z.uuid().optional(),
    requestModel: label,
    responseModel: label,
    responseId: label,
    generatedAt: z.iso.datetime(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1000),
    usage: z
      .object({ promptTokens: tokenCount, completionTokens: tokenCount, totalTokens: tokenCount })
      .strict()
      .nullable(),
  })
  .strict();
