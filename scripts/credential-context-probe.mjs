import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAuditApplication } from './live-audit-guards.ts';

// No networking or plaintext output. Discriminates missing Chromium encryption context.
assert.ok(process.env.CLASS_MANAGER_LIVE_CREDENTIALS);
assert.ok(process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE);
const source = resolve(process.env.CLASS_MANAGER_LIVE_CREDENTIALS);
const cipher = readFileSync(join(source, 'deepseek.enc'));
const localState = JSON.parse(readFileSync(join(source, '..', 'Local State'), 'utf8'));
assert.ok(localState.os_crypt?.encrypted_key);
const output = resolve('output/credential-context-probe');
mkdirSync(output, { recursive: true });
const results = [];
for (const includeContext of [false, true]) {
  const dataDirectory = mkdtempSync(join(output, 'isolated-'));
  const env = { ...process.env, CLASS_MANAGER_DATA_DIR: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    if (includeContext)
      writeFileSync(
        join(dataDirectory, 'Local State'),
        JSON.stringify({ os_crypt: localState.os_crypt }),
      );
    application = await electron.launch({
      executablePath: resolve(process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE),
      args: [],
      cwd: process.cwd(),
      env,
      timeout: 45000,
    });
    const result = await application.evaluate(({ safeStorage }, encrypted) => {
      globalThis.fetch = async () => {
        throw new Error('Credential probe forbids networking');
      };
      try {
        safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
        return { available: safeStorage.isEncryptionAvailable(), decryptable: true };
      } catch {
        return { available: safeStorage.isEncryptionAvailable(), decryptable: false };
      }
    }, cipher.toString('base64'));
    results.push({ includeContext, ...result });
  } finally {
    await closeAuditApplication(application, () => {
      rmSync(join(dataDirectory, 'Local State'), { force: true });
      assert.equal(existsSync(join(dataDirectory, 'Local State')), false);
    });
  }
}
assert.equal(
  createHash('sha256')
    .update(readFileSync(join(source, 'deepseek.enc')))
    .digest('hex'),
  createHash('sha256').update(cipher).digest('hex'),
);
writeFileSync(join(output, 'report.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
