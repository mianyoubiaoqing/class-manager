import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import sharp from 'sharp';
import { afterEach, expect, test } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { SCHEMA_VERSION } from '../src/core/database';
import { parseMaterial } from '../src/core/material-parser';
import type { MaterialCheckpoint } from '../src/core/material-book';

const roots: string[] = [];
const live: Workspace[] = [];
function fixture(checkpoint?: MaterialCheckpoint) {
  const root = mkdtempSync(join(tmpdir(), 'cm-material-book-'));
  roots.push(root);
  const workspace = new Workspace(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checkpoint,
  );
  live.push(workspace);
  return { root, workspace, epoch: workspace.snapshot().epoch };
}
function reopen(workspace: Workspace, root: string) {
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  const next = new Workspace(root);
  live.push(next);
  return next;
}
afterEach(() => {
  for (const workspace of live.splice(0)) workspace.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const text = Buffer.from('力有大小、方向和作用点。\n第二行合成资料。');

test('immutable original bytes and import identity survive reopening, replay and restore', async () => {
  const { root, workspace, epoch } = fixture();
  const parsed = await parseMaterial(text, 'txt');
  const command = { epoch, requestId: randomUUID(), name: '合成教材.txt', parsed };
  const receipt = workspace.materials.store(command);
  expect(workspace.materials.store(command)).toEqual({ ...receipt, replayed: true });
  expect(() => workspace.materials.store({ ...command, name: '不同教材.txt' })).toThrow('其他内容');
  const saved = workspace.materials.read({ epoch, id: receipt.id });
  const next = reopen(workspace, root);
  expect(next.materials.read({ epoch, id: receipt.id })).toEqual(saved);
  expect(
    next.materials.readAsset({ epoch, id: receipt.id, assetId: parsed.version.originalAssetId })
      .bytes,
  ).toEqual(text);
  expect(next.materials.store(command).replayed).toBe(true);
  const held = next.materials;
  const preview = next.previewRestore(next.exportBackup({ epoch }));
  expect(preview.materialVersionCount).toBe(1);
  const restored = next.commitRestore({ epoch, token: preview.token });
  expect(() => held.read({ epoch: restored.epoch, id: receipt.id })).toThrow('已切换');
  expect(next.materials.read({ epoch: restored.epoch, id: receipt.id })).toEqual(saved);
});

test('large normalized image assets round-trip through v6 backup, including owned UUID checks', async () => {
  const { workspace, epoch } = fixture();
  const png = await sharp(randomBytes(768 * 768 * 3), {
    raw: { width: 768, height: 768, channels: 3 },
  })
    .png()
    .toBuffer();
  expect(png.length).toBeGreaterThan(1024 * 1024);
  const parsed = await parseMaterial(png, 'png');
  const saved = workspace.materials.store({
    epoch,
    requestId: randomUUID(),
    name: '合成随机图.png',
    parsed,
  });
  const image = parsed.version.fragments[0]!;
  if (image.kind !== 'image') throw new Error('Expected image');
  expect(() =>
    workspace.materials.readAsset({ epoch, id: randomUUID(), assetId: image.assetId }),
  ).toThrow('不包含');
  const backup = workspace.exportBackup({ epoch });
  expect(JSON.parse(backup.toString()).version).toBe(SCHEMA_VERSION);
  const preview = workspace.previewRestore(backup);
  expect(preview.assetCount).toBe(2);
  const restored = workspace.commitRestore({ epoch, token: preview.token });
  expect(
    workspace.materials.readAsset({ epoch: restored.epoch, id: saved.id, assetId: image.assetId })
      .bytes,
  ).toEqual(parsed.assets[1]!.bytes);
});

test.each(['bytes', 'mime', 'extra', 'missing', 'hash', 'dimensions'] as const)(
  'bad parser asset %s is rejected without registering files',
  async (kind) => {
    const { root, workspace, epoch } = fixture();
    const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer();
    const parsed = await parseMaterial(png, 'png');
    if (kind === 'bytes') parsed.assets[0]!.bytes = Buffer.from('bad');
    if (kind === 'mime') parsed.assets[1]!.mime = 'text/plain';
    if (kind === 'extra') parsed.assets.push({ ...parsed.assets[0]!, id: randomUUID() });
    if (kind === 'missing') parsed.assets.pop();
    const image = parsed.version.fragments[0]!;
    if (image.kind !== 'image') throw new Error('Expected image');
    if (kind === 'hash') image.sha256 = '0'.repeat(64);
    if (kind === 'dimensions') image.width = 3;
    expect(() =>
      workspace.materials.store({ epoch, requestId: randomUUID(), name: 'bad.png', parsed }),
    ).toThrow();
    expect(workspace.materials.list({ epoch })).toEqual([]);
    expect(workspace.snapshot().assets).toEqual([]);
    expect(readdirSync(join(root, 'workspaces', epoch, 'assets'))).toEqual([]);
  },
);

test.each(['assets-written', 'stored', 'committed'] as const)(
  'failure at %s has an atomic record and allows only exact retry',
  async (stage) => {
    let fail = true;
    const { root, workspace, epoch } = fixture((point) => {
      if (point === stage && fail) throw new Error('synthetic material failure');
    });
    const parsed = await parseMaterial(text, 'txt');
    const command = { epoch, requestId: randomUUID(), name: '合成.txt', parsed };
    expect(() => workspace.materials.store(command)).toThrow('synthetic material failure');
    expect(workspace.materials.list({ epoch })).toHaveLength(stage === 'committed' ? 1 : 0);
    expect(workspace.snapshot().assets).toHaveLength(stage === 'committed' ? 1 : 0);
    fail = false;
    const next = reopen(workspace, root);
    expect(next.materials.store(command).replayed).toBe(stage === 'committed');
    expect(next.materials.list({ epoch })).toHaveLength(1);
  },
);

test('a stale orphan file cannot be overwritten, and registered corruption rejects reads and reopen', async () => {
  let fail = true;
  const { root, workspace, epoch } = fixture((point) => {
    if (point === 'assets-written' && fail) throw new Error('stop');
  });
  const parsed = await parseMaterial(text, 'txt');
  const command = { epoch, requestId: randomUUID(), name: '合成.txt', parsed };
  expect(() => workspace.materials.store(command)).toThrow('stop');
  const file = join(root, 'workspaces', epoch, 'assets', `${parsed.version.originalAssetId}.bin`);
  writeFileSync(file, 'different');
  fail = false;
  expect(() => workspace.materials.store(command)).toThrow('不一致');
  writeFileSync(file, text);
  workspace.materials.store(command);
  writeFileSync(file, 'corrupted');
  expect(() =>
    workspace.materials.readAsset({
      epoch,
      id: parsed.version.id,
      assetId: parsed.version.originalAssetId,
    }),
  ).toThrow('损坏');
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
  expect(() => new Workspace(root)).toThrow();
});

test('rehashed backup cannot forge material image dimensions or source ownership', async () => {
  const { root, workspace, epoch } = fixture();
  const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#00ff00' } })
    .png()
    .toBuffer();
  const parsed = await parseMaterial(png, 'png');
  workspace.materials.store({ epoch, requestId: randomUUID(), name: '合成.png', parsed });
  const bundle = JSON.parse(workspace.exportBackup({ epoch }).toString());
  const path = join(root, 'tampered.sqlite');
  writeFileSync(path, Buffer.from(bundle.database.base64, 'base64'));
  const db = new DatabaseSync(path);
  const image = parsed.version.fragments[0]!;
  if (image.kind !== 'image') throw new Error('Expected image');
  image.width = 3;
  const { materialImportHash } = await import('../src/core/material-records');
  db.prepare('UPDATE material_versions SET payload=?, import_hash=?').run(
    JSON.stringify(parsed.version),
    materialImportHash('合成.png', parsed.version),
  );
  db.close();
  const bytes = readFileSync(path);
  bundle.database = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow();
  expect(workspace.snapshot().epoch).toBe(epoch);
});

test('duplicate image references cannot hide conflicting dimensions in a rehashed backup', async () => {
  const { root, workspace, epoch } = fixture();
  const parsed = await parseMaterial(
    await sharp({ create: { width: 2, height: 3, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer(),
    'png',
  );
  workspace.materials.store({ epoch, requestId: randomUUID(), name: '合成.png', parsed });
  const bundle = JSON.parse(workspace.exportBackup({ epoch }).toString());
  const path = join(root, 'duplicate-image.sqlite');
  writeFileSync(path, Buffer.from(bundle.database.base64, 'base64'));
  const image = parsed.version.fragments[0]!;
  if (image.kind !== 'image') throw new Error('Expected image');
  parsed.version.fragments.push({ ...image, id: 2 });
  image.width = 3;
  const { materialImportHash } = await import('../src/core/material-records');
  const db = new DatabaseSync(path);
  db.prepare('UPDATE material_versions SET payload=?, import_hash=?').run(
    JSON.stringify(parsed.version),
    materialImportHash('合成.png', parsed.version),
  );
  db.close();
  const bytes = readFileSync(path);
  bundle.database = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow();
  expect(workspace.snapshot().epoch).toBe(epoch);
});

test.each(['assets-written', 'stored', 'committed'] as const)(
  'abrupt material exit at %s leaves an atomic import',
  async (checkpoint) => {
    const { root, workspace, epoch } = fixture();
    const parsed = await parseMaterial(text, 'txt');
    const command = { epoch, requestId: randomUUID(), name: '合成.txt', parsed };
    const inputPath = join(root, 'input.json');
    writeFileSync(
      inputPath,
      JSON.stringify({
        ...command,
        parsed: {
          ...parsed,
          assets: parsed.assets.map((asset) => ({
            id: asset.id,
            mime: asset.mime,
            base64: asset.bytes.toString('base64'),
          })),
        },
      }),
    );
    const childPath = join(root, 'crash.cjs');
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-material-lesson.ts'],
        outfile: childPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
      }),
    );
    workspace.close();
    live.splice(live.indexOf(workspace), 1);
    const child = spawnSync(
      process.execPath,
      [childPath, 'material', root, inputPath, join(root, 'unused.json'), checkpoint],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(89);
    const next = new Workspace(root);
    live.push(next);
    expect(next.materials.list({ epoch })).toHaveLength(checkpoint === 'committed' ? 1 : 0);
    expect(next.materials.store(command).replayed).toBe(checkpoint === 'committed');
    expect(next.materials.list({ epoch })).toHaveLength(1);
  },
);
