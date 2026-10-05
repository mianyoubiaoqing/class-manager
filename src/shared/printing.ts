/** Native outcomes acknowledge queue/export actions, never physical paper delivery. */
export interface PrintReceipt {
  versionId: string;
  revision: number;
  pageCount: number;
  /** Present only for bounded multi-batch reports; job/export counts do not imply every batch ran. */
  batchCount?: number;
  status:
    | 'closed'
    | 'submitted'
    | 'cancelled'
    | 'exported'
    | 'export-cancelled'
    | 'failed'
    | 'interrupted';
  submittedJobs: number;
  pdfExports: number;
  temporaryCleanupFailed: boolean;
}
