import { nodeBundleOptions } from './node-bundle-options.ts';
import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { resolve } from 'node:path';
import './patch-pdfjs.mjs';

await bundle(
  nodeBundleOptions({
    entryPoints: [
      'src/main/main.ts',
      'src/main/preload.ts',
      'src/main/worker.ts',
      'src/main/material-process.ts',
      'src/main/office-process.ts',
      'src/main/classroom-preload.ts',
      'src/main/mcp-stdio.ts',
    ],
    outdir: 'dist/main',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron', 'sharp', 'pdfjs-dist', '@napi-rs/canvas'],
    sourcemap: true,
  }),
);
await viteBuild({
  root: resolve('src/renderer'),
  base: './',
  build: {
    outDir: resolve('dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve('src/renderer/index.html'),
        classroom: resolve('src/renderer/classroom.html'),
      },
    },
  },
});
