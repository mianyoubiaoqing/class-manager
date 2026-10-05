import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 直接执行验收脚本中的安装守卫和终态发布代码，不启动应用、不运行安装器或付费调用。
const stabilitySource = readFileSync('scripts/release-stability-smoke.mjs', 'utf8');
const installationSource = readFileSync('scripts/release-installation-smoke.mjs', 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const report = { status: 'running', externalRequests: 0, installerRuns: 0, cases: [] };
const commandLine = installationSource
  .split('\n')
  .find((line) => line.trim().startsWith('"try { $ErrorActionPreference='));
assert.ok(commandLine, 'Missing actual installation guard');
const guard = JSON.parse(commandLine.trim().replace(/,$/, ''));
const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
for (const [name, body, expected] of [
  ['no-running-application', '', 0],
  ['running-application-refused', '[pscustomobject]@{ ProcessId=123 }', 12],
  ['nonterminating-query-error-refused', "Write-Error 'Synthetic process query failure'", 13],
  ['throwing-query-error-refused', "throw 'Synthetic process query failure'", 13],
]) {
  const prelude = `function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string]$Filter); ${body} }; `;
  const result = spawnSync(powershell, ['-NoProfile', '-Command', prelude + guard], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stdout + result.stderr);
  report.cases.push({ name, exitCode: result.status });
}
const start = stabilitySource.indexOf("  await call('deleteModelProviderKey'");
assert.ok(start > 0, 'Missing actual stability finalization');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const finalize = new AsyncFunction(
  'report',
  'call',
  'closeAuditApplication',
  'save',
  'record',
  'page',
  'console',
  'app',
  'root',
  'try {\n' + stabilitySource.slice(start),
);
for (const [name, callFails, closeFails] of [
  ['successful-close-before-passed', false, false],
  ['close-failure-persists-failed', false, true],
  ['operation-and-cleanup-failure-persists-failed', true, true],
]) {
  const value = { status: 'running' };
  const snapshots = [];
  let closed = false;
  let closeCalls = 0;
  let failure;
  try {
    await finalize(
      value,
      async () => {
        if (callFails) throw Error('Synthetic operation failure');
      },
      async () => {
        closeCalls++;
        if (closeFails) throw Error('Synthetic close failure');
        closed = true;
      },
      () => {
        if (value.status === 'passed') assert.equal(closed, true);
        snapshots.push(structuredClone(value));
      },
      () => {},
      undefined,
      { log() {} },
      {},
      'synthetic-finalization',
    );
  } catch (error) {
    failure = String(error);
  }
  assert.equal(closeCalls, 1);
  assert.equal(value.status, closeFails || callFails ? 'failed' : 'passed');
  assert.equal(snapshots.at(-1).status, value.status);
  assert.equal(Boolean(failure), closeFails || callFails);
  if (closeFails)
    assert.equal(
      snapshots.some((item) => item.status === 'passed'),
      false,
    );
  else assert.equal(value.shutdownVerified, true);
  report.cases.push({ name, status: value.status, closed, closeCalls, snapshots });
}
report.status = 'passed';
report.sources = { stability: hash(stabilitySource), installation: hash(installationSource) };
writeFileSync(
  process.env.CLASS_MANAGER_RELEASE_GUARDS_REPORT ?? 'output/15-guards-report.json',
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ status: report.status, cases: report.cases.length }));
