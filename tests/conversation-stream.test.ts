import { expect, test, vi } from 'vitest';
import { readConversationCompletion } from '../src/core/deepseek/conversation-stream';
import { DeepSeekClient } from '../src/core/deepseek/client';
import { parseConversationResponses } from '../src/core/conversation-response';
import type { DeepSeekTextMessage } from '../src/core/deepseek/types';

const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\r\n\r\n';
test.each(['missing', 'wrong-id', 'orphan', 'interleaved', 'duplicate'] as const)(
  'conversation rejects %s tool receipts before transport',
  (mode) => {
    const call = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'business_action', arguments: '{}' },
    };
    const messages: DeepSeekTextMessage[] = [
      { role: 'assistant', content: '', tool_calls: [call] },
    ];
    if (mode === 'wrong-id') messages.push({ role: 'tool', tool_call_id: 'wrong', content: '{}' });
    if (mode === 'orphan')
      messages.splice(0, 1, { role: 'tool', tool_call_id: 'call-1', content: '{}' });
    if (mode === 'interleaved')
      messages.push(
        { role: 'user', content: '不能插入未闭合工具批次' },
        { role: 'tool', tool_call_id: 'call-1', content: '{}' },
      );
    if (mode === 'duplicate') messages[0]!.tool_calls!.push(call);
    expect(() => new DeepSeekClient().conversationBody('deepseek-flash', messages, [])).toThrow(
      expect.objectContaining({ code: 'CONVERSATION_PROTOCOL_ERROR' }),
    );
  },
);
test('conversation context accommodates the full declared tool budget and reports explicit limits', () => {
  const client = new DeepSeekClient();
  const messages: DeepSeekTextMessage[] = [
    { role: 'system', content: '系统规则' },
    ...Array.from({ length: 48 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: '历史正文',
    })),
    { role: 'user', content: '你还有什么功能？' },
  ];
  for (let round = 0; round < 16; round++) {
    const calls = Array.from({ length: 8 }, (_, index) => ({
      id: `round-${round}-call-${index}`,
      type: 'function' as const,
      function: { name: 'business_action', arguments: '{}' },
    }));
    messages.push({ role: 'assistant', content: '', tool_calls: calls });
    for (const call of calls)
      messages.push({ role: 'tool', tool_call_id: call.id, content: '{"executed":true}' });
  }
  expect(messages).toHaveLength(194);
  expect(client.conversationBody('deepseek-flash', messages, []).messages).toEqual(messages);
  const tooMany = [
    ...messages,
    ...Array<DeepSeekTextMessage>(8193 - messages.length).fill({ role: 'user', content: '继续' }),
  ];
  try {
    client.conversationBody('deepseek-flash', tooMany, []);
    throw Error('Expected explicit context limit');
  } catch (error) {
    expect(error).toMatchObject({ code: 'CONVERSATION_CONTEXT_LIMIT' });
  }
  expect(() =>
    client.conversationBody(
      'deepseek-flash',
      [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }],
      [],
    ),
  ).toThrow(expect.objectContaining({ code: 'CONVERSATION_CONTEXT_LIMIT' }));
});

const frame = (delta: unknown, finish_reason: string | null = null) => ({
  id: 'stream-test',
  model: 'test-model',
  choices: [{ index: 0, delta, finish_reason }],
});
function stream(text: string, chunkSize = 7) {
  const encoded = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < encoded.length; i += chunkSize)
          controller.enqueue(encoded.slice(i, i + chunkSize));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}
test('SSE accepts nullable continuation metadata without losing the completed tool identity', async () => {
  const response = stream(
    event(
      frame({
        tool_calls: [
          {
            index: 0,
            id: 'call-nullable',
            type: 'function',
            function: { name: 'business_action', arguments: '{' },
          },
        ],
      }),
    ) +
      event(
        frame({
          tool_calls: [
            {
              index: 0,
              id: null,
              type: null,
              function: { name: null, arguments: '"action":{"kind":"query","query":"roster"}}' },
            },
          ],
        }),
      ) +
      event(frame({ tool_calls: null }, 'tool_calls')) +
      'data: [DONE]\r\n\r\n',
  );
  const result = await readConversationCompletion(response, new AbortController().signal, () => {});
  expect(result.toolCalls).toEqual([
    {
      id: 'call-nullable',
      type: 'function',
      function: {
        name: 'business_action',
        arguments: '{"action":{"kind":"query","query":"roster"}}',
      },
    },
  ]);
});
test('SSE decodes split UTF-8, reasoning and tool arguments with usage after finish', async () => {
  const update = vi.fn();
  const response = stream(
    event(frame({ reasoning_content: '需要先读取班级。' })) +
      event(
        frame({
          content: '正在读取。',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'business_action', arguments: '{"action":' },
            },
          ],
        }),
      ) +
      event(
        frame(
          {
            tool_calls: [
              { index: 0, function: { arguments: '{"kind":"query","query":"classes"}}' } },
            ],
          },
          'tool_calls',
        ),
      ) +
      event({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 12, total_tokens: 16 } }) +
      'data: [DONE]\r\n\r\n',
    1,
  );
  const result = await readConversationCompletion(response, new AbortController().signal, update);
  expect(result.reasoningContent).toBe('需要先读取班级。');
  expect(result.content).toBe('正在读取。');
  expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({
    action: { kind: 'query', query: 'classes' },
  });
  expect(result.usage?.total_tokens).toBe(16);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ reasoningCharacters: 8 }));
});
test('missing DONE never adopts a partial tool call', async () => {
  await expect(
    readConversationCompletion(
      stream(
        event(
          frame(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'broken',
                  type: 'function',
                  function: { name: 'business_action', arguments: '{}' },
                },
              ],
            },
            'tool_calls',
          ),
        ),
      ),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    diagnostic: {
      transport: 'sse',
      stage: 'completion',
      reason: 'missing-completion',
      done: false,
      hasId: true,
      hasModel: true,
      hasFinish: true,
      toolCalls: 1,
    },
  });
});

test('invalid SSE fields report structural paths and types without saving rejected values', async () => {
  const secret = 'sk-synthetic-diagnostic-private-value';
  const diagnostic = await readConversationCompletion(
    stream(
      event({
        id: 'test',
        model: 'test',
        choices: [{ delta: { content: { [secret]: '学生姓名' } } }],
      }),
    ),
    new AbortController().signal,
    () => {},
  ).catch((error) => error.diagnostic);
  expect(diagnostic).toMatchObject({
    transport: 'sse',
    stage: 'frame',
    reason: 'field-validation',
    frames: 1,
    issues: [{ path: ['choices', 0, 'delta', 'content'], actualType: 'object' }],
  });
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(JSON.stringify(diagnostic)).not.toContain('学生姓名');
});

test('non-stream invalid JSON receives a body diagnostic without parser text', async () => {
  await expect(
    readConversationCompletion(
      new Response('{private-invalid'),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    diagnostic: {
      transport: 'json',
      stage: 'body',
      reason: 'invalid-json',
      bytes: 16,
      frames: 0,
      issues: [],
    },
  });
});

test('SSE preserves call indices when a batch arrives as interleaved fragments', async () => {
  const response = stream(
    event(
      frame({
        tool_calls: [
          {
            index: 1,
            id: 'second',
            type: 'function',
            function: { name: 'business_action', arguments: '{"action":' },
          },
          {
            index: 0,
            id: 'first',
            type: 'function',
            function: { name: 'business_action', arguments: '{"action":' },
          },
        ],
      }),
    ) +
      event(
        frame(
          {
            tool_calls: [
              { index: 0, function: { arguments: '{"kind":"query","query":"classes"}}' } },
              { index: 1, function: { arguments: '{"kind":"query","query":"roster"}}' } },
            ],
          },
          'tool_calls',
        ),
      ) +
      'data: [DONE]\n\n',
  );
  const result = await readConversationCompletion(response, new AbortController().signal, () => {});
  expect(result.toolCalls.map((call) => call.id)).toEqual(['first', 'second']);
  const parsed = parseConversationResponses({
    ...result,
    responseId: result.id,
    model: result.model,
    durationMs: 1,
    usage: null,
    truncated: false,
  });
  expect(parsed.map((operation) => operation.output.action)).toEqual([
    { kind: 'query', query: 'classes' },
    { kind: 'query', query: 'roster' },
  ]);
});
test('cancel settles a stream that never finishes', async () => {
  const abort = new AbortController();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event(frame({ content: '部分正文' }))));
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  const pending = readConversationCompletion(response, abort.signal, () => {});
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
});
test.each(['deepseek', 'kimi', 'doubao'] as const)(
  'conversation uses streaming native tools and thinking for %s',
  (provider) => {
    const client = new DeepSeekClient({ protocol: provider });
    const body = client.conversationBody(
      provider === 'kimi' ? 'kimi-k3' : 'synthetic-model',
      [{ role: 'user', content: '教学计划' }],
      [{ type: 'function', function: { name: 'business_action', parameters: { type: 'object' } } }],
    );
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      parallel_tool_calls: false,
    });
    expect(body).not.toHaveProperty('response_format');
    if (provider !== 'kimi') expect(body.thinking).toEqual({ type: 'enabled' });
  },
);
test('length-limited prose is preserved, incomplete actions are never executable', () => {
  const response = {
    content: '# 教学计划\n已收到的正文',
    responseId: 'test',
    model: 'test',
    durationMs: 1,
    usage: null,
    toolCalls: [],
    truncated: true,
  };
  expect(parseConversationResponses(response)[0]!.output.action).toEqual({
    kind: 'reply',
    text: response.content,
  });
  expect(() =>
    parseConversationResponses({
      ...response,
      toolCalls: [
        { id: '1', type: 'function', function: { name: 'business_action', arguments: '{}' } },
      ],
    }),
  ).toThrow('未完整生成');
});
