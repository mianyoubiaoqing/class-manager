import type { Snapshot } from '../shared/contracts';
import {
  callOutcomeSchema,
  deviceCancelInput,
  deviceStatusInput,
  deviceStatusSchema,
  noiseMeasureInput,
  noiseSampleSchema,
  studentCallInput,
  studentCallReadInput,
  storedCallSchema,
  type CallOutcome,
  type DeviceCancelReceipt,
  type DeviceStatuses,
  type NoiseResult,
  type StudentCallView,
} from '../shared/devices';
import { DomainError } from './errors';
import type { NoiseMonitorAdapter, StudentCallAdapter } from './device-adapters';

type CallRun = {
  fingerprint: string;
  epoch: string;
  dispatched: boolean;
  synthetic: boolean;
  promise: Promise<StudentCallView>;
  view?: StudentCallView;
};

/** 教师外设模块拥有来源校验、会话内去重、有限等待与取消；Adapter拥有未来通道的持久幂等及回执。
 * 当前不保存业务表、不通知学生、不重放外部请求；换工作区使旧epoch失效，重开后会话结果不承诺留存。 */
export class DeviceGateway {
  private readonly active = new Map<string, AbortController>();
  private readonly noiseRuns = new Map<
    string,
    { fingerprint: string; promise: Promise<NoiseResult> }
  >();
  private readonly calls = new Map<string, CallRun>();
  constructor(
    private readonly snapshot: () => Promise<Snapshot>,
    private readonly noise: NoiseMonitorAdapter,
    private readonly calling: StudentCallAdapter,
    private readonly options: { allowSynthetic?: boolean; timeoutMs?: number } = {},
  ) {}
  get busy() {
    return this.active.size > 0;
  }
  /** 中止所有在途外设请求；实际动作可能已经发生，调用方仍须查询原回执，不自动重发。 */
  invalidate(): void {
    for (const controller of this.active.values()) controller.abort();
  }
  private async guard(epoch: string) {
    const snapshot = await this.snapshot();
    if (snapshot.epoch !== epoch)
      throw new DomainError('STALE_WORKSPACE', '外设工作区已切换，请重新读取。');
    return snapshot;
  }
  private async bounded<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active.has(key)) throw new DomainError('BUSY', '该外设操作尚未结束。');
    const controller = new AbortController();
    this.active.set(key, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)),
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(
              controller.signal.reason instanceof DomainError
                ? controller.signal.reason
                : new DomainError('DEVICE_CANCELLED', '外设操作已取消，实际通道结果仍须核对。'),
            );
          controller.signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(
            () =>
              controller.abort(
                new DomainError('DEVICE_TIMEOUT', '外设操作超时，请先查询原操作结果，勿重发。'),
              ),
            this.options.timeoutMs ?? 10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      if (this.active.get(key) === controller) this.active.delete(key);
    }
  }
  private status(raw: unknown) {
    const status = deviceStatusSchema.parse(raw);
    if (status.state === 'ready' && status.mode === 'synthetic' && !this.options.allowSynthetic)
      throw new DomainError('DEVICE_SYNTHETIC_FORBIDDEN', '发布环境不接受测试外设状态或测量。');
    return status;
  }
  /** 校验epoch后有界读取两类状态；无采集/发送副作用，故障明确保留，发布拒绝合成状态。 */
  async readStatus(raw: unknown): Promise<DeviceStatuses> {
    const input = deviceStatusInput.parse(raw);
    await this.guard(input.epoch);
    const result = await this.bounded('status', async (signal) => ({
      noise: this.status(await this.noise.status(signal)),
      calling: this.status(await this.calling.status(signal)),
    }));
    await this.guard(input.epoch);
    return result;
  }
  private capacity(): void {
    if (this.noiseRuns.size + this.calls.size >= 256)
      throw new DomainError(
        'DEVICE_LIMIT',
        '本次会话外设操作已达上限，请查询已有结果；未接入实现可重开后继续。',
      );
  }
  /** 一次100至5000ms采样；校验量纲/校准/模式，不推断纪律。ID幂等，取消/超时拒绝，不自动重试。 */
  measure(raw: unknown): Promise<NoiseResult> {
    const input = noiseMeasureInput.parse(raw),
      fingerprint = JSON.stringify(input);
    const previous = this.noiseRuns.get(input.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DomainError('CONFLICT', '该测量操作ID已用于不同输入，请核对原操作。');
      return this.guard(input.epoch).then(() => previous.promise);
    }
    this.capacity();
    const promise = this.bounded(`noise:${input.operationId}`, async (signal) => {
      await this.guard(input.epoch);
      const status = this.status(await this.noise.status(signal));
      await this.guard(input.epoch);
      if (status.state !== 'ready')
        return {
          operationId: input.operationId,
          status: 'unavailable' as const,
          code: status.state === 'fault' ? status.code : 'DEVICE_NOT_CONNECTED',
          message: status.message,
        };
      if (signal.aborted) throw signal.reason;
      const sample = noiseSampleSchema.parse(await this.noise.measure(input, signal));
      if (sample.durationMs !== input.durationMs || sample.mode !== status.mode)
        throw new DomainError('DEVICE_RESPONSE', '测量时段或测试标识与请求不符，结果未展示。');
      await this.guard(input.epoch);
      return { operationId: input.operationId, status: 'measured' as const, sample };
    });
    this.noiseRuns.set(input.operationId, { fingerprint, promise });
    return promise;
  }
  /** 核对当前学生修订及两项确认后才dispatch；ID相同不重发，变更输入冲突。取消/超时后可能已发送时返回unknown。 */
  requestCall(raw: unknown): Promise<StudentCallView> {
    const input = studentCallInput.parse(raw),
      fingerprint = JSON.stringify(input);
    const previous = this.calls.get(input.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DomainError('CONFLICT', '该呼叫操作ID已用于不同学生或内容，不会重发。');
      return this.guard(input.epoch).then(() => previous.view ?? previous.promise);
    }
    this.capacity();
    const record: CallRun = {
      fingerprint,
      epoch: input.epoch,
      dispatched: false,
      synthetic: false,
      promise: this.bounded(`call:${input.operationId}`, async (signal) => {
        const snapshot = await this.guard(input.epoch),
          student = snapshot.students.find((s) => s.id === input.studentId);
        if (
          !student ||
          !student.active ||
          !student.classId ||
          student.revision !== input.expectedStudentRevision
        )
          throw new DomainError('CONFLICT', '呼叫学生已变化或不可用，请重新读取名册并核对目标。');
        const status = this.status(await this.calling.status(signal));
        let outcome: CallOutcome;
        if (status.state === 'not_connected')
          outcome = { stage: 'unavailable', message: status.message };
        else if (status.state === 'fault')
          outcome = { stage: 'failed', code: status.code, message: status.message };
        else {
          if (signal.aborted) throw signal.reason;
          record.dispatched = true;
          record.synthetic = status.mode === 'synthetic';
          try {
            outcome = callOutcomeSchema.parse(await this.calling.request(input, signal));
          } catch (error) {
            outcome = {
              stage: 'unknown',
              code: error instanceof DomainError ? error.code : 'DEVICE_RESPONSE',
              message: '呼叫结果不明，先查询原操作；取消或超时不证明未发送。',
            };
          }
        }
        await this.guard(input.epoch);
        if (signal.aborted) throw signal.reason;
        const view = {
          operationId: input.operationId,
          studentId: input.studentId,
          studentRevision: input.expectedStudentRevision,
          synthetic: status.state === 'ready' && status.mode === 'synthetic',
          outcome,
        };
        record.view = view;
        return view;
      }).catch((error: unknown) => {
        if (!record.dispatched) throw error;
        record.view ??= {
          operationId: input.operationId,
          studentId: input.studentId,
          studentRevision: input.expectedStudentRevision,
          synthetic: record.synthetic,
          outcome: {
            stage: 'unknown',
            code: error instanceof DomainError ? error.code : 'DEVICE_RESPONSE',
            message: '呼叫结果不明，先查询原操作；取消或超时不证明未发送。',
          },
        };
        if (error instanceof DomainError && error.code === 'STALE_WORKSPACE') throw error;
        return record.view;
      }),
    };
    this.calls.set(input.operationId, record);
    return record.promise;
  }
  /** 有界查询原ID，不发送。会话外回执须包含原确认请求及模式；身份不符拒绝，null不证明未发送。 */
  async readCall(raw: unknown): Promise<StudentCallView | null> {
    const input = studentCallReadInput.parse(raw);
    await this.guard(input.epoch);
    let record = this.calls.get(input.operationId);
    if (!record) {
      this.capacity();
      const saved = await this.bounded(`query:${input.operationId}`, (signal) =>
        this.calling.read(input.operationId, signal),
      );
      await this.guard(input.epoch);
      if (!saved) return null;
      const parsed = storedCallSchema.parse(saved);
      if (parsed.request.operationId !== input.operationId || parsed.request.epoch !== input.epoch)
        throw new DomainError('DEVICE_RESPONSE', '通道查询回执与操作ID或工作区不符。');
      if (parsed.mode === 'synthetic' && !this.options.allowSynthetic)
        throw new DomainError('DEVICE_SYNTHETIC_FORBIDDEN', '发布环境不接受测试呼叫回执。');
      const snapshot = await this.guard(input.epoch);
      const student = snapshot.students.find((s) => s.id === parsed.request.studentId);
      if (!student || student.revision < parsed.request.expectedStudentRevision)
        throw new DomainError('DEVICE_RESPONSE', '通道回执学生或修订不属于当前名册，结果未展示。');
      const view = {
        operationId: input.operationId,
        studentId: parsed.request.studentId,
        studentRevision: parsed.request.expectedStudentRevision,
        synthetic: parsed.mode === 'synthetic',
        outcome: parsed.outcome,
      };
      record = {
        fingerprint: JSON.stringify(parsed.request),
        epoch: input.epoch,
        dispatched: true,
        synthetic: view.synthetic,
        promise: Promise.resolve(view),
        view,
      };
      this.calls.set(input.operationId, record);
      return view;
    }
    if (record.epoch !== input.epoch)
      throw new DomainError('STALE_WORKSPACE', '原呼叫属于其他工作区，请核对原操作。');
    const view = record.view ?? (await record.promise);
    if (view.outcome.stage !== 'accepted' && view.outcome.stage !== 'unknown') return view;
    const result = await this.bounded(`query:${input.operationId}`, async (signal) =>
      this.calling.read(input.operationId, signal),
    );
    await this.guard(input.epoch);
    if (record.view !== view) return record.view ?? view;
    if (result) {
      const saved = storedCallSchema.parse(result),
        outcome = saved.outcome;
      if (
        JSON.stringify(saved.request) !== record.fingerprint ||
        (saved.mode === 'synthetic') !== view.synthetic
      )
        throw new DomainError('DEVICE_RESPONSE', '通道回执与原学生或审核请求不符，原状态保留。');
      if (outcome.stage === 'unavailable')
        throw new DomainError('DEVICE_RESPONSE', '原呼叫可能已受理，不能将失联解释为未发送。');
      record.view = { ...view, outcome };
    }
    return record.view ?? view;
  }
  /** 同epoch按ID请求取消；requested只证明已提出请求，不证明撤销送达。通道终态须明确回执，不自动重试。 */
  async cancel(raw: unknown): Promise<DeviceCancelReceipt> {
    const input = deviceCancelInput.parse(raw);
    await this.guard(input.epoch);
    const controller = this.active.get(`${input.kind}:${input.operationId}`);
    if (controller) {
      controller.abort();
      return {
        operationId: input.operationId,
        requested: true,
        message: '已请求取消，晚到结果或实际送达仍须查询原操作。',
      };
    }
    if (input.kind === 'call' && !this.calls.has(input.operationId))
      await this.readCall({ epoch: input.epoch, operationId: input.operationId });
    const record = input.kind === 'call' ? this.calls.get(input.operationId) : undefined;
    const view = record?.view;
    if (
      record &&
      record.epoch === input.epoch &&
      view &&
      ['accepted', 'unknown'].includes(view.outcome.stage)
    ) {
      const outcome = callOutcomeSchema.parse(
        await this.bounded(`cancel:${input.operationId}`, (signal) =>
          this.calling.cancel(input.operationId, signal),
        ),
      );
      await this.guard(input.epoch);
      if (outcome.stage === 'unavailable')
        throw new DomainError('DEVICE_RESPONSE', '取消结果不明，请核对原呼叫是否受理或送达。');
      if (record.view === view) record.view = { ...view, outcome };
      return {
        operationId: input.operationId,
        requested: true,
        message: '已查询取消回执，请查看原呼叫状态；不能把受理当作送达。',
      };
    }
    return {
      operationId: input.operationId,
      requested: false,
      message: '没有正在执行的本次请求；原结果保持不变。',
    };
  }
}
