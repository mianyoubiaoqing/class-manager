import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { DeepSeekClient, DeepSeekLedger } from '../src/core/deepseek';
import { DomainError } from '../src/core/errors';
import { prepareGradingImage } from '../src/core/grading-image';
import { GradingRunner } from '../src/main/grading-runner';
import { WorkerClient } from '../src/main/worker-client';
import type { Result } from '../src/shared/contracts';
import type {
  GradingDraftView,
  GradingAttemptView,
  GradingPreparationView,
  GradingReceipt,
} from '../src/shared/grading-records';
import type { GradingPreparation } from '../src/core/grading';
import { gradingStorageFixture } from './fixtures/grading-storage';

let workerSource: string;
const roots: string[] = [];
const workers: WorkerClient[] = [];
const runners: GradingRunner[] = [];
beforeAll(() => {
  workerSource = buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/worker.ts'],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
    }),
  ).outputFiles[0]!.text;
});
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.invalidate();
  for (const worker of workers.splice(0)) await worker.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-grading-runner-'));
  roots.push(root);
  const workspace = new Workspace(root);
  let f;
  try {
    f = await gradingStorageFixture(workspace);
  } finally {
    workspace.close();
  }
  const script = join(root, 'worker.cjs');
  writeFileSync(script, workerSource);
  const worker = new WorkerClient(script, root);
  workers.push(worker);
  const call = vi.spyOn(worker, 'call');
  const success = (content = f.output) =>
    new Response(
      JSON.stringify({
        id: 'synthetic-grading-response',
        model: 'synthetic-model',
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      }),
    );
  const fetcher = vi.fn<typeof fetch>(async () => success());
  const client = new DeepSeekClient({ customFetch: fetcher });
  const ledger = new DeepSeekLedger(root);
  const credentials = { loadKey: vi.fn(() => 'sk-synthetic-grading-key') };
  const images = { gradingImage: vi.fn(prepareGradingImage) };
  const runner = new GradingRunner(worker, client, credentials, ledger, images);
  runners.push(runner);
  const read = () =>
    worker.call<GradingDraftView>('readGrading', { epoch: f.epoch, id: f.draft.id }).then(value);
  const attempts = () =>
    worker
      .call<GradingAttemptView[]>('gradingAttempts', { epoch: f.epoch, id: f.draft.id })
      .then(value);
  const prepare = async (selectedQuestionIds = ['choice']) => {
    const draft = await read();
    return value(
      await runner.prepare({
        epoch: f.epoch,
        id: f.draft.id,
        expectedRevision: draft.record.revision,
        selectedPageIds: [f.page.id],
        selectedQuestionIds,
        acknowledgeReplaceReviewed: false,
      }),
    );
  };
  const generate = (p: GradingPreparationView) =>
    runner.generate({
      epoch: f.epoch,
      token: p.token,
      wireHash: p.wireHash,
      acknowledgeOutboundPreview: true,
    });
  return {
    ...f,
    root,
    script,
    worker,
    call,
    fetcher,
    client,
    credentials,
    images,
    ledger,
    runner,
    read,
    attempts,
    prepare,
    generate,
    success,
  };
}

test('single-page actual preview works before payment and after freeze while refusing foreign page IDs', async () => {
  const f = await fixture();
  const input = { epoch: f.epoch, id: f.draft.id, pageId: f.page.id };
  const first = value(await f.runner.previewPage(input));
  expect(first.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(await f.attempts()).toHaveLength(0);
  await expect(f.runner.previewPage({ ...input, pageId: randomUUID() })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  value(
    await f.worker.call('editGrading', {
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 1,
      edits: f.edits,
    }),
  );
  value(
    await f.worker.call('freezeGrading', {
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 2,
      requestId: randomUUID(),
      reason: '合成冻结预览',
      acknowledgeComplete: true,
    }),
  );
  expect(value(await f.runner.previewPage(input))).toEqual(first);
  expect((await f.read()).reviewId).toEqual(expect.any(String));
  expect(f.fetcher).not.toHaveBeenCalled();
});

test('historical preview uses the immutable transform instead of the current rebound page', async () => {
  const f = await fixture();
  const input = { epoch: f.epoch, id: f.draft.id, pageId: f.page.id };
  const first = value(await f.runner.previewPage(input));
  value(
    await f.worker.call('rebindGrading', {
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 1,
      request: { ...f.request, pages: [{ ...f.page, rotation: 90 }] },
    }),
  );
  const current = value(await f.runner.previewPage(input));
  expect(current.width).toBe(first.height);
  expect(current.height).toBe(first.width);
  expect(value(await f.runner.previewPage({ ...input, revision: 1 }))).toEqual(first);
  await expect(f.runner.previewPage({ ...input, revision: 999 })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(await f.attempts()).toHaveLength(0);
});

test('real worker preparation sends exactly the preview JPEG and selected rubric, then preserves peer teacher progress', async () => {
  const f = await fixture();
  value(
    await f.worker.call('editGrading', {
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 1,
      edits: [f.edits[1]],
    }),
  );
  const before = await f.read();
  const prepared = await f.prepare();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(await f.attempts()).toHaveLength(0);
  expect(prepared.images).toHaveLength(1);
  expect(prepared.images[0]).toMatchObject({ pageId: f.page.id, role: 'student_answer', order: 1 });
  expect(value(await f.generate(prepared))).toMatchObject({ revision: 3, status: 'draft' });
  const packet = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
  const parts = packet.messages[1].content;
  expect(parts.find((p: { type: string }) => p.type === 'image_url').image_url.url).toBe(
    prepared.images[0]!.dataUrl,
  );
  expect(JSON.parse(parts[0].text).questions.map((q: { id: string }) => q.id)).toEqual(['choice']);
  const wire = JSON.stringify(packet);
  for (const privateValue of [
    f.request.studentId,
    f.request.examId,
    f.request.scoreVersionId,
    f.request.rubricVersionId,
    f.page.sourceVersionId,
    'synthetic-answer.png',
    'SYNTHETIC_1',
    '合成甲',
    'sha256',
    'sk-synthetic-grading-key',
  ])
    expect(wire).not.toContain(privateValue);
  const after = await f.read();
  expect(after.payload.rows.find((row) => row.questionId === 'manual')).toEqual(
    before.payload.rows.find((row) => row.questionId === 'manual'),
  );
  expect(after.payload.rows.find((row) => row.questionId === 'choice')).toMatchObject({
    scoreHundredths: 500,
    reviewed: false,
  });
  expect(await f.attempts()).toMatchObject([
    { record: { status: 'succeeded', resultRevision: 3 } },
  ]);
  expect(f.ledger.getSummary()).toMatchObject({
    totalCalls: 1,
    successCalls: 1,
    totalTokens: 60,
    recentEntries: [{ type: 'grading' }],
  });
  expect(new DeepSeekLedger(f.root).getSummary()).toEqual(f.ledger.getSummary());
  expect(
    await f.worker.call('freezeGrading', {
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 3,
      requestId: randomUUID(),
      reason: '未复核不能冻结',
      acknowledgeComplete: true,
    }),
  ).toMatchObject({ ok: false, error: { code: 'GRADING_INVALID' } });
  await expect(f.generate(prepared)).rejects.toMatchObject({ code: 'GRADING_EXPIRED' });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test.each(['{bad JSON', '{"formatVersion":1,"assessments":[{"questionId":"unknown"}]}'])(
  'invalid output ends durable attempt and keeps the exact draft',
  async (output) => {
    const f = await fixture();
    const before = await f.read();
    f.fetcher.mockResolvedValue(f.success(output));
    expect(await f.generate(await f.prepare())).toMatchObject({ ok: false });
    expect(await f.read()).toEqual(before);
    expect(await f.attempts()).toMatchObject([
      { record: { status: 'failed', resultRevision: null } },
    ]);
    expect(f.runner.busy).toBe(false);
    expect(f.ledger.getSummary()).toMatchObject({
      totalCalls: 1,
      successCalls: 0,
      totalTokens: 60,
    });
    f.fetcher.mockImplementation(async () => f.success());
    expect(value(await f.generate(await f.prepare())).revision).toBe(2);
    expect(await f.attempts()).toHaveLength(2);
  },
);

test.each([429, 500, 401, 402])(
  'HTTP %s causes one paid call, a failed attempt, and no automatic retry',
  async (status) => {
    const f = await fixture();
    const before = await f.read();
    f.fetcher.mockResolvedValue(new Response('', { status }));
    await expect(f.generate(await f.prepare())).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(await f.read()).toEqual(before);
    expect(await f.attempts()).toMatchObject([{ record: { status: 'failed' } }]);
    expect(f.ledger.getSummary()).toMatchObject({ totalCalls: 1, successCalls: 0 });
  },
);

test('cancelled provider response cannot change the draft even when the provider ignores AbortSignal', async () => {
  const f = await fixture();
  const before = await f.read();
  let finish!: (response: Response) => void;
  f.fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.generate(await f.prepare());
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  expect(await f.runner.cancel({ epoch: randomUUID() })).toMatchObject({
    ok: false,
    error: { code: 'STALE_WORKSPACE' },
  });
  expect((f.fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(false);
  value(await f.runner.cancel({ epoch: f.epoch }));
  const checked = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  finish(f.success());
  await checked;
  expect(await f.read()).toEqual(before);
  expect(await f.attempts()).toMatchObject([{ record: { status: 'cancelled' } }]);
  expect(f.ledger.getSummary().successCalls).toBe(0);
});

test('credential invalidation ends the attempt and rejects a late response', async () => {
  const f = await fixture();
  let finish!: (response: Response) => void;
  f.fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.generate(await f.prepare());
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
  f.runner.invalidate();
  const checked = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  finish(f.success());
  await checked;
  expect(await f.attempts()).toMatchObject([{ record: { status: 'cancelled' } }]);
  expect((await f.read()).record.revision).toBe(1);
});

test('changed rubric during provider call invalidates output and leaves stored rows intact', async () => {
  const f = await fixture();
  let finish!: (response: Response) => void;
  f.fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const before = await f.read();
  const pending = f.generate(await f.prepare());
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
  value(
    await f.worker.call('createRubric', {
      ...f.rubricInput,
      requestId: randomUUID(),
      definition: { ...f.definition, title: '合成新细则' },
    }),
  );
  finish(f.success());
  expect(await pending).toMatchObject({ ok: false, error: { code: 'GRADING_STALE' } });
  expect((await f.read()).payload).toEqual(before.payload);
  expect((await f.read()).stale).toBe(true);
  expect(await f.attempts()).toMatchObject([{ record: { status: 'failed' } }]);
});

test('bad preview acknowledgment, wrong digest, expired or replaced tokens never claim or send', async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  await expect(
    f.runner.generate({
      epoch: f.epoch,
      token: prepared.token,
      wireHash: prepared.wireHash,
      acknowledgeOutboundPreview: false,
    }),
  ).rejects.toThrow();
  await expect(f.generate({ ...prepared, wireHash: '0'.repeat(64) })).rejects.toMatchObject({
    code: 'GRADING_EXPIRED',
  });
  const replaced = await f.prepare();
  await expect(f.generate(prepared)).rejects.toMatchObject({ code: 'GRADING_EXPIRED' });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(replaced.expiresAt) + 1);
  await expect(f.generate(replaced)).rejects.toMatchObject({ code: 'GRADING_EXPIRED' });
  expect(await f.attempts()).toHaveLength(0);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test('image preparation failure never claims a paid attempt and explicit preparation can recover', async () => {
  const f = await fixture();
  f.images.gradingImage.mockRejectedValueOnce(new DomainError('MATERIAL_INVALID', '合成解码失败'));
  await expect(f.prepare()).rejects.toMatchObject({ code: 'MATERIAL_INVALID' });
  expect(f.runner.busy).toBe(false);
  expect(await f.attempts()).toHaveLength(0);
  expect(f.fetcher).not.toHaveBeenCalled();
  const prepared = await f.prepare();
  f.credentials.loadKey.mockImplementation(() => {
    throw new DomainError('NO_KEY', '合成未配置');
  });
  await expect(f.generate(prepared)).rejects.toMatchObject({ code: 'NO_KEY' });
  expect(await f.attempts()).toMatchObject([{ record: { status: 'failed', errorCode: 'NO_KEY' } }]);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.ledger.getSummary().totalCalls).toBe(0);
});

test('real worker commit admission rejects a pre-cancelled completion, then interrupted claim survives reopen without resuming', async () => {
  const f = await fixture();
  const read = { epoch: f.epoch, id: f.draft.id };
  const prepared = value(
    await f.worker.call<{ token: string; preparation: GradingPreparation }>('prepareGrading', {
      ...read,
      expectedRevision: 1,
      selectedPageIds: [f.page.id],
      selectedQuestionIds: ['choice'],
      acknowledgeReplaceReviewed: false,
    }),
  );
  const command = {
    epoch: f.epoch,
    token: prepared.token,
    requestId: randomUUID(),
    output: f.output,
    provider: f.provider,
  };
  value(
    await f.worker.call('claimGrading', {
      epoch: f.epoch,
      token: prepared.token,
      requestId: command.requestId,
    }),
  );
  const cancellation = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(cancellation), 0, 1);
  expect(
    await f.worker.call<GradingReceipt>('completeGrading', { command, cancellation }),
  ).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  expect((await f.read()).record.revision).toBe(1);
  await f.worker.close();
  workers.splice(workers.indexOf(f.worker), 1);
  const reopened = new WorkerClient(f.script, f.root);
  workers.push(reopened);
  expect(value(await reopened.call<GradingAttemptView[]>('gradingAttempts', read))).toMatchObject([
    { record: { status: 'interrupted' } },
  ]);
  expect(
    await reopened.call('claimGrading', {
      epoch: f.epoch,
      token: prepared.token,
      requestId: randomUUID(),
    }),
  ).toMatchObject({ ok: false, error: { code: 'GRADING_EXPIRED' } });
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each(['start', 'complete'] as const)(
  'ledger %s failure still ends the durable attempt without retrying',
  async (stage) => {
    const f = await fixture();
    const before = await f.read();
    if (stage === 'start')
      vi.spyOn(f.ledger, 'startCall').mockImplementation(() => {
        throw new Error('synthetic disk failure');
      });
    else {
      f.fetcher.mockRejectedValue(new Error('synthetic network failure'));
      vi.spyOn(f.ledger, 'completeCall').mockImplementation(() => {
        throw new Error('synthetic disk failure');
      });
    }
    await expect(f.generate(await f.prepare())).rejects.toThrow('synthetic disk failure');
    expect(await f.read()).toEqual(before);
    expect(await f.attempts()).toMatchObject([{ record: { status: 'failed' } }]);
    expect(f.fetcher).toHaveBeenCalledTimes(stage === 'start' ? 0 : 1);
    expect(f.runner.busy).toBe(false);
  },
);

test('duplicate generation is busy while cancellation during image preparation never claims', async () => {
  const f = await fixture();
  let releaseImage!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  f.images.gradingImage.mockImplementationOnce(async (bytes, transform) => {
    await barrier;
    return prepareGradingImage(bytes, transform);
  });
  const preparation = f.prepare();
  await vi.waitFor(() => expect(f.images.gradingImage).toHaveBeenCalled());
  await expect(f.prepare()).rejects.toMatchObject({ code: 'BUSY' });
  value(await f.runner.cancel({ epoch: f.epoch }));
  const checked = expect(preparation).rejects.toMatchObject({ code: 'ABORTED' });
  releaseImage();
  await checked;
  expect(await f.attempts()).toHaveLength(0);
  const prepared = await f.prepare();
  let releaseFetch!: (response: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseFetch = resolve;
      }),
  );
  const generation = f.generate(prepared);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
  await expect(f.generate(prepared)).rejects.toMatchObject({ code: 'BUSY' });
  releaseFetch(f.success());
  expect(value(await generation).revision).toBe(2);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
