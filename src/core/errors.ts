import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { PublicError } from '../shared/contracts';

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 原始文件系统/SQLite 错误可能带出路径或学生输入，只返回允许公开的错误。 */
export function publicError(error: unknown): PublicError {
  const operationId = randomUUID();
  if (error instanceof DomainError)
    return { code: error.code, message: error.message, operationId };
  if (error instanceof ZodError) {
    return { code: 'VALIDATION', message: '输入不符合要求，请检查内容和版本。', operationId };
  }
  return {
    code: 'STORAGE_ERROR',
    message: '操作未完成。请检查磁盘空间和文件权限；保留现有数据并导出诊断。',
    operationId,
  };
}
