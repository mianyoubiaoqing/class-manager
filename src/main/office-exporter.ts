import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { epochInput } from '../shared/contracts';
import {
  OFFICE_TEMPLATE_VERSION,
  officeExportInput,
  officeOpenInput,
  type OfficeExportReceipt,
  type OfficeSnapshot,
} from '../shared/office-export';
import { DomainError } from '../core/errors';
import type { WorkerClient } from './worker-client';
import type { OfficeTaskRunner } from './office-task';
import { officeTargetStamp, saveOfficeFile } from './office-files';

interface OfficeDialogs {
  choose: (name: string, format: 'docx' | 'pptx') => Promise<string | null>;
  validateDestination: (path: string) => Promise<void>;
  confirmOverwrite: (name: string) => Promise<boolean>;
}

/** Renderer chooses a version and explicit privacy options, never bytes or a path. Open tokens
 * refer only to this session's completed files and are invalidated by restore/cancelled session. */
export class OfficeExporter {
  private active?: { epoch: string; controller: AbortController };
  private readonly receipts = new Map<
    string,
    { epoch: string; path: string; stamp: string; receipt: OfficeExportReceipt }
  >();
  constructor(
    private readonly worker: Pick<WorkerClient, 'call'>,
    private readonly generator: Pick<OfficeTaskRunner, 'generate'>,
    private readonly files = { stamp: officeTargetStamp, save: saveOfficeFile },
  ) {}
  invalidate() {
    this.active?.controller.abort();
    this.receipts.clear();
  }
  cancel(raw: unknown) {
    const { epoch } = epochInput.parse(raw);
    if (this.active?.epoch === epoch) this.active.controller.abort();
  }
  async export(raw: unknown, dialogs: OfficeDialogs): Promise<OfficeExportReceipt | null> {
    const input = officeExportInput.parse(raw);
    if (this.active) throw new DomainError('BUSY', 'Office 导出尚未结束。');
    const task = { epoch: input.epoch, controller: new AbortController() };
    this.active = task;
    const current = () => {
      if (task.controller.signal.aborted)
        throw new DomainError('EXPORT_CANCELLED', 'Office 导出已取消。');
    };
    try {
      const result = await this.worker.call<OfficeSnapshot>('readOfficeSnapshot', input);
      if (!result.ok) throw new DomainError(result.error.code, result.error.message);
      current();
      // Complete generation before asking for a destination; failed export never opens a save flow.
      const generated = await this.generator.generate(result.value, input, task.controller.signal);
      current();
      const safeTitle =
        result.value.content.title
          // eslint-disable-next-line no-control-regex -- Main-generated Windows filename excludes control characters.
          .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
          .slice(0, 80)
          .replace(/[. ]+$/u, '') || '教案';
      const path = await dialogs.choose(
        `${safeTitle}-v${result.value.revision}.${input.format}`,
        input.format,
      );
      current();
      if (!path) return null;
      await dialogs.validateDestination(path);
      current();
      const stamp = await this.files.stamp(path, task.controller.signal);
      if (stamp !== null && !(await dialogs.confirmOverwrite(basename(path)))) {
        current();
        return null;
      }
      current();
      await this.files.save(path, generated.bytes, input.format, stamp, task.controller.signal);
      // Once publication succeeds return a receipt even if cancellation arrives immediately after.
      const receipt: OfficeExportReceipt = {
        token: randomUUID(),
        name: basename(path),
        versionId: result.value.versionId,
        revision: result.value.revision,
        contentHash: result.value.contentHash,
        templateVersion: OFFICE_TEMPLATE_VERSION,
        format: input.format,
        sha256: createHash('sha256').update(generated.bytes).digest('hex'),
        pages: generated.pages,
        openAvailable: false,
      };
      try {
        const savedStamp = await this.files.stamp(path);
        if (savedStamp !== null && savedStamp.endsWith(`:${receipt.sha256}`)) {
          if (this.receipts.size >= 20) this.receipts.delete(this.receipts.keys().next().value!);
          this.receipts.set(receipt.token, {
            epoch: input.epoch,
            path,
            stamp: savedStamp,
            receipt,
          });
          receipt.openAvailable = true;
        }
      } catch {
        /* Publication succeeded; verification failure must not report a failed save. */
      }
      if (!receipt.openAvailable) {
        receipt.warning =
          '文件已保存，但保存后核验未通过或文件已变化；请从保存目录检查，不能通过此回执打开。';
      }
      return receipt;
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }
  async open(raw: unknown, openPath: (path: string) => Promise<string>): Promise<void> {
    const input = officeOpenInput.parse(raw);
    const saved = this.receipts.get(input.token);
    if (!saved || saved.epoch !== input.epoch)
      throw new DomainError('EXPORT_EXPIRED', '文件打开凭据已失效，请从保存目录打开文件。');
    const snapshot = await this.worker.call<{ epoch: string }>('snapshot');
    if (!snapshot.ok) throw new DomainError(snapshot.error.code, snapshot.error.message);
    if (
      snapshot.value.epoch !== input.epoch ||
      (await this.files.stamp(saved.path)) !== saved.stamp
    )
      throw new DomainError('EXPORT_CHANGED', '文件或工作区已变化，请从保存目录检查文件。');
    const error = await openPath(saved.path);
    if (error)
      throw new DomainError(
        'EXPORT_OPEN_FAILED',
        '无法打开文件，请检查本机办公软件关联，或从保存目录打开。',
      );
  }
}
