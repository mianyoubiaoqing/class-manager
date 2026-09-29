import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = [];
function collect(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile()) paths.push(path);
  }
}
for (const directory of ['src', 'tests', 'scripts', 'docs', '.scratch/initial-release/issues'])
  collect(directory);
paths.push(
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.gitignore',
  'README.md',
  'CONTEXT.md',
);
const files = paths.sort().map((path) => {
  const bytes = readFileSync(join(root, path));
  return {
    path: relative(root, join(root, path)).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
});
const createdAt = new Date().toISOString();
const output = join(root, 'output', 'm0-baseline');
mkdirSync(output, { recursive: true });
const archive = gzipSync(Buffer.from(JSON.stringify({ version: 1, createdAt, files })));
// A future implementer must not silently replace the baseline used by the reviewer.
writeFileSync(join(output, 'source.json.gz'), archive, { flag: 'wx' });
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      createdAt,
      archiveSha256: createHash('sha256').update(archive).digest('hex'),
      files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(`Frozen ${files.length} files in ${output}`);
