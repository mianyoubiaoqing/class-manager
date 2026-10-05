import type { BrowserWindow } from 'electron';
import type { PrintDocument } from '../core/print-document';
import type { DesktopApi } from '../shared/contracts';
import { DomainError } from '../core/errors';
import type { WorkerClient } from './worker-client';
import type { PrintReceipt } from '../shared/printing';
import { openPrintPreview } from './print-preview';

/** Prints the explicitly requested immutable version, never a current roster or private draft. */
export async function openDutyPrintPreview(
  parent: BrowserWindow,
  input: Parameters<DesktopApi['readDutyVersion']>[0],
  worker: WorkerClient,
  paths: { temp: string; documents: string; dataRoot: string },
): Promise<PrintReceipt> {
  const loadBatch = async (pageOffset: number) => {
    const result = await worker.call<PrintDocument>('readDutyPrintBatch', { ...input, pageOffset });
    if (!result.ok) throw new DomainError(result.error.code, result.error.message);
    return result.value;
  };
  return openPrintPreview(parent, await loadBatch(0), paths, 'duty', loadBatch);
}
