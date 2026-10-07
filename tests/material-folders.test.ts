import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { MaterialFolders } from '../src/main/material-folders';
import { MaterialImporter } from '../src/main/material-importer';
import { parseMaterial } from '../src/core/material-parser';
import { Workspace } from '../src/core/workspace';
import { publicError } from '../src/core/errors';
import type { WorkerOperation } from '../src/main/worker-client';
import type { Result } from '../src/shared/contracts';
import { resourceLinkInput } from '../src/shared/material-folders';

const roots: string[] = [];
const workspaces: Workspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.close();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), 'cm-folders-')))
      throw Error('Unexpected cleanup target');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-folders-'));
  roots.push(root);
  const directory = join(root, '资料');
  mkdirSync(directory);
  mkdirSync(join(directory, '子目录'));
  writeFileSync(join(directory, '课程.txt'), '力有大小、方向和作用点。');
  writeFileSync(join(directory, '说明.exe'), 'unsupported');
  writeFileSync(join(directory, '子目录', '补充.txt'), '这是补充资料。');
  const workspace = new Workspace(join(root, 'workspace'));
  workspaces.push(workspace);
  const epoch = workspace.snapshot().epoch;
  let currentEpoch = epoch;
  const worker = {
    call: async <T>(operation: WorkerOperation, input?: unknown): Promise<Result<T>> => {
      try {
        const value =
          operation === 'snapshot'
            ? { epoch: currentEpoch }
            : workspace.materials.store((input as { command: unknown }).command);
        return { ok: true, value: value as T };
      } catch (error) {
        return { ok: false, error: publicError(error) };
      }
    },
  };
  const parser = { parse: vi.fn(parseMaterial) };
  const importer = new MaterialImporter(worker, parser);
  const folders = new MaterialFolders(importer, async () => currentEpoch);
  return {
    directory,
    workspace,
    epoch,
    parser,
    folders,
    importer,
    changeEpoch: () => {
      currentEpoch = randomUUID();
    },
  };
}
test('native folder choice lists only direct regular files by default, then explicitly reads selected material', async () => {
  const { folders, directory, epoch, workspace, parser } = fixture();
  const inventory = await folders.scan({ epoch, choose: true }, async () => directory);
  expect(inventory?.entries.map((entry) => entry.name)).toEqual(['课程.txt', '说明.exe']);
  expect(parser.parse).not.toHaveBeenCalled();
  expect(JSON.stringify(inventory)).not.toContain(directory);
  const id = inventory!.entries.find((entry) => entry.status === 'ready')!.id;
  const receipt = await folders.read({ epoch, token: inventory!.token, ids: [id] });
  expect(receipt.files[0]?.id).toBeDefined();
  expect(workspace.materials.list({ epoch })).toHaveLength(1);
  await expect(folders.read({ epoch, token: inventory!.token, ids: [id] })).rejects.toMatchObject({
    code: 'MATERIAL_EXPIRED',
  });
});
test('recursive inventory is explicit, old tokens and arbitrary IDs cannot read files', async () => {
  const { folders, directory, epoch } = fixture();
  const first = await folders.scan({ epoch, choose: true }, async () => directory);
  const next = await folders.scan({ epoch, includeChildren: true }, async () => null);
  expect(next!.entries.some((entry) => entry.name.includes('子目录'))).toBe(true);
  await expect(
    folders.read({ epoch, token: first!.token, ids: [first!.entries[0]!.id] }),
  ).rejects.toMatchObject({ code: 'MATERIAL_EXPIRED' });
  await expect(
    folders.read({ epoch, token: next!.token, ids: [randomUUID()] }),
  ).rejects.toMatchObject({ code: 'MATERIAL_EXPIRED' });
  await expect(
    folders.scan({ epoch, path: directory }, async () => directory),
  ).rejects.toBeDefined();
});
test('changed files fail individually while other selected files are stored and stale workspaces are rejected', async () => {
  const { folders, directory, epoch, workspace, changeEpoch } = fixture();
  const inventory = await folders.scan(
    { epoch, choose: true, includeChildren: true },
    async () => directory,
  );
  writeFileSync(join(directory, '课程.txt'), '文件已经修改，不能按旧清单导入。');
  const receipt = await folders.read({
    epoch,
    token: inventory!.token,
    ids: inventory!.entries.filter((entry) => entry.status === 'ready').map((entry) => entry.id),
  });
  expect(receipt.files.filter((file) => file.error)).toHaveLength(1);
  expect(receipt.files.filter((file) => file.id)).toHaveLength(1);
  expect(workspace.materials.list({ epoch })).toHaveLength(1);
  changeEpoch();
  await expect(folders.scan({ epoch }, async () => directory)).rejects.toMatchObject({
    code: 'STALE_WORKSPACE',
  });
});
test('pending single-file preview is retained and cancellation stops folder persistence', async () => {
  const { folders, importer, parser, directory, epoch, workspace } = fixture();
  await importer.preview({ epoch }, async () => join(directory, '课程.txt'));
  await expect(folders.scan({ epoch, choose: true }, async () => directory)).rejects.toMatchObject({
    code: 'BUSY',
  });
  importer.cancel({ epoch });
  const inventory = await folders.scan({ epoch, choose: true }, async () => directory);
  parser.parse.mockImplementationOnce(async (bytes, format) => {
    folders.cancel({ epoch });
    return parseMaterial(bytes, format);
  });
  const receipt = await folders.read({
    epoch,
    token: inventory!.token,
    ids: [inventory!.entries.find((entry) => entry.status === 'ready')!.id],
  });
  expect(receipt.cancelled).toBe(true);
  expect(workspace.materials.list({ epoch })).toHaveLength(0);
  expect(importer.hasPreview).toBe(false);
});
test.each([
  'javascript:alert(1)',
  'file:///C:/secret',
  'http://example.com',
  'https://name:password@example.com',
])('resource opener rejects unsafe address %s', (url) => {
  expect(resourceLinkInput.safeParse({ url }).success).toBe(false);
});
