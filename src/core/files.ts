import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { DomainError } from './errors';

export function durableWrite(path: string, bytes: string | Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface AtomicWriteOptions {
  renameFn?: (oldPath: string, newPath: string) => void;
  sleepFn?: (ms: number) => void;
  maxRetries?: number;
}

/** Publish only fully written files; a failed rename leaves the previous target intact. */
export function atomicWrite(
  path: string,
  bytes: string | Uint8Array,
  options?: AtomicWriteOptions,
): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const rename = options?.renameFn ?? renameSync;
  const sleep =
    options?.sleepFn ??
    ((ms: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    });
  const maxRetries = options?.maxRetries ?? 10;

  try {
    durableWrite(temporary, bytes);
    let attempts = 0;
    while (true) {
      try {
        rename(temporary, path);
        break;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempts < maxRetries) {
          attempts++;
          const delay = attempts * 10;
          sleep(delay);
          continue;
        }
        throw err;
      }
    }
  } finally {
    // 失败的导出不应在目标旁留下含完整数据的临时文件；不触碰原目标。
    try {
      unlinkSync(temporary);
    } catch {
      /* 已成功发布，或临时文件未能建立。 */
    }
  }
}

/** Publish a template without ever replacing an existing teacher file, including a late race. */
export function atomicCreate(path: string, bytes: string | Uint8Array): void {
  atomicWrite(path, bytes, {
    renameFn: (temporary, target) => {
      try {
        try {
          linkSync(temporary, target);
        } catch (error) {
          // Removable FAT/exFAT volumes do not support hard links. Exclusive copy still protects existing files.
          if (
            ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            copyFileSync(temporary, target, constants.COPYFILE_EXCL);
          else throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new DomainError(
            'CONFLICT',
            '空白模板不能覆盖已有文件。请使用新的文件名；导入现有名单请点击“选择名单文件”。',
          );
        throw error;
      }
    },
  });
}

export function requireRegularFile(path: string, maxBytes: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new DomainError('BACKUP_INVALID', '文件类型或大小不符合要求。');
  }
}

export function requireDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainError('STORAGE_ERROR', '数据目录类型异常，已停止操作。');
  }
}
