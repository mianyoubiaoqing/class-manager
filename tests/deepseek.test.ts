import { mkdtempSync, rmSync } from 'node:fs';
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
    expect(result.model).toBe('deepseek-flash');
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

  test('429 rate limit performs limited retry then throws RATE_LIMIT', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Too many requests' } }),
    });

    const client = new DeepSeekClient({ customFetch: mockFetch as unknown as typeof fetch });

    await expect(client.checkTextConnection(testKey)).rejects.toMatchObject({
      code: 'RATE_LIMIT',
    });
    // Initial attempt + 1 retry = 2 attempts
    expect(mockFetch).toHaveBeenCalledTimes(2);
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
      timestamp: new Date().toISOString(),
      type: 'text_check',
      requestModel: 'deepseek-flash',
      responseModel: 'deepseek-flash',
      status: 'success',
      durationMs: 120,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });

    ledger.record({
      id: 'entry-2',
      timestamp: new Date().toISOString(),
      type: 'vision_check',
      requestModel: 'deepseek-flash',
      status: 'failed',
      errorCode: 'INSUFFICIENT_BALANCE',
      durationMs: 90,
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
});
