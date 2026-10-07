import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
const buildBase = process.env.CLASS_MANAGER_PORTABLE_BUILD_ROOT
  ? path.resolve(process.env.CLASS_MANAGER_PORTABLE_BUILD_ROOT)
  : path.join(process.env.USERPROFILE, 'ClassManagerPortableBuilds');
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
for (const directory of ['src', 'scripts', 'tests', 'tools', 'docs'])
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
  'docs/handoff/current-delivery-notes.md',
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
async function run(stage, args, extraEnv = {}) {
  await verifySource();
  console.log(JSON.stringify({ stage, status: 'running', root }));
  const child = spawn('rtk', args, {
    env: { ...process.env, TEMP: temp, TMP: temp, ...extraEnv },
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
  const runtimeEntries = await fs.readdir(program);
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
  for (const folder of ['使用说明', '比赛材料', '开发资料', '诊断记录'])
    await fs.mkdir(path.join(program, folder));
  await fs.cp(noticesSource, path.join(program, '开发资料', '第三方许可'), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const addText = (file, text) =>
    fs.writeFile(path.join(program, file), '\uFEFF' + text.replace(/\r?\n/g, '\r\n'), {
      flag: 'wx',
    });
  await addText(
    '先读我.txt',
    `班级助手 / Windows x64
1. 先退出旧版，将整个 ZIP 完整解压到本机普通文件夹。
2. 双击“启动工作台.cmd”，无需安装 Node.js 或配置开发环境。
3. 新建班级，点击“导入资料”，核对名单与成绩后确认保存。
4. 第一次使用请看“使用说明”中的“07_快速上手.docx”。

使用说明：教师操作与安装说明。
比赛材料：项目说明、开发与应用报告、演示视频脚本。
开发资料：完整源码、维护文档、版本说明与第三方许可。
诊断记录：历史测试范围及验收记录。
程序：完整运行文件，请保留整个目录。

升级前请在应用内导出备份，再退出旧版。数据保存在当前 Windows 用户的应用数据目录；更换程序目录不会清空业务数据，换电脑请使用备份恢复。模型凭据由交付人员配置，不包含在本包中。
`,
  );
  await fs.writeFile(
    path.join(program, '启动工作台.cmd'),
    '@echo off\r\nchcp 65001 >nul\r\nstart "" /D "%~dp0程序" "%~dp0程序\\Class Manager.exe" %*\r\nexit /b\r\n',
    { flag: 'wx' },
  );
  const guide = await fs.readFile('docs/handoff/portable-release.md', 'utf8');
  await addText('诊断记录/免安装版本说明.md', guide);
  await addText(
    '诊断记录/本地压力测试记录.md',
    await fs.readFile('docs/handoff/ui-stress-20261007.md', 'utf8'),
  );
  await addText(
    '诊断记录/客户操作卡点诊断.md',
    await fs.readFile('docs/handoff/customer-friction-20261007.md', 'utf8'),
  );
  await addText(
    '诊断记录/Computer Use 全流程验收记录.md',
    await fs.readFile('docs/handoff/computer-use-20261007.md', 'utf8'),
  );
  await addText(
    '诊断记录/教师工作台简化验收记录.md',
    await fs.readFile('docs/handoff/teacher-workspace-20261007.md', 'utf8'),
  );
  const documents = JSON.parse(
    await fs.readFile('output/docx-delivery-20261006/conversion-manifest.json', 'utf8'),
  );
  for (const item of documents) {
    assert.equal(
      hash(await fs.readFile(item.source)),
      item.sourceSha256,
      'DOCX source changed: ' + item.source,
    );
    const bytes = await fs.readFile(path.join('output/docx-delivery-20261006', item.docx));
    assert.equal(hash(bytes), item.sha256, 'DOCX hash changed: ' + item.docx);
    const folder = /^(02|03|07)_/.test(item.docx)
      ? '使用说明'
      : /^(01|05|06)_/.test(item.docx)
        ? '比赛材料'
        : '开发资料';
    await fs.writeFile(path.join(program, folder, item.docx), bytes, { flag: 'wx' });
  }
  assert.equal(documents.length, 8, 'Expected original six manuals and two current guides');
  const git = spawnSync(
    'rtk',
    ['proxy', 'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(git.status, 0, 'Cannot inventory source');
  const sourceZip = new JSZip();
  const sourceManifest = [];
  const sourceFiles = [...new Set(git.stdout.toString('utf8').split('\0').filter(Boolean))]
    .filter(
      (file) =>
        /^(?:src|scripts|tests|tools|docs)\//.test(file) ||
        [
          'package.json',
          'package-lock.json',
          'tsconfig.json',
          'vitest.config.ts',
          'eslint.config.mjs',
          '.prettierrc.json',
          '.gitignore',
          'README.md',
          'CONTEXT.md',
        ].includes(file),
    )
    .sort();
  for (const file of sourceFiles) {
    assert.ok(!(await fs.lstat(file)).isSymbolicLink(), 'Unsupported source link');
    assert.ok(
      !/(?:^|\/)(?:credentials|conversation-history|workspace-data|node_modules)(?:\/|$)|\.cmbackup$|\.env(?:\.|$)/i.test(
        file,
      ),
      'Private source file',
    );
    if (/\.sqlite(?:-|$)/i.test(file))
      assert.ok(
        ['tests/fixtures/frozen-v7.sqlite', 'tests/fixtures/frozen-v6-lessons.sqlite'].includes(
          file,
        ),
        'Unexpected source database',
      );
    const bytes = await fs.readFile(file);
    sourceZip.file('class-manager/' + file, bytes);
    sourceManifest.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  const sourceBytes = await sourceZip.generateAsync({
    type: 'nodebuffer',
    platform: 'DOS',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const sourceRead = await JSZip.loadAsync(sourceBytes, { checkCRC32: true });
  for (const item of sourceManifest)
    assert.equal(
      hash(await sourceRead.file('class-manager/' + item.file).async('nodebuffer')),
      item.sha256,
    );
  await fs.writeFile(path.join(program, '开发资料', 'Class-Manager-Source.zip'), sourceBytes, {
    flag: 'wx',
  });
  await fs.writeFile(
    path.join(program, '开发资料', 'source-manifest.json'),
    JSON.stringify({ files: sourceManifest }, null, 2),
  );
  await addText(
    '开发资料/当前版本补充说明.md',
    await fs.readFile('docs/handoff/current-delivery-notes.md', 'utf8'),
  );
  report.asarHash = hash(await fs.readFile(archive));
  const runtimeDirectory = path.join(program, '程序');
  await fs.mkdir(runtimeDirectory);
  for (const entry of runtimeEntries) {
    const from = path.resolve(program, entry);
    const to = path.resolve(runtimeDirectory, entry);
    assert.ok(from.startsWith(path.resolve(program) + path.sep));
    assert.ok(to.startsWith(path.resolve(runtimeDirectory) + path.sep));
    await fs.rename(from, to);
  }
  const files = await inventory(program);
  assert.ok(files.some((file) => file.file.replaceAll('\\', '/') === '程序/Class Manager.exe'));
  assert.ok(
    !files.some((file) =>
      /(?:^|[\\/])(?:Setup|Install|Uninstall).*\.(?:exe|cmd)$/i.test(file.file),
    ),
  );
  assert.ok(!files.some((file) => /\.(?:sqlite(?:-[\w]+)?|cmbackup)$/i.test(file.file)));
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
    entrypoint: '启动工作台.cmd',
    executable: '程序/Class Manager.exe',
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
  // Execute verification from the user's local drive even when build storage is elsewhere.
  const verificationBase = path.join(process.env.USERPROFILE, 'ClassManagerPortableBuilds');
  await fs.mkdir(verificationBase, { recursive: true });
  report.verificationRoot = await fs.mkdtemp(
    path.join(verificationBase, releaseLabel + '-verify-'),
  );
  const extracted = path.join(report.verificationRoot, '免安装 验证', label);
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
  report.executable = path.join(extracted, '程序', 'Class Manager.exe');
  await save();
  const psLiteral = (value) => "'" + value.replaceAll("'", "''") + "'";
  await run('portable-launcher-smoke', [
    'proxy',
    'powershell',
    '-NoProfile',
    '-Command',
    `& ([scriptblock]::Create((Get-Content -LiteralPath ${psLiteral(path.resolve('scripts/portable-launcher-smoke.ps1'))} -Raw -Encoding UTF8))) -PackageRoot ${psLiteral(extracted)} -Output ${psLiteral(path.join(root, 'launcher-smoke'))}`,
  ]);
  report.launcherSmoke = 'passed';
  console.log(
    JSON.stringify({ stage: 'portable-smoke', status: 'running', executable: report.executable }),
  );
  const smoke = await runPortableSmoke(report.executable, path.join(root, 'smoke'));
  assert.equal(smoke.status, 'passed');
  await verifySource();
  report.gates = smoke.gates;
  report.smokeReport = path.join(root, 'smoke/portable-smoke-report.json');
  await run('shared-class-data-smoke', ['proxy', 'node', 'scripts/shared-class-data-smoke.mjs'], {
    CLASS_MANAGER_SHARED_EXECUTABLE: report.executable,
  });
  report.sharedClassDataSmoke = 'passed';
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
