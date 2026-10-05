import sharp from 'sharp';
import JSZip from 'jszip';
import { crc32 } from 'node:zlib';
import { expect, test } from 'vitest';
import { decodeMaterialImage } from '../src/core/material-image';
import { parseMaterial } from '../src/core/material-parser';
import { prepareLesson } from '../src/core/lesson-drafting';

const sourceImage = () =>
  sharp({ create: { width: 40, height: 20, channels: 3, background: '#2867a3' } });

test('JPEG fully decodes, applies orientation and strips EXIF from canonical image', async () => {
  const input = await sourceImage().withMetadata({ orientation: 6 }).jpeg().toBuffer();
  expect((await sharp(input).metadata()).exif).toBeDefined();
  const decoded = await decodeMaterialImage(input, 'jpg');
  expect(decoded).toMatchObject({ width: 20, height: 40, mime: 'image/png' });
  const metadata = await sharp(decoded.bytes).metadata();
  expect(metadata.exif).toBeUndefined();
  expect(metadata.orientation).toBeUndefined();
  expect(metadata.format).toBe('png');
  expect((await sharp(decoded.bytes).raw().toBuffer()).length).toBe(40 * 20 * 3);
});

test('PNG transparency survives canonical decoding', async () => {
  const input = await sharp({
    create: { width: 30, height: 20, channels: 4, background: { r: 5, g: 10, b: 20, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  const decoded = await decodeMaterialImage(input, 'png');
  expect(decoded).toMatchObject({ width: 30, height: 20 });
  const { data, info } = await sharp(decoded.bytes).raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  expect(data[3]).toBe(128);
});

test('pixel bound is checked before full decompression', async () => {
  const input = await sourceImage().png().toBuffer();
  input.writeUInt32BE(5000, 16);
  input.writeUInt32BE(4001, 20);
  input.writeUInt32BE(crc32(input.subarray(12, 29)), 29);
  await expect(decodeMaterialImage(input, 'png')).rejects.toMatchObject({
    code: 'MATERIAL_INVALID',
  });
});

test('truncated or mismatched image is not accepted by metadata-only validation', async () => {
  const png = await sourceImage().png().toBuffer();
  const jpg = await sourceImage().jpeg().toBuffer();
  await expect(decodeMaterialImage(png, 'jpg')).rejects.toThrow(/格式/);
  await expect(decodeMaterialImage(jpg, 'png')).rejects.toThrow(/格式/);
  await expect(decodeMaterialImage(png.subarray(0, png.length - 12), 'png')).rejects.toThrow();
  await expect(decodeMaterialImage(jpg.subarray(0, jpg.length - 25), 'jpg')).rejects.toThrow();
});

test('APNG cannot silently use only its first frame', async () => {
  const png = await sourceImage().png().toBuffer();
  const control = Buffer.alloc(20);
  control.writeUInt32BE(8, 0);
  control.write('acTL', 4, 'ascii');
  control.writeUInt32BE(2, 8);
  control.writeUInt32BE(crc32(control.subarray(4, 16)), 16);
  const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
  await expect(decodeMaterialImage(apng, 'png')).rejects.toThrow(/动画/);
});

test('parsed source retains original and normalized assets separately; lesson selects only fragment identity', async () => {
  const input = await sourceImage().withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const parsed = await parseMaterial(input, 'jpg');
  expect(parsed.assets).toHaveLength(2);
  expect(parsed.assets[0]!.bytes).toEqual(input);
  expect(parsed.version.fragments[0]).toMatchObject({ kind: 'image', width: 20, height: 40 });
  const prepared = prepareLesson(
    {
      topic: '合成图片',
      subject: '物理',
      grade: '高中',
      durationMinutes: 40,
      instructions: '',
      acknowledgePartial: false,
      selection: [{ sourceVersionId: parsed.version.id, fragmentId: 1 }],
    },
    [parsed.version],
  );
  expect(JSON.stringify(prepared)).not.toContain(parsed.version.originalAssetId);
  input.fill(0);
  expect(parsed.assets[0]!.bytes[0]).toBe(255);
});

test('DOCX embedded image uses the same real decoder, preserving paragraph location', async () => {
  const zip = new JSZip();
  const type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relationship = (body: string) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${type}"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    relationship(
      `<Relationship Id="main" Type="${office}/officeDocument" Target="word/document.xml"/>`,
    ),
  );
  zip.file(
    'word/_rels/document.xml.rels',
    relationship(`<Relationship Id="image" Type="${office}/image" Target="media/image.png"/>`),
  );
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${office}"><w:body><w:p/><w:p><w:r><w:t>图示</w:t><w:drawing><a:blip r:embed="image"/></w:drawing></w:r></w:p></w:body></w:document>`,
  );
  zip.file('word/media/image.png', await sourceImage().png().toBuffer());
  const parsed = await parseMaterial(await zip.generateAsync({ type: 'nodebuffer' }), 'docx');
  expect(parsed.version.fragments).toMatchObject([
    { kind: 'text', id: 1, locator: { kind: 'paragraph', index: 2 }, text: '图示' },
    { kind: 'image', id: 2, locator: { kind: 'paragraph', index: 2 }, width: 40, height: 20 },
  ]);
  zip.file('word/media/image.png', 'bad image');
  await expect(
    parseMaterial(await zip.generateAsync({ type: 'nodebuffer' }), 'docx'),
  ).rejects.toThrow();
});

test('TXT integrates with the same bounded original asset/version contract and broken PDF is rejected', async () => {
  const parsed = await parseMaterial(Buffer.from('第一行\n第二行'), 'txt');
  expect(parsed.version).toMatchObject({ format: 'txt', completeness: 'complete' });
  expect(parsed.assets).toHaveLength(1);
  expect(parsed.version.fragments[0]).toMatchObject({ kind: 'text', text: '第一行\n第二行' });
  await expect(parseMaterial(Buffer.from('%PDF-1.7'), 'pdf')).rejects.toMatchObject({
    code: 'MATERIAL_INVALID',
  });
});
