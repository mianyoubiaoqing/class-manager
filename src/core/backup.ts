import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assetSchema, type Snapshot } from '../shared/contracts';
import { openDatabase, validateDatabase } from './database';
import { DomainError } from './errors';
import { durableWrite, requireDirectory, requireRegularFile } from './files';
import { readSnapshot } from './snapshot';

import {
  MAX_BACKUP_BYTES,
  MAX_DATABASE_BYTES,
  MAX_ASSET_BYTES,
  MAX_ASSETS_BYTES,
  MAX_ASSETS,
  LEGACY_MAX_BACKUP_BYTES,
  LEGACY_MAX_ASSET_BYTES,
  LEGACY_MAX_ASSETS_BYTES,
  LEGACY_MAX_ASSETS,
} from './storage-limits';
import { materialVersionSchema } from '../shared/lessons';
import { matchesMaterialImage } from './material-records';
export { MAX_BACKUP_BYTES } from './storage-limits';
const limits = (version: number) =>
  version >= 6
    ? {
        file: MAX_ASSET_BYTES,
        total: MAX_ASSETS_BYTES,
        count: MAX_ASSETS,
        backup: MAX_BACKUP_BYTES,
      }
    : {
        file: LEGACY_MAX_ASSET_BYTES,
        total: LEGACY_MAX_ASSETS_BYTES,
        count: LEGACY_MAX_ASSETS,
        backup: LEGACY_MAX_BACKUP_BYTES,
      };
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
    version: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(12),
    ]),
    createdAt: z.iso.datetime(),
    database: payloadSchema,
    assets: z.array(assetSchema.extend({ base64: z.string() })).max(MAX_ASSETS),
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

/** Called before a workspace worker starts accepting commands. No restore/backup token
 * survives a restart. Only application-generated direct UUID directories are removed;
 * unknown names and links stay untouched, and workspace data is outside this boundary. */
export function recoverBackupStaging(root: string): void {
  const parent = join(root, 'staging');
  requireDirectory(root);
  requireDirectory(parent);
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!z.uuid().safeParse(entry.name).success || !entry.isDirectory() || entry.isSymbolicLink())
      continue;
    const directory = join(parent, entry.name);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    removeStaging(root, directory);
  }
}

export function validateAssets(directory: string, snapshot: Snapshot, db: DatabaseSync): void {
  requireDirectory(join(directory, 'assets'));
  const bound = limits(snapshot.schemaVersion);
  if (snapshot.assets.length > bound.count)
    throw new DomainError('BACKUP_INVALID', '附件数量超过对应版本上限。');
  const images = new Map<string, { width: number; height: number }>();
  if (snapshot.schemaVersion >= 6) {
    for (const row of db.prepare('SELECT payload FROM material_versions').all()) {
      const version = materialVersionSchema.parse(JSON.parse(String(row.payload)));
      for (const fragment of version.fragments)
        if (fragment.kind === 'image') images.set(fragment.assetId, fragment);
    }
  }
  let total = 0;
  for (const asset of snapshot.assets) {
    const path = join(directory, 'assets', `${asset.id}.bin`);
    requireRegularFile(path, bound.file);
    const bytes = readFileSync(path);
    total += bytes.length;
    const image = images.get(asset.id);
    const invalidImage = image && !matchesMaterialImage(bytes, image);
    if (
      invalidImage ||
      total > bound.total ||
      bytes.length !== asset.bytes ||
      hash(bytes) !== asset.sha256
    ) {
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
  validateDatabase(db);
  validateAssets(directory, snapshot, db);
  const temporary = join(root, 'staging', randomUUID());
  mkdirSync(temporary, { recursive: true });
  try {
    const snapshotPath = join(temporary, 'snapshot.sqlite');
    // 数据操作在单个工作线程内串行执行，取得快照期间附件不会被另一条命令修改。
    db.prepare('VACUUM INTO ?').run(snapshotPath);
    requireRegularFile(snapshotPath, MAX_DATABASE_BYTES);
    const bundle: BackupBundle = {
      format: 'class-manager-backup',
      version: bundleSchema.shape.version.parse(
        db.prepare('PRAGMA user_version').get()?.user_version,
      ),
      createdAt: new Date().toISOString(),
      database: payload(readFileSync(snapshotPath)),
      assets: snapshot.assets.map((asset) => ({
        ...asset,
        base64: readFileSync(join(directory, 'assets', `${asset.id}.bin`)).toString('base64'),
      })),
    };
    const bytes = Buffer.from(JSON.stringify(bundle), 'utf8');
    if (bytes.length > limits(bundle.version).backup)
      throw new DomainError('VALIDATION', '备份超过对应版本的大小上限。');
    return bytes;
  } finally {
    removeStaging(root, temporary);
  }
}

export function validateStaged(staged: StagedBackup): Snapshot & {
  examCount: number;
  scoreVersionCount: number;
  explanationDraftCount: number;
  seatingVersionCount: number;
  dutyVersionCount: number;
  materialVersionCount: number;
  lessonDraftCount: number;
  lessonVersionCount: number;
  teachingSessionCount: number;
  countdownCount: number;
  rubricVersionCount: number;
  gradingDraftCount: number;
  gradingReviewCount: number;
  gradingAttemptCount: number;
  gradingRevisionCount: number;
  gradingPublicationCount: number;
  growthEventCount: number;
  growthSummaryCount: number;
  growthEntryCount: number;
  attendanceCount: number;
  studentProfileCount: number;
} {
  requireDirectory(staged.directory);
  const path = join(staged.directory, 'data.sqlite');
  requireRegularFile(path, MAX_DATABASE_BYTES);
  const bytes = readFileSync(path);
  if (hash(bytes) !== staged.manifest.database.sha256)
    throw new DomainError('BACKUP_INVALID', '暂存数据库校验失败。');
  const db = openDatabase(path, 'readonly');
  try {
    const snapshot = readSnapshot(db, staged.token, staged.directory);
    if (snapshot.schemaVersion !== staged.manifest.version) {
      throw new DomainError('BACKUP_INVALID', '备份协议版本与数据库版本不一致。');
    }
    const canonical = (assets: Snapshot['assets']) =>
      JSON.stringify(
        assets
          .map(({ id, name, bytes: size, sha256 }) => ({ id, name, bytes: size, sha256 }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    if (canonical(snapshot.assets) !== canonical(staged.manifest.assets)) {
      throw new DomainError('BACKUP_INVALID', '备份清单与数据库附件引用不一致。');
    }
    validateAssets(staged.directory, snapshot, db);
    return {
      ...snapshot,
      examCount:
        snapshot.schemaVersion === 1
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM exams').get()?.count),
      scoreVersionCount:
        snapshot.schemaVersion === 1
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM score_versions').get()?.count),
      explanationDraftCount:
        snapshot.schemaVersion < 3
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM explanation_drafts').get()?.count),
      seatingVersionCount:
        snapshot.schemaVersion < 4
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM seating_versions').get()?.count),
      dutyVersionCount:
        snapshot.schemaVersion < 5
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM duty_versions').get()?.count),
      materialVersionCount:
        snapshot.schemaVersion < 6
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM material_versions').get()?.count),
      lessonDraftCount:
        snapshot.schemaVersion < 6
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM lesson_drafts').get()?.count),
      lessonVersionCount:
        snapshot.schemaVersion < 6
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM lesson_versions').get()?.count),
      teachingSessionCount:
        snapshot.schemaVersion < 7
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM teaching_sessions').get()?.count),
      countdownCount:
        snapshot.schemaVersion < 7
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM countdown_settings').get()?.count),
      rubricVersionCount:
        snapshot.schemaVersion < 8
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM rubric_versions').get()?.count),
      gradingDraftCount:
        snapshot.schemaVersion < 8
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM grading_drafts').get()?.count),
      gradingReviewCount:
        snapshot.schemaVersion < 8
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM grading_reviews').get()?.count),
      gradingAttemptCount:
        snapshot.schemaVersion < 8
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM grading_attempts').get()?.count),
      gradingRevisionCount:
        snapshot.schemaVersion < 8
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM grading_revisions').get()?.count),
      gradingPublicationCount:
        snapshot.schemaVersion < 9
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM grading_publications').get()?.count),
      growthEventCount:
        snapshot.schemaVersion < 10
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM growth_events').get()?.count),
      growthSummaryCount:
        snapshot.schemaVersion < 10
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM growth_summaries').get()?.count),
      growthEntryCount:
        snapshot.schemaVersion < 10
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM growth_summary_entries').get()?.count),
      attendanceCount:
        snapshot.schemaVersion < 12
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM attendance_records').get()?.count),
      studentProfileCount:
        snapshot.schemaVersion < 12
          ? 0
          : Number(db.prepare('SELECT COUNT(*) AS count FROM student_profiles').get()?.count),
    };
  } finally {
    db.close();
  }
}

export function stageBackup(root: string, bytes: Uint8Array, epoch: string): StagedBackup {
  if (bytes.byteLength > MAX_BACKUP_BYTES)
    throw new DomainError('BACKUP_INVALID', '备份超过 224 MiB 上限。');
  let manifest: BackupBundle;
  try {
    manifest = bundleSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    throw new DomainError('BACKUP_INVALID', '不是受支持的 M0 备份，或备份清单已损坏。');
  }
  const bound = limits(manifest.version);
  if (bytes.byteLength > bound.backup || manifest.assets.length > bound.count)
    throw new DomainError('BACKUP_INVALID', '备份超过对应版本的大小或附件数量上限。');
  if (new Set(manifest.assets.map((asset) => asset.id)).size !== manifest.assets.length) {
    throw new DomainError('BACKUP_INVALID', '备份含重复附件。');
  }
  const database = decode(manifest.database, MAX_DATABASE_BYTES);
  let total = 0;
  const assets = manifest.assets.map((asset) => {
    const data = decode(asset, bound.file);
    total += data.length;
    if (total > bound.total) throw new DomainError('BACKUP_INVALID', '附件总量超过上限。');
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
