import { nodeBundleOptions } from './node-bundle-options.ts';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import electronPath from 'electron';

const output = resolve('output/material-runtime');
mkdirSync(output, { recursive: true });
const run = mkdtempSync(join(output, 'run-'));
const script = join(run, 'check.cjs');
await build(
  nodeBundleOptions({
    entryPoints: ['tests/fixtures/material-runtime.ts'],
    outfile: script,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
  }),
);
const executablePath = process.env.CLASS_MANAGER_MATERIAL_RUNTIME ?? electronPath;
const result = spawnSync(executablePath, [script], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 75_000,
  windowsHide: true,
});
const report = { at: new Date().toISOString(), status: 'failed', executablePath, result: null };
if (result.status === 0) {
  report.result = JSON.parse(result.stdout.trim());
  if (report.result.status === 'passed') report.status = 'passed';
}
writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, evidence: join(run, 'report.json') }));
if (report.status !== 'passed') process.exitCode = 1;
