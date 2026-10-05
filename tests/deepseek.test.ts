import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DeepSeekClient,
  DeepSeekCredentialStore,
  DeepSeekLedger,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  maskApiKey,
  SYNTHETIC_TEST_IMAGE_DATA_URL,
  type CryptoProvider,
} from '../src/core/deepseek';
import { DomainError } from '../src/core/errors';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createMockCryptoProvider(available = true): CryptoProvider {
  return {
    isAvailable: () => available,
    encrypt: (plain: string) => Buffer.from(`ENC:${plain}`, 'utf8'),
    decrypt: (cipher: Buffer) => {
      const str = cipher.toString('utf8');
      if (!str.startsWith('ENC:')) throw new Error('Bad cipher');
      return str.slice(4);
    },
  };
}

describe('DeepSeek Credential Store', () => {
  test('maskApiKey hides middle characters and prevents full key leakage', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-...cdef');
    expect(maskApiKey('short')).toBe('***');
    expect(maskApiKey('12345678')).toBe('123...5678');
  });

  test('saves key securely and returns masked key without returning plaintext', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-cred-test-'));
    roots.push(root);
    const store = new DeepSeekCredentialStore(root, createMockCryptoProvider(true));

    expect(store.getStatus()).toEqual({ configured: false, maskedKey: null, updatedAt: null });

    const status = store.saveKey('  sk-test-secret-key-123456  ');
    expect(status.configured).toBe(true);
    expect(status.maskedKey).toBe('sk-...3456');
    expect(status.updatedAt).toBeTruthy();

    const loaded = store.loadKey();
    expect(loaded).toBe('sk-test-secret-key-123456');

    // Status does not reveal plaintext
    const currentStatus = store.getStatus();
    expect(currentStatus.configured).toBe(true);
    expect(currentStatus.maskedKey).toBe('sk-...3456');
    expect(JSON.stringify(currentStatus)).not.toContain('secret-key');
  });

  test('refuses to save in plaintext when system encryption is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-cred-test-'));
    roots.push(root);
    const store = new DeepSeekCredentialStore(root, createMockCryptoProvider(false));

    expect(() => store.saveKey('sk-valid-key-12345')).toThrowError(
      expect.objectContaining({
        code: 'ENCRYPTION_UNAVAILABLE',
      }),
    );
    expect(store.getStatus().configured).toBe(false);
  });

  test('deleting key removes files and blocks new tasks from loading it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-cred-test-'));
    roots.push(root);
    const store = new DeepSeekCredentialStore(root, createMockCryptoProvider(true));

    store.saveKey('sk-sample-key-12345');
    expect(store.getStatus().configured).toBe(true);

    store.deleteKey();
    expect(store.getStatus().configured).toBe(false);
    expect(() => store.loadKey()).toThrowError(
      expect.objectContaining({
        code: 'CREDENTIAL_MISSING',
      }),
    );
  });
});

describe('DeepSeek Client & Connection Verification', () => {
  const testKey = 'sk-real-secret-token-abcdef';

  test('text connection check succeeds and parses returned model and usage', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-123',
        model: 'deepseek-flash',
        choices: [{ message: { content: 'Pong' } }],
        usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
      }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    const result = await client.checkTextConnection(testKey);

    expect(result.type).toBe('text');
    expect(result.success).toBe(true);
    expect(result.responseId).toBe('chatcmpl-123');
    expect(result.model).toBe('deepseek-flash');
    expect(result.promptVersion).toBe('ping-v1');
    expect(result.usage).toEqual({ promptTokens: 6, completionTokens: 2, totalTokens: 8 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArg = mockFetch.mock.calls[0]?.[1] as { body?: string } | undefined;
    const callBody = JSON.parse(callArg?.body ?? '{}');
    expect(callBody.model).toBe(DEFAULT_TEXT_MODEL);
    expect(callBody.thinking).toEqual({ type: 'disabled' });
  });

  test('vision connection check sends synthetic image data URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-vision-123',
        model: 'deepseek-flash',
        choices: [{ message: { content: 'A transparent pixel' } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    const result = await client.checkVisionConnection(testKey);

    expect(result.type).toBe('vision');
    expect(result.success).toBe(true);
    expect(result.responseId).toBe('chatcmpl-vision-123');
    expect(result.promptVersion).toBe('synthetic-1x1-v1');
    expect(result.usage?.totalTokens).toBe(17);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArg = mockFetch.mock.calls[0]?.[1] as { body?: string } | undefined;
    const callBody = JSON.parse(callArg?.body ?? '{}');
    expect(callBody.model).toBe(DEFAULT_VISION_MODEL);
    expect(callBody.messages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image_url',
          image_url: { url: SYNTHETIC_TEST_IMAGE_DATA_URL },
        }),
      ]),
    );
  });

  test('401 authentication failure is classified and does not retry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key' } }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });

    await expect(client.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    // Strict non-retry for 401
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('402 insufficient balance failure is classified and does not retry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: { message: 'Insufficient balance' } }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });

    await expect(client.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('429 rate limit is rejected without automatic paid retry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Too many requests' } }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });

    await expect(client.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'RATE_LIMIT',
    });
    // 新多供应商契约：回包不明仍可能计费，只请求一次。
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('errors do not leak raw API key in error message', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error(`Failed with key: ${testKey}`));

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });

    try {
      await client.checkTextConnection(testKey);
      expect.unreachable('Should fail');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      const msg = (err as DomainError).message;
      expect(msg).not.toContain(testKey);
      expect(msg).toContain('***');
    }
  });

  test('cancelled task with AbortSignal throws ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch = vi.fn();
    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });

    await expect(
      client.checkTextConnection(testKey, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('DeepSeek Usage Ledger', () => {
  test('records entries and aggregates token usage', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-ledger-test-'));
    roots.push(root);
    const ledger = new DeepSeekLedger(root);

    expect(ledger.getSummary()).toEqual({
      totalCalls: 0,
      successCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      recentEntries: [],
    });

    ledger.record({
      id: 'entry-1',
      responseId: 'chatcmpl-001',
      timestamp: new Date().toISOString(),
      type: 'text_check',
      requestModel: 'deepseek-flash',
      responseModel: 'deepseek-flash',
      status: 'success',
      durationMs: 120,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      promptVersion: 'ping-v1',
    });

    ledger.record({
      id: 'entry-2',
      timestamp: new Date().toISOString(),
      type: 'vision_check',
      requestModel: 'deepseek-flash',
      status: 'failed',
      errorCode: 'INSUFFICIENT_BALANCE',
      durationMs: 90,
      promptVersion: 'synthetic-1x1-v1',
    });

    const summary = ledger.getSummary();
    expect(summary.totalCalls).toBe(2);
    expect(summary.successCalls).toBe(1);
    expect(summary.totalTokens).toBe(7);
    expect(summary.promptTokens).toBe(5);
    expect(summary.completionTokens).toBe(2);
    expect(summary.recentEntries.length).toBe(2);
    expect(summary.recentEntries[0]?.id).toBe('entry-2'); // newest first
  });

  test('corrupted ledger file is not silently overwritten and raises DATA_CORRUPTED', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-ledger-corrupt-'));
    roots.push(root);
    const ledgerPath = join(root, 'deepseek-ledger.json');
    const corruptedContent = '{"invalid": "json", corrupt}';
    writeFileSync(ledgerPath, corruptedContent, 'utf8');

    const ledger = new DeepSeekLedger(root);
    expect(() => ledger.getSummary()).toThrowError(
      expect.objectContaining({
        code: 'DATA_CORRUPTED',
      }),
    );

    // Verify original file was preserved and not wiped
    expect(readFileSync(ledgerPath, 'utf8')).toBe(corruptedContent);
  });

  test('cumulative totals survive window trimming beyond 200 entries without dropping counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-ledger-limit-'));
    roots.push(root);
    const ledger = new DeepSeekLedger(root);

    // Record 205 entries (each with 2 tokens)
    for (let i = 0; i < 205; i++) {
      ledger.record({
        id: `entry-${i}`,
        timestamp: new Date().toISOString(),
        type: 'text_check',
        requestModel: 'deepseek-flash',
        status: 'success',
        durationMs: 50,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        promptVersion: 'ping-v1',
      });
    }

    const summary = ledger.getSummary();
    // Lifetime totals must be 205 and 410 tokens
    expect(summary.totalCalls).toBe(205);
    expect(summary.successCalls).toBe(205);
    expect(summary.totalTokens).toBe(410);
    expect(summary.promptTokens).toBe(205);
    expect(summary.completionTokens).toBe(205);
    // Recent detail entries window is capped at 200
    expect(summary.recentEntries.length).toBe(200);
    expect(summary.recentEntries[0]?.id).toBe('entry-204');
  });

  test('smoothly migrates legacy v1 ledger without totals by reconstructing totals from entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-ledger-legacy-'));
    roots.push(root);
    const ledgerPath = join(root, 'deepseek-ledger.json');
    const legacyContent = JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'legacy-1',
          timestamp: new Date().toISOString(),
          type: 'text_check',
          requestModel: 'deepseek-flash',
          status: 'success',
          durationMs: 100,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          promptVersion: 'ping-v1',
        },
      ],
    });
    writeFileSync(ledgerPath, legacyContent, 'utf8');

    const ledger = new DeepSeekLedger(root);
    const summary = ledger.getSummary();
    expect(summary.totalCalls).toBe(1);
    expect(summary.successCalls).toBe(1);
    expect(summary.totalTokens).toBe(15);
    expect(summary.promptTokens).toBe(10);
    expect(summary.completionTokens).toBe(5);

    // Verify file is persisted with totals structure
    const updated = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(updated.totals).toBeDefined();
    expect(updated.totals.totalCalls).toBe(1);
  });

  test('in-progress call on restart is marked as interrupted without replay', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-ledger-reconcile-'));
    roots.push(root);

    // First session starts a call that does not complete before exit
    const session1 = new DeepSeekLedger(root);
    session1.startCall({
      id: 'flight-call-1',
      timestamp: new Date().toISOString(),
      type: 'text_check',
      requestModel: 'deepseek-flash',
      status: 'in_progress',
      durationMs: 0,
      promptVersion: 'ping-v1',
    });

    // Second session starts up (simulating restart)
    const session2 = new DeepSeekLedger(root);
    const summary = session2.getSummary();
    expect(summary.totalCalls).toBe(1);
    expect(summary.successCalls).toBe(0);
    expect(summary.recentEntries[0]?.status).toBe('interrupted');
    expect(summary.recentEntries[0]?.errorCode).toBe('INTERRUPTED');
  });

  test('damaged totals structure is rejected with DATA_CORRUPTED and not overwritten', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-ledger-damaged-totals-'));
    roots.push(root);
    const ledgerPath = join(root, 'deepseek-ledger.json');
    const damagedContent = JSON.stringify({
      version: 1,
      totals: { totalCalls: 'NOT_A_NUMBER' },
      entries: [],
    });
    writeFileSync(ledgerPath, damagedContent, 'utf8');

    const ledger = new DeepSeekLedger(root);
    expect(() => ledger.getSummary()).toThrowError(
      expect.objectContaining({
        code: 'DATA_CORRUPTED',
      }),
    );

    // Verify original damaged file was preserved and NOT overwritten
    expect(readFileSync(ledgerPath, 'utf8')).toBe(damagedContent);
  });

  test('legacy ledger with corrupted entry (e.g. usage.totalTokens as string) throws DATA_CORRUPTED and preserves file untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-corrupt-entry-'));
    roots.push(root);
    const ledgerPath = join(root, 'deepseek-ledger.json');
    const legacyCorrupted = JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'call-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'text_check',
          requestModel: 'deepseek-flash',
          status: 'success',
          durationMs: 120,
          promptVersion: 'ping-v1',
          usage: {
            promptTokens: 10,
            completionTokens: 2,
            totalTokens: '7',
          },
        },
      ],
    });
    writeFileSync(ledgerPath, legacyCorrupted, 'utf8');

    const ledger = new DeepSeekLedger(root);
    expect(() => ledger.getSummary()).toThrowError(
      expect.objectContaining({
        code: 'DATA_CORRUPTED',
      }),
    );

    // Verify original file on disk is strictly untouched and NOT overwritten with "07"
    const onDisk = readFileSync(ledgerPath, 'utf8');
    expect(onDisk).toBe(legacyCorrupted);
    expect(onDisk).not.toContain('"07"');
    expect(onDisk).not.toContain('"totals"');
  });

  test('legacy ledger with missing required entry fields throws DATA_CORRUPTED and does not overwrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-missing-fields-'));
    roots.push(root);
    const ledgerPath = join(root, 'deepseek-ledger.json');
    const legacyMissing = JSON.stringify({
      version: 1,
      entries: [{ id: 'broken-entry' }],
    });
    writeFileSync(ledgerPath, legacyMissing, 'utf8');

    const ledger = new DeepSeekLedger(root);
    expect(() => ledger.getSummary()).toThrowError(
      expect.objectContaining({
        code: 'DATA_CORRUPTED',
      }),
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe(legacyMissing);
  });

  test('startCall rejects invalid entry with PARAM_ERROR', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-startcall-invalid-'));
    roots.push(root);
    const ledger = new DeepSeekLedger(root);
    expect(() =>
      ledger.startCall({
        id: '',
        timestamp: '',
        type: 'text_check',
        requestModel: 'deepseek-flash',
        status: 'in_progress',
        durationMs: 0,
        promptVersion: 'ping-v1',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'PARAM_ERROR',
      }),
    );
  });
});

describe('DeepSeek Response Validation & Usage Nuance', () => {
  const testKey = 'sk-real-secret-token-abcdef';

  test('HTTP 200 with invalid unparseable JSON throws INVALID_RESPONSE without retrying', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    await expect(client.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    // Crucial: exactly 1 call, zero retry attempts
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('empty response body or missing choices throws INVALID_RESPONSE', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    await expect(client.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  test('empty choices list or choices with empty/whitespace content throws INVALID_RESPONSE', async () => {
    const mockEmptyContent = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-empty-body',
        model: 'deepseek-flash',
        choices: [{ message: { content: '   ' } }],
      }),
    });

    const client1 = new DeepSeekClient({
      customFetch: mockEmptyContent as unknown as typeof fetch,
    });
    await expect(client1.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const mockMissingMessage = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-no-msg',
        model: 'deepseek-flash',
        choices: [{}],
      }),
    });

    const client2 = new DeepSeekClient({
      customFetch: mockMissingMessage as unknown as typeof fetch,
    });
    await expect(client2.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  test('missing id or model in response throws INVALID_RESPONSE', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: '',
        model: '',
        choices: [{ message: { content: 'Ping response' } }],
      }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    await expect(client.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  test('partial usage preserves unknown/null fields instead of zeroing them', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-usage-test',
        model: 'deepseek-flash',
        choices: [{ message: { content: 'Hello' } }],
        usage: { prompt_tokens: 5 }, // completion_tokens and total_tokens omitted
      }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    const result = await client.checkTextConnection(testKey);

    expect(result.usage).toEqual({
      promptTokens: 5,
      completionTokens: null,
      totalTokens: null,
    });
  });

  test('empty usage object returns null usage instead of three zeros', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-empty-usage',
        model: 'deepseek-flash',
        choices: [{ message: { content: 'Hello' } }],
        usage: {},
      }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    const result = await client.checkTextConnection(testKey);
    expect(result.usage).toBeNull();
  });

  test('reading body stream interrupted by network drops throws NETWORK_ERROR without retry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('ECONNRESET: socket hung up');
      },
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    await expect(client.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('reading body stream aborted with AbortSignal throws ABORTED without retry and without INVALID_RESPONSE', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => {
          controller.abort();
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        },
      });
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });
    await expect(
      client.checkTextConnection(testKey, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'ABORTED',
    });
    // Cancellation must never retry
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('DeepSeek Flow & Lifecycle Regressions (Key replacement, cancellation, crash interruption)', () => {
  test('replacing key invalidates in-flight check task and ensures late response is dropped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-key-replace-'));
    roots.push(root);
    const store = new DeepSeekCredentialStore(root, createMockCryptoProvider(true));

    // 1. Initial key A configured
    const credA = store.saveKey('sk-account-a-123456');
    const timestampA = credA.updatedAt;

    // 2. Start in-flight task 1
    const controller1 = new AbortController();
    let resolveTask1: ((value: unknown) => void) | undefined;

    const mockFetch = vi.fn().mockImplementation((_url, init?: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        resolveTask1 = resolve;
        if (init?.signal) {
          if (init.signal.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });
    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });

    const inFlightCheck = client.checkTextConnection(store.loadKey(), {
      signal: controller1.signal,
    });

    // 3. User replaces key with Account B while task 1 is in-flight
    controller1.abort(); // Simulates App.tsx / Main.ts aborting in-flight check on new key
    const credB = store.saveKey('sk-account-b-789012');
    const timestampB = credB.updatedAt;

    // Timestamp B is newer than Task 1's starting timestamp A
    expect(timestampB).not.toBe(timestampA);

    // 4. In-flight check throws ABORTED
    await expect(inFlightCheck).rejects.toMatchObject({ code: 'ABORTED' });

    // 5. Late response arriving after key change is recognized as outdated by comparing credentials
    const currentStatus = store.getStatus();
    const isOutdated = currentStatus.updatedAt !== timestampA;
    expect(isOutdated).toBe(true);
    expect(currentStatus.maskedKey).toBe('sk-...9012');

    // Clean up task 1 promise
    resolveTask1!({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-late',
        model: 'deepseek-flash',
        choices: [{ message: { content: 'Late' } }],
      }),
    });
  });

  test('abrupt exit during check preserves in_progress record and marks interrupted on restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-crash-interrupted-'));
    roots.push(root);

    const callId = 'crash-test-call-1';
    // Phase 1: Main process starts check and writes in_progress record before fetch
    const session1 = new DeepSeekLedger(root);
    session1.startCall({
      id: callId,
      timestamp: new Date().toISOString(),
      type: 'text_check',
      requestModel: 'deepseek-flash',
      status: 'in_progress',
      durationMs: 0,
      promptVersion: 'ping-v1',
    });

    // Simulate abrupt process crash / exit before completeCall can be reached
    // Phase 2: App starts up again, constructing new DeepSeekLedger
    const session2 = new DeepSeekLedger(root);
    const summary = session2.getSummary();

    // Call was not lost: totalCalls is 1, but success is 0
    expect(summary.totalCalls).toBe(1);
    expect(summary.successCalls).toBe(0);
    // Entry status is transitioned to 'interrupted' without executing any replay
    expect(summary.recentEntries[0]?.id).toBe(callId);
    expect(summary.recentEntries[0]?.status).toBe('interrupted');
    expect(summary.recentEntries[0]?.errorCode).toBe('INTERRUPTED');
  });
});
