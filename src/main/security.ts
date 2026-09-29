import { isAbsolute, relative, resolve } from 'node:path';
import { DomainError } from '../core/errors';

export function isTrustedSender(actual: string, expected: string, mainFrame: boolean): boolean {
  return mainFrame && actual === expected;
}

export function assertExportDestination(path: string, dataRoot: string): void {
  const relation = relative(resolve(dataRoot), resolve(path));
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) {
    throw new DomainError('VALIDATION', '请将导出文件保存在应用数据目录之外。');
  }
}
