// 诊断复现：只观察本次启动的独立验收安装器，在正式安装前停止。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'nsis19-bootstrap-'));
const evidence = mkdtempSync(resolve('output/nsis19-matrix-'));
const compiledProbe = join(evidence, 'probe.exe');
const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const compilation = spawnSync(
  compiler,
  [
    '/nologo',
    '/r:System.Drawing.dll',
    '/r:System.Web.Extensions.dll',
    '/out:' + compiledProbe,
    resolve('scripts/installer-wizard-probe.cs'),
  ],
  { encoding: 'utf8' },
);
if (compilation.status !== 0) throw Error(compilation.stdout + compilation.stderr);
const probe = join(root, 'probe.exe');
copyFileSync(compiledProbe, probe);
const source = resolve('output/installer19-isolated/Class-Manager-Agent18-Audit-Setup.exe');
const copy = join(root, 'Setup.exe');
copyFileSync(source, copy);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (hash(source) !== hash(copy)) throw Error('Copy identity mismatch');
const temp = join(root, 'temp');
mkdirSync(temp);
const results = [];
for (const [name, executable, environment] of [
  ['H-default-temp', source, {}],
  ['C-default-temp', copy, {}],
  ['C-fresh-temp', copy, { TEMP: temp, TMP: temp }],
  ['H-fresh-temp', source, { TEMP: temp, TMP: temp }],
]) {
  const output = join(evidence, name);
  mkdirSync(output);
  const result = spawnSync(
    probe,
    [executable, join(root, 'never-install'), output, '--bootstrap'],
    {
      env: { ...process.env, ...environment },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  const report = JSON.parse(readFileSync(join(output, 'wizard-report.json')));
  results.push({
    name,
    status: result.status,
    report,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  console.log(JSON.stringify({ name, status: report.status, error: report.error }));
}
writeFileSync(
  join(evidence, 'matrix.json'),
  JSON.stringify({ root, sha256: hash(source), results }, null, 2),
);
console.log(evidence);
