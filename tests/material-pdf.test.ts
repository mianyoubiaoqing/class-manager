import { expect, test } from 'vitest';
import sharp from 'sharp';
import { extractPdfMaterial } from '../src/core/material-pdf';
import { parseMaterial } from '../src/core/material-parser';
import { prepareLesson } from '../src/core/lesson-drafting';
import { syntheticPdf } from './fixtures/material-pdf';

const scan = {
  width: 3,
  height: 2,
  bytes: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0]),
};

test('real PDF text and page image retain the same page locator and exact original', async () => {
  const bytes = syntheticPdf([{ text: 'Synthetic lesson source' }]);
  const parsed = await parseMaterial(bytes, 'pdf');
  expect(parsed.version).toMatchObject({ format: 'pdf', completeness: 'partial' });
  expect(parsed.version.warnings).toHaveLength(1);
  expect(parsed.version.fragments).toMatchObject([
    { kind: 'text', text: 'Synthetic lesson source', locator: { kind: 'page', index: 1 } },
    { kind: 'image', width: 270, height: 150, locator: { kind: 'page', index: 1 } },
  ]);
  expect(parsed.assets[0]!.bytes).toEqual(bytes);
  const image = parsed.assets[1]!.bytes;
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(270);
  expect(data.some((value) => value < 100)).toBe(true);
});

test('self-authored scan renders actual image pixels without claiming recognized text', async () => {
  const parsed = await extractPdfMaterial(syntheticPdf([{ image: scan }]));
  expect(parsed.parts).toHaveLength(1);
  const page = parsed.parts[0]!;
  expect(page.kind).toBe('image');
  if (page.kind !== 'image') throw new Error('Expected scan');
  const { data } = await sharp(page.bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let colorful = 0;
  for (let i = 0; i < data.length; i += 3) {
    if (
      Math.max(data[i]!, data[i + 1]!, data[i + 2]!) -
        Math.min(data[i]!, data[i + 1]!, data[i + 2]!) >
      100
    )
      colorful++;
  }
  expect(colorful).toBeGreaterThan(1000);
  expect(parsed.warnings[0]).toContain('尚未进行 OCR');
});

test('mixed and blank pages are retained in page order; scans never disappear behind extracted text', async () => {
  const parsed = await extractPdfMaterial(
    syntheticPdf([{ text: 'First', image: scan }, {}, { text: 'Third' }]),
  );
  expect(parsed.parts.map((part) => [part.page, part.kind])).toEqual([
    [1, 'text'],
    [1, 'image'],
    [2, 'image'],
    [3, 'text'],
    [3, 'image'],
  ]);
});

test('partial PDF requires explicit teacher acknowledgement before preparing selected fragments', async () => {
  const { version } = await parseMaterial(syntheticPdf([{ text: 'Source' }]), 'pdf');
  const request = {
    topic: 'Synthetic',
    subject: 'English',
    grade: 'High school',
    durationMinutes: 40,
    instructions: '',
    selection: [{ sourceVersionId: version.id, fragmentId: 1 }],
    acknowledgePartial: false,
  };
  expect(() => prepareLesson(request, [version])).toThrow();
  expect(prepareLesson({ ...request, acknowledgePartial: true }, [version])).toBeDefined();
});

test('page count is checked before creating native page canvases', async () => {
  await expect(
    extractPdfMaterial(syntheticPdf(Array.from({ length: 21 }, () => ({ text: 'x' })))),
  ).rejects.toThrow(/20 页/);
});

test.each([
  { width: 4000, height: 4000 },
  { width: 100000, height: 100000 },
])(
  'oversized page rejects instead of downsampling or allocating unbounded canvas',
  async (page) => {
    await expect(extractPdfMaterial(syntheticPdf([page]))).rejects.toMatchObject({
      code: 'MATERIAL_INVALID',
    });
  },
);

test('oversized embedded image rejects instead of silently dropping it', async () => {
  await expect(
    extractPdfMaterial(syntheticPdf([{ image: { ...scan, width: 5000, height: 4001 } }])).then(
      () => 'unexpected success',
    ),
  ).rejects.toMatchObject({ code: 'MATERIAL_INVALID' });
});

test.each([0, -3])(
  'invalid embedded image width %s rejects even when the decoder only warns',
  async (width) => {
    await expect(
      extractPdfMaterial(
        syntheticPdf([{ image: { width, height: 2, bytes: Buffer.from([255]) } }]),
      ).then(() => 'unexpected success'),
    ).rejects.toMatchObject({ code: 'MATERIAL_INVALID' });
  },
);

test('decoder warning interception restores console after failure and refuses concurrent PDF processing', async () => {
  const previous = console.warn;
  const first = extractPdfMaterial(syntheticPdf([{ text: 'First' }]));
  await expect(extractPdfMaterial(syntheticPdf([{ text: 'Second' }]))).rejects.toThrow(/正在处理/);
  await first;
  expect(console.warn).toBe(previous);
  await expect(extractPdfMaterial(Buffer.from('bad'))).rejects.toThrow();
  expect(console.warn).toBe(previous);
});

test('catalog JavaScript is rejected as data and never executes', async () => {
  await expect(
    extractPdfMaterial(syntheticPdf([{ text: 'x' }], 'globalThis.pdfWasExecuted=true')),
  ).rejects.toThrow(/脚本/);
  expect(Object.hasOwn(globalThis, 'pdfWasExecuted')).toBe(false);
});

test('truncated, forged and trailing non-PDF data are rejected without partial success', async () => {
  const valid = syntheticPdf([{ text: 'x' }]);
  for (const bytes of [
    Buffer.from('not a PDF'),
    valid.subarray(0, valid.length - 10),
    Buffer.concat([valid, Buffer.from('<script>bad</script>')]),
    Buffer.from('%PDF-1.7\n%%EOF'),
  ]) {
    await expect(extractPdfMaterial(bytes)).rejects.toMatchObject({ code: 'MATERIAL_INVALID' });
  }
});

test('long source splits into bounded fragments while retaining the original page', async () => {
  const parsed = await extractPdfMaterial(
    syntheticPdf([{ text: 'a'.repeat(9000), fontSize: 0.001 }]),
  );
  const text = parsed.parts.filter((part) => part.kind === 'text');
  expect(text.map((part) => part.text.length)).toEqual([8000, 1000]);
  expect(text.every((part) => part.page === 1)).toBe(true);
});

test('total source text rejects rather than truncating to the character limit', async () => {
  await expect(
    extractPdfMaterial(syntheticPdf([{ text: 'a'.repeat(200001), fontSize: 0.001 }])),
  ).rejects.toThrow(/200000/);
}, 30000);
