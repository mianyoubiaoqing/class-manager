import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const source = resolve(process.argv[2] ?? 'release/ticket19-20261002-agent18-installer');
const manifest = JSON.parse(readFileSync(join(source, 'installer-manifest.json')));
assert.equal(manifest.appId, 'local.classmanager.desktop');
assert.equal(manifest.isolated, false);
assert.match(process.env.USERPROFILE ?? '', /^C:[\\/]/i);
// Packaged hosts can redirect LocalAppData into their private LocalCache.
// A user-profile folder gives Explorer the same physical path as this process.
const parent = join(process.env.USERPROFILE, 'ClassManagerInstallers');
mkdirSync(parent, { recursive: true });
const releaseLabel = manifest.releaseLabel ?? 'Agent18';
assert.match(releaseLabel, /^[A-Za-z0-9-]+$/);
const output = mkdtempSync(join(parent, `${releaseLabel}-Installer-`));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = [];
for (const artifact of manifest.installers) {
  const original = join(source, basename(artifact.file));
  assert.equal(hash(original), artifact.sha256);
  const target = join(output, basename(artifact.file));
  copyFileSync(original, target);
  assert.equal(hash(target), artifact.sha256);
  files.push({ file: target, sha256: artifact.sha256 });
}
for (const name of ['Install.cmd', 'SHA256SUMS.txt']) {
  const original = join(source, name),
    target = join(output, name);
  copyFileSync(original, target);
  assert.equal(hash(target), hash(original));
  files.push({ file: target, sha256: hash(target) });
}
const setup = files.find((file) => file.file.endsWith('.exe')).file;
writeFileSync(
  join(output, '安装说明.txt'),
  '\uFEFF' +
    [
      `Class Manager — ${releaseLabel} 安装向导`,
      '',
      '1. 保存并退出正在运行的 Class Manager。',
      '2. 双击本文件夹中的 ' + basename(setup) + '，按简体中文向导安装。',
      '3. 默认仅为当前用户安装，可更改目录。安装完成后从桌面或开始菜单启动，首页是业务对话。',
      '',
      '如果安装器位于其他位置后出现 NSIS 临时文件错误，请运行旁边的 Install.cmd。',
      '它会复制并核对安装器到当前用户的 C 盘目录，然后启动向导；保留 Install.cmd 与 ' +
        basename(setup) +
        ' 在同一文件夹，不要改名。',
      '本机 H 盘仓库中的 EXE 继承了低完整性标签，请使用此 C 盘副本。无需修改系统 TEMP 或目录权限。',
      '',
      '卸载保留业务资料；模型账号在安装后设置。',
    ].join('\r\n'),
  { flag: 'wx' },
);
const identity = { createdAt: new Date().toISOString(), source, output, setup, files };
writeFileSync(join(output, 'delivery-manifest.json'), JSON.stringify(identity, null, 2), {
  flag: 'wx',
});
console.log(JSON.stringify(identity));
