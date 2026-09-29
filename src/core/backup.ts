import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assetSchema, type Snapshot } from '../shared/contracts';
import { openDatabase } from './database';
import { DomainError } from './errors';
import { durableWrite, requireDirectory, requireRegularFile } from './files';
import { readSnapshot } from './snapshot';

export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const MAX_DB_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_ASSETS_BYTES = 12 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const payloadSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    base64: z.string(),
  })
  .strict();
const bundleSchema = z
  .object({
    format: z.literal('class-manager-backup'),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    database: payloadSchema,
    assets: z.array(assetSchema.extend({ base64: z.string() })).max(32),
  })
  .strict();
export type BackupBundle = z.infer<typeof bundleSchema>;
export interface StagedBackup {
  token: string;
  directory: string;
  manifest: BackupBundle;
  epoch: string;
}

function payload(bytes: Buffer) {
  return { bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') };
}

function decode(value: z.infer<typeof payloadSchema>, maximum: number): Buffer {
  if (value.bytes > maximum || value.base64.length > Math.ceil(maximum / 3) * 4) {
    throw new DomainError('BACKUP_INVALID', '备份内容超过大小上限。');
  }
  const bytes = Buffer.from(value.base64, 'base64');
  if (
    bytes.length !== value.bytes ||
    bytes.toString('base64') !== value.base64 ||
    hash(bytes) !== value.sha256
  ) {
    throw new DomainError('BACKUP_INVALID', '备份校验失败：大小、编码或哈希不一致。');
  }
  return bytes;
}

/** 只清理应用生成的暂存子目录，绝不根据备份内的路径递归删除。 */
export function removeStaging(root: string, directory: string): void {
  const parent = join(root, 'staging');
  const child = relative(parent, directory);
  if (
    !child ||
    child.startsWith('..') ||
    isAbsolute(child) ||
    child.includes('/') ||
    child.includes('\\')
  ) {
    throw new DomainError('STORAGE_ERROR', '拒绝清理不属于暂存区的路径。');
  }
  rmSync(directory, { recursive: true, force: true });
}

export function validateAssets(directory: string, snapshot: Snapshot): void {
  requireDirectory(join(directory, 'assets'));
  let total = 0;
  for (const asset of snapshot.assets) {
    const path = join(directory, 'assets', `${asset.id}.bin`);
    requireRegularFile(path, MAX_ASSET_BYTES);
    const bytes = readFileSync(path);
    total += bytes.length;
    if (total > MAX_ASSETS_BYTES || bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) {
      throw new DomainError('BACKUP_INVALID', '附件缺失、损坏或超过限制，原数据未被替换。');
    }
  }
}

export function createBackup(
  db: DatabaseSync,
  directory: string,
  root: string,
  snapshot: Snapshot,
): Buffer {
  validateAssets(directory, snapshot);
  const temporary = join(root, 'staging', randomUUID());
  mkdirSync(temporary, { recursive: true });
  try {
    const snapshotPath = join(temporary, 'snapshot.sqlite');
    // 数据操作在单个工作线程内串行执行，取得快照期间附件不会被另一条命令修改。
    db.prepare('VACUUM INTO ?').run(snapshotPath);
    requireRegularFile(snapshotPath, MAX_DB_BYTES);
    const bundle: BackupBundle = {
      format: 'class-manager-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      database: payload(readFileSync(snapshotPath)),
      assets: snapshot.assets.map((asset) => ({
        ...asset,
        base64: readFileSync(join(directory, 'assets', `${asset.id}.bin`)).toString('base64'),
      })),
    };
    const bytes = Buffer.from(JSON.stringify(bundle), 'utf8');
    if (bytes.length > MAX_BACKUP_BYTES)
      throw new DomainError('VALIDATION', '备份超过 M0 的 32 MiB 上限。');
    return bytes;
  } finally {
    removeStaging(root, temporary);
  }
}

export function validateStaged(staged: StagedBackup): Snapshot {
  requireDirectory(staged.directory);
  const path = join(staged.directory, 'data.sqlite');
  requireRegularFile(path, MAX_DB_BYTES);
  const bytes = readFileSync(path);
  if (hash(bytes) !== staged.manifest.database.sha256)
    throw new DomainError('BACKUP_INVALID', '暂存数据库校验失败。');
  const db = openDatabase(path, 'readonly');
  try {
    const snapshot = readSnapshot(db, staged.token, staged.directory);
    const canonical = (assets: Snapshot['assets']) =>
      JSON.stringify(
        assets
          .map(({ id, name, bytes: size, sha256 }) => ({ id, name, bytes: size, sha256 }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    if (canonical(snapshot.assets) !== canonical(staged.manifest.assets)) {
      throw new DomainError('BACKUP_INVALID', '备份清单与数据库附件引用不一致。');
    }
    validateAssets(staged.directory, snapshot);
    return snapshot;
  } finally {
    db.close();
  }
}

export function stageBackup(root: string, bytes: Uint8Array, epoch: string): StagedBackup {
  if (bytes.byteLength > MAX_BACKUP_BYTES)
    throw new DomainError('BACKUP_INVALID', '备份超过 32 MiB 上限。');
  let manifest: BackupBundle;
  try {
    manifest = bundleSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    throw new DomainError('BACKUP_INVALID', '不是受支持的 M0 备份，或备份清单已损坏。');
  }
  if (new Set(manifest.assets.map((asset) => asset.id)).size !== manifest.assets.length) {
    throw new DomainError('BACKUP_INVALID', '备份含重复附件。');
  }
  const database = decode(manifest.database, MAX_DB_BYTES);
  let total = 0;
  const assets = manifest.assets.map((asset) => {
    const data = decode(asset, MAX_ASSET_BYTES);
    total += data.length;
    if (total > MAX_ASSETS_BYTES) throw new DomainError('BACKUP_INVALID', '附件总量超过上限。');
    return { id: asset.id, data };
  });
  const token = randomUUID();
  const directory = join(root, 'staging', token);
  const staged = { token, directory, manifest, epoch };
  mkdirSync(join(directory, 'assets'), { recursive: true });
  try {
    durableWrite(join(directory, 'data.sqlite'), database);
    // 文件名仅从校验后的 UUID 生成；备份格式不接受路径、链接或 ZIP 条目。
    for (const asset of assets)
      durableWrite(join(directory, 'assets', `${asset.id}.bin`), asset.data);
    validateStaged(staged);
    return staged;
  } catch (error) {
    removeStaging(root, directory);
    throw error;
  }
}
