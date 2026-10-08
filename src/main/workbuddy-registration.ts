import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicCreate, atomicWrite, requireDirectory, requireRegularFile } from '../core/files';
import { DomainError } from '../core/errors';
import type { WorkBuddyRegistration } from '../shared/teaching-workbench';

export interface WorkBuddyServer {
  command: string;
  args: string[];
  env: { ELECTRON_RUN_AS_NODE: string };
}

/** Only known desktop installations are launched; never execute paths supplied by the renderer. */
export function findWorkBuddy(home: string, environment: NodeJS.ProcessEnv = process.env) {
  const roots = [
    join(home, 'AppData', 'Local', 'Programs'),
    environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, 'Programs'),
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
  ].filter((root): root is string => Boolean(root));
  for (const name of ['WorkBuddy', 'WorkBuddyAI']) {
    for (const root of roots) {
      const path = join(root, name, `${name}.exe`);
      if (!existsSync(path)) continue;
      requireRegularFile(path, 1024 * 1024 * 1024);
      return path;
    }
  }
  return undefined;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Merge the documented user configuration. Approval files are intentionally outside this module. */
export function registerWorkBuddy(
  home: string,
  server: WorkBuddyServer,
): Omit<WorkBuddyRegistration, 'installed' | 'launched' | 'active'> {
  const directory = join(home, '.workbuddy');
  mkdirSync(directory, { recursive: true });
  requireDirectory(directory);
  const path = join(directory, 'mcp.json');
  const read = () => {
    if (!existsSync(path)) return undefined;
    requireRegularFile(path, 2 * 1024 * 1024);
    return readFileSync(path, 'utf8');
  };
  const original = read();
  let configuration: Record<string, unknown> = {};
  if (original !== undefined) {
    try {
      const parsed: unknown = JSON.parse(original.replace(/^\uFEFF/, ''));
      if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers)))
        throw new Error('Invalid structure');
      configuration = parsed;
    } catch {
      throw new DomainError(
        'VALIDATION',
        'WorkBuddy 的已有 MCP 配置无法解析，已保留原文件。请先在 WorkBuddy 中修复配置，再点击开始连接。',
      );
    }
  }
  const servers = (configuration.mcpServers ?? {}) as Record<string, unknown>;
  const previous = servers['class-manager'];
  if (previous !== undefined) {
    const ours =
      object(previous) &&
      Array.isArray(previous.args) &&
      typeof previous.args[0] === 'string' &&
      /(?:^|[\\/])mcp-stdio\.cjs$/.test(previous.args[0]) &&
      previous.args[1] === '--connection' &&
      typeof previous.args[2] === 'string' &&
      /(?:^|[\\/])workbuddy-connection\.json$/.test(previous.args[2]);
    if (!ours)
      throw new DomainError(
        'CONFLICT',
        'WorkBuddy 中已有其他名为 class-manager 的服务，未覆盖它。请在 WorkBuddy 中将该服务改名后重试。',
      );
    if (JSON.stringify(previous) === JSON.stringify(server))
      return {
        registered: true,
        changed: false,
        firstRegistration: false,
        configurationPath: path,
      };
  }
  const bytes =
    JSON.stringify(
      { ...configuration, mcpServers: { ...servers, 'class-manager': server } },
      null,
      2,
    ) + '\n';
  // Keep the exact previous bytes for recovery, including unrelated servers and credentials.
  const backupPath =
    original === undefined ? undefined : `${path}.class-manager-${randomUUID()}.bak`;
  if (backupPath) atomicCreate(backupPath, original!);
  atomicWrite(path, bytes, {
    renameFn: (temporary, target) => {
      if (read() !== original)
        throw new DomainError(
          'CONFLICT',
          'WorkBuddy 配置刚被其他程序修改，已保留新配置，请再次点击开始连接。',
        );
      // Atomic publication for replacements; exclusive publication for a previously absent file.
      if (original === undefined) atomicCreate(target, readFileSync(temporary));
      else {
        // atomicWrite normally retries busy Windows files; the callback preserves the concurrency check.
        renameSync(temporary, target);
      }
    },
  });
  return {
    registered: true,
    changed: true,
    firstRegistration: original === undefined,
    configurationPath: path,
    backupPath,
  };
}
