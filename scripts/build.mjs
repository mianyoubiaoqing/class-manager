import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { resolve } from 'node:path';

await bundle({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts', 'src/main/worker.ts'],
  outdir: 'dist/main',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
});
await viteBuild({
  root: resolve('src/renderer'),
  base: './',
  build: { outDir: resolve('dist/renderer'), emptyOutDir: true },
});
