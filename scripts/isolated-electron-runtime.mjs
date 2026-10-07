import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Reuse an immutable test runtime; every launch still gets independent data and temp files. */
export function isolatedElectronRuntime(prefix) {
  const base = join(process.env.USERPROFILE, 'ClassManagerSetupChecks');
  mkdirSync(base, { recursive: true });
  const bundled = resolve('node_modules/electron/dist');
  const version = readFileSync(join(bundled, 'version'), 'utf8').trim();
  const cached = readdirSync(base)
    .map((name) => join(base, name, 'runtime'))
    .find((runtime) => {
      try {
        return (
          existsSync(join(runtime, 'electron.exe')) &&
          existsSync(join(runtime, 'resources/default_app.asar')) &&
          readFileSync(join(runtime, 'version'), 'utf8').trim() === version
        );
      } catch {
        return false;
      }
    });
  const local = mkdtempSync(join(base, prefix));
  const runtime = cached ?? join(local, 'runtime');
  if (!cached) cpSync(bundled, runtime, { recursive: true });
  mkdirSync(join(local, 'temp'));
  return { local, runtime, executablePath: join(runtime, 'electron.exe') };
}
