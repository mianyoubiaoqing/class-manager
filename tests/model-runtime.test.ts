import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ModelRuntime } from '../src/core/model-runtime';
import { DeepSeekCredentialStore } from '../src/core/deepseek/credentials';
import { DeepSeekLedger } from '../src/core/deepseek/ledger';
import type { ModelProviderId, ModelCheckPreparation } from '../src/shared/model-providers';
import { Workspace } from '../src/core/workspace';
import { openDatabase, SCHEMA_VERSION } from '../src/core/database';
import { pupilSchemaStatements } from '../src/core/pupil-records';
import { teachingSchemaStatements } from '../src/core/teaching-book';

const roots: string[] = [],
  workspaces: Workspace[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of workspaces.splice(0)) w.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const crypto = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from('SYNTHETIC-ENC:' + plain),
  decrypt: (b: Buffer) => b.toString().slice('SYNTHETIC-ENC:'.length),
};
const reply = (content = 'synthetic output') =>
  new Response(
    JSON.stringify({
      id: 'synthetic-model-response',
      model: 'synthetic-provider-model',
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
    }),
  );
function fixture(fetcher: typeof fetch = vi.fn(async () => reply())) {
  const root = mkdtempSync(join(tmpdir(), 'cm-providers-'));
  roots.push(root);
  const models = new ModelRuntime(root, crypto, fetcher);
  return { root, models, fetcher };
}
function select(models: ModelRuntime, provider: ModelProviderId) {
  if (provider === 'doubao')
    models.configure({
      provider,
      expectedRevision: models.settings().revision,
      textModel: 'ep-synthetic-text',
      visionModel: 'ep-synthetic-vision',
    });
  models.select({ provider, expectedRevision: models.settings().revision });
  models.saveKey({ provider, apiKey: `sk-synthetic-${provider}-credential` });
}
const confirm = (p: ModelCheckPreparation) => ({
  token: p.token,
  revision: p.revision,
  wireHash: p.wireHash,
  acknowledgeOutboundPreview: true as const,
});

test('presets stay local, expose no Key and require explicit Doubao model selection', () => {
  const f = fixture(),
    s = f.models.settings();
  expect(s.providers.map((p) => p.provider)).toEqual(['deepseek', 'kimi', 'doubao']);
  expect(s.providers.find((p) => p.provider === 'kimi')).toMatchObject({
    baseUrl: 'https://api.moonshot.cn/v1',
    textModel: 'kimi-k2.6',
    visionModel: 'kimi-k2.6',
  });
  f.models.select({ provider: 'doubao', expectedRevision: s.revision });
  expect(() => f.models.selection('text')).toThrow();
  expect(() => f.models.selection('vision')).toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each(['deepseek', 'kimi', 'doubao'] as const)(
  'exact %s text check uses its credential, wire bytes and isolated usage once',
  async (provider) => {
    const f = fixture();
    select(f.models, provider);
    const p = f.models.prepareCheck({
      type: 'text',
      expectedRevision: f.models.settings().revision,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(p.wireHash).toBe(createHash('sha256').update(p.body).digest('hex'));
    expect(p.body).not.toContain('credential');
    const r = await f.models.check(confirm(p));
    expect(r).toMatchObject({
      provider,
      revision: p.revision,
      result: { usage: { totalTokens: 10 } },
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const args = vi.mocked(f.fetcher).mock.calls[0]!;
    expect(args[0]).toBe(p.endpoint);
    expect(args[1]?.body).toBe(p.body);
    expect(args[1]?.headers).toMatchObject({
      Authorization: `Bearer sk-synthetic-${provider}-credential`,
    });
    expect(f.models.ledger({ provider }).summary).toMatchObject({ totalCalls: 1, totalTokens: 10 });
    for (const other of ['deepseek', 'kimi', 'doubao'].filter((p) => p !== provider))
      expect(f.models.ledger({ provider: other }).summary.totalCalls).toBe(0);
    await expect(f.models.check(confirm(p))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  },
);

test.each(['kimi', 'doubao'] as const)(
  '%s image check sends only synthetic inline image',
  async (provider) => {
    const f = fixture();
    select(f.models, provider);
    const p = f.models.prepareCheck({
      type: 'vision',
      expectedRevision: f.models.settings().revision,
    });
    const body = JSON.parse(p.body);
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    await f.models.check(confirm(p));
    expect(vi.mocked(f.fetcher).mock.calls[0]![1]?.body).toBe(p.body);
    expect(f.models.ledger({ provider }).summary.recentEntries[0]).toMatchObject({
      provider,
      type: 'vision_check',
      configurationRevision: p.revision,
    });
  },
);

test('K3 request omits unsupported thinking and uses supported reasoning parameter', async () => {
  const f = fixture();
  select(f.models, 'kimi');
  f.models.configure({
    provider: 'kimi',
    expectedRevision: f.models.settings().revision,
    textModel: 'kimi-k3',
    visionModel: 'kimi-k3',
  });
  const p = f.models.prepareCheck({ type: 'text', expectedRevision: f.models.settings().revision }),
    body = JSON.parse(p.body);
  expect(body).toMatchObject({
    reasoning_effort: 'low',
    model: 'kimi-k3',
    max_completion_tokens: 1024,
  });
  expect(body).not.toHaveProperty('max_tokens');
  expect(body).not.toHaveProperty('thinking');
  await f.models.check(confirm(p));
  expect(vi.mocked(f.fetcher).mock.calls[0]![1]?.body).toBe(p.body);
});

test.each([
  'vision-disabled',
  'missing-key',
  'wrong-hash',
  'missing-confirmation',
  'stale-revision',
  'old-token',
] as const)('rejects %s before network', async (kind) => {
  const f = fixture();
  select(f.models, 'kimi');
  if (kind === 'vision-disabled') {
    f.models.configure({
      provider: 'kimi',
      expectedRevision: f.models.settings().revision,
      textModel: 'kimi-k2.6',
      visionModel: '',
    });
    expect(() =>
      f.models.prepareCheck({ type: 'vision', expectedRevision: f.models.settings().revision }),
    ).toThrow();
  } else {
    const p = f.models.prepareCheck({
      type: 'text',
      expectedRevision: f.models.settings().revision,
    });
    let input: unknown = confirm(p);
    if (kind === 'missing-key') {
      f.models.deleteKey({ provider: 'kimi' });
      const next = f.models.prepareCheck({
        type: 'text',
        expectedRevision: f.models.settings().revision,
      });
      input = confirm(next);
    }
    if (kind === 'wrong-hash') input = { ...confirm(p), wireHash: 'a'.repeat(64) };
    if (kind === 'missing-confirmation')
      input = { ...confirm(p), acknowledgeOutboundPreview: false };
    if (kind === 'stale-revision')
      f.models.saveKey({ provider: 'kimi', apiKey: 'sk-synthetic-replaced-kimi' });
    if (kind === 'old-token')
      f.models.prepareCheck({ type: 'text', expectedRevision: f.models.settings().revision });
    await expect(f.models.check(input)).rejects.toBeDefined();
  }
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each([401, 402, 429, 500] as const)(
  'HTTP %s never retries or falls back and labels original supplier',
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status })),
      f = fixture(fetcher);
    select(f.models, 'kimi');
    const p = f.models.prepareCheck({
      type: 'text',
      expectedRevision: f.models.settings().revision,
    });
    await expect(f.models.check(confirm(p))).rejects.toMatchObject({
      message: expect.stringContaining('Kimi'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.models.ledger({ provider: 'kimi' }).summary).toMatchObject({
      totalCalls: 1,
      successCalls: 0,
    });
    expect(f.models.ledger({ provider: 'deepseek' }).summary.totalCalls).toBe(0);
  },
);

test('network failure retains unknown usage without retry', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError('synthetic offline');
    }),
    f = fixture(fetcher);
  select(f.models, 'doubao');
  const p = f.models.prepareCheck({ type: 'text', expectedRevision: f.models.settings().revision });
  await expect(f.models.check(confirm(p))).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(f.models.ledger({ provider: 'doubao' }).summary.recentEntries[0]!.usage).toBeUndefined();
});

test('configuration and provider credentials persist separately and deletion never removes usage', async () => {
  const f = fixture();
  for (const provider of ['deepseek', 'kimi', 'doubao'] as const) select(f.models, provider);
  const before = f.models.settings(),
    reopened = new ModelRuntime(f.root, crypto, f.fetcher);
  expect(reopened.settings()).toEqual(before);
  expect(JSON.stringify(before)).not.toContain('sk-synthetic');
  expect(reopened.loadKey()).toBe('sk-synthetic-doubao-credential');
  const p = reopened.prepareCheck({ type: 'text', expectedRevision: reopened.settings().revision });
  await reopened.check(confirm(p));
  reopened.deleteKey({ provider: 'doubao' });
  expect(reopened.ledger({ provider: 'doubao' }).summary.totalCalls).toBe(1);
  expect(
    reopened.settings().providers.find((p) => p.provider === 'kimi')!.credentials.configured,
  ).toBe(true);
  expect(() => reopened.loadKey()).toThrow();
});

test('legacy DeepSeek encrypted key and ledger are reused without decrypting during status/config migration', () => {
  const f = fixture(),
    legacy = new DeepSeekCredentialStore(f.root, crypto),
    ledger = new DeepSeekLedger(f.root);
  legacy.saveKey('sk-synthetic-legacy-deepseek');
  ledger.record({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'text_check',
    requestModel: 'historical-model',
    status: 'success',
    durationMs: 1,
    promptVersion: 'historical',
  });
  const decrypt = vi.fn(crypto.decrypt),
    reopened = new ModelRuntime(f.root, { ...crypto, decrypt }, f.fetcher);
  expect(reopened.settings().providers[0]!.credentials.configured).toBe(true);
  expect(reopened.ledger({ provider: 'deepseek' }).summary.totalCalls).toBe(1);
  expect(decrypt).not.toHaveBeenCalled();
  expect(reopened.loadKey()).toBe('sk-synthetic-legacy-deepseek');
  expect(decrypt).toHaveBeenCalledTimes(1);
});

test('encrypted storage unavailable never writes a plaintext key or makes a request', () => {
  const f = fixture(),
    models = new ModelRuntime(f.root, { ...crypto, isAvailable: () => false }, f.fetcher);
  expect(() => models.saveKey({ provider: 'kimi', apiKey: 'sk-synthetic-safe-key' })).toThrow();
  expect(models.settings().providers[1]!.credentials.configured).toBe(false);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test('corrupt/extra persisted configuration is preserved and rejected rather than resetting accounts', () => {
  const f = fixture();
  const bad = JSON.stringify({
    version: 1,
    revision: randomUUID(),
    selectedProvider: 'other',
    providers: {},
  });
  writeFileSync(join(f.root, 'model-providers.json'), bad);
  expect(() => new ModelRuntime(f.root, crypto, f.fetcher)).toThrow();
  expect(readFileSync(join(f.root, 'model-providers.json'), 'utf8')).toBe(bad);
});

test('captured generation cannot move to a different supplier after preparation', async () => {
  const f = fixture();
  select(f.models, 'kimi');
  const selected = f.models.selection('text'),
    key = f.models.loadKey();
  select(f.models, 'doubao');
  await expect(
    Promise.resolve().then(() =>
      f.models.generateText(key, [{ role: 'user', content: 'synthetic' }], {
        provider: selected.provider,
        model: selected.requestModel,
        configurationRevision: selected.configurationRevision,
      }),
    ),
  ).rejects.toMatchObject({ code: 'ABORTED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each(['cancel', 'select', 'key', 'configure'] as const)(
  'late check after %s cannot publish success or reach another supplier',
  async (action) => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
      f = fixture(fetcher);
    select(f.models, 'kimi');
    const p = f.models.prepareCheck({
        type: 'text',
        expectedRevision: f.models.settings().revision,
      }),
      pending = f.models.check(confirm(p));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    if (action === 'cancel') f.models.invalidate();
    if (action === 'select')
      f.models.select({ provider: 'deepseek', expectedRevision: f.models.settings().revision });
    if (action === 'key')
      f.models.saveKey({ provider: 'kimi', apiKey: 'sk-synthetic-replacement' });
    if (action === 'configure')
      f.models.configure({
        provider: 'kimi',
        expectedRevision: f.models.settings().revision,
        textModel: 'kimi-k3',
        visionModel: 'kimi-k3',
      });
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    finish(reply());
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(f.models.busy).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.models.ledger({ provider: 'kimi' }).summary.recentEntries[0]).toMatchObject({
      status: 'failed',
      errorCode: 'ABORTED',
    });
  },
);

test('Schema10 migrates atomically to11 and model configuration/key/usage stay outside business backup', async () => {
  const f = fixture(),
    workspace = new Workspace(join(f.root, 'workspace-data'));
  workspaces.push(workspace);
  const snapshot = workspace.seedDemo({ epoch: workspace.snapshot().epoch });
  select(f.models, 'kimi');
  const backup = workspace.exportBackup({ epoch: snapshot.epoch });
  expect(JSON.parse(backup.toString()).version).toBe(SCHEMA_VERSION);
  expect(backup.toString()).not.toContain('sk-synthetic-kimi');
  expect(backup.toString()).not.toContain('model-providers.json');
  const dbPath = join(workspace.root, 'workspaces', snapshot.epoch, 'data.sqlite');
  workspace.close();
  workspaces.splice(workspaces.indexOf(workspace), 1);
  const old = openDatabase(dbPath, 'open');
  for (const sql of [...pupilSchemaStatements, ...teachingSchemaStatements].reverse()) {
    const name = sql.match(/CREATE (?:TABLE|INDEX) (\w+)/)![1]!;
    old.exec(`DROP ${sql.includes('CREATE INDEX') ? 'INDEX' : 'TABLE'} ${name}`);
  }
  old.exec('PRAGMA user_version=10');
  old.close();
  const before = readFileSync(dbPath);
  expect(() =>
    openDatabase(dbPath, 'open', {
      migrationCheckpoint: (stage) => {
        if (stage === 'upgraded') throw Error('synthetic migration failure');
      },
    }),
  ).toThrow();
  const preserved = openDatabase(dbPath, 'readonly');
  expect(preserved.prepare('PRAGMA user_version').get()?.user_version).toBe(10);
  preserved.close();
  const current = openDatabase(dbPath, 'open');
  expect(current.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  current.close();
  expect(before.length).toBeGreaterThan(0);
});

test('timeout releases the check slot even when transport never settles', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {})),
    f = fixture(fetcher);
  select(f.models, 'kimi');
  const p = f.models.prepareCheck({ type: 'text', expectedRevision: f.models.settings().revision });
  const pending = expect(f.models.check(confirm(p))).rejects.toMatchObject({ code: 'ABORTED' });
  await vi.advanceTimersByTimeAsync(30001);
  await pending;
  expect(f.models.busy).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(f.models.ledger({ provider: 'kimi' }).summary.recentEntries[0]).toMatchObject({
    status: 'failed',
    errorCode: 'ABORTED',
  });
});

test('duplicate IDs cannot move a pending call; duplicate completion never counts tokens again', () => {
  const f = fixture(),
    id = randomUUID();
  select(f.models, 'kimi');
  const record = {
    id,
    timestamp: new Date().toISOString(),
    type: 'score_explanation' as const,
    provider: 'kimi' as const,
    requestModel: 'kimi-k2.6',
    status: 'in_progress' as const,
    durationMs: 0,
    promptVersion: 'synthetic-v1',
  };
  f.models.startCall(record);
  select(f.models, 'doubao');
  expect(() => f.models.startCall({ ...record, provider: 'doubao' })).toThrow();
  const result = {
    status: 'success' as const,
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  };
  f.models.completeCall(id, result);
  f.models.completeCall(id, result);
  expect(f.models.ledger({ provider: 'kimi' }).summary).toMatchObject({
    totalCalls: 1,
    successCalls: 1,
    totalTokens: 3,
  });
  expect(f.models.ledger({ provider: 'doubao' }).summary.totalCalls).toBe(0);
  expect(() => f.models.startCall(record)).toThrow();
});

test('a malicious check response cannot echo the complete credential into IPC or ledger metadata', async () => {
  const key = 'sk-synthetic-kimi-credential';
  const f = fixture(
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: key, model: key, choices: [{ message: { content: key } }] }),
        ),
    ),
  );
  select(f.models, 'kimi');
  const p = f.models.prepareCheck({ type: 'text', expectedRevision: f.models.settings().revision });
  const receipt = await f.models.check(confirm(p));
  expect(JSON.stringify(receipt)).not.toContain(key);
  expect(JSON.stringify(f.models.ledger({ provider: 'kimi' }))).not.toContain(key);
});
