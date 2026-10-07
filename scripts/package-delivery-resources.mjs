// Package an already-built Windows program with repository documentation and reproducible source.
// No app launch, paid request, customer data access, existing-release overwrite or UI automation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { extractFile, listPackage, statFile } from '@electron/asar';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const option = (name) => {
  const index = process.argv.indexOf(name);
  assert.ok(index >= 0 && process.argv[index + 1], `Required argument: ${name}`);
  return path.resolve(process.argv[index + 1]);
};
const program = option('--program'),
  destination = option('--delivery-root'),
  notices = option('--notices');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalized = (file) => file.replaceAll('\\', '/');
async function inventory(root, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    assert.ok(entry.isFile() || entry.isDirectory(), `Unsupported filesystem entry: ${file}`);
    if (entry.isDirectory()) files.push(...(await inventory(root, file)));
    else files.push(normalized(file));
  }
  return files.sort();
}
const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
const archive = path.join(program, 'resources/app.asar');
await fs.access(path.join(program, 'Class Manager.exe'));
for (const file of await inventory('dist'))
  assert.equal(
    hash(extractFile(archive, path.join('dist', file))),
    hash(await fs.readFile(path.join('dist', file))),
    `Program differs from current build: ${file}`,
  );
const packedMetadata = JSON.parse(extractFile(archive, 'package.json'));
for (const field of ['name', 'version', 'main', 'dependencies'])
  assert.deepEqual(packedMetadata[field], metadata[field]);

const entries = listPackage(archive).map((file) => normalized(file).replace(/^\//, ''));
for (const file of entries.filter((file) => /\.(?:cjs|js|json|map|html|css|md|txt)$/i.test(file))) {
  const archivePath = file.replaceAll('/', path.sep);
  const entry = statFile(archive, archivePath, false);
  if ('files' in entry || 'link' in entry) continue;
  assert.ok(
    !/\bsk-[A-Za-z0-9_-]{20,}\b/.test(extractFile(archive, archivePath).toString('utf8')),
    `Credential-shaped content in program; value omitted: ${file}`,
  );
}
const reviewed = JSON.parse(await fs.readFile(path.join(notices, 'packages.json'), 'utf8'));
const runtime = entries
  .filter((file) => file.includes('node_modules/') && file.endsWith('/package.json'))
  .map((file) => {
    const pkg = JSON.parse(extractFile(archive, file.replaceAll('/', path.sep)));
    return { name: pkg.name, version: pkg.version, packagePath: path.posix.dirname(file) };
  })
  .filter((pkg) => pkg.name && pkg.version);
assert.equal(runtime.length, reviewed.length, 'Reviewed dependency inventory differs from program');
for (const pkg of runtime) {
  const item = reviewed.find(
    (item) =>
      item.name === pkg.name &&
      item.version === pkg.version &&
      item.packagePath === pkg.packagePath,
  );
  assert.ok(item?.notices?.length, `License notices missing: ${pkg.name}`);
  for (const file of item.notices)
    assert.equal(hash(await fs.readFile(path.join(notices, file.file))), file.sha256);
}
const git = spawnSync(
  'rtk',
  ['proxy', 'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
);
assert.equal(git.status, 0, 'Cannot inventory repository source');
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
assert.ok(sourceFiles.includes('src/main/main.ts') && sourceFiles.includes('package-lock.json'));
const source = new JSZip(),
  sourceManifest = [];
for (const file of sourceFiles) {
  assert.ok(!(await fs.lstat(file)).isSymbolicLink(), `Unsupported source link: ${file}`);
  assert.ok(
    !/(?:^|\/)(?:credentials|conversation-history|workspace-data|node_modules)(?:\/|$)|\.cmbackup$|\.env(?:\.|$)/i.test(
      file,
    ),
    `Private data directory in source: ${file}`,
  );
  if (/\.sqlite(?:-|$)/i.test(file))
    assert.ok(
      ['tests/fixtures/frozen-v7.sqlite', 'tests/fixtures/frozen-v6-lessons.sqlite'].includes(file),
      `Unexpected database file: ${file}`,
    );
  const bytes = await fs.readFile(file);
  source.file('class-manager/' + file, bytes);
  sourceManifest.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
await fs.mkdir(destination, { recursive: true });
const delivery = await fs.mkdtemp(path.join(destination, 'Diagnostics-and-Docs-20261006-'));
const label = `Class-Manager-${metadata.version}-Diagnostics-20261006-x64`;
const root = path.join(delivery, label);
await fs.mkdir(root);
await fs.cp(program, path.join(root, '程序'), {
  recursive: true,
  force: false,
  errorOnExist: true,
});
await fs.cp(notices, path.join(root, '程序/third-party-notices'), {
  recursive: true,
  force: false,
  errorOnExist: true,
});
await fs.cp('docs/submissions', path.join(root, '使用文档'), {
  recursive: true,
  force: false,
  errorOnExist: true,
});
await fs.copyFile('docs/handoff/current-delivery-notes.md', path.join(root, '当前版本补充说明.md'));
await fs.writeFile(
  path.join(root, '先读我.txt'),
  '\uFEFF' +
    '请完整解压本包，先阅读“当前版本补充说明.md”，然后双击“程序\\Class Manager.exe”。\r\n' +
    '使用文档：六份仓库原稿。源码：Class-Manager-Source.zip。\r\n' +
    '更新前保存、备份并退出旧版，保留程序文件夹内全部文件。\r\n' +
    '本包未配置模型账号；需交付方在客户使用的 Windows 用户下代配置比赛专用账号。\r\n' +
    '遇到模型响应问题：系统设置 → 数据与维护 → 导出诊断。\r\n' +
    '本次诊断增强不代表此前六次真实响应的具体格式问题已经修复。\r\n',
);
const sourceBytes = await source.generateAsync({
  type: 'nodebuffer',
  platform: 'DOS',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
});
await fs.writeFile(path.join(root, 'Class-Manager-Source.zip'), sourceBytes, { flag: 'wx' });
await fs.writeFile(
  path.join(root, 'source-manifest.json'),
  JSON.stringify({ files: sourceManifest }, null, 2),
);
const reopenedSource = await JSZip.loadAsync(sourceBytes, { checkCRC32: true });
for (const item of sourceManifest)
  assert.equal(
    hash(await reopenedSource.file('class-manager/' + item.file).async('nodebuffer')),
    item.sha256,
  );
for (const item of sourceManifest)
  assert.equal(
    hash(await fs.readFile(item.file)),
    item.sha256,
    `Source changed during packaging: ${item.file}`,
  );
const docs = await inventory('docs/submissions');
assert.equal(
  docs.filter((file) => file.endsWith('.md')).length,
  6,
  'Expected the six existing submission documents',
);
for (const file of docs)
  assert.equal(
    hash(await fs.readFile(path.join(root, '使用文档', file))),
    hash(await fs.readFile(path.join('docs/submissions', file))),
  );
const files = await inventory(root),
  manifest = [];
const zip = new JSZip();
for (const file of files) {
  if (file.startsWith('程序/'))
    assert.ok(
      !/(?:credentials|workspace-data|conversation-history)|\.(?:sqlite|cmbackup|chat|enc)$/i.test(
        file,
      ),
      `Private program data: ${file}`,
    );
  const bytes = await fs.readFile(path.join(root, file));
  zip.file(label + '/' + file, bytes);
  manifest.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
const manifestBytes = Buffer.from(
  JSON.stringify(
    {
      version: metadata.version,
      entrypoint: '程序/Class Manager.exe',
      documents: docs,
      sourceFiles: sourceManifest.length,
      runtimePackages: runtime.length,
      verification: {
        buildMatchesAsar: true,
        sourceCrcAndHashes: true,
        originalDocumentsUnchanged: true,
        paidModelCalls: false,
        uiAcceptanceRerun: false,
      },
      files: manifest,
    },
    null,
    2,
  ),
);
zip.file(label + '/delivery-manifest.json', manifestBytes);
zip.file(
  label + '/SHA256SUMS.txt',
  [
    ...manifest.map((item) => item.sha256 + '  ' + item.file),
    hash(manifestBytes) + '  delivery-manifest.json',
  ].join('\r\n') + '\r\n',
);
const zipPath = path.join(delivery, label + '-Delivery.zip');
console.log(
  JSON.stringify({ stage: 'zip', documents: docs.length, sourceFiles: sourceManifest.length }),
);
const zipBytes = await zip.generateAsync({
  type: 'nodebuffer',
  platform: 'DOS',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
});
await fs.writeFile(zipPath, zipBytes, { flag: 'wx' });
const reopened = await JSZip.loadAsync(zipBytes, { checkCRC32: true });
for (const item of manifest)
  assert.equal(hash(await reopened.file(label + '/' + item.file).async('nodebuffer')), item.sha256);
assert.equal(Object.values(reopened.files).filter((file) => !file.dir).length, manifest.length + 2);
for (const file of await inventory('dist'))
  assert.equal(
    hash(extractFile(archive, path.join('dist', file))),
    hash(await fs.readFile(path.join('dist', file))),
  );
const report = {
  status: 'verified',
  zipPath,
  extracted: root,
  sha256: hash(zipBytes),
  bytes: zipBytes.length,
  documents: docs,
  sourceFiles: sourceManifest.length,
  runtimePackages: runtime.length,
  uiAcceptanceRerun: false,
  paidModelCalls: false,
};
await fs.writeFile(zipPath + '.sha256', report.sha256 + '  ' + path.basename(zipPath) + '\r\n');
await fs.writeFile(path.join(delivery, 'delivery-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
