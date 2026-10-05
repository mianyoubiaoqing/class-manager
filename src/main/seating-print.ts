import type { BrowserWindow } from 'electron';
import { createSeatingPrintDocument } from '../core/seating-print';
import type { SeatingPrintReceipt, SeatingVersionView } from '../shared/seating-records';
import { openPrintPreview } from './print-preview';

export {
  DOCUMENT_PRINT_OPTIONS as SEATING_PRINT_OPTIONS,
  DOCUMENT_PDF_OPTIONS as SEATING_PDF_OPTIONS,
  printOutcome,
} from './print-preview';

/** Only a validated saved seating snapshot may reach the shared native preview. */
export function openSeatingPrintPreview(
  parent: BrowserWindow,
  view: SeatingVersionView,
  paths: { temp: string; documents: string; dataRoot: string },
): Promise<SeatingPrintReceipt> {
  return openPrintPreview(parent, createSeatingPrintDocument(view), paths, 'seating');
}
