const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const manifest = JSON.parse(fs.readFileSync('output/18-reviewed-package-manifest.json'));
const [script, ...args] = process.argv.slice(2);
if (!script) throw Error('Expected test script');
for (const field of ['CONVERSATION', 'PACKAGED', 'PROVIDERS', 'DEVICES']) process.env[`CLASS_MANAGER_${field}_EXECUTABLE`] = manifest.executable;
if (script.endsWith('desktop-smoke.mjs')) {
  fs.mkdirSync('output/playwright/agent18-general-packaged', { recursive: true });
  process.env.CLASS_MANAGER_DESKTOP_OUTPUT = fs.mkdtempSync(path.resolve('output/playwright/agent18-general-packaged/run-'));
}
const result = cp.spawnSync(process.execPath, [script, ...args], { env: process.env, stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
