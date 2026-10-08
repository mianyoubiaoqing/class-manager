import { z } from 'zod';
import { createOfficeDocument } from '../core/office-document';
import { DomainError } from '../core/errors';
import { officeExportInput, officeSnapshotSchema } from '../shared/office-export';
import { teachingReportDocument } from '../shared/teaching-report';
import { createTeachingReportDocument } from '../core/teaching-report-document';

process.once('disconnect', () => process.exit(0));
process.once('message', async (input: unknown) => {
  let reply: unknown;
  try {
    const request = z
      .union([
        z.object({ snapshot: officeSnapshotSchema, options: officeExportInput }).strict(),
        z.object({ report: teachingReportDocument }).strict(),
      ])
      .parse(input);
    reply = {
      ok: true,
      value:
        'report' in request
          ? await createTeachingReportDocument(request.report)
          : await createOfficeDocument(request.snapshot, request.options),
    };
  } catch (error) {
    reply = {
      ok: false,
      error:
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : { code: 'EXPORT_FAILED', message: 'Office 文件生成失败，没有保存部分文件。' },
    };
  }
  if (!process.connected || !process.send) process.exit(1);
  process.send(reply, (error) => process.exit(error ? 1 : 0));
});
