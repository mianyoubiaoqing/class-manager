import { parseMaterial } from '../../src/core/material-parser';

process.once('message', async (input: { bytes: Buffer }) => {
  const mode = input.bytes.toString('utf8');
  if (mode === 'crash') process.exit(88);
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'environment' && process.env.MATERIAL_TEST_SECRET) process.exit(77);
  const value = await parseMaterial(input.bytes, 'txt');
  if (mode === 'mismatch') value.version.sha256 = '0'.repeat(64);
  if (mode === 'original-mime') value.assets[0]!.mime = 'text/html';
  if (mode === 'orphan')
    value.assets.push({ ...value.assets[0]!, id: '10000000-0000-4000-8000-000000000001' });
  if (mode === 'duplicate') value.assets.push(value.assets[0]!);
  process.send?.(mode === 'invalid' ? { ok: true, value: {} } : { ok: true, value }, () =>
    process.exit(0),
  );
});
