import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { DomainError } from '../core/errors';
import { LESSON_LIMITS } from '../shared/lessons';
import { materialPreviewInput } from '../shared/material-records';
import {
  folderReadInput,
  folderScanInput,
  type FolderInventory,
  type FolderReadReceipt,
} from '../shared/material-folders';
import type { MaterialImporter } from './material-importer';
import { assertLocalScorePath } from './local-score-path';

/** Native directory selection grants a bounded, local inventory. Renderer receives opaque IDs. */
export class MaterialFolders {
  private root?: string;
  private inventory?: {
    epoch: string;
    value: FolderInventory;
    files: Map<string, { path: string; fingerprint: string }>;
  };
  private task?: { epoch: string; cancelled: boolean };
  private scanning = false;
  constructor(
    private readonly importer: MaterialImporter,
    private readonly currentEpoch: () => Promise<string>,
  ) {}
  get busy() {
    return Boolean(this.task) || this.scanning;
  }
  invalidate() {
    if (this.task) {
      this.task.cancelled = true;
      this.importer.cancel({ epoch: this.task.epoch });
    }
    this.inventory = undefined;
    this.root = undefined;
  }
  cancel(raw: unknown) {
    const { epoch } = materialPreviewInput.parse(raw);
    if (this.task?.epoch === epoch) {
      this.task.cancelled = true;
      this.importer.cancel({ epoch });
    }
  }
  private async checkEpoch(epoch: string) {
    if ((await this.currentEpoch()) !== epoch)
      throw new DomainError('STALE_WORKSPACE', '工作区已变化，请重新读取文件夹。');
  }
  private async fingerprint(path: string, root: string) {
    await assertLocalScorePath(path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new DomainError('MATERIAL_INVALID', '资料不是普通本地文件。');
    const resolved = await realpath(path);
    if (!resolved.startsWith(root + sep))
      throw new DomainError('MATERIAL_INVALID', '资料不在所选文件夹内。');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }
  async scan(raw: unknown, choose: () => Promise<string | null>): Promise<FolderInventory | null> {
    const input = folderScanInput.parse(raw);
    if (this.busy || this.importer.busy || this.importer.hasPreview)
      throw new DomainError('BUSY', '请先保存或取消当前资料预览。');
    this.scanning = true;
    try {
      await this.checkEpoch(input.epoch);
      if (input.remove) {
        this.root = undefined;
        this.inventory = undefined;
        return null;
      }
      const chosen = input.choose ? await choose() : this.root;
      if (!chosen) return null;
      await assertLocalScorePath(chosen);
      if ((await lstat(chosen)).isSymbolicLink())
        throw new DomainError('MATERIAL_INVALID', '请选择普通本地目录。');
      const root = await realpath(chosen);
      const value: FolderInventory = {
        token: randomUUID(),
        folderName: basename(root),
        scannedAt: new Date().toISOString(),
        includeChildren: input.includeChildren,
        entries: [],
        warnings: [],
      };
      const files = new Map<string, { path: string; fingerprint: string }>();
      let directories = 0;
      const visit = async (directory: string, depth: number) => {
        if (++directories > 200 || depth > 8) {
          value.warnings.push('部分子目录超出扫描范围，请单独选择该目录。');
          return;
        }
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        for (const entry of entries) {
          if (value.entries.length >= 500) {
            value.warnings.push('最多列出 500 份资料，请缩小文件夹范围。');
            return;
          }
          const path = join(directory, entry.name);
          try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
              if (input.includeChildren) await visit(path, depth + 1);
              continue;
            }
            if (!stat.isFile()) continue;
            const fingerprint = await this.fingerprint(path, root);
            const supported = ['.txt', '.docx', '.pdf', '.png', '.jpg', '.jpeg'].includes(
              extname(path).toLowerCase(),
            );
            const id = randomUUID();
            const status = !supported
              ? 'unsupported'
              : !stat.size
                ? 'empty'
                : stat.size > LESSON_LIMITS.fileBytes
                  ? 'tooLarge'
                  : 'ready';
            value.entries.push({ id, name: relative(root, path), bytes: stat.size, status });
            if (status === 'ready') files.set(id, { path, fingerprint });
          } catch {
            value.warnings.push(`无法读取：${relative(root, path)}`);
          }
        }
      };
      await visit(root, 0);
      await this.checkEpoch(input.epoch);
      this.root = root;
      this.inventory = { epoch: input.epoch, value, files };
      value.warnings = [...new Set(value.warnings)].slice(0, 20);
      return value;
    } finally {
      this.scanning = false;
    }
  }
  async read(raw: unknown): Promise<FolderReadReceipt> {
    const input = folderReadInput.parse(raw);
    if (this.busy || this.importer.busy || this.importer.hasPreview)
      throw new DomainError('BUSY', '请先保存或取消当前资料预览。');
    const inventory = this.inventory;
    const root = this.root;
    if (
      !inventory ||
      !root ||
      inventory.epoch !== input.epoch ||
      inventory.value.token !== input.token ||
      input.ids.some((id) => !inventory.files.has(id))
    )
      throw new DomainError('MATERIAL_EXPIRED', '文件清单已失效，请重新扫描并选择。');
    const task = { epoch: input.epoch, cancelled: false };
    this.task = task;
    const receipt: FolderReadReceipt = { cancelled: false, files: [] };
    try {
      await this.checkEpoch(input.epoch);
      for (const id of input.ids) {
        if (task.cancelled) break;
        const file = inventory.files.get(id)!;
        const name = inventory.value.entries.find((entry) => entry.id === id)!.name;
        try {
          if ((await this.fingerprint(file.path, root)) !== file.fingerprint)
            throw new DomainError('MATERIAL_INVALID', '文件已变化，请重新扫描。');
          const preview = await this.importer.preview(
            { epoch: input.epoch },
            async () => file.path,
          );
          if (!preview || task.cancelled) break;
          if ((await this.fingerprint(file.path, root)) !== file.fingerprint)
            throw new DomainError('MATERIAL_INVALID', '读取时文件发生变化，请重新扫描。');
          const result = await this.importer.confirm({
            epoch: input.epoch,
            token: preview.token,
            requestId: randomUUID(),
          });
          if (!result.ok) throw new DomainError(result.error.code, result.error.message);
          receipt.files.push({ name, id: result.value.id });
          inventory.files.delete(id);
        } catch (error) {
          if (error instanceof DomainError && error.code === 'STALE_WORKSPACE') throw error;
          if (task.cancelled) break;
          this.importer.cancel({ epoch: input.epoch });
          receipt.files.push({
            name,
            error:
              error instanceof DomainError ? error.message : '文件无法读取，请检查权限或重新选择。',
          });
        }
      }
      receipt.cancelled = task.cancelled;
      return receipt;
    } finally {
      this.importer.cancel({ epoch: input.epoch });
      if (this.task === task) this.task = undefined;
    }
  }
}
