import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import sharp from 'sharp';
import { MaterialTaskRunner } from '../../src/main/material-task';
import { syntheticPdf } from './material-pdf';

async function main() {
  const parserPath =
    process.env.CLASS_MANAGER_MATERIAL_PARSER ?? resolve('dist/main/material-process.cjs');
  const runner = new MaterialTaskRunner(parserPath);
  try {
    const text = await runner.parse(Buffer.from('合成资料运行时检查'), 'txt');
    assert.equal(text.version.format, 'txt');
    const source = await sharp({
      create: { width: 30, height: 20, channels: 3, background: '#63924e' },
    })
      .png()
      .toBuffer();
    const image = await runner.parse(source, 'png');
    assert.equal(image.version.fragments[0]?.kind, 'image');
    assert.equal(image.assets.length, 2);
    const pdf = await runner.parse(syntheticPdf([{ text: 'Synthetic PDF runtime' }]), 'pdf');
    assert.equal(pdf.version.format, 'pdf');
    assert.equal(pdf.version.fragments[0]?.kind, 'text');
    assert.equal(pdf.version.fragments[1]?.kind, 'image');
    assert.equal(pdf.assets.length, 2);
    await assert.rejects(
      runner.parse(
        syntheticPdf([{ image: { width: 0, height: 2, bytes: Buffer.from([255]) } }]),
        'pdf',
      ),
      { code: 'MATERIAL_INVALID' },
    );
    console.log(
      JSON.stringify({
        status: 'passed',
        parserPath,
        versions: process.versions,
        cases: [
          'isolated-text',
          'isolated-native-png',
          'isolated-pdf-page',
          'invalid-pdf-image-rejected',
          'successive-processes',
        ],
      }),
    );
  } finally {
    await runner.close();
  }
}
void main().catch(() => {
  console.error('Material runtime verification failed');
  process.exitCode = 1;
});
