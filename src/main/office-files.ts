import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, link, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { DomainError } from '../core/errors';
import { OFFICE_LIMITS } from '../shared/office-export';

const cancelled = () => new DomainError('EXPORT_CANCELLED', 'Office 导出已取消，原文件未改动。');
function current(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}

/** Main-only dialog destination. Snapshotting the existing target before explicit overwrite
 * confirmation detects ordinary concurrent edits. Atomic rename publishes only a flushed file;
 * a new target uses exclusive hard-link publication so a competing creator is never overwritten.
 * This is not a filesystem compare-and-swap against a hostile process changing directories. */
export async function officeTargetStamp(
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  current(signal);
  try {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(OFFICE_LIMITS.outputBytes))
      throw new DomainError(
        'EXPORT_DESTINATION',
        '目标必须是普通文件且不超过 64 MiB，请另选文件名。',
      );
    const handle = await open(path, 'r');
    try {
      const start = await handle.stat({ bigint: true });
      if (start.ino !== stat.ino || start.dev !== stat.dev)
        throw new DomainError('EXPORT_CONFLICT', '目标文件发生变化，请重新选择。');
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(256 * 1024);
      let total = 0;
      while (true) {
        current(signal);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > OFFICE_LIMITS.outputBytes)
          throw new DomainError('EXPORT_DESTINATION', '目标文件过大，请另选文件名。');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const end = await handle.stat({ bigint: true });
      const stamp = (s: typeof end) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
      if (stamp(start) !== stamp(end) || total !== Number(end.size))
        throw new DomainError('EXPORT_CONFLICT', '目标文件正在变化，请另选文件名。');
      return `${stamp(end)}:${hash.digest('hex')}`;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveOfficeFile(
  path: string,
  bytes: Buffer,
  format: 'docx' | 'pptx',
  expectedStamp: string | null,
  signal?: AbortSignal,
  operations: {
    open: typeof open;
    link: typeof link;
    rename: typeof rename;
    unlink: typeof unlink;
  } = { open, link, rename, unlink },
): Promise<void> {
  if (extname(path).toLowerCase() !== `.${format}`)
    throw new DomainError('EXPORT_DESTINATION', `请使用 .${format} 文件名。`);
  // The native dialog normally rejects these; validate again before creating any sidecar.
  if (
    // eslint-disable-next-line no-control-regex -- Reject Windows device/alternate-stream filenames.
    /[<>:"/\\|?*\u0000-\u001f]/u.test(basename(path)) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(basename(path))
  )
    throw new DomainError('EXPORT_DESTINATION', '导出文件名不能使用设备名、控制字符或数据流。');
  if (!bytes.length || bytes.length > OFFICE_LIMITS.outputBytes)
    throw new DomainError('EXPORT_LIMIT', '导出文件大小无效。');
  current(signal);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.cmexport-tmp`);
  let owned = false;
  try {
    const handle = await operations.open(temporary, 'wx', 0o600);
    owned = true;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        current(signal);
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          Math.min(256 * 1024, bytes.length - offset),
          null,
        );
        if (!bytesWritten)
          throw new DomainError('EXPORT_SAVE_FAILED', '文件写入未完成，原文件未改动。');
        offset += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await officeTargetStamp(path, signal)) !== expectedStamp)
      throw new DomainError('EXPORT_CONFLICT', '目标文件已变化，原文件未覆盖，请重新导出。');
    current(signal);
    // Commit wins once publication is admitted; later cancellation cannot undo a completed file.
    if (expectedStamp === null) await operations.link(temporary, path);
    else await operations.rename(temporary, path);
  } finally {
    if (owned)
      await operations.unlink(temporary).catch(() => {
        /* Published rename removes the temporary path. */
      });
  }
}
