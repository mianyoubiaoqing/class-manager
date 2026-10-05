const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const [log, ...args] = process.argv.slice(2);
if (!log || !args.length) throw new Error('Expected log path and Node arguments');
const env = { ...process.env,
  ELECTRON_OVERRIDE_DIST_PATH: 'C:/Users/flow032417/AppData/Local/class-manager-electron-probe-qXAqES',
  TEMP: path.resolve('output/audit03-temp'), TMP: path.resolve('output/audit03-temp') };
const fd = fs.openSync(log, 'wx');
const npm = args[0] === '--npm';
const result = cp.spawnSync(npm ? 'npm.cmd' : process.execPath, npm ? args.slice(1) : args,
  { env, stdio: ['ignore', fd, fd], windowsHide: true, ...(npm ? { shell: true } : {}) });
fs.closeSync(fd);
console.log(JSON.stringify({ args, log, status: result.status, error: result.error?.message }));
process.exit(result.status ?? 1);
