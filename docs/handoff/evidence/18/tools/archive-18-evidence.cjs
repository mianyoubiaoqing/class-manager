const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = path.resolve('docs/handoff/evidence/18');
fs.mkdirSync(root);
const entries = [];
function copy(source, relative) {
  const bytes = fs.readFileSync(source), target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  assert.equal(hash(fs.readFileSync(target)), hash(bytes));
  entries.push({ source: path.resolve(source), archive: target, bytes: bytes.length, sha256: hash(bytes) });
}
for (const file of fs.readdirSync('output').filter(file => /^18-.*\.(log|json)$/.test(file))) copy(path.join('output', file), path.join('output', file));
const directories = {
  'conversation-development': 'output/playwright/conversation18/run-9xzL1m',
  'conversation-packaged': 'output/playwright/conversation18/run-EFitsx',
  providers: 'output/playwright/providers/run-QiapOS',
  devices: 'output/playwright/devices/run-TyU6ig',
};
for (const [kind, directory] of Object.entries(directories)) {
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json')));
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.errors, []);
  assert.equal(report.externalRequests, 0);
  for (const file of fs.readdirSync(directory).filter(file => /\.(json|png|yml)$/.test(file)))
    copy(path.join(directory, file), path.join(kind, file));
}
for (const kind of ['development', 'packaged']) {
  const parent = `output/playwright/agent18-general-${kind}`;
  const passed = fs.readdirSync(parent).filter(file => fs.existsSync(path.join(parent, file, 'report.json')));
  assert.equal(passed.length, 1);
  const source = path.join(parent, passed[0], 'report.json');
  const report = JSON.parse(fs.readFileSync(source));
  assert.equal(report.status, 'passed'); assert.equal(report.reopenCycles, 10); assert.deepEqual(report.errors, []);
  copy(source, `general-${kind}/report.json`);
}
for (const file of ['prepare-18-reviewed-package.cjs', 'archive-18-evidence.cjs', 'build-18-reviewed.cjs', 'run-18-node-check.cjs', 'run-18-packaged.cjs', 'run-18-desktop-development.cjs']) copy(path.join('output', file), path.join('tools', file));
const baseline = fs.readFileSync('output/18-agent-baseline-path.txt', 'utf8').trim();
const manifest = JSON.parse(fs.readFileSync(path.join(baseline, 'manifest.json')));
for (const file of manifest) assert.equal(hash(fs.readFileSync(path.join(baseline, file.path))), file.sha256);
const original = JSON.parse(fs.readFileSync('output/15-handoff-identity.json'));
assert.equal(hash(fs.readFileSync(original.zip)), original.zipSha256);
for (const ticket of [16,17]) {
  const identity = JSON.parse(fs.readFileSync(`output/${ticket}-final-review-identity.json`));
  assert.equal(hash(fs.readFileSync(identity.file)), identity.sha256);
}
const identity = { createdAt: new Date().toISOString(), entries, baseline, baselineFilesVerified: manifest.length,
  frozen15ZipUnchanged: true, frozen16And17DiffsUnchanged: true };
fs.writeFileSync('output/18-evidence-manifest.json', JSON.stringify(identity, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ files: entries.length, bytes: entries.reduce((count, entry) => count + entry.bytes, 0), baselineFiles: manifest.length, frozenPreviousEvidence: 'unchanged' }));
