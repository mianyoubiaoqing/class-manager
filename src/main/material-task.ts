import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  gradingTransformSchema,
  gradingRectangleSchema,
  type GradingTransform,
  type GradingRectangle,
} from '../shared/grading';
import { gradingEffectiveCrop, gradingTransformHash } from '../core/grading-geometry';
import { DomainError } from '../core/errors';
import type { ParsedMaterial } from '../core/material-parser';
import {
  LESSON_LIMITS,
  LESSON_MODEL_IMAGE_LIMITS,
  MATERIAL_IMAGE_LIMITS,
  MATERIAL_MIME,
  materialVersionSchema,
  type MaterialVersion,
} from '../shared/lessons';

const modelImageSchema = z
  .object({
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .instanceof(Buffer)
      .refine((bytes) => bytes.length > 0 && bytes.length <= LESSON_MODEL_IMAGE_LIMITS.imageBytes),
    width: z.number().int().positive().max(LESSON_MODEL_IMAGE_LIMITS.edge),
    height: z.number().int().positive().max(LESSON_MODEL_IMAGE_LIMITS.edge),
    mime: z.literal('image/jpeg'),
  })
  .strict();
const replySchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      value: z.union([
        z
          .object({
            version: materialVersionSchema,
            assets: z
              .array(
                z
                  .object({ id: z.uuid(), mime: z.string().max(100), bytes: z.instanceof(Buffer) })
                  .strict(),
              )
              .min(1)
              .max(LESSON_LIMITS.sourceFragments + 1),
          })
          .strict(),
        modelImageSchema,
        modelImageSchema
          .extend({
            transformHash: z.string().regex(/^[a-f0-9]{64}$/),
            crop: gradingRectangleSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum(['MATERIAL_INVALID', 'MATERIAL_UNSUPPORTED']),
          message: z.string().min(1).max(500),
        })
        .strict(),
    })
    .strict(),
]);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface ModelImage {
  inputHash: string;
  bytes: Buffer;
  width: number;
  height: number;
  mime: 'image/jpeg';
}
export interface GradingImage extends ModelImage {
  transformHash: string;
  crop: GradingRectangle;
}
const failure = () =>
  new DomainError('MATERIAL_TASK_FAILED', '资料处理进程异常退出，未保存资料；可重新选择文件。');

/**
 * One bounded child process at a time, separate from Main and the database worker. Script/executable
 * are bundled, trusted configuration, never Renderer parameters. Cancellation/deadline kills the
 * decoder and waits for close before releasing the task slot; no retries or persistence. This is
 * process isolation, not an OS permission sandbox or a hard bound on native-library RSS.
 */
export class MaterialTaskRunner {
  private active?: { child: ChildProcess; cancel: () => void; done: Promise<void> };
  private closed = false;

  constructor(
    private readonly script: string,
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('Invalid material deadline');
  }

  async parse(
    bytes: Buffer,
    format: MaterialVersion['format'],
    signal?: AbortSignal,
  ): Promise<ParsedMaterial> {
    const value = await this.run(bytes, format, signal);
    if (!('version' in value)) throw failure();
    return value;
  }

  async modelImage(bytes: Buffer, signal?: AbortSignal): Promise<ModelImage> {
    const value = await this.run(bytes, 'model-image', signal);
    if ('version' in value || 'transformHash' in value) throw failure();
    return value;
  }

  /**
   * 后台传入登记尺寸与已确认的遮盖/裁剪/旋转，返回预览和外发共用的同一 JPEG 字节。
   * 绑定字节和命令指纹，拒绝跨任务或原图替代返回；不保存或发送，不自动重试。
   * 与导入共用独占子进程，取消/超时等待进程关闭；结构/解码/占用失败保留输入。
   */
  async gradingImage(bytes: Buffer, raw: unknown, signal?: AbortSignal): Promise<GradingImage> {
    const transform = gradingTransformSchema.parse(raw);
    const value = await this.run(bytes, 'grading-image', signal, transform);
    if ('version' in value || !('transformHash' in value)) throw failure();
    return value;
  }

  private async run(
    bytes: Buffer,
    format: MaterialVersion['format'] | 'model-image' | 'grading-image',
    signal?: AbortSignal,
    transform?: GradingTransform,
  ): Promise<ParsedMaterial | ModelImage | GradingImage> {
    if (this.closed) throw new DomainError('MATERIAL_TASK_CLOSED', '资料服务已关闭。');
    if (this.active)
      throw new DomainError('MATERIAL_TASK_BUSY', '已有资料正在解析，请等待或取消。');
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length >
        (format === 'model-image' || format === 'grading-image'
          ? MATERIAL_IMAGE_LIMITS.outputBytes
          : LESSON_LIMITS.fileBytes) ||
      !['txt', 'docx', 'jpg', 'png', 'pdf', 'model-image', 'grading-image'].includes(format)
    )
      throw new DomainError('MATERIAL_INVALID', '资料为空、格式不支持或超过 10 MiB。');
    if (signal?.aborted) throw new DomainError('MATERIAL_CANCELLED', '资料解析已取消。');
    const expectedHash = hash(bytes);
    const expectedBytes = bytes.length;
    // Do not inherit arbitrary model keys, developer NODE_OPTIONS or user-config paths.
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = fork(this.script, [], {
      execArgv: ['--max-old-space-size=256'],
      env,
      windowsHide: true,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let finishDone!: () => void;
    const done = new Promise<void>((resolve) => {
      finishDone = resolve;
    });
    return new Promise<ParsedMaterial | ModelImage | GradingImage>((resolve, reject) => {
      let result: ParsedMaterial | ModelImage | GradingImage | undefined;
      let error: Error | undefined;
      let received = false;
      const stop = (reason: Error) => {
        error ??= reason;
        child.kill();
      };
      const cancel = () => stop(new DomainError('MATERIAL_CANCELLED', '资料解析已取消。'));
      const timer = setTimeout(
        () => stop(new DomainError('MATERIAL_TIMEOUT', '资料解析超时，请拆分资料后重试。')),
        this.timeoutMs,
      );
      this.active = { child, cancel, done };
      signal?.addEventListener('abort', cancel, { once: true });
      child.on('message', (raw: unknown) => {
        if (error) return;
        if (received) {
          stop(failure());
          return;
        }
        received = true;
        const parsed = replySchema.safeParse(raw);
        if (!parsed.success) {
          stop(failure());
          return;
        }
        if (!parsed.data.ok) {
          error = new DomainError(parsed.data.error.code, parsed.data.error.message);
          return;
        }
        const value = parsed.data.value;
        if (format === 'model-image' || format === 'grading-image') {
          if (
            'version' in value ||
            value.inputHash !== expectedHash ||
            !value.bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
            !value.bytes.subarray(-2).equals(Buffer.from([255, 217]))
          ) {
            stop(failure());
            return;
          }
          if (format === 'grading-image') {
            if (
              !transform ||
              !('transformHash' in value) ||
              value.transformHash !== gradingTransformHash(expectedHash, transform) ||
              JSON.stringify(value.crop) !==
                JSON.stringify(
                  gradingEffectiveCrop(transform.page, transform.width, transform.height),
                )
            ) {
              stop(failure());
              return;
            }
          } else if ('transformHash' in value) {
            stop(failure());
            return;
          }
          result = value;
          return;
        }
        if (!('version' in value)) {
          stop(failure());
          return;
        }
        const { version, assets } = value;
        const byId = new Map(assets.map((asset) => [asset.id, asset]));
        const original = byId.get(version.originalAssetId);
        const imageIds = new Set(
          version.fragments.flatMap((fragment) =>
            fragment.kind === 'image' ? [fragment.assetId] : [],
          ),
        );
        if (
          version.format !== format ||
          version.sha256 !== expectedHash ||
          version.bytes !== expectedBytes ||
          !original ||
          original.mime !== MATERIAL_MIME[format] ||
          original.bytes.length !== expectedBytes ||
          byId.size !== assets.length ||
          assets.some((asset) => asset.bytes.length === 0) ||
          assets.some(
            (asset) =>
              asset.id !== original.id &&
              (!imageIds.has(asset.id) ||
                asset.mime !== 'image/png' ||
                asset.bytes.length > MATERIAL_IMAGE_LIMITS.outputBytes),
          ) ||
          assets.reduce((sum, asset) => sum + asset.bytes.length, 0) >
            expectedBytes + MATERIAL_IMAGE_LIMITS.totalOutputBytes
        ) {
          stop(failure());
          return;
        }
        const hashes = new Map(assets.map((asset) => [asset.id, hash(asset.bytes)]));
        if (
          hashes.get(original.id) !== expectedHash ||
          version.fragments.some(
            (fragment) =>
              fragment.kind === 'image' &&
              (!byId.has(fragment.assetId) ||
                fragment.assetId === original.id ||
                hashes.get(fragment.assetId) !== fragment.sha256),
          )
        ) {
          stop(failure());
          return;
        }
        result = value;
      });
      child.once('error', () => stop(failure()));
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.active = undefined;
        finishDone();
        if (error) reject(error);
        else if (code !== 0 || !result) reject(failure());
        else resolve(result);
      });
      child.send(
        format === 'grading-image'
          ? { bytes, operation: format, transform }
          : format === 'model-image'
            ? { bytes, operation: format }
            : { bytes, format },
        (sendError) => {
          if (sendError) stop(failure());
        },
      );
      if (signal?.aborted) cancel();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    active?.cancel();
    await active?.done;
  }
}
