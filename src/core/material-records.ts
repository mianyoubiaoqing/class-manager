import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  MATERIAL_IMAGE_LIMITS,
  MATERIAL_MIME,
  materialVersionSchema,
  type MaterialVersion,
} from '../shared/lessons';
import { materialRecordSchema, type StoredMaterial } from '../shared/material-records';
import { MAX_MATERIAL_VERSIONS, MAX_MATERIAL_PAYLOAD_BYTES } from './storage-limits';
import { DomainError } from './errors';

export const MATERIAL_COLUMNS = `id, name, created_at AS createdAt, import_request_id AS importRequestId, import_hash AS importHash`;
export interface MaterialAssetMetadata {
  id: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export const materialImportHash = (name: string, version: MaterialVersion) =>
  createHash('sha256').update(JSON.stringify({ name, version })).digest('hex');

/** Parser-decoded PNG identity check shared by registration and restore. The full file hash is
 * checked separately; this compares its IHDR with the immutable fragment's dimensions. */
export function matchesMaterialImage(
  bytes: Buffer,
  image: { width: number; height: number },
): boolean {
  return (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) === image.width &&
    bytes.readUInt32BE(20) === image.height
  );
}

/** Validate exact asset ownership and original/image identities, without opening paths or decoding. */
export function validateMaterialAssets(
  version: MaterialVersion,
  assets: MaterialAssetMetadata[],
): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const original = byId.get(version.originalAssetId);
  const expected = new Set([version.originalAssetId]);
  let totalImageBytes = 0;
  for (const fragment of version.fragments) {
    if (fragment.kind !== 'image') continue;
    if (expected.has(fragment.assetId))
      throw new DomainError('MATERIAL_INVALID', '资料图像资产编号重复。');
    expected.add(fragment.assetId);
    const asset = byId.get(fragment.assetId);
    if (
      !asset ||
      fragment.assetId === version.originalAssetId ||
      asset.mime !== 'image/png' ||
      asset.sha256 !== fragment.sha256 ||
      asset.bytes < 1 ||
      asset.bytes > MATERIAL_IMAGE_LIMITS.outputBytes
    )
      throw new DomainError('MATERIAL_INVALID', '资料图像资产身份、大小或哈希无效。');
  }
  for (const asset of assets)
    if (asset.id !== version.originalAssetId) totalImageBytes += asset.bytes;
  if (
    !original ||
    original.mime !== MATERIAL_MIME[version.format] ||
    original.sha256 !== version.sha256 ||
    original.bytes !== version.bytes ||
    byId.size !== assets.length ||
    expected.size !== assets.length ||
    assets.some((asset) => !expected.has(asset.id)) ||
    totalImageBytes > MATERIAL_IMAGE_LIMITS.totalOutputBytes
  )
    throw new DomainError('MATERIAL_INVALID', '资料原文件或资产清单无效。');
}

/** Bounded immutable record lookup; inputs are private database identifiers, not filesystem paths. */
export function readStoredMaterial(db: DatabaseSync, id: string): StoredMaterial {
  const raw = db
    .prepare(`SELECT ${MATERIAL_COLUMNS}, payload FROM material_versions WHERE id=?`)
    .get(id);
  if (!raw) throw new DomainError('NOT_FOUND', '资料版本不存在。');
  const { payload, ...metadata } = raw;
  const version = materialVersionSchema.parse(JSON.parse(String(payload)));
  const record = materialRecordSchema.parse(metadata);
  if (record.id !== version.id || record.importHash !== materialImportHash(record.name, version))
    throw new DomainError('BACKUP_INVALID', '资料身份与版本不一致。');
  return { record, version };
}

/** Strict database validation also runs before migration/backup; no unknown or orphaned asset links. */
export function validateMaterialRecords(db: DatabaseSync): void {
  try {
    if (
      Number(db.prepare('SELECT COUNT(*) AS count FROM material_versions').get()?.count) >
      MAX_MATERIAL_VERSIONS
    )
      throw new Error('Material quota');
    const owned = new Set<string>();
    for (const row of db
      .prepare('SELECT id, length(CAST(payload AS BLOB)) AS bytes FROM material_versions')
      .all()) {
      if (Number(row.bytes) > MAX_MATERIAL_PAYLOAD_BYTES) throw new Error('Material size');
      const { version } = readStoredMaterial(db, String(row.id));
      const assets = db
        .prepare(
          `SELECT a.id, a.bytes, a.sha256, m.mime FROM material_assets m JOIN assets a ON a.id=m.asset_id WHERE m.source_version_id=?`,
        )
        .all(version.id);
      const metadata = assets.map((asset) => ({
        id: String(asset.id),
        bytes: Number(asset.bytes),
        sha256: String(asset.sha256),
        mime: String(asset.mime),
      }));
      validateMaterialAssets(version, metadata);
      for (const asset of metadata) {
        if (owned.has(asset.id)) throw new Error('Shared asset ownership');
        owned.add(asset.id);
      }
    }
    if (
      owned.size !==
      Number(db.prepare('SELECT COUNT(*) AS count FROM material_assets').get()?.count)
    )
      throw new Error('Orphaned material asset');
  } catch {
    throw new DomainError('BACKUP_INVALID', '资料版本或资产来源无效，已拒绝打开。');
  }
}
