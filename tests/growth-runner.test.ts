import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { WorkerClient } from '../src/main/worker-client';
import { GrowthRunner } from '../src/main/growth-runner';
import { DeepSeekLedger } from '../src/core/deepseek/ledger';
import { DomainError } from '../src/core/errors';
import type { DeepSeekClient } from '../src/core/deepseek/client';
import type { DeepSeekGenerationResult } from '../src/core/deepseek/types';
import type { Result, Snapshot } from '../src/shared/contracts';
import type { GrowthTimeline, GrowthPreparation } from '../src/shared/growth';
import { growthStorageFixture } from './fixtures/growth-storage';
import { modelProviderFixture } from './fixtures/model-provider';

const roots: string[] = [],
  workers: WorkerClient[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-growth-runner-'));
  roots.push(root);
  const data = join(root, 'data'),
    workspace = new Workspace(data),
    f = await growthStorageFixture(workspace);
  const content = {
    date: '2026-10-01',
    kind: 'conversation' as const,
    description: '合成成长甲的私有完整谈话，不能外发。',
    source: '合成教师',
    action: '',
    result: '',
    followUp: 'planned' as const,
    summaryFact: '完成一次订正练习，后续结果待核实。',
  };
  const event = workspace.growth.saveEvent({
    epoch: f.epoch,
    studentId: f.studentId,
    requestId: randomUUID(),
    content,
    reason: '合成事件',
  });
  workspace.close();
  const path = join(root, 'worker.cjs');
  buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/worker.ts'],
      outfile: path,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
    }),
  );
  const worker = new WorkerClient(path, data);
  workers.push(worker);
  const ledger = new DeepSeekLedger(root),
    generateText = vi.fn<DeepSeekClient['generateText']>(),
    loadKey = vi.fn(() => 'sk-synthetic-growth-only');
  const runner = new GrowthRunner(worker, { generateText }, { loadKey }, ledger),
    prepareInput = {
      epoch: f.epoch,
      selection: {
        studentId: f.studentId,
        from: '2026-10-01',
        to: '2026-10-31',
        events: [{ id: event.id, revision: 1 }],
        scores: [{ versionId: f.score.versionId, subjectId: f.subjectId }],
      },
      acknowledgeSyntheticOnly: true,
      acknowledgeRedacted: true,
    };
  const prepare = async () => value(await runner.prepare(prepareInput));
  const prepared = await prepare();
  const response: DeepSeekGenerationResult = {
    content: JSON.stringify({
      formatVersion: 1,
      factIds: prepared.packet.wire.facts.map((f) => f.id),
      suggestions: [],
      limitations: ['事实较少，只能描述所选资料。'],
    }),
    model: 'synthetic-growth-model',
    responseId: 'synthetic-growth-response',
    durationMs: 1,
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
  };
  generateText.mockResolvedValue(response);
  const timeline = async () =>
    value(
      await worker.call<GrowthTimeline>('growthTimeline', {
        epoch: f.epoch,
        studentId: f.studentId,
      }),
    );
  return {
    root,
    ...f,
    content,
    event,
    worker,
    runner,
    ledger,
    generateText,
    loadKey,
    prepared,
    prepare,
    prepareInput,
    response,
    timeline,
    command: { epoch: f.epoch, token: prepared.token },
  };
}

test('actual worker and Main coordinator save only a draft and record observed synthetic provider usage', async () => {
  const f = await fixture(),
    receipt = value(await f.runner.generate(f.command));
  expect(f.generateText).toHaveBeenCalledTimes(1);
  const messages = JSON.stringify(f.generateText.mock.calls[0]![1]);
  expect(messages).toContain('订正练习');
  for (const secret of [f.studentId, f.score.versionId, '合成成长甲', '完整谈话', 'GROWTH_001'])
    expect(messages).not.toContain(secret);
  const timeline = await f.timeline();
  expect(timeline.summaries[0]?.record).toMatchObject({
    id: receipt.id,
    status: 'draft',
    reviewed: false,
    provider: { usage: { totalTokens: 30 } },
  });
  expect(timeline.entries).toHaveLength(0);
  expect(f.ledger.getSummary()).toMatchObject({ totalCalls: 1, successCalls: 1, totalTokens: 30 });
  expect(f.ledger.getSummary().recentEntries[0]?.type).toBe('growth_summary');
  expect(f.ledger.getSummary().recentEntries[0]?.growthInput).toEqual({
    source: f.prepared.packet.source,
    inputHash: f.prepared.packet.inputHash,
  });
  const ledgerText = readFileSync(join(f.root, 'deepseek-ledger.json'), 'utf8');
  for (const text of ['完整谈话', '订正练习', '合成成长甲', 'GROWTH_001'])
    expect(ledgerText).not.toContain(text);
  expect(
    await f.worker.call('completeGrowthSummary', { epoch: f.epoch, output: 'forged' }),
  ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
});

test.each(['deepseek', 'kimi', 'doubao'] as const)(
  '%s growth text keeps exact provenance in actual worker history and original ledger',
  async (provider) => {
    const f = await fixture(),
      { models, fetcher } = modelProviderFixture(f.root, provider, f.response);
    const runner = new GrowthRunner(f.worker, models, models, models, (kind) =>
      models.selection(kind),
    );
    const selection = models.selection('text');
    value(await runner.generate(f.command));
    const timeline = await f.timeline();
    expect(timeline.summaries[0]!.record.provider).toMatchObject({
      ...selection,
      responseId: f.response.responseId,
      usage: f.response.usage,
    });
    expect(timeline.summaries[0]!.record).toMatchObject({ source: f.prepared.packet.source });
    expect(models.ledger({ provider }).summary).toMatchObject({
      totalCalls: 1,
      totalTokens: 30,
      recentEntries: [
        { ...selection, promptVersion: f.prepared.packet.promptVersion, type: 'growth_summary' },
      ],
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).model).toBe(selection.requestModel);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test('invalid provider output preserves events and permits offline follow-up and manual summary', async () => {
  const f = await fixture();
  f.generateText.mockResolvedValue({ ...f.response, content: '{}' });
  expect(await f.runner.generate(f.command)).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION' },
  });
  expect((await f.timeline()).summaries).toHaveLength(0);
  expect(new DeepSeekLedger(f.root).getSummary().recentEntries[0]).toMatchObject({
    status: 'failed',
    growthInput: { source: f.prepared.packet.source, inputHash: f.prepared.packet.inputHash },
  });
  expect(
    await f.worker.call('saveGrowthEvent', {
      epoch: f.epoch,
      id: f.event.id,
      expectedRevision: 1,
      studentId: f.studentId,
      requestId: randomUUID(),
      reason: '模型失败后离线追加',
      content: { ...f.content, result: '已追加离线结果' },
    }),
  ).toMatchObject({ ok: true, value: { revision: 2 } });
  expect(f.runner.busy).toBe(false);
  expect(f.generateText).toHaveBeenCalledTimes(1);
});

test.each(['cancel', 'configuration', 'restore'] as const)(
  'late synthetic provider response after %s cannot save or trigger a retry',
  async (action) => {
    const f = await fixture(),
      pending = deferred<DeepSeekGenerationResult>(),
      called = deferred<void>();
    f.generateText.mockImplementation(async () => {
      called.resolve();
      return pending.promise;
    });
    const result = f.runner.generate(f.command);
    await called.promise;
    await expect(f.runner.generate(f.command)).rejects.toThrow('重复');
    if (action === 'cancel') value(await f.runner.cancel({ epoch: f.epoch }));
    else if (action === 'configuration') f.runner.invalidate();
    else {
      const bytes = value(await f.worker.call<Uint8Array>('exportBackup', { epoch: f.epoch })),
        preview = value(await f.worker.call<{ token: string }>('previewRestoreBytes', bytes));
      const restored = value(
        await f.worker.call<Snapshot>('commitRestore', { epoch: f.epoch, token: preview.token }),
      );
      expect(restored.epoch).not.toBe(f.epoch);
      f.runner.invalidate();
    }
    pending.resolve(f.response);
    await expect(result).rejects.toThrow('取消');
    expect(f.generateText).toHaveBeenCalledTimes(1);
    expect(f.runner.busy).toBe(false);
    expect(new DeepSeekLedger(f.root).getSummary().recentEntries[0]).toMatchObject({
      status: 'failed',
      errorCode: 'ABORTED',
      growthInput: { source: f.prepared.packet.source, inputHash: f.prepared.packet.inputHash },
    });
    const current = value(await f.worker.call<Snapshot>('snapshot'));
    expect(
      value(
        await f.worker.call<GrowthTimeline>('growthTimeline', {
          epoch: current.epoch,
          studentId: f.studentId,
        }),
      ).summaries,
    ).toHaveLength(0);
  },
);

test('event revision changed while generation runs invalidates result before worker commit', async () => {
  const f = await fixture(),
    pending = deferred<DeepSeekGenerationResult>(),
    called = deferred<void>();
  f.generateText.mockImplementation(async () => {
    called.resolve();
    return pending.promise;
  });
  const result = f.runner.generate(f.command);
  await called.promise;
  value(
    await f.worker.call('saveGrowthEvent', {
      epoch: f.epoch,
      id: f.event.id,
      expectedRevision: 1,
      studentId: f.studentId,
      requestId: randomUUID(),
      reason: '并发更正',
      content: { ...f.content, summaryFact: '核实后更正为两次练习。' },
    }),
  );
  pending.resolve(f.response);
  expect(await result).toMatchObject({ ok: false, error: { code: 'GROWTH_STALE' } });
  expect((await f.timeline()).summaries).toHaveLength(0);
  expect(f.generateText).toHaveBeenCalledTimes(1);
  expect(new DeepSeekLedger(f.root).getSummary().recentEntries[0]).toMatchObject({
    status: 'failed',
    errorCode: 'GROWTH_STALE',
    growthInput: { source: f.prepared.packet.source, inputHash: f.prepared.packet.inputHash },
  });
});

test('corrupted persisted growth source is rejected without replacing the ledger', async () => {
  const f = await fixture();
  value(await f.runner.generate(f.command));
  const path = join(f.root, 'deepseek-ledger.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data.entries[0].growthInput.source.selection.events[0].revision = 0;
  const invalid = JSON.stringify(data);
  writeFileSync(path, invalid);
  const reopened = new DeepSeekLedger(f.root);
  expect(() => reopened.getSummary()).toThrow('异常条目');
  expect(readFileSync(path, 'utf8')).toBe(invalid);
});

test('ledger start failure prevents provider request and leaves no summary', async () => {
  const f = await fixture();
  vi.spyOn(f.ledger, 'startCall').mockImplementation(() => {
    throw new DomainError('STORAGE_ERROR', 'Synthetic ledger start failure');
  });
  await expect(f.runner.generate(f.command)).rejects.toThrow('ledger');
  expect(f.generateText).not.toHaveBeenCalled();
  expect((await f.timeline()).summaries).toHaveLength(0);
});

test('ledger completion failure does not undo a committed draft or require paid regeneration', async () => {
  const f = await fixture();
  vi.spyOn(f.ledger, 'completeCall').mockImplementation(() => {
    throw new DomainError('STORAGE_ERROR', 'Synthetic ledger completion failure');
  });
  await expect(f.runner.generate(f.command)).rejects.toThrow('ledger');
  const timeline = await f.timeline();
  expect(timeline.summaries).toHaveLength(1);
  expect(timeline.entries).toHaveLength(0);
  expect(f.generateText).toHaveBeenCalledTimes(1);
  expect(new DeepSeekLedger(f.root).getSummary().recentEntries[0]).toMatchObject({
    status: 'interrupted',
    growthInput: { source: f.prepared.packet.source, inputHash: f.prepared.packet.inputHash },
  });
});

test('cancelled worker admission refuses saving before any record is committed', async () => {
  const f = await fixture(),
    requestId = randomUUID();
  value(await f.worker.call('claimGrowthSummary', { ...f.command, requestId }));
  const cancellation = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(cancellation), 0, 1);
  const result = await f.worker.call('completeGrowthSummary', {
    cancellation,
    command: {
      ...f.command,
      requestId,
      output: f.response.content,
      provider: {
        provider: 'deepseek',
        requestModel: 'synthetic',
        responseModel: f.response.model,
        responseId: f.response.responseId,
        generatedAt: new Date().toISOString(),
        durationMs: 1,
        usage: f.response.usage,
      },
    },
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  expect((await f.timeline()).summaries).toHaveLength(0);
  expect(
    await f.worker.call<GrowthPreparation>('prepareGrowthSummary', f.prepareInput),
  ).toMatchObject({ ok: true });
});
