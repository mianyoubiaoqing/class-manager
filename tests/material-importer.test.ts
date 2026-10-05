import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { MaterialImporter, readMaterialFile } from '../src/main/material-importer';
import { parseMaterial } from '../src/core/material-parser';
import { Workspace } from '../src/core/workspace';
import { publicError, DomainError } from '../src/core/errors';
import type { WorkerOperation } from '../src/main/worker-client';
import type { Result } from '../src/shared/contracts';
const roots: string[] = [];
const live: Workspace[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const workspace of live.splice(0)) workspace.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-material-import-'));
  roots.push(root);
  const workspace = new Workspace(root);
  live.push(workspace);
  const epoch = workspace.snapshot().epoch;
  const file = join(root, '合成.txt');
  writeFileSync(file, '力有大小、方向和作用点。');
  const worker = {
    call: async <T>(operation: WorkerOperation, input?: unknown): Promise<Result<T>> => {
      try {
        let value: unknown;
        if (operation === 'snapshot') value = workspace.snapshot();
        else if (operation === 'storeMaterial') {
          const request = input as { command: unknown; cancellation: SharedArrayBuffer };
          value = workspace.materials.store(request.command, () => {
            if (Atomics.compareExchange(new Int32Array(request.cancellation), 0, 0, 2) !== 0)
              throw new DomainError('ABORTED', 'cancelled');
          });
        } else throw new Error('Unexpected operation');
        return { ok: true, value: value as T };
      } catch (error) {
        return { ok: false, error: publicError(error) };
      }
    },
  };
  const parser = { parse: vi.fn(parseMaterial) };
  const importer = new MaterialImporter(worker, parser);
  return { root, workspace, epoch, file, parser, importer };
}
test('native choice produces a local preview and only explicit confirmation registers original bytes', async () => {
  const { importer, epoch, file, workspace } = fixture();
  const preview = await importer.preview({ epoch }, async () => file);
  if (!preview) throw new Error('Missing preview');
  expect(workspace.materials.list({ epoch })).toEqual([]);
  expect(preview.name).toBe('合成.txt');
  expect(JSON.stringify(preview)).not.toContain(file);
  const stored = await importer.confirm({ epoch, token: preview.token, requestId: randomUUID() });
  expect(stored.ok).toBe(true);
  expect(workspace.materials.list({ epoch })).toHaveLength(1);
  await expect(
    importer.confirm({ epoch, token: preview.token, requestId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'MATERIAL_EXPIRED' });
});
test('Renderer paths and snapshots are not import parameters', async () => {
  const { importer, epoch, file, parser } = fixture();
  await expect(importer.preview({ epoch, path: file }, async () => file)).rejects.toBeDefined();
  expect(parser.parse).not.toHaveBeenCalled();
});
test.each(['cancel', 'expired', 'bad-replacement'] as const)(
  '%s revokes the pending import token without writing',
  async (kind) => {
    const { importer, epoch, file, workspace } = fixture();
    const preview = await importer.preview({ epoch }, async () => file);
    if (!preview) throw new Error('Missing preview');
    if (kind === 'cancel') importer.cancel({ epoch });
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
    if (kind === 'bad-replacement')
      await expect(
        importer.preview({ epoch }, async () => join(file, 'missing')),
      ).rejects.toBeDefined();
    await expect(
      importer.confirm({ epoch, token: preview.token, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'MATERIAL_EXPIRED' });
    expect(workspace.materials.list({ epoch })).toEqual([]);
  },
);
test('cancelled native dialog cannot start a decoder or resurrect a preview', async () => {
  const { importer, epoch, file, parser } = fixture();
  let choose!: (value: string) => void;
  const pending = importer.preview(
    { epoch },
    () =>
      new Promise((resolve) => {
        choose = resolve;
      }),
  );
  await vi.waitFor(() => expect(importer.busy).toBe(true));
  importer.cancel({ epoch });
  choose(file);
  await expect(pending).rejects.toMatchObject({ code: 'MATERIAL_CANCELLED' });
  expect(parser.parse).not.toHaveBeenCalled();
  expect(importer.busy).toBe(false);
});
test('file reader rejects unsupported, missing, empty and oversized selected files', async () => {
  const { root, file } = fixture();
  expect((await readMaterialFile(file)).format).toBe('txt');
  for (const [name, bytes] of [
    ['bad.exe', Buffer.from('bad')],
    ['empty.txt', Buffer.alloc(0)],
    ['huge.txt', Buffer.alloc(10 * 1024 * 1024 + 1)],
  ] as const) {
    const path = join(root, name);
    writeFileSync(path, bytes);
    await expect(readMaterialFile(path)).rejects.toBeDefined();
  }
  await expect(readMaterialFile(join(root, 'missing.txt'))).rejects.toBeDefined();
});
