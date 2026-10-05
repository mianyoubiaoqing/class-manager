import { closeSync, openSync, unlinkSync, fsyncSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

/** Reserve before checking reports or launching. Keep the file after a paid/ambiguous attempt. */
export function reservePaidAudit(path: string): () => void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (!released) {
      unlinkSync(path);
      released = true;
    }
  };
}

/** Flush a complete report before publishing it. A failed write/flush/rename keeps old evidence. */
export function writeAuditReport(
  path: string,
  value: unknown,
  options?: { sync?: (fd: number) => void; rename?: (source: string, destination: string) => void },
): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2));
      (options?.sync ?? fsyncSync)(fd);
    } finally {
      closeSync(fd);
    }
    (options?.rename ?? renameSync)(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Published or never created. */
    }
  }
}

export async function closeAuditApplication(
  application: { close(): Promise<void>; process(): ChildProcess } | undefined,
  cleanup: () => void,
): Promise<void> {
  try {
    if (!application) return;
    try {
      await application.close();
    } catch (error) {
      // Only this audit's owned child may be terminated, never an installed user instance.
      const child = application.process();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.removeListener('exit', exited);
            reject(
              new Error('Audit child did not exit; cleanup attempted but shutdown unverified'),
            );
          }, 5000);
          function exited() {
            clearTimeout(timer);
            resolve();
          }
          child.once('exit', exited);
          child.kill();
        });
      }
      throw error;
    }
  } finally {
    cleanup();
  }
}
