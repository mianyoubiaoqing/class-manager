import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// PDF.js 6.3.289 resolves getOperatorList when marking an error stream as finished, before
// rejecting it. This can turn an oversized/malformed image into a successfully blank page.
// Reject the public read promise first. Keep this patch narrow and fail closed on upgrades.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version !== '6.3.289')
  throw new Error('PDF.js version changed; audit and update the stream-error patch before use.');
const identities = {
  'legacy/build/pdf.mjs': '91e29f812c593904e8d48d022db5ddf93e3443575d4765ac9bfbb42494cfbd8d',
  'build/pdf.mjs': '495588717f62303a839e91a5343deebf1b41f52e2f9f6361e73dee6ea6a4355e',
};
const before = `        if (intentState.operatorList) {
          intentState.operatorList.lastChunk = true;`;
const after = `        // Class Manager: reject failed reads before completion callbacks can resolve them.
        intentState.opListReadCapability?.reject(reason);
${before}`;
for (const [relative, expectedHash] of Object.entries(identities)) {
  const path = join(root, relative);
  let source = readFileSync(path, 'utf8');
  const unpatched = source.replace(after, before);
  if (
    createHash('sha256').update(unpatched).digest('hex') !== expectedHash ||
    unpatched.split(before).length !== 2
  )
    throw new Error(`PDF.js source changed: ${relative}; refusing an unverified patch.`);
  if (!source.includes(after)) {
    source = source.replace(before, after);
    writeFileSync(path, source);
  }
}
console.log('Verified PDF.js stream-error patch (6.3.289).');
