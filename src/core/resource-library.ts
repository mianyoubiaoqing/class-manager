import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  resourceReadInput,
  resourceSaveInput,
  resourceSection,
  resourceTemplate,
  type ResourceDocument,
} from '../shared/resource-library';
import { DomainError } from './errors';
import { transaction } from './database';
import {
  resourceAttachmentInput,
  resourceLinkSaveInput,
  resourceFileExtensions,
  type ResourceAttachment,
} from '../shared/resource-library';
import { durableWrite, requireRegularFile } from './files';
import { MAX_ASSET_BYTES, MAX_ASSETS_BYTES, MAX_ASSETS } from './storage-limits';
export const resourceSchemaStatements = [
  `CREATE TABLE resource_documents (course_key TEXT NOT NULL, resource_type TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=200000), updated_at TEXT NOT NULL, PRIMARY KEY(course_key,resource_type))`,
  `CREATE TABLE resource_revisions (request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=210000))`,
  `CREATE TABLE resource_attachments (id TEXT PRIMARY KEY, course_key TEXT NOT NULL, resource_type TEXT NOT NULL, name TEXT NOT NULL, asset_id TEXT REFERENCES assets(id), url TEXT, active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, CHECK((asset_id IS NULL)!=(url IS NULL)))`,
];
const documentSchema = z
  .object({
    key: resourceReadInput.shape.key,
    type: resourceReadInput.shape.type,
    revision: z.number().int().positive(),
    body: z.string().max(50000),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name === basename(name) &&
      !/[<>:"/\\|?*]/.test(name) &&
      !Array.from(name).some((c) => c.charCodeAt(0) < 32) &&
      !/[. ]$/.test(name) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name) &&
      resourceFileExtensions.includes(extname(name).slice(1).toLowerCase()),
  );
export function validateResourceLibrary(db: DatabaseSync) {
  for (const row of db.prepare('SELECT * FROM resource_attachments').all()) {
    resourceReadInput.parse({ epoch: randomUUID(), key: row.course_key, type: row.resource_type });
    resourceSection(String(row.course_key));
    z.uuid().parse(row.id);
    z.string().min(1).max(255).parse(row.name);
    z.iso.datetime().parse(row.created_at);
    if (row.asset_id !== null) {
      fileNameSchema.parse(row.name);
      z.uuid().parse(row.asset_id);
      const asset = db.prepare('SELECT name FROM assets WHERE id=?').get(String(row.asset_id));
      if (
        !asset ||
        asset.name !== row.name ||
        !resourceFileExtensions.includes(extname(String(row.name)).slice(1).toLowerCase())
      )
        throw new DomainError('BACKUP_INVALID', '教材附件无效。');
    } else resourceLinkSaveInput.shape.url.parse(row.url);
  }
  for (const row of db.prepare('SELECT * FROM resource_documents').all()) {
    const doc = documentSchema.parse({
      key: row.course_key,
      type: row.resource_type,
      revision: row.revision,
      body: row.body,
      updatedAt: row.updated_at,
    });
    resourceSection(doc.key);
    if (
      !db
        .prepare(
          "SELECT request_id FROM resource_revisions WHERE json_extract(payload,'$.key')=? AND json_extract(payload,'$.type')=? AND json_extract(payload,'$.revision')=? AND json_extract(payload,'$.body')=?",
        )
        .get(doc.key, doc.type, doc.revision, doc.body)
    )
      throw new DomainError('BACKUP_INVALID', '备课资源与保存记录不一致。');
  }
  for (const row of db.prepare('SELECT * FROM resource_revisions').all()) {
    z.uuid().parse(row.request_id);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(row.input_hash);
    const doc = documentSchema.parse(JSON.parse(String(row.payload)));
    resourceSection(doc.key);
    const current = db
      .prepare('SELECT revision FROM resource_documents WHERE course_key=? AND resource_type=?')
      .get(doc.key, doc.type);
    if (!current || Number(current.revision) < doc.revision)
      throw new DomainError('BACKUP_INVALID', '备课资源保存记录无效。');
  }
}
export class ResourceLibrary {
  constructor(
    private readonly db: DatabaseSync,
    private readonly epoch: () => string,
    private readonly directory: () => string,
  ) {}
  listFiles(raw: unknown): ResourceAttachment[] {
    const input = resourceReadInput.parse(raw);
    this.guard(input.epoch, input.key);
    return this.db
      .prepare(
        'SELECT r.*,a.bytes FROM resource_attachments r LEFT JOIN assets a ON a.id=r.asset_id WHERE r.course_key=? AND r.resource_type=? AND r.active=1 ORDER BY r.created_at,r.id',
      )
      .all(input.key, input.type)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        bytes: Number(row.bytes ?? 0),
        url: row.url === null ? null : String(row.url),
        createdAt: String(row.created_at),
      }));
  }
  addLink(raw: unknown): ResourceAttachment {
    const input = resourceLinkSaveInput.parse(raw);
    this.guard(input.epoch, input.key);
    this.fileQuota();
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO resource_attachments VALUES (?,?,?,?,NULL,?,1,?)')
      .run(id, input.key, input.type, input.name, input.url, createdAt);
    return { id, name: input.name, bytes: 0, url: input.url, createdAt };
  }
  private fileQuota() {
    if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM resource_attachments').get()?.n) >= 2000)
      throw new DomainError('STORAGE_LIMIT', '教材附件记录已达上限，请先备份资料。');
  }
  storeFile(raw: unknown): ResourceAttachment {
    const input = resourceReadInput
      .extend({ name: z.string().min(1).max(255), bytes: z.instanceof(Uint8Array) })
      .parse(raw);
    this.guard(input.epoch, input.key);
    if (
      !fileNameSchema.safeParse(input.name).success ||
      !resourceFileExtensions.includes(extname(input.name).slice(1).toLowerCase()) ||
      !input.bytes.length ||
      input.bytes.length > MAX_ASSET_BYTES
    )
      throw new DomainError('VALIDATION', '请选择支持的普通教学文件，单份不超过 32 MiB。');
    const hash = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.db
      .prepare(
        'SELECT r.id FROM resource_attachments r JOIN assets a ON a.id=r.asset_id WHERE course_key=? AND resource_type=? AND r.name=? AND a.sha256=? AND active=1',
      )
      .get(input.key, input.type, input.name, hash);
    if (existing)
      return this.listFiles({ epoch: input.epoch, key: input.key, type: input.type }).find(
        (f) => f.id === existing.id,
      )!;
    this.fileQuota();
    const quota = this.db
      .prepare('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM assets')
      .get()!;
    if (
      Number(quota.n) >= MAX_ASSETS ||
      Number(quota.bytes) + input.bytes.length > MAX_ASSETS_BYTES
    )
      throw new DomainError('STORAGE_LIMIT', '附件存储已达上限，请先备份资料。');
    const id = randomUUID(),
      assetId = randomUUID(),
      createdAt = new Date().toISOString(),
      path = join(this.directory(), 'assets', `${assetId}.bin`);
    durableWrite(path, input.bytes);
    try {
      transaction(this.db, () => {
        this.db
          .prepare('INSERT INTO assets VALUES (?,?,?,?)')
          .run(assetId, input.name, input.bytes.length, hash);
        this.db
          .prepare('INSERT INTO resource_attachments VALUES (?,?,?,?,?,NULL,1,?)')
          .run(id, input.key, input.type, input.name, assetId, createdAt);
      });
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    return { id, name: input.name, bytes: input.bytes.length, url: null, createdAt };
  }
  removeFile(raw: unknown): void {
    const input = resourceAttachmentInput.parse(raw);
    this.guard(input.epoch, input.key);
    this.db
      .prepare(
        'UPDATE resource_attachments SET active=0 WHERE id=? AND course_key=? AND resource_type=?',
      )
      .run(input.id, input.key, input.type);
  }
  readFile(raw: unknown): { id: string; name: string; url: string | null; bytes?: Uint8Array } {
    const input = resourceAttachmentInput.parse(raw);
    this.guard(input.epoch, input.key);
    const row = this.db
      .prepare(
        'SELECT r.*,a.bytes,a.sha256 FROM resource_attachments r LEFT JOIN assets a ON a.id=r.asset_id WHERE r.id=? AND r.course_key=? AND r.resource_type=? AND r.active=1',
      )
      .get(input.id, input.key, input.type);
    if (!row) throw new DomainError('NOT_FOUND', '教材附件已移除，请刷新列表。');
    if (row.url !== null)
      return {
        id: input.id,
        name: String(row.name),
        url: resourceLinkSaveInput.shape.url.parse(row.url),
      };
    const path = join(this.directory(), 'assets', `${row.asset_id}.bin`);
    requireRegularFile(path, MAX_ASSET_BYTES);
    const bytes = readFileSync(path);
    if (
      bytes.length !== row.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== row.sha256
    )
      throw new DomainError('BACKUP_INVALID', '附件校验失败，请从备份恢复。');
    return { id: input.id, name: String(row.name), url: null, bytes };
  }
  private guard(epoch: string, key: string) {
    if (epoch !== this.epoch())
      throw new DomainError('STALE_WORKSPACE', '资料已恢复或切换，请重新打开教材章节。');
    resourceSection(key);
  }
  read(raw: unknown): ResourceDocument {
    const input = resourceReadInput.parse(raw);
    this.guard(input.epoch, input.key);
    const row = this.db
      .prepare('SELECT * FROM resource_documents WHERE course_key=? AND resource_type=?')
      .get(input.key, input.type);
    return row
      ? documentSchema.parse({
          key: row.course_key,
          type: row.resource_type,
          revision: row.revision,
          body: row.body,
          updatedAt: row.updated_at,
        })
      : {
          key: input.key,
          type: input.type,
          revision: 0,
          body: resourceTemplate(input.key, input.type),
          updatedAt: null,
        };
  }
  save(raw: unknown): ResourceDocument {
    const input = resourceSaveInput.parse(raw);
    this.guard(input.epoch, input.key);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(this.db, () => {
      const replay = this.db
        .prepare('SELECT input_hash,payload FROM resource_revisions WHERE request_id=?')
        .get(input.requestId);
      if (replay) {
        if (replay.input_hash !== hash)
          throw new DomainError('IDEMPOTENCY_CONFLICT', '请求编号已用于其他内容。');
        return documentSchema.parse(JSON.parse(String(replay.payload)));
      }
      const old = this.read({ epoch: input.epoch, key: input.key, type: input.type });
      if (old.revision !== input.expectedRevision)
        throw new DomainError('REVISION_CONFLICT', '资源已修改，请重新读取后核对版本。');
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM resource_revisions').get()?.n) >= 5000)
        throw new DomainError('STORAGE_LIMIT', '备课资源历史已达上限，请先备份。');
      if (
        Number(
          this.db
            .prepare(
              'SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM resource_revisions',
            )
            .get()?.n,
        ) +
          Buffer.byteLength(JSON.stringify(input), 'utf8') >
        8 * 1024 * 1024
      )
        throw new DomainError('STORAGE_LIMIT', '备课资源保存历史已达容量上限，请先备份。');
      const doc = {
        key: input.key,
        type: input.type,
        body: input.body,
        revision: old.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), old.updatedAt ? Date.parse(old.updatedAt) : 0),
        ).toISOString(),
      };
      this.db
        .prepare(
          'INSERT INTO resource_documents VALUES (?,?,?,?,?) ON CONFLICT(course_key,resource_type) DO UPDATE SET revision=excluded.revision,body=excluded.body,updated_at=excluded.updated_at',
        )
        .run(doc.key, doc.type, doc.revision, doc.body, doc.updatedAt);
      this.db
        .prepare('INSERT INTO resource_revisions VALUES (?,?,?)')
        .run(input.requestId, hash, JSON.stringify(doc));
      return doc;
    });
  }
}
