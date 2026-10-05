import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ConversationHistoryStore } from '../src/core/conversation-history';
import type { CryptoProvider } from '../src/core/deepseek/credentials';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// Deliberately reversible test encryption verifies that the store uses the provider,
// without pretending to exercise Windows safeStorage (covered by desktop checks).
const crypto: CryptoProvider = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0xa5)),
  decrypt: (bytes) =>
    Buffer.from(bytes)
      .map((byte) => byte ^ 0xa5)
      .toString(),
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-history-'));
  roots.push(root);
  let clock = Date.parse('2026-10-04T01:00:00.000Z');
  const store = new ConversationHistoryStore(root, crypto, () => new Date(clock++).toISOString());
  const epoch = randomUUID(),
    item = store.create({ epoch });
  const state = {
    ...item.state,
    draft: '待补充课时要求',
    messages: [
      { speaker: 'user' as const, text: '为七年级准备英语教学计划' },
      {
        speaker: 'assistant' as const,
        text: '请说明课题和时长。',
        document: {
          kind: 'teaching-plan' as const,
          title: '英语计划',
          body: '目标：练习阅读',
          nextPrompt: '制作课件',
        },
      },
    ],
  };
  return { root, store, epoch, item, state };
}
test('encrypted transcripts, artifacts, draft and selectors survive restart with separate sessions', () => {
  const f = fixture();
  const state = { ...f.state, classId: randomUUID(), studentId: randomUUID() };
  const saved = f.store.save({ epoch: f.epoch, id: f.item.id, expectedRevision: 1, state });
  expect(saved.title).toBe('为七年级准备英语教学计划');
  const second = f.store.create({ epoch: f.epoch });
  const restarted = new ConversationHistoryStore(f.root, crypto);
  expect(restarted.read({ epoch: f.epoch, id: f.item.id })).toEqual(saved);
  expect(restarted.read({ epoch: f.epoch, id: second.id }).state.messages).toEqual([]);
  expect(restarted.list({ epoch: f.epoch }).map((record) => record.id)).toEqual([
    second.id,
    saved.id,
  ]);
  const bytes = readFileSync(join(f.root, 'conversation-history', f.item.id + '.chat'));
  expect(bytes.includes(Buffer.from(state.draft))).toBe(false);
  expect(bytes.includes(Buffer.from('英语计划'))).toBe(false);
  expect(restarted.resume({ epoch: f.epoch, id: saved.id })).toEqual(state.messages);
});
test('stale save, rename and deletion conflict; delayed saves cannot resurrect deleted history', () => {
  const f = fixture(),
    input = { epoch: f.epoch, id: f.item.id, expectedRevision: 1 };
  f.store.save({ ...input, state: f.state });
  for (const operation of [
    () => f.store.save({ ...input, state: f.item.state }),
    () => f.store.rename({ ...input, title: '新标题' }),
    () => f.store.delete(input),
  ])
    expect(operation).toThrow('已更新');
  const renamed = f.store.rename({ ...input, expectedRevision: 2, title: '英语备课' });
  expect(renamed.title).toBe('英语备课');
  f.store.delete({ ...input, expectedRevision: 3 });
  expect(() => f.store.save({ ...input, expectedRevision: 3, state: f.state })).toThrow('已删除');
  expect(f.store.list({ epoch: f.epoch })).toEqual([]);
  expect(f.store.resume({ epoch: f.epoch, id: f.item.id })).toEqual([]);
});
test('restored workspace history remains viewable, but cannot save or resume executable context', () => {
  const f = fixture();
  f.store.save({ epoch: f.epoch, id: f.item.id, expectedRevision: 1, state: f.state });
  const epoch = randomUUID();
  expect(f.store.list({ epoch })[0]?.archived).toBe(true);
  expect(f.store.read({ epoch, id: f.item.id }).state).toEqual(f.state);
  expect(() => f.store.save({ epoch, id: f.item.id, expectedRevision: 2, state: f.state })).toThrow(
    '仅供查看',
  );
  expect(() => f.store.resume({ epoch, id: f.item.id })).toThrow('仅供查看');
  expect(f.store.create({ epoch }).epoch).toBe(epoch);
});
test('strict archive rejects pending actions, raw tool messages and reasoning', () => {
  const f = fixture(),
    input = { epoch: f.epoch, id: f.item.id, expectedRevision: 1 };
  for (const state of [
    { ...f.state, token: randomUUID() },
    { ...f.state, task: { status: 'proposed', action: 'createClass' } },
    { ...f.state, messages: [{ speaker: 'tool', text: 'result' }] },
    { ...f.state, messages: [{ speaker: 'assistant', text: '计划', tool_calls: [] }] },
    { ...f.state, messages: [{ speaker: 'assistant', text: '计划', reasoning_content: '推理' }] },
  ])
    expect(() => f.store.save({ ...input, state })).toThrow();
  expect(f.store.read({ epoch: f.epoch, id: f.item.id })).toEqual(f.item);
});
test('corrupt history is reported and preserved; no silent overwrite', () => {
  const f = fixture(),
    file = join(f.root, 'conversation-history', f.item.id + '.chat');
  const bytes = Buffer.from('damaged encrypted record');
  writeFileSync(file, bytes);
  expect(() => f.store.read({ epoch: f.epoch, id: f.item.id })).toThrow('原文件已保留');
  expect(() => f.store.list({ epoch: f.epoch })).toThrow('原文件已保留');
  expect(readFileSync(file)).toEqual(bytes);
});
test('encryption unavailable and oversized histories preserve last saved content', () => {
  const f = fixture();
  const unavailable = new ConversationHistoryStore(f.root, { ...crypto, isAvailable: () => false });
  expect(() => unavailable.create({ epoch: f.epoch })).toThrow('加密');
  expect(() =>
    unavailable.save({ epoch: f.epoch, id: f.item.id, expectedRevision: 1, state: f.state }),
  ).toThrow('加密');
  const state = {
    ...f.state,
    messages: Array.from({ length: 60 }, () => ({ speaker: 'user', text: '教'.repeat(20000) })),
  };
  expect(() => f.store.save({ epoch: f.epoch, id: f.item.id, expectedRevision: 1, state })).toThrow(
    '内容过多',
  );
  expect(f.store.read({ epoch: f.epoch, id: f.item.id })).toEqual(f.item);
});
test('history count limit never overwrites older chats', () => {
  const f = fixture();
  for (let i = 1; i < 100; i++) f.store.create({ epoch: f.epoch });
  expect(() => f.store.create({ epoch: f.epoch })).toThrow('100段');
  expect(readdirSync(join(f.root, 'conversation-history'))).toHaveLength(100);
  expect(f.store.read({ epoch: f.epoch, id: f.item.id })).toEqual(f.item);
});
