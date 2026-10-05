import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'check';
const pointer = path.resolve('output/current-application-tools-release.json');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let state;
if (mode === 'check') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  const label = `Agent-Context-Pupils-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
  fs.mkdirSync('output', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('output', label + '-'));
  state = { root, releaseLabel: label, release: path.resolve('release', path.basename(root)) };
  fs.writeFileSync(pointer, JSON.stringify(state, null, 2));
  const source = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        source.push({ file: path.resolve(file), sha256: hash(fs.readFileSync(file)) });
    }
  };
  for (const directory of ['src', 'scripts', 'tests']) visit(directory);
  for (const file of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.ts',
    'eslint.config.mjs',
    '.prettierrc.json',
  ])
    source.push({ file: path.resolve(file), sha256: hash(fs.readFileSync(file)) });
  fs.writeFileSync(
    path.join(root, 'source-manifest.json'),
    JSON.stringify({ ...state, source }, null, 2),
  );
} else state = JSON.parse(fs.readFileSync(pointer));
const source = JSON.parse(fs.readFileSync(path.join(state.root, 'source-manifest.json')));
function verifySource() {
  for (const file of source.source)
    assert.equal(hash(fs.readFileSync(file.file)), file.sha256, 'Source changed: ' + file.file);
}
verifySource();
const temp = path.join(state.root, 'check-temp');
fs.mkdirSync(temp, { recursive: true });
const env = { ...process.env, TEMP: temp, TMP: temp };
async function run(stage, args, extraEnv = {}) {
  verifySource();
  const log = path.join(state.root, stage + '.log');
  const output = fs.openSync(log, 'wx');
  const startedAt = new Date().toISOString();
  console.log(JSON.stringify({ stage, status: 'running', log }));
  const child = spawn('rtk', args, {
    env: { ...env, ...extraEnv },
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  fs.closeSync(output);
  const result = { stage, startedAt, completedAt: new Date().toISOString(), exitCode: code, log };
  fs.writeFileSync(path.join(state.root, stage + '-result.json'), JSON.stringify(result, null, 2), {
    flag: 'wx',
  });
  console.log(JSON.stringify(result));
  assert.equal(code, 0, 'Failed release gate: ' + stage);
  verifySource();
}
if (mode === 'check') await run('check', ['npm', 'run', 'check']);
else if (mode === 'package') {
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.root, 'check-result.json'))).exitCode, 0);
  assert.ok(!fs.existsSync(state.release));
  await run('package', [
    'proxy',
    'node',
    'node_modules/electron-builder/out/cli/cli.js',
    '--win',
    '--x64',
    '--dir',
    '-c.directories.output=' + state.release,
    '-c.electronDist=' + path.resolve('node_modules/electron/dist'),
  ]);
  // 沿用上一轮已验证的ASAR/依赖许可核对方法，独立保存新证据。
  const previous = fs.readFileSync(
    'output/ui-release-20261003-1506-fixed-ZdYjXz/verify-package.cjs',
    'utf8',
  );
  const script = previous
    .replace(
      "path.resolve('output/ui-release-20261003-1506-fixed-ZdYjXz')",
      'path.resolve(' + JSON.stringify(state.root) + ')',
    )
    .replace(
      "path.resolve('release/ui-release-20261003-1506-fixed-ZdYjXz/win-unpacked')",
      'path.resolve(' + JSON.stringify(path.join(state.release, 'win-unpacked')) + ')',
    )
    .replaceAll('UI-Updated-20261003-1506', state.releaseLabel);
  const file = path.join(state.root, 'verify-package.cjs');
  fs.writeFileSync(file, script, { flag: 'wx' });
  await run('verify-package', ['proxy', 'node', file]);
} else if (mode === 'desktop') {
  const packaged = JSON.parse(fs.readFileSync(path.join(state.root, 'package-manifest.json')));
  await run('sessions-desktop', ['proxy', 'node', 'scripts/conversation-sessions-smoke.mjs'], {
    CLASS_MANAGER_SESSIONS_EXECUTABLE: packaged.executable,
    CLASS_MANAGER_SESSIONS_REPORT: path.join(state.root, 'sessions-smoke-report.json'),
  });
  await run('conversation-desktop', ['proxy', 'node', 'scripts/conversation-ui-smoke.mjs'], {
    CLASS_MANAGER_CONVERSATION_EXECUTABLE: packaged.executable,
  });
  await run('general-desktop', ['proxy', 'node', 'scripts/desktop-smoke.mjs', '--packaged'], {
    CLASS_MANAGER_PACKAGED_EXECUTABLE: packaged.executable,
    CLASS_MANAGER_DESKTOP_OUTPUT: path.join(state.root, 'general-desktop'),
  });
  await run('actions-desktop', ['proxy', 'node', 'scripts/conversation-actions-smoke.mjs'], {
    CLASS_MANAGER_ACTION_RELEASE: pointer,
  });
  await run('pupils-desktop', ['proxy', 'node', 'scripts/pupils-ui-smoke.mjs'], {
    CLASS_MANAGER_PUPIL_EXECUTABLE: packaged.executable,
    CLASS_MANAGER_PUPIL_REPORT: path.join(state.root, 'pupil-smoke-report.json'),
  });
  await run('providers-desktop', ['proxy', 'node', 'scripts/providers-ui-smoke.mjs'], {
    CLASS_MANAGER_PROVIDERS_EXECUTABLE: packaged.executable,
    CLASS_MANAGER_PROVIDERS_REPORT: path.join(state.root, 'providers-smoke-report.json'),
  });
} else if (mode === 'installer') {
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state.root, 'providers-desktop-result.json'))).exitCode,
    0,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state.root, 'pupils-desktop-result.json'))).exitCode,
    0,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state.root, 'pupil-smoke-report.json'))).status,
    'passed',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state.root, 'sessions-desktop-result.json'))).exitCode,
    0,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state.root, 'actions-desktop-result.json'))).exitCode,
    0,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state.root, 'actions-smoke-report.json'))).status,
    'passed',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state.root, 'conversation-desktop-result.json'))).exitCode,
    0,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state.root, 'general-desktop-result.json'))).exitCode,
    0,
  );
  await run('installer', [
    'proxy',
    'node',
    'scripts/build-agent-installer.mjs',
    '--manifest',
    path.join(state.root, 'package-manifest.json'),
    '--output',
    path.join(state.release, 'installer'),
  ]);
  await run('installer-delivery', [
    'proxy',
    'node',
    'scripts/prepare-agent-installer-delivery.mjs',
    path.join(state.release, 'installer'),
  ]);
} else throw new Error('Unknown mode: ' + mode);
console.log(JSON.stringify(state));
