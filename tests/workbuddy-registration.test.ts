import { afterEach, expect, test, vi } from 'vitest';
import * as files from '../src/core/files';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findWorkBuddy,
  registerWorkBuddy,
  type WorkBuddyServer,
} from '../src/main/workbuddy-registration';

const homes: string[] = [];
function home() {
  const path = mkdtempSync(join(tmpdir(), 'cm-workbuddy-registration-'));
  homes.push(path);
  return path;
}
const server: WorkBuddyServer = {
  command: 'C:/Portable/Class Manager.exe',
  args: [
    'C:/Portable/resources/mcp-stdio.cjs',
    '--connection',
    'C:/Data/workbuddy-connection.json',
  ],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};
afterEach(() => {
  vi.restoreAllMocks();
  homes.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function config(path: string, text: string) {
  mkdirSync(join(path, '.workbuddy'), { recursive: true });
  writeFileSync(join(path, '.workbuddy', 'mcp.json'), text);
}
test('detects the desktop installation, prioritizes WorkBuddy, and does not invent an executable', () => {
  const path = home();
  expect(findWorkBuddy(path, {})).toBeUndefined();
  for (const name of ['WorkBuddy', 'WorkBuddyAI']) {
    const dir = join(path, 'AppData', 'Local', 'Programs', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.exe`), 'synthetic executable');
  }
  expect(findWorkBuddy(path, {})).toBe(
    join(path, 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
  );
});
test('recognizes a machine-wide installation', () => {
  const path = home(),
    programs = join(path, 'programs');
  mkdirSync(join(programs, 'WorkBuddy'), { recursive: true });
  writeFileSync(join(programs, 'WorkBuddy', 'WorkBuddy.exe'), 'synthetic');
  expect(findWorkBuddy(path, { ProgramFiles: programs })).toBe(
    join(programs, 'WorkBuddy', 'WorkBuddy.exe'),
  );
});
test('registers stdio without persisting connection credentials or approving third-party tools', () => {
  const path = home(),
    result = registerWorkBuddy(path, server);
  expect(result).toMatchObject({ registered: true, changed: true, firstRegistration: true });
  expect(JSON.parse(readFileSync(result.configurationPath!, 'utf8'))).toEqual({
    mcpServers: { 'class-manager': server },
  });
  expect(readdirSync(join(path, '.workbuddy'))).toEqual(['mcp.json']);
});
test('preserves unrelated settings and servers and backs up the exact previous bytes', () => {
  const path = home();
  const original =
    '\uFEFF' +
    JSON.stringify({
      enabled: true,
      mcpServers: { other: { command: 'other.exe', env: { PRIVATE_KEY: 'synthetic-secret' } } },
    });
  config(path, original);
  writeFileSync(join(path, '.workbuddy', 'mcp-approvals.json'), '{"synthetic":"unchanged"}');
  const result = registerWorkBuddy(path, server);
  const parsed = JSON.parse(readFileSync(result.configurationPath!, 'utf8'));
  expect(parsed.enabled).toBe(true);
  expect(parsed.mcpServers.other.env.PRIVATE_KEY).toBe('synthetic-secret');
  expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
  expect(readFileSync(join(path, '.workbuddy', 'mcp-approvals.json'), 'utf8')).toBe(
    '{"synthetic":"unchanged"}',
  );
});
test('repeated registration is idempotent, without new backups or file writes', () => {
  const path = home();
  const first = registerWorkBuddy(path, server);
  const second = registerWorkBuddy(path, server);
  expect(second).toMatchObject({ registered: true, changed: false, firstRegistration: false });
  expect(second.backupPath).toBeUndefined();
  expect(readFileSync(first.configurationPath!, 'utf8')).toContain(server.command);
  expect(readdirSync(join(path, '.workbuddy'))).toEqual(['mcp.json']);
});
test('updates our previous portable location while retaining other servers', () => {
  const path = home();
  config(
    path,
    JSON.stringify({ mcpServers: { 'class-manager': server, other: { command: 'other' } } }),
  );
  const updated = {
    ...server,
    command: 'D:/New/Class Manager.exe',
    args: ['D:/New/resources/mcp-stdio.cjs', '--connection', server.args[2]!],
  };
  const result = registerWorkBuddy(path, updated);
  expect(JSON.parse(readFileSync(result.configurationPath!, 'utf8')).mcpServers).toEqual({
    'class-manager': updated,
    other: { command: 'other' },
  });
});
test.each(['{bad', '[]', 'null', '{"mcpServers":[]}'])(
  'leaves malformed existing configuration untouched: %s',
  (original) => {
    const path = home();
    config(path, original);
    expect(() => registerWorkBuddy(path, server)).toThrow('已有 MCP 配置无法解析');
    expect(readFileSync(join(path, '.workbuddy', 'mcp.json'), 'utf8')).toBe(original);
    expect(readdirSync(join(path, '.workbuddy'))).toEqual(['mcp.json']);
  },
);
test('does not overwrite an unrelated service with the same name', () => {
  const path = home(),
    original = '{"mcpServers":{"class-manager":{"command":"unrelated"}}}';
  config(path, original);
  expect(() => registerWorkBuddy(path, server)).toThrow('未覆盖');
  expect(readFileSync(join(path, '.workbuddy', 'mcp.json'), 'utf8')).toBe(original);
});
test('detects an intervening configuration edit before publication and removes temporary output', () => {
  const path = home(),
    changed = '{"mcpServers":{"late":{"command":"new-service"}}}';
  config(path, '{}');
  const publish = files.atomicWrite;
  vi.spyOn(files, 'atomicWrite').mockImplementationOnce((target, bytes, options) => {
    writeFileSync(target, changed);
    publish(target, bytes, options);
  });
  expect(() => registerWorkBuddy(path, server)).toThrow('刚被其他程序修改');
  expect(readFileSync(join(path, '.workbuddy', 'mcp.json'), 'utf8')).toBe(changed);
  expect(readdirSync(join(path, '.workbuddy')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});
