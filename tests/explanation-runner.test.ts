import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { WorkerClient } from '../src/main/worker-client';
import { ExplanationRunner } from '../src/main/explanation-runner';
import { DeepSeekLedger } from '../src/core/deepseek/ledger';
import { DomainError } from '../src/core/errors';
import type { DeepSeekGenerationResult } from '../src/core/deepseek/types';
import type { DeepSeekClient } from '../src/core/deepseek/client';
import { DeepSeekGenerationError } from '../src/core/deepseek/client';
import type { ExplanationDraftSummary } from '../src/shared/explanation-drafts';
import type { Result, Snapshot } from '../src/shared/contracts';
import { modelProviderFixture } from './fixtures/model-provider';

const roots: string[] = [];
const workers: WorkerClient[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cm-explanation-runner-'));
  roots.push(directory);
  const root = join(directory, 'data');
  const workspace = new Workspace(root);
  const epoch = workspace.snapshot().epoch;
  let versionId: string;
  const subjectId = randomUUID();
  const groupId = randomUUID();
  try {
    workspace.createClass({ epoch, name: '合成班' });
    const classId = workspace.snapshot().classes[0]!.id;
    workspace.saveStudent({
      epoch,
      classId,
      studentNumber: '0001',
      displayName: '不得出站的合成姓名',
    });
    const studentId = workspace.snapshot().students[0]!.id;
    const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), {
      epoch,
      classId,
      expectedRevision: 0,
      definition: {
        name: '合成月考',
        date: '2026-09-30',
        academicYear: '2026-2027',
        term: '上学期',
        grade: '高一',
      },
      subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 }],
      groups: [{ id: groupId, name: '组', subjectIds: [subjectId] }],
      assignments: [{ studentId, groupId }],
      scoreBasis: 'raw',
      format: 'csv',
      fileName: 'private.csv',
    });
    versionId = workspace.scores.confirm({
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '合成测试',
    }).versionId;
  } finally {
    workspace.close();
  }
  const workerPath = join(directory, 'worker.cjs');
  buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/worker.ts'],
      outfile: workerPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
    }),
  );
  const worker = new WorkerClient(workerPath, root);
  workers.push(worker);
  const ledger = new DeepSeekLedger(directory);
  const generateText = vi.fn<DeepSeekClient['generateText']>();
  const loadKey = vi.fn(() => 'synthetic-private-key');
  const runner = new ExplanationRunner(worker, { generateText }, { loadKey }, ledger);
  const prepare = async () =>
    unwrap(
      await runner.prepare({
        epoch,
        sourceVersionId: versionId,
        selection: {
          scope: { kind: 'class' },
          subjectIds: [subjectId],
          metrics: ['fullScore', 'validCount', 'mean'],
        },
      }),
    );
  const prepared = await prepare();
  const response: DeepSeekGenerationResult = {
    content: JSON.stringify({
      formatVersion: 1,
      observations: prepared.packet.wire.facts.map(({ id, value }) => ({ factId: id, value })),
      interpretations: [],
      questions: [],
      actions: [],
      limitations: ['无题目级数据，无法判断'],
    }),
    responseId: 'synthetic-response',
    model: 'synthetic-model',
    durationMs: 10,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  };
  generateText.mockResolvedValue(response);
  const command = { epoch, token: prepared.token };
  const drafts = async () =>
    unwrap(await worker.call<ExplanationDraftSummary[]>('listExplanations', { epoch }));
  return {
    directory,
    worker,
    ledger,
    runner,
    generateText,
    loadKey,
    prepare,
    response,
    command,
    epoch,
    drafts,
  };
}

test('real worker saves a generated draft with minimal outbound facts and a durable ledger', async () => {
  const f = await fixture();
  const receipt = unwrap(await f.runner.generate(f.command));
  expect(receipt.revision).toBe(1);
  expect(await f.drafts()).toHaveLength(1);
  const [, messages] = f.generateText.mock.calls[0]!;
  const wire = JSON.parse(messages[1]!.content);
  expect(Object.keys(wire).sort()).toEqual(['facts', 'formatVersion', 'scope']);
  expect(JSON.stringify(messages)).not.toMatch(/不得出站|private.csv|合成月考/);
  const summary = new DeepSeekLedger(f.directory).getSummary();
  expect(summary).toMatchObject({ totalCalls: 1, successCalls: 1, totalTokens: 150 });
  expect(summary.recentEntries[0]).toMatchObject({ type: 'score_explanation', status: 'success' });
  expect(readFileSync(join(f.directory, 'deepseek-ledger.json'), 'utf8')).not.toMatch(
    /synthetic-private-key|observations|不得出站/,
  );
  expect((await f.runner.generate(f.command)).ok).toBe(false);
  expect(f.generateText).toHaveBeenCalledTimes(1);
});

test.each(['deepseek', 'kimi', 'doubao'] as const)(
  '%s explanation text preserves provider/model/prompt/usage in real worker history',
  async (provider) => {
    const f = await fixture(),
      { models, fetcher } = modelProviderFixture(f.directory, provider, f.response);
    const runner = new ExplanationRunner(f.worker, models, models, models, (kind) =>
      models.selection(kind),
    );
    const selection = models.selection('text');
    const receipt = unwrap(await runner.generate(f.command));
    const draft = unwrap(
      await f.worker.call<import('../src/shared/explanation-drafts').ExplanationDraftView>(
        'readExplanation',
        { epoch: f.epoch, id: receipt.id },
      ),
    );
    expect(draft.payload.provider).toMatchObject({
      ...selection,
      responseId: f.response.responseId,
      usage: f.response.usage,
    });
    expect(draft.payload.promptVersion).toBe('score-explanation-v1');
    expect(models.ledger({ provider }).summary).toMatchObject({
      totalCalls: 1,
      totalTokens: 150,
      recentEntries: [{ ...selection, type: 'score_explanation' }],
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).model).toBe(selection.requestModel);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test('pending model request leaves the real worker available; duplicate generation is rejected', async () => {
  const f = await fixture();
  const arrived = deferred<void>();
  const network = deferred<DeepSeekGenerationResult>();
  f.generateText.mockImplementation(async () => {
    arrived.resolve();
    return network.promise;
  });
  const generation = f.runner.generate(f.command);
  await arrived.promise;
  expect(unwrap(await f.worker.call<Snapshot>('snapshot')).epoch).toBe(f.epoch);
  expect(f.ledger.getSummary().recentEntries[0]?.status).toBe('in_progress');
  await expect(f.runner.generate(f.command)).rejects.toMatchObject({ code: 'BUSY' });
  network.resolve(f.response);
  expect((await generation).ok).toBe(true);
});

test.each(['cancel', 'credential-change', 'restore'] as const)(
  '%s rejects a late successful response and preserves consumed usage',
  async (kind) => {
    const f = await fixture();
    const arrived = deferred<AbortSignal>();
    const network = deferred<DeepSeekGenerationResult>();
    f.generateText.mockImplementation(async (_key, _messages, options) => {
      arrived.resolve(options!.signal!);
      return network.promise; // Deliberately ignores abort to exercise the late-response guard.
    });
    const generation = f.runner.generate(f.command);
    const signal = await arrived.promise;
    let restoredEpoch = f.epoch;
    if (kind === 'cancel') unwrap(await f.runner.cancel({ epoch: f.epoch }));
    if (kind === 'credential-change') f.runner.invalidate();
    if (kind === 'restore') {
      const bytes = unwrap(await f.worker.call<Uint8Array>('exportBackup', { epoch: f.epoch }));
      const preview = unwrap(await f.worker.call<{ token: string }>('previewRestoreBytes', bytes));
      restoredEpoch = unwrap(
        await f.worker.call<Snapshot>('commitRestore', { epoch: f.epoch, token: preview.token }),
      ).epoch;
      f.runner.invalidate();
    }
    expect(signal.aborted).toBe(true);
    network.resolve(f.response);
    await expect(generation).rejects.toMatchObject({ code: 'ABORTED' });
    expect(unwrap(await f.worker.call('listExplanations', { epoch: restoredEpoch }))).toEqual([]);
    expect(f.ledger.getSummary()).toMatchObject({
      totalCalls: 1,
      successCalls: 0,
      totalTokens: 150,
    });
    expect(f.ledger.getSummary().recentEntries[0]).toMatchObject({
      status: 'failed',
      errorCode: 'ABORTED',
    });
  },
);

test('an old epoch cannot cancel a current generation', async () => {
  const f = await fixture();
  const arrived = deferred<AbortSignal>();
  const network = deferred<DeepSeekGenerationResult>();
  f.generateText.mockImplementation(async (_key, _messages, options) => {
    arrived.resolve(options!.signal!);
    return network.promise;
  });
  const generation = f.runner.generate(f.command);
  const signal = await arrived.promise;
  expect((await f.runner.cancel({ epoch: randomUUID() })).ok).toBe(false);
  expect(signal.aborted).toBe(false);
  network.resolve(f.response);
  expect((await generation).ok).toBe(true);
});

test('invalid model output is charged but never overwrites an existing draft', async () => {
  const f = await fixture();
  const first = unwrap(await f.runner.generate(f.command));
  const next = await f.prepare();
  f.generateText.mockResolvedValue({ ...f.response, content: '{}' });
  expect(await f.runner.generate({ epoch: f.epoch, token: next.token })).toMatchObject({
    ok: false,
    error: { code: 'EXPLANATION_INVALID' },
  });
  expect((await f.drafts()).map((draft) => draft.record.id)).toEqual([first.id]);
  expect(f.ledger.getSummary()).toMatchObject({ totalCalls: 2, successCalls: 1, totalTokens: 300 });
});

test('network failure does not create a draft or invent zero token usage and permits explicit retry', async () => {
  const f = await fixture();
  f.generateText.mockRejectedValueOnce(new DomainError('TIMEOUT', '合成超时'));
  await expect(f.runner.generate(f.command)).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(await f.drafts()).toEqual([]);
  expect(f.ledger.getSummary().recentEntries[0]).toMatchObject({
    status: 'failed',
    errorCode: 'TIMEOUT',
  });
  expect(f.ledger.getSummary().recentEntries[0]?.usage).toBeUndefined();
  const next = await f.prepare();
  expect((await f.runner.generate({ epoch: f.epoch, token: next.token })).ok).toBe(true);
});

test('missing credentials or failed start ledger prevent any paid request', async () => {
  const f = await fixture();
  f.loadKey.mockImplementationOnce(() => {
    throw new DomainError('NO_KEY', 'No key');
  });
  await expect(f.runner.generate(f.command)).rejects.toMatchObject({ code: 'NO_KEY' });
  expect(f.generateText).not.toHaveBeenCalled();
  const next = await f.prepare();
  vi.spyOn(f.ledger, 'startCall').mockImplementationOnce(() => {
    throw new Error('synthetic disk failure');
  });
  await expect(f.runner.generate({ epoch: f.epoch, token: next.token })).rejects.toThrow(
    'synthetic disk failure',
  );
  expect(f.generateText).not.toHaveBeenCalled();
  expect(await f.drafts()).toEqual([]);
});

test('ledger completion failure preserves the saved draft and does not resend', async () => {
  const f = await fixture();
  vi.spyOn(f.ledger, 'completeCall').mockImplementationOnce(() => {
    throw new Error('synthetic disk failure');
  });
  await expect(f.runner.generate(f.command)).rejects.toThrow('synthetic disk failure');
  expect(await f.drafts()).toHaveLength(1);
  expect((await f.runner.generate(f.command)).ok).toBe(false);
  expect(f.generateText).toHaveBeenCalledTimes(1);
  expect(new DeepSeekLedger(f.directory).getSummary().recentEntries[0]?.status).toBe('interrupted');
});

test('ledger failure completions count usage once and survive reopening', async () => {
  const f = await fixture();
  const id = randomUUID();
  f.ledger.startCall({
    id,
    timestamp: new Date().toISOString(),
    type: 'score_explanation',
    requestModel: 'synthetic',
    status: 'in_progress',
    durationMs: 0,
    promptVersion: 'synthetic',
  });
  const completion = {
    status: 'failed' as const,
    errorCode: 'EXPLANATION_INVALID',
    durationMs: 10,
    usage: f.response.usage!,
  };
  f.ledger.completeCall(id, completion);
  f.ledger.completeCall(id, completion);
  expect(new DeepSeekLedger(f.directory).getSummary()).toMatchObject({
    totalCalls: 1,
    successCalls: 0,
    totalTokens: 150,
  });
});

test('a malformed replacement selection invalidates the old paid generation token', async () => {
  const f = await fixture();
  expect(
    await f.runner.prepare({ epoch: f.epoch, sourceVersionId: randomUUID(), selection: {} }),
  ).toMatchObject({ ok: false });
  expect(await f.runner.generate(f.command)).toMatchObject({
    ok: false,
    error: { code: 'EXPLANATION_EXPIRED' },
  });
  expect(f.generateText).not.toHaveBeenCalled();
});

test('adapter-rejected truncated responses still preserve their known billing metadata', async () => {
  const f = await fixture();
  const metadata = {
    responseId: f.response.responseId,
    model: f.response.model,
    durationMs: f.response.durationMs,
    usage: f.response.usage,
  };
  f.generateText.mockRejectedValueOnce(new DeepSeekGenerationError('合成截断', metadata));
  await expect(f.runner.generate(f.command)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(f.ledger.getSummary()).toMatchObject({ totalTokens: 150, successCalls: 0 });
  expect(await f.drafts()).toEqual([]);
});

test('cancellation after completion dispatch is observed by the real worker before commit', async () => {
  const f = await fixture();
  const dispatched = deferred<void>();
  const release = deferred<void>();
  const original = f.worker.call.bind(f.worker);
  vi.spyOn(f.worker, 'call').mockImplementation(
    async <T>(
      operation: Parameters<WorkerClient['call']>[0],
      input?: unknown,
    ): Promise<Result<T>> => {
      if (operation === 'completeExplanation') {
        dispatched.resolve();
        await release.promise;
      }
      return original<T>(operation, input);
    },
  );
  const generation = f.runner.generate(f.command);
  await dispatched.promise;
  f.runner.invalidate();
  release.resolve();
  expect(await generation).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  expect(await f.drafts()).toEqual([]);
  expect(f.ledger.getSummary()).toMatchObject({ totalTokens: 150, successCalls: 0 });
});
