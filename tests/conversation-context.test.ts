import { expect, test } from 'vitest';
import { DeepSeekClient } from '../src/core/deepseek/client';
import {
  contextBudget,
  estimateContextTokens,
  shouldCompact,
  contextGroups,
  compactionPlan,
  CONVERSATION_OUTPUT_TOKENS,
} from '../src/core/conversation-context';
import type { DeepSeekTextMessage } from '../src/core/deepseek/types';

test('300K total budget reserves output and compacts at 90%, including schemas and reasoning', () => {
  expect(contextBudget({ provider: 'deepseek', requestModel: 'deepseek-flash' })).toBe(300000);
  const messages: DeepSeekTextMessage[] = [{ role: 'user', content: 'a'.repeat(730000) }];
  expect(shouldCompact(messages, [], 300000)).toBe(false);
  messages.push({ role: 'assistant', content: 'ok', reasoning_content: 'a'.repeat(60000) });
  expect(shouldCompact(messages, [], 300000)).toBe(true);
  expect(shouldCompact([{ role: 'user', content: '' }], ['a'.repeat(800000)], 300000)).toBe(true);
  expect(
    estimateContextTokens([{ role: 'user', content: '' }]) + CONVERSATION_OUTPUT_TOKENS,
  ).toBeLessThan(300000);
});
test('provider windows and explicit smaller windows win over the application budget', () => {
  expect(contextBudget({ provider: 'kimi', requestModel: 'kimi-k2.6' })).toBe(262144);
  expect(
    contextBudget({ provider: 'kimi', requestModel: 'kimi-k2.6', contextWindowTokens: 300000 }),
  ).toBe(262144);
  expect(contextBudget({ provider: 'kimi', requestModel: 'kimi-k3' })).toBe(300000);
  expect(contextBudget({ provider: 'doubao', requestModel: 'ep-private' })).toBe(32768);
  expect(
    contextBudget({ provider: 'doubao', requestModel: 'ep-private', contextWindowTokens: 256000 }),
  ).toBe(256000);
  expect(
    contextBudget({ provider: 'deepseek', requestModel: 'custom', contextWindowTokens: 64000 }),
  ).toBe(64000);
});
test('summary chunks and retained messages preserve complete native tool batches', () => {
  const messages: DeepSeekTextMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'early'.repeat(30000) },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'business_action', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'business_action', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'tool', tool_call_id: 'b', content: 'ok' },
    { role: 'user', content: 'continue' },
  ];
  expect(contextGroups(messages.slice(1))[1]).toHaveLength(3);
  const plan = compactionPlan(messages, 32768);
  for (const chunk of [...plan.chunks, plan.recent]) contextGroups(chunk);
  expect(plan.recent.some((m) => m.tool_call_id === 'a')).toBe(
    plan.recent.some((m) => m.tool_call_id === 'b'),
  );
  expect(() => contextGroups(messages.slice(0, 4))).toThrow(/回执/);
});
test('transport accepts long valid histories and omits empty tool declarations for summaries', () => {
  const messages: DeepSeekTextMessage[] = Array.from({ length: 300 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'ok',
  }));
  const body = new DeepSeekClient().conversationBody('deepseek-flash', messages, []);
  expect(body).not.toHaveProperty('tools');
  expect(body).not.toHaveProperty('parallel_tool_calls');
  expect(body.max_tokens).toBe(16384);
  expect(() =>
    new DeepSeekClient().conversationBody(
      'deepseek-flash',
      [{ role: 'user', content: 'a'.repeat(1100000) }],
      [],
    ),
  ).not.toThrow();
});
