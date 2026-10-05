import { nodeBundleOptions } from './node-bundle-options.ts';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electronPath from 'electron';
const output = resolve('output/lesson-runtime');
mkdirSync(output, { recursive: true });
const run = mkdtempSync(join(output, 'run-'));
const script = join(run, 'check.cjs');
await build(
  nodeBundleOptions({
    entryPoints: ['tests/fixtures/lesson-runtime.ts'],
    outfile: script,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
  }),
);
const executablePath = process.env.CLASS_MANAGER_LESSON_RUNTIME ?? electronPath;
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
