import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { WorkBuddyBridge } from '../src/main/workbuddy-bridge';
import { nodeBundleOptions } from '../scripts/node-bundle-options';
const roots: string[] = [],
  spaces: Workspace[] = [],
  bridges: WorkBuddyBridge[] = [];
afterEach(() => {
  vi.useRealTimers();
  bridges.splice(0).forEach((b) => b.close());
  spaces.splice(0).forEach((w) => w.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

test('disconnect and idle expiry release MCP sessions across more than 32 reconnects', async () => {
  const f = await fixture();
  for (let i = 0; i < 40; i++) {
    const client = randomUUID();
    expect(
      await f.bridge.rpc({ jsonrpc: '2.0', id: i, method: 'initialize' }, client),
    ).toHaveProperty('result');
    await f.bridge.rpc({ jsonrpc: '2.0', method: 'notifications/disconnected' }, client);
  }
  vi.useFakeTimers();
  for (let i = 0; i < 30; i++)
    await f.bridge.rpc({ jsonrpc: '2.0', id: i, method: 'initialize' }, randomUUID());
  vi.setSystemTime(Date.now() + 10 * 60 * 1000);
  expect(
    await f.bridge.rpc({ jsonrpc: '2.0', id: 100, method: 'initialize' }, randomUUID()),
  ).toHaveProperty('result');
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-mcp-'));
  roots.push(root);
  const workspace = new Workspace(root);
  spaces.push(workspace);
  workspace.createClass({ epoch: workspace.snapshot().epoch, name: '合成一班' });
  const file = join(root, 'connection.json');
  const bridge = new WorkBuddyBridge(
    file,
    async () => workspace.snapshot(),
    async (channel, input) => {
      switch (channel) {
        case 'listTeachingRecords':
          return workspace.teaching.list(input);
        case 'saveTeachingRecord':
          return workspace.teaching.save(input);
        case 'deleteTeachingRecord':
          return workspace.teaching.remove(input);
        case 'saveStudent':
          return workspace.saveStudent(input);
        case 'setStudentActive':
          return workspace.setStudentActive(input);
        default:
          throw new Error(`Unexpected operation ${channel}`);
      }
    },
  );
  bridges.push(bridge);
  await bridge.start();
  const client = randomUUID();
  await bridge.rpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    },
    client,
  );
  await bridge.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, client);
  return { root, workspace, bridge, file, client };
}
function value(raw: unknown): Record<string, unknown> {
  const response = raw as { result: { content: Array<{ text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}
test('MCP exposes typed tools, reads directly, and never writes until local approval', async () => {
  const f = await fixture();
  const catalog = (await f.bridge.rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    f.client,
  )) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
  expect(catalog.result.tools.some((t) => t.name === 'propose_teaching_record')).toBe(true);
  expect(JSON.stringify(catalog)).toContain('dueAt');
  const read = value(
    await f.bridge.rpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace', arguments: {} } },
      f.client,
    ),
  );
  expect(read).toHaveProperty('classes');
  expect(read).not.toHaveProperty('dataDirectory');
  const snapshot = f.workspace.snapshot();
  const args = {
    classId: snapshot.classes[0]!.id,
    kind: 'todo',
    expectedRevision: 0,
    content: { text: '合成待办', dueAt: new Date().toISOString(), priority: 'high', done: false },
  };
  const proposed = value(
    await f.bridge.rpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'propose_teaching_record', arguments: args },
      },
      f.client,
    ),
  );
  expect(proposed.status).toBe('pending');
  expect(f.workspace.teaching.list({ epoch: snapshot.epoch })).toEqual([]);
  const proposal = f.bridge.list()[0]!;
  expect(proposal.preview?.className).toBe('合成一班');
  expect(
    await f.bridge.rpc(
      { jsonrpc: '2.0', id: 5, method: 'approve', params: { id: proposal.id } },
      f.client,
    ),
  ).toHaveProperty('error');
  expect(f.workspace.teaching.list({ epoch: snapshot.epoch })).toEqual([]);
  expect((await f.bridge.resolve({ id: proposal.id, approve: true })).status).toBe('succeeded');
  expect(f.workspace.teaching.list({ epoch: snapshot.epoch })).toHaveLength(1);
  await expect(f.bridge.resolve({ id: proposal.id, approve: true })).rejects.toThrow(/已处理/);
});
test('proposals retain before/after preview, reject stale revisions, and expire across restores', async () => {
  const f = await fixture(),
    snapshot = f.workspace.snapshot();
  const saved = f.workspace.teaching.save({
    epoch: snapshot.epoch,
    classId: snapshot.classes[0]!.id,
    kind: 'notes',
    expectedRevision: 0,
    requestId: randomUUID(),
    content: { title: '旧标题', content: '旧内容' },
  });
  const call = () =>
    f.bridge.rpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'propose_teaching_record',
          arguments: {
            classId: saved.classId,
            kind: saved.kind,
            id: saved.id,
            expectedRevision: saved.revision,
            content: { title: '新标题', content: '新内容' },
          },
        },
      },
      f.client,
    );
  await call();
  expect(f.bridge.list()[0]?.preview?.before).toEqual(saved);
  f.workspace.teaching.save({
    epoch: snapshot.epoch,
    classId: saved.classId,
    kind: saved.kind,
    id: saved.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    content: { title: '教师手动修改', content: '' },
  });
  expect((await f.bridge.resolve({ id: f.bridge.list()[0]!.id, approve: true })).status).toBe(
    'failed',
  );
  await call();
  const pending = f.bridge.list().find((p) => p.status === 'pending')!;
  const backup = f.workspace.exportBackup({ epoch: snapshot.epoch }),
    preview = f.workspace.previewRestore(backup);
  f.workspace.commitRestore({ epoch: snapshot.epoch, token: preview.token });
  await expect(f.bridge.resolve({ id: pending.id, approve: true })).rejects.toThrow(/过期/);
  expect(f.bridge.list().find((p) => p.id === pending.id)?.status).toBe('expired');
});
test('local HTTP rejects unauthenticated and browser-origin requests; stdio helper emits only JSON-RPC', async () => {
  const f = await fixture(),
    connection = JSON.parse(readFileSync(f.file, 'utf8')) as { url: string; token: string };
  expect((await fetch(connection.url, { method: 'POST', body: '{}' })).status).toBe(403);
  expect(
    (
      await fetch(connection.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${connection.token}`, origin: 'https://example.com' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
  const helper = join(f.root, 'stdio.cjs');
  buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/mcp-stdio.ts'],
      outfile: helper,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    }),
  );
  const child = spawn(process.execPath, [helper, '--connection', f.file], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = createInterface({ input: child.stdout });
  const output: unknown[] = [],
    waiters: Array<(v: unknown) => void> = [];
  reader.on('line', (line) => {
    const result = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(result);
    else output.push(result);
  });
  const next = () =>
    output.length
      ? Promise.resolve(output.shift())
      : new Promise<unknown>((resolve) => waiters.push(resolve));
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1' },
        },
      }) + '\n',
    );
    expect(await next()).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'class-manager' } },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'workspace', arguments: {} },
      }) + '\n',
    );
    expect(value(await next()).classes).toHaveLength(1);
  } finally {
    child.kill();
    reader.close();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
});
