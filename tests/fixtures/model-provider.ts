import { vi } from 'vitest';
import { ModelRuntime } from '../../src/core/model-runtime';
import type { ModelProviderId } from '../../src/shared/model-providers';
import type { DeepSeekGenerationResult } from '../../src/core/deepseek/types';

/** Only synthetic credentials and responses; never read the installed application's account. */
export function modelProviderFixture(
  root: string,
  provider: ModelProviderId,
  response: DeepSeekGenerationResult,
) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          id: response.responseId,
          model: response.model,
          choices: [{ message: { content: response.content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: response.usage?.promptTokens,
            completion_tokens: response.usage?.completionTokens,
            total_tokens: response.usage?.totalTokens,
          },
        }),
      ),
  );
  const models = new ModelRuntime(
    root,
    {
      isAvailable: () => true,
      encrypt: (plain) => Buffer.from('SYNTHETIC:' + plain),
      decrypt: (bytes) => bytes.toString().slice('SYNTHETIC:'.length),
    },
    fetcher,
  );
  if (provider === 'doubao')
    models.configure({
      provider,
      expectedRevision: models.settings().revision,
      textModel: 'ep-synthetic-text',
      visionModel: 'ep-synthetic-vision',
    });
  models.select({ provider, expectedRevision: models.settings().revision });
  models.saveKey({ provider, apiKey: `sk-synthetic-${provider}-only` });
  return { models, fetcher };
}
