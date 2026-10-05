import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { win32, join } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '../core/errors';

const execute = promisify(execFile);

async function windowsDriveType(root: string): Promise<string> {
  const { stdout } = await execute(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.IO.DriveInfo]::new($env:CM_SCORE_DRIVE).DriveType.ToString()',
    ],
    {
      env: { ...process.env, CM_SCORE_DRIVE: root },
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 4096,
    },
  );
  return stdout.trim();
}

/** Check the drive before touching the path: even metadata reads can block on a share. */
export async function assertLocalScorePath(
  path: string,
  driveType: (root: string) => Promise<string> = windowsDriveType,
): Promise<void> {
  if (process.platform !== 'win32')
    throw new DomainError('UNSUPPORTED_PLATFORM', '当前版本仅支持 Windows 本地成绩文件。');
  if (!/^[a-z]:[\\/]/i.test(path))
    throw new DomainError(
      'SCORE_LOCAL_FILE',
      '请先把成绩文件复制到本地磁盘，不能使用共享或设备路径。',
    );
  const normalized = win32.normalize(path);
  const root = win32.parse(normalized).root;
  let type: string;
  try {
    type = await driveType(root);
  } catch {
    throw new DomainError('SCORE_LOCAL_FILE', '无法确认磁盘类型，请使用可访问的本地磁盘后重试。');
  }
  if (!['Fixed', 'Removable', 'Ram', 'CDRom'].includes(type))
    throw new DomainError('SCORE_LOCAL_FILE', '不支持网络映射盘，请先把成绩文件复制到本地磁盘。');
  let parent = root;
  for (const segment of win32
    .relative(root, win32.dirname(normalized))
    .split('\\')
    .filter(Boolean)) {
    parent = win32.join(parent, segment);
    const stat = await lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new DomainError(
        'SCORE_LOCAL_FILE',
        '成绩文件不能位于目录链接中，请复制到本地普通目录。',
      );
  }
}
