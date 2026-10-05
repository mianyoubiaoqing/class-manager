import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { LESSON_LIMITS, MATERIAL_IMAGE_LIMITS, materialVersionSchema } from '../shared/lessons';
import {
  materialAssetReadInput,
  materialListInput,
  materialNameSchema,
  materialReadInput,
  type MaterialSummary,
} from '../shared/material-records';
import { transaction } from './database';
import { DomainError } from './errors';
import { durableWrite, requireRegularFile } from './files';
import {
  materialImportHash,
  readStoredMaterial,
  validateMaterialAssets,
  matchesMaterialImage,
} from './material-records';
import {
  MAX_ASSETS,
  MAX_ASSETS_BYTES,
  MAX_MATERIAL_PAYLOAD_BYTES,
  MAX_MATERIAL_VERSIONS,
} from './storage-limits';

const storeInput = z
  .object({
    epoch: z.uuid(),
    requestId: z.uuid(),
    name: materialNameSchema,
    parsed: z
      .object({
        version: materialVersionSchema,
        assets: z
          .array(
            z
              .object({
                id: z.uuid(),
                mime: z.string().max(100),
                bytes: z
                  .instanceof(Uint8Array)
                  .refine(
                    (bytes) =>
                      bytes.length > 0 && bytes.length <= MATERIAL_IMAGE_LIMITS.outputBytes,
                  ),
              })
              .strict(),
          )
          .min(1)
          .max(LESSON_LIMITS.sourceFragments + 1),
      })
      .strict(),
  })
  .strict();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type MaterialCheckpoint = (stage: 'assets-written' | 'stored' | 'committed') => void;

/** Immutable materials share the registered backup asset store; no decoding or networking here. */
export class MaterialBook {
  private alive = true;
  constructor(
    private readonly db: DatabaseSync,
    private readonly epoch: () => string,
    private readonly directory: () => string,
    private readonly checkpoint?: MaterialCheckpoint,
  ) {}
  private guard(epoch: string) {
    if (!this.alive || epoch !== this.epoch())
      throw new DomainError('STALE_WORKSPACE', '资料工作区已切换，请重新选择文件。');
  }
  dispose() {
    this.alive = false;
  }

  /** Internal worker command only. Store validated parser bytes atomically; never accept Renderer
   * source snapshots. Same request/content replays; changed content conflicts. Failed file writes
   * leave only unregistered immutable files, reusable on an exact retry. No automatic retry. */
  store(raw: unknown, admitCommit?: () => void) {
    const input = storeInput.parse(raw);
    this.guard(input.epoch);
    const { version, assets } = input.parsed;
    const importHash = materialImportHash(input.name, version);
    const existing = this.db
      .prepare('SELECT id FROM material_versions WHERE import_request_id=?')
      .get(input.requestId);
    if (existing) {
      const stored = readStoredMaterial(this.db, String(existing.id));
      if (stored.record.importHash !== importHash)
        throw new DomainError('CONFLICT', '资料请求编号已用于其他内容。');
      // Revalidate supplied bytes even on replay so bad IPC data cannot claim successful acceptance.
      validateMaterialAssets(
        version,
        assets.map((asset) => ({ ...asset, bytes: asset.bytes.length, sha256: hash(asset.bytes) })),
      );
      return { id: stored.record.id, replayed: true };
    }
    validateMaterialAssets(
      version,
      assets.map((asset) => ({ ...asset, bytes: asset.bytes.length, sha256: hash(asset.bytes) })),
    );
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    for (const fragment of version.fragments) {
      if (fragment.kind !== 'image') continue;
      const bytes = Buffer.from(byId.get(fragment.assetId)!.bytes);
      if (!matchesMaterialImage(bytes, fragment))
        throw new DomainError('MATERIAL_INVALID', '资料图像尺寸与资产不一致。');
    }
    const payload = JSON.stringify(version);
    if (Buffer.byteLength(payload) > MAX_MATERIAL_PAYLOAD_BYTES)
      throw new DomainError('MATERIAL_LIMIT', '资料版本超过 1 MiB 保存上限。');
    transaction(this.db, () => {
      const count = Number(
        this.db.prepare('SELECT COUNT(*) AS count FROM material_versions').get()?.count,
      );
      const quota = this.db
        .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM assets')
        .get()!;
      if (
        count >= MAX_MATERIAL_VERSIONS ||
        Number(quota.count) + assets.length > MAX_ASSETS ||
        Number(quota.bytes) + assets.reduce((sum, asset) => sum + asset.bytes.length, 0) >
          MAX_ASSETS_BYTES
      )
        throw new DomainError('MATERIAL_LIMIT', '资料或附件存储达到上限，请先备份并联系维护者。');
      if (assets.some((asset) => this.db.prepare('SELECT id FROM assets WHERE id=?').get(asset.id)))
        throw new DomainError('CONFLICT', '资料资产编号已被登记。');
      for (const asset of assets) {
        const path = join(this.directory(), 'assets', `${asset.id}.bin`);
        if (existsSync(path)) {
          requireRegularFile(path, MATERIAL_IMAGE_LIMITS.outputBytes);
          if (hash(readFileSync(path)) !== hash(asset.bytes))
            throw new DomainError('CONFLICT', '同名资料暂存内容不一致。');
        } else durableWrite(path, asset.bytes);
      }
      this.checkpoint?.('assets-written');
      this.db
        .prepare('INSERT INTO material_versions VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          version.id,
          input.name,
          new Date().toISOString(),
          input.requestId,
          importHash,
          payload,
        );
      for (const asset of assets) {
        this.db
          .prepare('INSERT INTO assets VALUES (?, ?, ?, ?)')
          .run(
            asset.id,
            asset.id === version.originalAssetId ? input.name : '资料页面或内嵌图.png',
            asset.bytes.length,
            hash(asset.bytes),
          );
        this.db
          .prepare('INSERT INTO material_assets VALUES (?, ?, ?)')
          .run(asset.id, version.id, asset.mime);
      }
      this.checkpoint?.('stored');
      admitCommit?.();
    });
    this.checkpoint?.('committed');
    return { id: version.id, replayed: false };
  }

  /** Bounded public record lookup; an immutable version is valid across later imports. */
  read(raw: unknown) {
    const input = materialReadInput.parse(raw);
    this.guard(input.epoch);
    return readStoredMaterial(this.db, input.id);
  }
  /** At most 500 shallow summaries; no file bytes, credentials or private system paths. */
  list(raw: unknown): MaterialSummary[] {
    const input = materialListInput.parse(raw);
    this.guard(input.epoch);
    return this.db
      .prepare('SELECT id FROM material_versions ORDER BY created_at DESC, id')
      .all()
      .map((row) => {
        const stored = readStoredMaterial(this.db, String(row.id));
        return {
          record: stored.record,
          format: stored.version.format,
          fragments: stored.version.fragments.length,
          completeness: stored.version.completeness,
        };
      });
  }
  /** Internal asset resolver for a selected version. Only its owned UUIDs are readable; verify hash
   * on each bounded read. Main decides original comparison and approved model/media exposure. */
  readAsset(raw: unknown) {
    const input = materialAssetReadInput.parse(raw);
    this.guard(input.epoch);
    const asset = this.db
      .prepare(
        'SELECT a.bytes, a.sha256, m.mime FROM material_assets m JOIN assets a ON a.id=m.asset_id WHERE m.source_version_id=? AND m.asset_id=?',
      )
      .get(input.id, input.assetId);
    if (!asset) throw new DomainError('NOT_FOUND', '该资料不包含此资产。');
    const path = join(this.directory(), 'assets', `${input.assetId}.bin`);
    requireRegularFile(path, MATERIAL_IMAGE_LIMITS.outputBytes);
    const bytes = readFileSync(path);
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256)
      throw new DomainError('BACKUP_INVALID', '资料资产损坏，已拒绝读取。');
    return { mime: String(asset.mime), bytes };
  }
}
