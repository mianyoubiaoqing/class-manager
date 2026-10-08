import { fork } from 'node:child_process';
import { z } from 'zod';
import { DomainError } from '../core/errors';
import { teachingReportDocument, type TeachingReportDocument } from '../shared/teaching-report';
import {
  OFFICE_LIMITS,
  officeExportInput,
  officeSnapshotSchema,
  type OfficeExportInput,
  type OfficeSnapshot,
} from '../shared/office-export';

const replySchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      value: z
        .object({
          bytes: z
            .instanceof(Buffer)
            .refine(
              (bytes) =>
                bytes.length >= 4 &&
                bytes.length <= OFFICE_LIMITS.outputBytes &&
                bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])),
            ),
          pages: z.number().int().min(1).max(OFFICE_LIMITS.pages).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum([
            'EXPORT_FAILED',
            'EXPORT_INVALID',
            'EXPORT_INVALID_TEXT',
            'EXPORT_LIMIT',
            'EXPORT_LAYOUT',
          ]),
          message: z.string().min(1).max(500),
        })
        .strict(),
    })
    .strict(),
]);
const failed = () =>
  new DomainError('EXPORT_FAILED', 'Office 导出进程异常，未保存文件；可重新导出。');

/** One trusted bundled process per task, no inherited keys/NODE_OPTIONS, no automatic retry.
 * Wait for child close before releasing the slot. Heap cap is not a native RSS permission sandbox. */
export class OfficeTaskRunner {
  private active?: { cancel: () => void; done: Promise<void> };
  private closed = false;
  constructor(
    private readonly script: string,
    private readonly timeoutMs = 60_000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new Error('Invalid export deadline');
  }
  async generate(
    rawSnapshot: OfficeSnapshot,
    rawOptions: OfficeExportInput,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; pages: number | null }> {
    const snapshot = officeSnapshotSchema.parse(rawSnapshot);
    const options = officeExportInput.parse(rawOptions);
    return this.run({ snapshot, options }, options.format, signal);
  }
  async generateTeachingReport(
    raw: TeachingReportDocument,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; pages: number | null }> {
    const report = teachingReportDocument.parse(raw);
    return this.run({ report }, report.format, signal);
  }
  private async run(
    input:
      { snapshot: OfficeSnapshot; options: OfficeExportInput } | { report: TeachingReportDocument },
    format: 'docx' | 'pptx' | 'xlsx',
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; pages: number | null }> {
    if (this.closed) throw new DomainError('EXPORT_CLOSED', '导出服务已关闭。');
    if (this.active) throw new DomainError('BUSY', 'Office 导出尚未结束。');
    if (signal?.aborted) throw new DomainError('EXPORT_CANCELLED', 'Office 导出已取消。');
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'])
      if (process.env[name]) env[name] = process.env[name];
    const child = fork(this.script, [], {
      execArgv: ['--max-old-space-size=384'],
      env,
      windowsHide: true,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return new Promise((resolve, reject) => {
      let value: { bytes: Buffer; pages: number | null } | undefined;
      let error: Error | undefined;
      let received = false;
      const stop = (reason: Error) => {
        error ??= reason;
        child.kill();
      };
      const cancel = () =>
        stop(new DomainError('EXPORT_CANCELLED', 'Office 导出已取消，未保存文件。'));
      this.active = { cancel, done };
      const timer = setTimeout(
        () => stop(new DomainError('EXPORT_TIMEOUT', 'Office 导出超时，请精简内容后重试。')),
        this.timeoutMs,
      );
      signal?.addEventListener('abort', cancel, { once: true });
      child.on('message', (raw: unknown) => {
        if (error) return;
        if (received) return stop(failed());
        received = true;
        const result = replySchema.safeParse(raw);
        if (!result.success) return stop(failed());
        if (!result.data.ok) {
          error = new DomainError(result.data.error.code, result.data.error.message);
          return;
        }
        if ((format !== 'pptx') !== (result.data.value.pages === null)) return stop(failed());
        value = result.data.value;
      });
      child.once('error', () => stop(failed()));
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.active = undefined;
        finish();
        if (error) reject(error);
        else if (code !== 0 || !value) reject(failed());
        else resolve(value);
      });
      child.send(input, (error) => {
        if (error) stop(failed());
      });
      if (signal?.aborted) cancel();
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    active?.cancel();
    await active?.done;
  }
}
