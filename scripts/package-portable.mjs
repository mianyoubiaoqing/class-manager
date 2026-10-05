import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { extractFile, listPackage, statFile } from '@electron/asar';
import JSZip from 'jszip';
import { runPortableSmoke } from './portable-smoke.mjs';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
assert.equal(process.platform, 'win32', 'Portable release verification requires Windows.');
assert.match(process.env.USERPROFILE, /^C:[\\/]/i);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stamp = Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
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
const releaseLabel = `Portable-${stamp.year}${stamp.month}${stamp.day}-${stamp.hour}${stamp.minute}`;
const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
const label = `Class-Manager-${metadata.version}-${releaseLabel}-x64`;
const buildBase = path.join(process.env.USERPROFILE, 'ClassManagerPortableBuilds');
const deliveryBase = path.join(process.env.USERPROFILE, 'ClassManagerDeliveries');
const evidenceBase = path.resolve('output/playwright/portable');
for (const directory of [buildBase, deliveryBase, evidenceBase])
  await fs.mkdir(directory, { recursive: true });
const root = await fs.mkdtemp(path.join(evidenceBase, releaseLabel + '-'));
const buildRoot = await fs.mkdtemp(path.join(buildBase, releaseLabel + '-'));
const delivery = await fs.mkdtemp(path.join(deliveryBase, releaseLabel + '-'));
const temp = path.join(buildRoot, 'temp');
await fs.mkdir(temp);
async function inventory(directory, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    assert.ok(entry.isFile() || entry.isDirectory(), 'Unsupported filesystem entry: ' + file);
    if (entry.isDirectory()) files.push(...(await inventory(directory, file)));
    else {
      const bytes = await fs.readFile(path.join(directory, file));
      files.push({ file, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
const source = [];
for (const directory of ['src', 'scripts', 'tests'])
  for (const file of await inventory(directory))
    source.push({ ...file, file: path.join(directory, file.file) });
for (const file of [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'eslint.config.mjs',
  '.prettierrc.json',
  'docs/handoff/portable-release.md',
])
  source.push({ file, sha256: hash(await fs.readFile(file)) });
async function verifySource() {
  for (const item of source)
    assert.equal(
      hash(await fs.readFile(item.file)),
      item.sha256,
      'Source changed during packaging: ' + item.file,
    );
}
const report = {
  status: 'running',
  startedAt: new Date().toISOString(),
  version: metadata.version,
  releaseLabel,
  root,
  buildRoot,
  delivery,
  source,
  stages: [],
  validation: { fullTestSuiteRerun: false, existingInstallationModified: false },
};
const save = () =>
  fs.writeFile(path.join(root, 'release-report.json'), JSON.stringify(report, null, 2));
async function run(stage, args) {
  await verifySource();
  console.log(JSON.stringify({ stage, status: 'running', root }));
  const child = spawn('rtk', args, {
    env: { ...process.env, TEMP: temp, TMP: temp },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await fs.writeFile(path.join(root, stage + '.log'), output, { flag: 'wx' });
  report.stages.push({ stage, exitCode });
  await save();
  assert.equal(exitCode, 0, stage + ': ' + output);
  await verifySource();
  console.log(JSON.stringify({ stage, status: 'passed' }));
}
try {
  await save();
  await run('build', ['npm', 'run', 'build']);
  const packagedRoot = path.join(buildRoot, 'package');
  await run('package', [
    'proxy',
    'node',
    'node_modules/electron-builder/out/cli/cli.js',
    '--win',
    '--x64',
    '--dir',
    '-c.directories.output=' + packagedRoot,
    '-c.electronDist=' + path.resolve('node_modules/electron/dist'),
  ]);
  const program = path.join(packagedRoot, 'win-unpacked');
  const archive = path.join(program, 'resources/app.asar');
  const dist = await inventory('dist');
  for (const file of dist) {
    assert.equal(
      hash(extractFile(archive, path.join('dist', file.file))),
      file.sha256,
      'Packaged dist mismatch: ' + file.file,
    );
    if (/\.(html|js)$/i.test(file.file)) {
      const text = await fs.readFile(path.join('dist', file.file), 'utf8');
      for (const marker of [
        'Browser-Virtual-Storage',
        'preview-epoch-01',
        '[Class Manager Web Preview]',
        'Web Preview API Call',
      ])
        assert.ok(!text.includes(marker), 'Browser preview adapter in production: ' + file.file);
    }
  }
  const packedMetadata = JSON.parse(extractFile(archive, 'package.json'));
  for (const field of ['name', 'version', 'main', 'dependencies'])
    assert.deepEqual(packedMetadata[field], metadata[field]);
  const entries = listPackage(archive).map((file) => file.replaceAll('\\', '/').replace(/^\//, ''));
  const noticesArgument = process.argv.indexOf('--notices');
  if (noticesArgument >= 0)
    assert.ok(process.argv[noticesArgument + 1], '--notices needs a reviewed notice directory');
  const noticesSource = path.resolve(
    noticesArgument >= 0
      ? process.argv[noticesArgument + 1]
      : 'output/release-audit18-reviewed/third-party-notices-reviewed',
  );
  const reviewed = JSON.parse(await fs.readFile(path.join(noticesSource, 'packages.json')));
  const runtime = entries
    .filter((file) => file.includes('node_modules/') && file.endsWith('/package.json'))
    .map((file) => {
      const item = JSON.parse(extractFile(archive, file.replaceAll('/', path.sep)));
      return { name: item.name, version: item.version, packagePath: path.posix.dirname(file) };
    })
    .filter((item) => item.name && item.version);
  assert.equal(
    runtime.length,
    reviewed.length,
    'Reviewed dependency inventory differs from packaged inventory',
  );
  for (const item of runtime) {
    const notice = reviewed.find(
      (file) =>
        file.name === item.name &&
        file.version === item.version &&
        file.packagePath === item.packagePath,
    );
    assert.ok(
      notice?.notices?.length,
      'Reviewed notice missing for exact package version: ' + item.name,
    );
    for (const file of notice.notices)
      assert.equal(hash(await fs.readFile(path.join(noticesSource, file.file))), file.sha256);
  }
  for (const file of entries.filter((file) => /\.(cjs|js|json|map|html|css|md|txt)$/i.test(file))) {
    const stat = statFile(archive, file.replaceAll('/', path.sep), false);
    if ('files' in stat || 'link' in stat) continue;
    assert.ok(
      !/\bsk-[A-Za-z0-9_-]{20,}\b/.test(
        extractFile(archive, file.replaceAll('/', path.sep)).toString('utf8'),
      ),
      'Credential-shaped content in package; value omitted',
    );
  }
  await fs.cp(noticesSource, path.join(program, 'third-party-notices'), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const addText = (file, text) =>
    fs.writeFile(path.join(program, file), '\uFEFF' + text.replace(/\r?\n/g, '\r\n'), {
      flag: 'wx',
    });
  await addText(
    '先读我-免安装使用说明.txt',
    `Class Manager ${metadata.version} / ${releaseLabel} / Windows x64
1. 将整个 ZIP 完整解压到本机 C 盘普通文件夹，例如 C:\\ClassManager。不要在压缩包内直接运行，也不要只复制 EXE。
2. 首次使用或切换版本前，保存并退出正在运行的 Class Manager。
3. 双击文件夹内的 Class Manager.exe。无需运行安装向导或安装 Node.js，不会自动创建桌面/开始菜单快捷方式。
4. 也可右键 Class Manager.exe，在 Windows 的更多选项中手动发送到桌面快捷方式。
5. 数据默认保存在当前 Windows 用户的应用数据目录；程序目录内不保存业务数据库。删除或更换程序目录不会迁移或删除业务数据。
6. 同一电脑、同一 Windows 用户、默认配置下，与安装版复用 Class Manager 数据。先备份再切换，两个版本不能同时操作同一数据。切换时如旧窗口被唤起，请退出旧版本后再启动新版本。
7. 升级：旧版应用内备份 → 保存并退出 → 将新包解压到另一个文件夹 → 启动新 EXE。不要覆盖正在使用的程序目录。数据库升级后不要直接用旧版本打开。
8. 换电脑：使用“数据与维护”导出 .cmbackup，再在新电脑的免安装版本预览并确认恢复；模型账号/密钥须在新电脑重新设置。
9. 首次运行若系统显示安全提示，先核对来源及随包哈希；本包尚未添加代码签名。不要禁用系统保护。
10. 本版是程序免安装，数据不随 U 盘目录移动。先使用本机普通可写目录；网络共享、只读目录和 exFAT U 盘未作为本版验收范围。
本包包含完整 Electron 运行时和依赖许可，不包含客户数据库、模型凭据、WPS/Office 或开发工具。
备份恢复、导出及模型设置沿用应用内功能。模型服务需要网络；Word/PPTX 生成不要求安装 Office，打开和展示文件需本机兼容软件。
`,
  );
  const guide = await fs.readFile('docs/handoff/portable-release.md', 'utf8');
  await addText('免安装版本说明.md', guide);
  const files = await inventory(program);
  assert.ok(files.some((file) => file.file === 'Class Manager.exe'));
  assert.ok(
    !files.some((file) =>
      /(?:^|[\\/])(?:Setup|Install|Uninstall).*\.(?:exe|cmd)$/i.test(file.file),
    ),
  );
  assert.ok(!files.some((file) => /\.(?:sqlite(?:-[\w]+)?|cmbackup)$/i.test(file.file)));
  report.asarHash = hash(await fs.readFile(archive));
  report.inventory = {
    packages: runtime.length,
    notices: reviewed.reduce((count, item) => count + item.notices.length, 0),
    unresolved: [],
  };
  const content = new Map(files.map((file) => [file.file.replaceAll('\\', '/'), file]));
  const publicManifest = {
    schemaVersion: 1,
    version: metadata.version,
    releaseLabel,
    platform: 'Windows x64',
    entrypoint: 'Class Manager.exe',
    distribution: 'extracted-directory',
    userData: 'current Windows user / Class Manager',
    asarHash: report.asarHash,
    inventory: report.inventory,
    files: [...content.values()].map((file) => ({
      ...file,
      file: file.file.replaceAll('\\', '/'),
    })),
  };
  const zip = new JSZip();
  for (const [file] of content)
    zip.file(label + '/' + file, await fs.readFile(path.join(program, file)), {
      compression: 'DEFLATE',
    });
  const manifestBytes = Buffer.from(JSON.stringify(publicManifest, null, 2) + '\n');
  zip.file(label + '/delivery-manifest.json', manifestBytes);
  const sums = [...content].map(([file, item]) => item.sha256 + '  ' + file);
  sums.push(hash(manifestBytes) + '  delivery-manifest.json');
  zip.file(label + '/SHA256SUMS.txt', sums.join('\r\n') + '\r\n');
  const zipFile = path.join(delivery, label + '-Portable.zip');
  console.log(JSON.stringify({ stage: 'zip', status: 'running', files: content.size }));
  await fs.writeFile(
    zipFile,
    await zip.generateAsync({
      type: 'nodebuffer',
      platform: 'DOS',
      compressionOptions: { level: 6 },
    }),
    { flag: 'wx' },
  );
  const zipBytes = await fs.readFile(zipFile);
  const reopened = await JSZip.loadAsync(zipBytes, { checkCRC32: true });
  assert.equal(Object.values(reopened.files).filter((file) => !file.dir).length, content.size + 2);
  const extracted = path.join(buildRoot, '免安装 验证', label);
  for (const entry of Object.values(reopened.files).filter((file) => !file.dir)) {
    const relative = entry.name.slice(label.length + 1);
    assert.ok(entry.name.startsWith(label + '/'));
    const target = path.resolve(extracted, relative);
    assert.ok(
      target.startsWith(path.resolve(extracted) + path.sep),
      'ZIP path outside extraction directory',
    );
    const bytes = await entry.async('nodebuffer');
    if (content.has(relative)) assert.equal(hash(bytes), content.get(relative).sha256, relative);
    else if (relative === 'delivery-manifest.json') assert.equal(hash(bytes), hash(manifestBytes));
    else assert.equal(bytes.toString(), sums.join('\r\n') + '\r\n');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  report.zip = zipFile;
  report.bytes = zipBytes.length;
  report.sha256 = hash(zipBytes);
  report.crcVerified = true;
  report.allFileHashesVerified = true;
  report.executable = path.join(extracted, 'Class Manager.exe');
  await save();
  console.log(
    JSON.stringify({ stage: 'portable-smoke', status: 'running', executable: report.executable }),
  );
  const smoke = await runPortableSmoke(report.executable, path.join(root, 'smoke'));
  assert.equal(smoke.status, 'passed');
  await verifySource();
  report.gates = smoke.gates;
  report.smokeReport = path.join(root, 'smoke/portable-smoke-report.json');
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  await save();
  await fs.copyFile(
    path.join(root, 'release-report.json'),
    path.join(delivery, 'release-report.json'),
  );
  await fs.writeFile(zipFile + '.sha256', `${report.sha256}  ${path.basename(zipFile)}\r\n`, {
    flag: 'wx',
  });
  await fs.writeFile(
    'output/current-portable-delivery.json',
    JSON.stringify({ ...report, source: undefined }, null, 2),
  );
  console.log(JSON.stringify({ ...report, source: undefined }, null, 2));
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  report.completedAt = new Date().toISOString();
  await save();
  throw error;
}
