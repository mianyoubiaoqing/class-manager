import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { DeviceGateway } from '../src/core/device-gateway';
import { DisconnectedNoiseMonitor, DisconnectedStudentCall } from '../src/core/device-adapters';
import type { NoiseMonitorAdapter, StudentCallAdapter } from '../src/core/device-adapters';
import type { DeviceStatus, CallOutcome, StoredCall } from '../src/shared/devices';

const roots: string[] = [],
  workspaces: Workspace[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of workspaces.splice(0)) w.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ready: DeviceStatus = { state: 'ready', label: '合成测试通道', mode: 'synthetic' };
const receipt = (stage: 'accepted' | 'delivered' | 'cancelled'): CallOutcome => ({
  stage,
  receiptId: 'synthetic-receipt',
  observedAt: '2026-10-02T00:00:00Z',
});
function fixture(
  options: { allowSynthetic?: boolean; timeoutMs?: number } = { allowSynthetic: true },
) {
  const root = mkdtempSync(join(tmpdir(), 'cm-devices-'));
  roots.push(root);
  const workspace = new Workspace(root);
  workspaces.push(workspace);
  const snapshot = workspace.seedDemo({ epoch: workspace.snapshot().epoch });
  const student = snapshot.students.find((s) => s.active && s.classId)!;
  const request = {
    epoch: snapshot.epoch,
    operationId: randomUUID(),
    studentId: student.id,
    expectedStudentRevision: student.revision,
    reason: '合成课堂呼叫',
    acknowledgeTeacherReviewed: true as const,
    acknowledgeSyntheticOnly: true as const,
  };
  const noiseRequest = {
    epoch: snapshot.epoch,
    operationId: randomUUID(),
    purpose: 'reading' as const,
    durationMs: 1000,
  };
  const noise: NoiseMonitorAdapter = {
    status: vi.fn(async () => ready),
    measure: vi.fn(async () => ({
      unit: 'relative_amplitude' as const,
      value: 0.3,
      durationMs: 1000,
      mode: 'synthetic' as const,
      observedAt: '2026-10-02T00:00:00Z',
    })),
  };
  const calling: StudentCallAdapter = {
    status: vi.fn(async () => ready),
    request: vi.fn(async () => receipt('accepted')),
    read: vi.fn(async () => null),
    cancel: vi.fn(async () => receipt('cancelled')),
  };
  const gateway = new DeviceGateway(async () => workspace.snapshot(), noise, calling, options);
  const saved = (outcome: CallOutcome = receipt('delivered')): StoredCall => ({
    request: { ...request },
    outcome,
    mode: 'synthetic',
  });
  return { workspace, snapshot, request, noiseRequest, noise, calling, gateway, saved };
}

test('default adapters never manufacture samples, acceptance or delivery', async () => {
  const f = fixture(),
    noise = new DisconnectedNoiseMonitor(),
    calling = new DisconnectedStudentCall();
  const gateway = new DeviceGateway(async () => f.workspace.snapshot(), noise, calling);
  expect(await gateway.readStatus({ epoch: f.request.epoch })).toMatchObject({
    noise: { state: 'not_connected' },
    calling: { state: 'not_connected' },
  });
  const result = await gateway.measure(f.noiseRequest);
  expect(result).toMatchObject({ status: 'unavailable', code: 'DEVICE_NOT_CONNECTED' });
  expect(result).not.toHaveProperty('sample');
  const call = await gateway.requestCall(f.request);
  expect(call.outcome.stage).toBe('unavailable');
  expect(
    await gateway.readCall({ epoch: f.request.epoch, operationId: f.request.operationId }),
  ).toEqual(call);
  expect(
    await gateway.cancel({
      epoch: f.request.epoch,
      operationId: f.request.operationId,
      kind: 'call',
    }),
  ).toMatchObject({ requested: false });
  expect(await gateway.readCall({ epoch: f.request.epoch, operationId: randomUUID() })).toBeNull();
  await expect(noise.measure(f.noiseRequest, new AbortController().signal)).rejects.toMatchObject({
    code: 'DEVICE_NOT_CONNECTED',
  });
});

test('both disconnected adapters obey cancelled signals for every operation', async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  const noise = new DisconnectedNoiseMonitor(),
    calling = new DisconnectedStudentCall();
  for (const pending of [
    noise.status(controller.signal),
    noise.measure(f.noiseRequest, controller.signal),
    calling.status(controller.signal),
    calling.request(f.request, controller.signal),
    calling.read(f.request.operationId, controller.signal),
    calling.cancel(f.request.operationId, controller.signal),
  ])
    await expect(pending).rejects.toMatchObject({ code: 'DEVICE_CANCELLED' });
});

test.each(['noise', 'call'] as const)(
  'fault %s preserves diagnostics without dispatch',
  async (kind) => {
    const f = fixture(),
      fault: DeviceStatus = { state: 'fault', code: 'SYNTHETIC_OFFLINE', message: '合成通道故障' };
    f.noise.status = async () => fault;
    f.calling.status = async () => fault;
    expect(await f.gateway.readStatus({ epoch: f.request.epoch })).toEqual({
      noise: fault,
      calling: fault,
    });
    if (kind === 'noise')
      expect(await f.gateway.measure(f.noiseRequest)).toMatchObject({
        status: 'unavailable',
        code: fault.code,
      });
    else
      expect(await f.gateway.requestCall(f.request)).toMatchObject({
        outcome: { stage: 'failed', code: fault.code },
      });
    expect(f.noise.measure).not.toHaveBeenCalled();
    expect(f.calling.request).not.toHaveBeenCalled();
  },
);

test.each([
  'confirmation',
  'synthetic',
  'target',
  'revision',
  'epoch',
  'inactive',
  'reason',
  'extra',
] as const)('rejects invalid call %s before dispatch', async (kind) => {
  const f = fixture();
  const raw: Record<string, unknown> = { ...f.request };
  if (kind === 'confirmation') raw.acknowledgeTeacherReviewed = false;
  if (kind === 'synthetic') raw.acknowledgeSyntheticOnly = false;
  if (kind === 'target') raw.studentId = randomUUID();
  if (kind === 'revision') raw.expectedStudentRevision = 100;
  if (kind === 'epoch') raw.epoch = randomUUID();
  if (kind === 'reason') raw.reason = ' ';
  if (kind === 'extra') raw.secret = 'unexpected';
  if (kind === 'inactive')
    f.workspace.setStudentActive({
      epoch: f.request.epoch,
      id: f.request.studentId,
      expectedRevision: f.request.expectedStudentRevision,
      active: false,
    });
  await expect(Promise.resolve().then(() => f.gateway.requestCall(raw))).rejects.toBeDefined();
  expect(f.calling.request).not.toHaveBeenCalled();
});

test('same operation shares its pending result and altered input never resends', async () => {
  const f = fixture();
  let finish!: (outcome: CallOutcome) => void;
  f.calling.request = vi.fn(
    () =>
      new Promise<CallOutcome>((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.gateway.requestCall(f.request),
    second = f.gateway.requestCall(f.request);
  await vi.waitFor(() => expect(f.calling.request).toHaveBeenCalledTimes(1));
  expect(() => f.gateway.requestCall({ ...f.request, reason: 'changed' })).toThrow();
  finish(receipt('accepted'));
  expect(await second).toEqual(await first);
  expect((await first).outcome.stage).toBe('accepted');
  f.calling.read = vi.fn(async () => f.saved());
  expect(
    await f.gateway.readCall({ epoch: f.request.epoch, operationId: f.request.operationId }),
  ).toMatchObject({ outcome: { stage: 'delivered' } });
  expect(f.calling.request).toHaveBeenCalledTimes(1);
});

test('noise shares its operation and cannot reuse ID for changed measurement', async () => {
  const f = fixture();
  expect(await f.gateway.measure(f.noiseRequest)).toMatchObject({
    status: 'measured',
    sample: { unit: 'relative_amplitude' },
  });
  await f.gateway.measure(f.noiseRequest);
  expect(f.noise.measure).toHaveBeenCalledTimes(1);
  expect(() => f.gateway.measure({ ...f.noiseRequest, purpose: 'ambient' })).toThrow();
});

test.each(['duration', 'mode', 'calibration', 'range'] as const)(
  'rejects invalid noise sample %s',
  async (kind) => {
    const f = fixture();
    f.noise.measure = async () => {
      const sample: Record<string, unknown> = {
        unit: 'relative_amplitude',
        value: 0.3,
        durationMs: 1000,
        mode: 'synthetic',
        observedAt: '2026-10-02T00:00:00Z',
      };
      if (kind === 'duration') sample.durationMs = 2000;
      if (kind === 'mode') sample.mode = 'live';
      if (kind === 'range') sample.value = 2;
      if (kind === 'calibration') {
        sample.unit = 'db_spl';
        sample.value = 60;
      }
      // 故意越过静态类型，验证第三方 Adapter 的运行时返回边界。
      return sample as unknown as Awaited<ReturnType<NoiseMonitorAdapter['measure']>>;
    };
    await expect(f.gateway.measure(f.noiseRequest)).rejects.toBeDefined();
  },
);

test('calibrated SPL keeps its unit and calibration; it does not infer a noise alarm', async () => {
  const f = fixture();
  f.noise.measure = async () => ({
    unit: 'db_spl',
    value: 60,
    calibration: '合成校准说明',
    durationMs: 1000,
    mode: 'synthetic',
    observedAt: '2026-10-02T00:00:00Z',
  });
  const result = await f.gateway.measure(f.noiseRequest);
  expect(result).toMatchObject({ sample: { unit: 'db_spl', calibration: '合成校准说明' } });
  expect(result).not.toHaveProperty('alarm');
});

test.each(['status', 'noise', 'call', 'stored'] as const)(
  'release rejects synthetic %s',
  async (kind) => {
    const f = fixture({});
    f.calling.read = async () => f.saved();
    const run = (): Promise<unknown> =>
      kind === 'status'
        ? f.gateway.readStatus({ epoch: f.request.epoch })
        : kind === 'noise'
          ? f.gateway.measure(f.noiseRequest)
          : kind === 'call'
            ? f.gateway.requestCall(f.request)
            : f.gateway.readCall({ epoch: f.request.epoch, operationId: f.request.operationId });
    await expect(Promise.resolve().then(run)).rejects.toMatchObject({
      code: 'DEVICE_SYNTHETIC_FORBIDDEN',
    });
    expect(f.calling.request).not.toHaveBeenCalled();
    expect(f.noise.measure).not.toHaveBeenCalled();
  },
);

test('invalid delivered receipt is unknown and never retried', async () => {
  const f = fixture();
  f.calling.request = vi.fn(async () => ({ stage: 'delivered' }) as CallOutcome);
  expect(await f.gateway.requestCall(f.request)).toMatchObject({
    outcome: { stage: 'unknown', code: 'DEVICE_RESPONSE' },
  });
  await f.gateway.requestCall(f.request);
  expect(f.calling.request).toHaveBeenCalledTimes(1);
});

test.each(['cancel', 'timeout'] as const)(
  '%s remains bounded when adapter ignores signal; late reply cannot overwrite unknown',
  async (action) => {
    vi.useFakeTimers();
    const f = fixture({ allowSynthetic: true, timeoutMs: 20 });
    let finish!: (outcome: CallOutcome) => void;
    f.calling.request = vi.fn(
      () =>
        new Promise<CallOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.gateway.requestCall(f.request);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calling.request).toHaveBeenCalledTimes(1);
    expect(f.gateway.busy).toBe(true);
    if (action === 'cancel')
      await f.gateway.cancel({
        epoch: f.request.epoch,
        operationId: f.request.operationId,
        kind: 'call',
      });
    else await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({
      outcome: {
        stage: 'unknown',
        code: action === 'cancel' ? 'DEVICE_CANCELLED' : 'DEVICE_TIMEOUT',
      },
    });
    expect(f.gateway.busy).toBe(false);
    finish(receipt('delivered'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.gateway.requestCall(f.request)).toMatchObject({ outcome: { stage: 'unknown' } });
    f.calling.read = vi.fn(async () => f.saved());
    expect(
      await f.gateway.readCall({ epoch: f.request.epoch, operationId: f.request.operationId }),
    ).toMatchObject({ outcome: { stage: 'delivered' } });
    expect(f.calling.request).toHaveBeenCalledTimes(1);
  },
);

test('cancellation while status is pending prevents dispatch', async () => {
  const f = fixture();
  let finish!: (status: DeviceStatus) => void;
  f.calling.status = vi.fn(
    () =>
      new Promise<DeviceStatus>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.gateway.requestCall(f.request);
  const rejection = expect(pending).rejects.toMatchObject({ code: 'DEVICE_CANCELLED' });
  await vi.waitFor(() => expect(f.calling.status).toHaveBeenCalled());
  await f.gateway.cancel({
    epoch: f.request.epoch,
    operationId: f.request.operationId,
    kind: 'call',
  });
  await rejection;
  finish(ready);
  await Promise.resolve();
  expect(f.calling.request).not.toHaveBeenCalled();
});

test.each(['query-first', 'cancel-first'] as const)(
  'query/cancel %s race does not roll back a final receipt',
  async (order) => {
    const f = fixture();
    await f.gateway.requestCall(f.request);
    let finishRead!: (stored: StoredCall) => void, finishCancel!: (outcome: CallOutcome) => void;
    f.calling.read = vi.fn(
      () =>
        new Promise<StoredCall>((resolve) => {
          finishRead = resolve;
        }),
    );
    f.calling.cancel = vi.fn(
      () =>
        new Promise<CallOutcome>((resolve) => {
          finishCancel = resolve;
        }),
    );
    const query = f.gateway.readCall({
      epoch: f.request.epoch,
      operationId: f.request.operationId,
    });
    const cancel = f.gateway.cancel({
      epoch: f.request.epoch,
      operationId: f.request.operationId,
      kind: 'call',
    });
    await vi.waitFor(() => expect(f.calling.cancel).toHaveBeenCalled());
    await vi.waitFor(() => expect(f.calling.read).toHaveBeenCalled());
    if (order === 'query-first') {
      finishRead(f.saved());
      await query;
      finishCancel(receipt('accepted'));
    } else {
      finishCancel(receipt('cancelled'));
      await cancel;
      finishRead(f.saved(receipt('accepted')));
    }
    await Promise.all([query, cancel]);
    expect(
      await f.gateway.readCall({ epoch: f.request.epoch, operationId: f.request.operationId }),
    ).toMatchObject({ outcome: { stage: order === 'query-first' ? 'delivered' : 'cancelled' } });
  },
);

test('a new gateway restores an adapter receipt with original target and prevents resending', async () => {
  const f = fixture();
  f.calling.read = vi.fn(async () => f.saved());
  const gateway = new DeviceGateway(async () => f.workspace.snapshot(), f.noise, f.calling, {
    allowSynthetic: true,
  });
  expect(
    await gateway.readCall({ epoch: f.request.epoch, operationId: f.request.operationId }),
  ).toMatchObject({
    studentId: f.request.studentId,
    studentRevision: f.request.expectedStudentRevision,
    outcome: { stage: 'delivered' },
  });
  await gateway.requestCall(f.request);
  expect(f.calling.request).not.toHaveBeenCalled();
});

test.each(['id', 'epoch', 'student', 'revision'] as const)(
  'restored receipt rejects mismatched %s',
  async (kind) => {
    const f = fixture();
    const stored = f.saved();
    if (kind === 'id') stored.request.operationId = randomUUID();
    if (kind === 'epoch') stored.request.epoch = randomUUID();
    if (kind === 'student') stored.request.studentId = randomUUID();
    if (kind === 'revision') stored.request.expectedStudentRevision = 1000;
    f.calling.read = async () => stored;
    await expect(
      f.gateway.readCall({ epoch: f.snapshot.epoch, operationId: f.request.operationId }),
    ).rejects.toMatchObject({ code: 'DEVICE_RESPONSE' });
  },
);

test.each(['input', 'mode', 'unavailable'] as const)(
  'query rejects %s changes and preserves accepted state',
  async (kind) => {
    const f = fixture();
    await f.gateway.requestCall(f.request);
    f.calling.read = async () => ({
      ...f.saved(
        kind === 'unavailable' ? { stage: 'unavailable', message: 'lost' } : receipt('delivered'),
      ),
      request: { ...f.request, reason: kind === 'input' ? 'changed' : f.request.reason },
      mode: kind === 'mode' ? 'live' : 'synthetic',
    });
    await expect(
      f.gateway.readCall({ epoch: f.request.epoch, operationId: f.request.operationId }),
    ).rejects.toMatchObject({ code: 'DEVICE_RESPONSE' });
    expect(await f.gateway.requestCall(f.request)).toMatchObject({
      outcome: { stage: 'accepted' },
    });
  },
);

test('all operations reject old workspace epoch', async () => {
  const f = fixture(),
    epoch = randomUUID(),
    operationId = randomUUID();
  for (const work of [
    () => f.gateway.readStatus({ epoch }),
    () => f.gateway.measure({ ...f.noiseRequest, epoch }),
    () => f.gateway.requestCall({ ...f.request, epoch }),
    () => f.gateway.readCall({ epoch, operationId }),
    () => f.gateway.cancel({ epoch, operationId, kind: 'call' }),
  ])
    await expect(
      Promise.resolve().then(async (): Promise<unknown> => work()),
    ).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
});

test('session has bounded capacity without evicting idempotency records', async () => {
  const f = fixture();
  for (let i = 0; i < 256; i++)
    await f.gateway.measure({ ...f.noiseRequest, operationId: randomUUID() });
  expect(() => f.gateway.requestCall(f.request)).toThrow();
  expect(f.calling.request).not.toHaveBeenCalled();
});
