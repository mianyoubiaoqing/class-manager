import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { DeepSeekLedger } from '../src/core/deepseek/ledger';
import {
  conversationDiagnosticEntries,
  type ConversationDiagnostic,
} from '../src/core/deepseek/conversation-diagnostics';
import type { DeepSeekCallRecord } from '../src/core/deepseek/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const diagnostic: ConversationDiagnostic = {
  version: 1,
  transport: 'sse',
  stage: 'completion',
  reason: 'missing-completion',
  bytes: 500,
  frames: 2,
  done: false,
  hasId: true,
  hasModel: true,
  hasFinish: false,
  toolCalls: 1,
  issues: [],
};
const record = (): DeepSeekCallRecord => ({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  type: 'conversation_intent',
  requestModel: 'synthetic-model',
  status: 'in_progress',
  durationMs: 0,
  promptVersion: 'synthetic-diagnostic',
  conversationAttempt: { taskId: randomUUID(), transportAttempt: 1 },
});

test('diagnostics persist with their original call and older ledger entries stay readable', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-diagnostic-'));
  roots.push(root);
  const ledger = new DeepSeekLedger(root),
    call = record();
  ledger.startCall(call);
  ledger.completeCall(call.id, {
    status: 'failed',
    errorCode: 'INVALID_RESPONSE',
    responseDiagnostic: diagnostic,
  });
  const legacy = record();
  delete legacy.conversationAttempt;
  ledger.record({ ...legacy, status: 'success' });
  const entries = new DeepSeekLedger(root).getSummary().recentEntries;
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({
    responseDiagnostic: diagnostic,
    conversationAttempt: call.conversationAttempt,
  });
  expect(conversationDiagnosticEntries(entries)).toHaveLength(1);
});

test('export projection omits unrelated ledger strings and rejects extra diagnostic properties', () => {
  const call = {
    ...record(),
    status: 'failed' as const,
    responseDiagnostic: diagnostic,
    responseId: 'sk-synthetic-secret',
    responseModel: '学生姓名',
    rawResponse: 'private-body',
  };
  const exported = conversationDiagnosticEntries([call]);
  expect(exported).toEqual([
    {
      callId: call.id,
      at: call.timestamp,
      status: 'failed',
      response: diagnostic,
      attempt: call.conversationAttempt,
    },
  ]);
  expect(JSON.stringify(exported)).not.toMatch(/sk-synthetic-secret|学生姓名|private-body/);
  const invalid = {
    ...call,
    conversationAttempt: undefined,
    responseDiagnostic: { ...diagnostic, body: 'private-body' },
  };
  expect(conversationDiagnosticEntries([invalid])).toEqual([]);
});

test('corrupt diagnostic metadata rejects ledger access without overwriting the existing file', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-diagnostic-'));
  roots.push(root);
  const ledger = new DeepSeekLedger(root),
    call = record();
  ledger.record({ ...call, status: 'failed' });
  const path = join(root, 'deepseek-ledger.json'),
    raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.entries[0].responseDiagnostic = {
    ...diagnostic,
    issues: [{ path: ['学生姓名'], actualType: 'string' }],
  };
  const before = JSON.stringify(raw);
  writeFileSync(path, before);
  expect(() => new DeepSeekLedger(root).getSummary()).toThrow(
    expect.objectContaining({ code: 'DATA_CORRUPTED' }),
  );
  expect(readFileSync(path, 'utf8')).toBe(before);
});
