import { expect, test, vi } from 'vitest';
import {
  DeepSeekClient,
  GENERATION_TIMEOUT_MS,
  DeepSeekGenerationError,
  type FetchFunction,
} from '../src/core/deepseek/client';
import { readBoundedResponse } from '../src/core/deepseek/bounded-response';

const key = 'sk-synthetic-generation-key';
const messages = [{ role: 'user' as const, content: '{"facts":[]}' }];

test('truncated response errors retain usage but not the unsafe model content', async () => {
  const fetch = vi.fn<FetchFunction>().mockResolvedValue(
    new Response(
      JSON.stringify(
        reply({
          choices: [{ finish_reason: 'length', message: { content: 'unsafe synthetic fragment' } }],
        }),
      ),
    ),
  );
  const error = await new DeepSeekClient({ customFetch: fetch })
    .generateText(key, messages)
    .catch((value: unknown) => value);
  expect(error).toBeInstanceOf(DeepSeekGenerationError);
  expect(error).toMatchObject({
    response: { usage: { totalTokens: 12 }, responseId: 'synthetic-response' },
  });
  expect(JSON.stringify(error)).not.toContain('unsafe synthetic fragment');
});
function reply(overrides: Record<string, unknown> = {}) {
  return {
    id: 'synthetic-response',
    model: 'deepseek-flash',
    choices: [
      { message: { role: 'assistant', content: '{"formatVersion":1}' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    ...overrides,
  };
}

test('generation sends bounded nonstreaming requests and returns usage without automatic retries', async () => {
  const fetch = vi.fn<FetchFunction>().mockResolvedValue(new Response(JSON.stringify(reply())));
  const result = await new DeepSeekClient({ customFetch: fetch }).generateText(key, messages);
  expect(result).toMatchObject({
    content: '{"formatVersion":1}',
    responseId: 'synthetic-response',
    model: 'deepseek-flash',
    usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
  expect(body).toEqual({
    model: 'deepseek-flash',
    messages,
    max_tokens: 4096,
    thinking: { type: 'disabled' },
  });
  expect(JSON.stringify(body)).not.toContain(key);
});

test.each([429, 500, 401, 402])(
  'generation HTTP %s never automatically repeats a paid request',
  async (status) => {
    const fetch = vi.fn<FetchFunction>().mockResolvedValue(new Response('', { status }));
    await expect(
      new DeepSeekClient({ customFetch: fetch }).generateText(key, messages),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test('network failure and input size errors do not retry or leak the credential', async () => {
  const fetch = vi.fn<FetchFunction>().mockRejectedValue(new Error(`synthetic network ${key}`));
  const client = new DeepSeekClient({ customFetch: fetch });
  await expect(client.generateText(key, messages)).rejects.toMatchObject({
    code: 'NETWORK_ERROR',
    message: '与 DeepSeek 服务器连接失败: synthetic network ***',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(
    client.generateText(key, [{ role: 'user', content: 'x'.repeat(160 * 1024) }]),
  ).rejects.toMatchObject({ code: 'VALIDATION' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('returned credential echoes are redacted from content and metadata', async () => {
  const fetch = vi.fn<FetchFunction>().mockResolvedValue(
    new Response(
      JSON.stringify(
        reply({
          id: key,
          model: key,
          choices: [{ message: { content: key }, finish_reason: 'stop' }],
        }),
      ),
    ),
  );
  const result = await new DeepSeekClient({ customFetch: fetch }).generateText(key, messages);
  expect(JSON.stringify(result)).not.toContain(key);
  expect(result.content).toBe('***');
});

test.each(['length', 'content_filter', null])(
  'unfinished output (%s) cannot become a generated draft',
  async (finish_reason) => {
    const fetch = vi.fn<FetchFunction>().mockResolvedValue(
      new Response(
        JSON.stringify(
          reply({
            choices: [{ message: { content: '{"formatVersion":1}' }, finish_reason }],
          }),
        ),
      ),
    );
    await expect(
      new DeepSeekClient({ customFetch: fetch }).generateText(key, messages),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test('oversized and invalid JSON provider responses fail without retry', async () => {
  for (const text of ['x'.repeat(256 * 1024 + 1), '{ malformed']) {
    const fetch = vi.fn<FetchFunction>().mockResolvedValue(new Response(text));
    await expect(
      new DeepSeekClient({ customFetch: fetch }).generateText(key, messages),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

test('response bounds count bytes across chunks and abort a stalled reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readBoundedResponse(new Response(stream), 10)).rejects.toMatchObject({
    code: 'RESPONSE_LIMIT',
  });
  expect(cancelled).toBe(true);
  const abort = new AbortController();
  const stalled = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const pending = readBoundedResponse(new Response(stalled), 10, abort.signal);
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
});

test('declared overflow, invalid UTF-8 and pre-cancelled reads are refused', async () => {
  await expect(
    readBoundedResponse(new Response('x', { headers: { 'content-length': '999' } }), 10),
  ).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
  await expect(readBoundedResponse(new Response(new Uint8Array([0xff])), 10)).rejects.toMatchObject(
    { code: 'INVALID_RESPONSE' },
  );
  await expect(
    readBoundedResponse(new Response('x'), 10, AbortSignal.abort()),
  ).rejects.toMatchObject({ code: 'ABORTED' });
});

test('generation enforces its default deadline on a body that never completes', async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetch = vi.fn<FetchFunction>().mockResolvedValue(new Response(body));
    const promise = new DeepSeekClient({ customFetch: fetch }).generateText(key, messages);
    const check = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
    await check;
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('explicit cancellation remains ABORTED and clears the generation deadline', async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    const fetch = vi.fn<FetchFunction>().mockResolvedValue(new Response(new ReadableStream()));
    const pending = new DeepSeekClient({ customFetch: fetch }).generateText(key, messages, {
      signal: abort.signal,
    });
    const check = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    abort.abort();
    await check;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.each([400, 401, 402, 422, 429, 500, 403])(
  'HTTP %s disposes its error body without exposing provider text',
  async (status) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(key));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = vi.fn<FetchFunction>().mockResolvedValue(new Response(body, { status }));
    let thrown: unknown;
    try {
      await new DeepSeekClient({ customFetch: fetch }).generateText(key, messages);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(key);
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
