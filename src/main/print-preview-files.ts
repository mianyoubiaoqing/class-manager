import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { durableWrite } from '../core/files';
import { DomainError } from '../core/errors';

const ownedName = /^preview-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const marker = 'class-manager-seating-preview-v1';
function prepareRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new DomainError('VALIDATION', '打印缓存目录不是受支持的本地目录。');
}
function ownedDirectory(root: string, name: string): string | undefined {
  if (!ownedName.test(name)) return;
  const directory = join(root, name);
  try {
    const info = lstatSync(directory);
    const metadata = lstatSync(join(directory, 'owner.txt'));
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 100
    )
      return;
    if (readFileSync(join(directory, 'owner.txt'), 'utf8') !== marker) return;
    return directory;
  } catch {
    return;
  }
}
export function countPrintPreviewResidues(root: string): number {
  prepareRoot(root);
  return readdirSync(root).filter((name) => ownedDirectory(root, name)).length;
}

/** Nonrecursive cleanup of a marked child only. Unknown files and symlinks are never deleted. */
export async function removePrintPreview(
  root: string,
  name: string,
  remove: (path: string) => void = unlinkSync,
  removeDirectory: (path: string) => void = rmdirSync,
): Promise<boolean> {
  prepareRoot(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    const directory = ownedDirectory(root, name);
    if (!directory) return false;
    try {
      const children = readdirSync(directory);
      if (children.some((child) => child !== 'owner.txt' && child !== 'preview.html')) return false;
      if (children.includes('preview.html')) {
        const info = lstatSync(join(directory, 'preview.html'));
        if (!info.isFile() || info.isSymbolicLink()) return false;
        remove(join(directory, 'preview.html'));
      }
      remove(join(directory, 'owner.txt'));
      removeDirectory(directory);
      return true;
    } catch {
      // If only the final rmdir failed, restore ownership before the next retry/startup.
      // Never overwrite a marker or add one to a directory containing unknown files.
      try {
        const info = lstatSync(directory);
        if (info.isDirectory() && !info.isSymbolicLink() && readdirSync(directory).length === 0)
          durableWrite(join(directory, 'owner.txt'), marker);
      } catch {
        /* Preserve the original cleanup failure if ownership cannot be restored. */
      }
      if (attempt < 2) await setTimeout(25 * (attempt + 1));
    }
  }
  return false;
}

/** Call at startup before opening previews; never scan the user's general temporary directory. */
export async function recoverPrintPreviews(root: string): Promise<number> {
  prepareRoot(root);
  for (const name of readdirSync(root))
    if (ownedDirectory(root, name)) await removePrintPreview(root, name);
  return countPrintPreviewResidues(root);
}

export async function createPrintPreviewFile(root: string, html: string) {
  const priorResidues = await recoverPrintPreviews(root);
  const name = `preview-${randomUUID()}`;
  const directory = join(root, name);
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'preview.html');
  try {
    // The durable marker precedes private labels, allowing recovery after interrupted writes.
    durableWrite(join(directory, 'owner.txt'), marker);
    durableWrite(path, html);
    return { path, directory, priorResidues, cleanup: () => removePrintPreview(root, name) };
  } catch (error) {
    await removePrintPreview(root, name);
    throw error;
  }
}
