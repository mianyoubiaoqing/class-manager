const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
fs.mkdirSync('output/playwright/agent18-general-development', { recursive: true });
process.env.CLASS_MANAGER_DESKTOP_OUTPUT = fs.mkdtempSync(path.resolve('output/playwright/agent18-general-development/run-'));
const result = cp.spawnSync(process.execPath, ['scripts/desktop-smoke.mjs'], { env: process.env, stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
