import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
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

/** Publish only fully written files; a failed rename leaves the previous target intact. */
export function atomicWrite(path: string, bytes: string | Uint8Array): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    durableWrite(temporary, bytes);
    renameSync(temporary, path);
  } finally {
    // 失败的导出不应在目标旁留下含完整数据的临时文件；不触碰原目标。
    try {
      unlinkSync(temporary);
    } catch {
      /* 已成功发布，或临时文件未能建立。 */
    }
  }
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
