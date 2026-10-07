import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LESSON_LIMITS, type MaterialVersion } from '../shared/lessons';
import {
  materialConfirmInput,
  materialNameSchema,
  materialPreviewImageInput,
  materialPreviewInput,
  type MaterialPreview,
} from '../shared/material-records';
import { DomainError } from '../core/errors';
import { requireRegularFile } from '../core/files';
import type { ParsedMaterial } from '../core/material-parser';
import { assertLocalScorePath } from './local-score-path';
import type { MaterialTaskRunner } from './material-task';
import type { WorkerClient } from './worker-client';
import type { Result } from '../shared/contracts';

/** Paths come only from Main's native dialog. Bound reads even if a selected file grows. */
export async function readMaterialFile(path: string) {
  const format = extname(path).slice(1).toLowerCase();
  if (!['txt', 'docx', 'pdf', 'png', 'jpg', 'jpeg'].includes(format))
    throw new DomainError('MATERIAL_INVALID', '请选择 TXT、DOCX、PDF、PNG 或 JPG。');
  await assertLocalScorePath(path);
  requireRegularFile(path, LESSON_LIMITS.fileBytes);
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LESSON_LIMITS.fileBytes)
      throw new DomainError('MATERIAL_INVALID', '资料类型或大小无效。');
    const buffer = Buffer.alloc(LESSON_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (
      !length ||
      length > LESSON_LIMITS.fileBytes ||
      length !== stat.size ||
      fstatSync(fd).size !== length
    )
      throw new DomainError('MATERIAL_INVALID', '资料为空、超限或读取时发生变化。');
    return {
      name: materialNameSchema.parse(basename(path)),
      format: (format === 'jpeg' ? 'jpg' : format) as MaterialVersion['format'],
      bytes: Buffer.from(buffer.subarray(0, length)),
    };
  } finally {
    closeSync(fd);
  }
}

/** Main holds temporary parser bytes, never Renderer file paths or reconstructed source snapshots.
 * Preview and persistence are separate user actions; cancellation can stop dialog/decoder/commit. */
export class MaterialImporter {
  private pending?: {
    token: string;
    epoch: string;
    name: string;
    expiresAt: number;
    parsed: ParsedMaterial;
  };
  private active?: { epoch: string; controller: AbortController; cancellation: Int32Array };
  constructor(
    private readonly worker: Pick<WorkerClient, 'call'>,
    private readonly parser: Pick<MaterialTaskRunner, 'parse'>,
  ) {}
  get busy() {
    return this.active !== undefined;
  }
  get hasPreview() {
    return this.pending !== undefined;
  }
  invalidate() {
    this.pending = undefined;
    if (this.active) Atomics.compareExchange(this.active.cancellation, 0, 0, 1);
    this.active?.controller.abort();
  }
  cancel(raw: unknown) {
    const input = materialPreviewInput.parse(raw);
    if (this.pending?.epoch === input.epoch) this.pending = undefined;
    if (this.active?.epoch === input.epoch) this.invalidate();
  }
  async preview(
    raw: unknown,
    choose: () => Promise<string | null>,
  ): Promise<MaterialPreview | null> {
    const input = materialPreviewInput.parse(raw);
    if (this.active) throw new DomainError('BUSY', '资料处理尚未结束，请先取消或等待。');
    this.pending = undefined;
    const task = {
      epoch: input.epoch,
      controller: new AbortController(),
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
    };
    this.active = task;
    const current = () => {
      if (task.controller.signal.aborted)
        throw new DomainError('MATERIAL_CANCELLED', '资料导入已取消。');
    };
    try {
      const snapshot = await this.worker.call<{ epoch: string }>('snapshot');
      if (!snapshot.ok) throw new DomainError(snapshot.error.code, snapshot.error.message);
      if (snapshot.value.epoch !== input.epoch)
        throw new DomainError('STALE_WORKSPACE', '资料工作区已切换。');
      const path = await choose();
      current();
      if (!path) return null;
      const file = await readMaterialFile(path);
      current();
      const parsed = await this.parser.parse(file.bytes, file.format, task.controller.signal);
      current();
      const token = randomUUID();
      this.pending = {
        token,
        epoch: input.epoch,
        name: file.name,
        parsed,
        expiresAt: Date.now() + 15 * 60 * 1000,
      };
      return { token, name: file.name, version: parsed.version };
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }
  private previewRecord(epoch: string, token: string) {
    const pending = this.pending;
    if (
      !pending ||
      pending.epoch !== epoch ||
      pending.token !== token ||
      Date.now() >= pending.expiresAt
    )
      throw new DomainError('MATERIAL_EXPIRED', '资料预览已失效，请重新选择。');
    return pending;
  }
  previewImage(raw: unknown): string {
    const input = materialPreviewImageInput.parse(raw);
    const pending = this.previewRecord(input.epoch, input.token);
    const fragment = pending.parsed.version.fragments.find(
      (value) => value.id === input.fragmentId,
    );
    if (!fragment || fragment.kind !== 'image')
      throw new DomainError('NOT_FOUND', '预览图像片段不存在。');
    const asset = pending.parsed.assets.find((value) => value.id === fragment.assetId)!;
    return `data:image/png;base64,${asset.bytes.toString('base64')}`;
  }
  async confirm(raw: unknown): Promise<Result<{ id: string; replayed: boolean }>> {
    const input = materialConfirmInput.parse(raw);
    if (this.active) throw new DomainError('BUSY', '资料任务尚未结束。');
    const pending = this.previewRecord(input.epoch, input.token);
    const task = {
      epoch: input.epoch,
      controller: new AbortController(),
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
    };
    this.active = task;
    try {
      const result = await this.worker.call<{ id: string; replayed: boolean }>('storeMaterial', {
        cancellation: task.cancellation.buffer,
        command: {
          epoch: input.epoch,
          requestId: input.requestId,
          name: pending.name,
          parsed: pending.parsed,
        },
      });
      if (result.ok) this.pending = undefined;
      return result;
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }
}
