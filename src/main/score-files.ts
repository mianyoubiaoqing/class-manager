import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireRegularFile } from '../core/files';
import { DomainError } from '../core/errors';
import { SCORE_FILE_LIMITS } from '../shared/score-import';
import { assertLocalScorePath } from './local-score-path';

export interface SelectedScoreFile {
  token: string;
  epoch: string;
  name: string;
  format: 'csv' | 'xlsx';
  bytes: Uint8Array;
}

/** 文件路径仅来自主进程选择框；使用有界读取，文件中途增长也不能突破内存上限。 */
export async function readScoreFile(path: string, epoch: string): Promise<SelectedScoreFile> {
  const extension = extname(path).toLowerCase();
  if (extension !== '.csv' && extension !== '.xlsx') {
    throw new DomainError('SCORE_FILE_TYPE', '请选择 XLSX 或 UTF-8 CSV 成绩表。');
  }
  await assertLocalScorePath(path);
  requireRegularFile(path, SCORE_FILE_LIMITS.bytes);
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SCORE_FILE_LIMITS.bytes) {
      throw new DomainError('SCORE_FILE_LIMIT', '成绩文件类型或大小不符合要求。');
    }
    const bytes = Buffer.alloc(SCORE_FILE_LIMITS.bytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (
      length === 0 ||
      length > SCORE_FILE_LIMITS.bytes ||
      stat.size !== length ||
      fstatSync(fd).size !== length
    ) {
      throw new DomainError('SCORE_FILE_LIMIT', '成绩文件为空、过大或读取期间发生变化。');
    }
    return {
      token: randomUUID(),
      epoch,
      name: basename(path),
      format: extension === '.csv' ? 'csv' : 'xlsx',
      bytes: Uint8Array.from(bytes.subarray(0, length)),
    };
  } finally {
    closeSync(fd);
  }
}
