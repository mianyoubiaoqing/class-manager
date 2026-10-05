import { nodeBundleOptions } from './node-bundle-options.ts';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

// Synthetic originals and parsed page PNGs are saved together for direct visual comparison.
const root = resolve('output/pdf/material08');
mkdirSync(root, { recursive: true });
await build(
  nodeBundleOptions({
    stdin: {
      contents: `export { syntheticPdf } from './tests/fixtures/material-pdf'; export { parseMaterial } from './src/core/material-parser';`,
      resolveDir: process.cwd(),
      sourcefile: 'pdf-visual.ts',
    },
    outfile: join(root, 'parse.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
  }),
);
const require = createRequire(import.meta.url);
const { syntheticPdf, parseMaterial } = require(join(root, 'parse.cjs'));
const scan = {
  width: 3,
  height: 2,
  bytes: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0]),
};
const bytes = syntheticPdf([
  { text: 'Synthetic text and scan', width: 300, image: scan },
  { image: scan },
  { text: 'Final source page' },
]);
writeFileSync(join(root, 'synthetic-original.pdf'), bytes);
const parsed = await parseMaterial(bytes, 'pdf');
for (const fragment of parsed.version.fragments) {
  if (fragment.kind !== 'image') continue;
  writeFileSync(
    join(root, `page-${fragment.locator.index}.png`),
    parsed.assets.find((asset) => asset.id === fragment.assetId).bytes,
  );
}
writeFileSync(
  join(root, 'report.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      version: parsed.version,
      original: join(root, 'synthetic-original.pdf'),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ output: root, pages: 3, completeness: parsed.version.completeness }));
