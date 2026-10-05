const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), asar = require('@electron/asar');
const source = path.resolve('output/release-audit18-reviewed/win-unpacked');
const noticeRoot = path.resolve('output/release-audit18-reviewed/third-party-notices-reviewed');
const oldRoot = path.resolve('output/release-audit15-license/third-party-notices');
const old = JSON.parse(fs.readFileSync(path.join(oldRoot, 'packages.json')));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function paths(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(path.relative(root, file));
      else throw Error('Unsupported entry ' + file);
    }
  }
  walk(root); return files.sort();
}
const archive = path.join(source, 'resources/app.asar');
const extract = file => asar.extractFile(archive, path.normalize(file));
const entries = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
fs.mkdirSync(noticeRoot);
const packages = [];
for (const file of entries.filter(file => file.endsWith('/package.json') && file.includes('node_modules'))) {
  const meta = JSON.parse(extract(file));
  if (!meta.name || !meta.version) continue;
  assert.ok(!['binary', 'buffers', 'chainsaw', 'https'].includes(meta.name));
  const directory = path.posix.dirname(file), notices = [];
  for (const from of entries.filter(file => path.posix.dirname(file) === directory && /^(LICEN[CS]E|COPYING|NOTICE)([._-].*)?$/i.test(path.posix.basename(file)))) {
    const bytes = extract(from), target = path.join(noticeRoot, from);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    notices.push({ file: from, bytes: bytes.length, sha256: hash(bytes), source: 'actual-asar' });
  }
  if (!notices.length) {
    const previous = old.find(item => item.name === meta.name && item.version === meta.version);
    assert.ok(previous?.notices.length, 'Missing exact-version notice ' + meta.name);
    for (const notice of previous.notices) {
      const bytes = fs.readFileSync(path.join(oldRoot, notice.file));
      assert.equal(hash(bytes), notice.sha256);
      const target = path.join(noticeRoot, notice.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
      notices.push({ ...notice, source: 'verified exact-version notice from license candidate' });
    }
  }
  assert.ok(meta.license ?? meta.licenses);
  packages.push({ name: meta.name, version: meta.version, license: meta.license ?? meta.licenses, packagePath: directory, notices });
}
assert.equal(packages.length, 109);
for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) fs.copyFileSync(path.join(source, file), path.join(noticeRoot, file), fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(noticeRoot, 'packages.json'), JSON.stringify(packages, null, 2), { flag: 'wx' });
const dist = paths('dist').map(file => {
  const bytes = fs.readFileSync(path.join('dist', file));
  assert.ok(bytes.equals(asar.extractFile(archive, path.join('dist', file))), 'dist/ASAR mismatch ' + file);
  return { file, bytes: bytes.length, sha256: hash(bytes) };
});
const files = paths(source).map(file => {
  const bytes = fs.readFileSync(path.join(source, file));
  return { file, bytes: bytes.length, sha256: hash(bytes) };
});
const destination = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'class-manager-agent18-'));
for (const file of files) {
  const target = path.join(destination, file.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(source, file.file), target, fs.constants.COPYFILE_EXCL);
  assert.equal(hash(fs.readFileSync(target)), file.sha256);
}
const manifest = { createdAt: new Date().toISOString(), source, destination, executable: path.join(destination, 'Class Manager.exe'), files, dist,
  exeHash: hash(fs.readFileSync(path.join(destination, 'Class Manager.exe'))), asarHash: hash(fs.readFileSync(archive)),
  inventory: { packages: packages.length, notices: packages.reduce((count, item) => count + item.notices.length, 0), unresolved: [] } };
fs.writeFileSync('output/18-reviewed-package-manifest.json', JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ source, executable: manifest.executable, files: files.length, dist: dist.length, inventory: manifest.inventory, asarHash: manifest.asarHash }));
