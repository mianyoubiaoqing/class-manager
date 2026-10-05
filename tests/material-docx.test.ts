import JSZip from 'jszip';
import { expect, test } from 'vitest';
import { DOCX_LIMITS, extractDocxMaterial } from '../src/core/material-docx';
import { LESSON_LIMITS } from '../src/shared/lessons';

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const types = 'http://schemas.openxmlformats.org/package/2006/content-types';
const type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const relationships = (body: string) => `<Relationships xmlns="${rel}">${body}</Relationships>`;
const image = '<w:r><w:drawing><a:blip r:embed="picture"/></w:drawing></w:r>';

function fixture(body = paragraph('合成教学资料')) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="${types}"><Override PartName="/word/document.xml" ContentType="${type}"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    relationships(
      `<Relationship Id="main" Type="${office}/officeDocument" Target="word/document.xml"/>`,
    ),
  );
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="${word}" xmlns:r="${office}" xmlns:a="${drawing}"><w:body>${body}</w:body></w:document>`,
  );
  return zip;
}
const bytes = (zip: JSZip) => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
async function extract(zip: JSZip) {
  return extractDocxMaterial(await bytes(zip));
}

test('DOCX preserves literal paragraphs, empty paragraph positions, runs, tabs and line breaks', async () => {
  const result = await extract(
    fixture(
      '<w:p/><w:p><w:r><w:t xml:space="preserve">  力与运动 </w:t><w:tab/><w:t>例题 &amp; 提问</w:t><w:br/><w:t>&lt;script&gt;literal&lt;/script&gt;</w:t></w:r></w:p>',
    ),
  );
  expect(result).toEqual({
    completeness: 'complete',
    warnings: [],
    parts: [
      { kind: 'text', paragraph: 2, text: '  力与运动 \t例题 & 提问\n<script>literal</script>' },
    ],
  });
});

test('strict OOXML namespaces are accepted without relying on chosen prefixes', async () => {
  const zip = fixture();
  zip.file(
    'word/document.xml',
    '<x:document xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"><x:body><x:p><x:r><x:t>严格格式</x:t></x:r></x:p></x:body></x:document>',
  );
  expect((await extract(zip)).parts).toEqual([{ kind: 'text', paragraph: 1, text: '严格格式' }]);
});

test('embedded PNG/JPEG bytes retain their exact source order for later isolated image decoding', async () => {
  const zip = fixture(`<w:p><w:r><w:t>图前</w:t></w:r>${image}<w:r><w:t>图后</w:t></w:r></w:p>`);
  zip.file(
    'word/_rels/document.xml.rels',
    relationships(`<Relationship Id="picture" Type="${office}/image" Target="media/picture.png"/>`),
  );
  // The extractor never claims these synthetic bytes are a decoded/validated image.
  zip.file('word/media/picture.png', Buffer.from([137, 80, 78, 71]));
  const result = await extract(zip);
  expect(result.parts).toEqual([
    { kind: 'text', paragraph: 1, text: '图前' },
    { kind: 'image', paragraph: 1, format: 'png', bytes: Buffer.from([137, 80, 78, 71]) },
    { kind: 'text', paragraph: 1, text: '图后' },
  ]);
});

test('tables, numbering, fields and special symbols explicitly report partial extraction', async () => {
  const result = await extract(
    fixture(
      `<w:tbl><w:tr><w:tc>${paragraph('单元格甲')}</w:tc><w:tc>${paragraph('单元格乙')}</w:tc></w:tr></w:tbl><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:fldChar/><w:instrText>DO NOT EXECUTE</w:instrText><w:t>缓存字段</w:t><w:sym/></w:r></w:p>`,
    ),
  );
  expect(result.completeness).toBe('partial');
  expect(result.warnings.join('')).toMatch(/字段/);
  expect(result.parts.map((part) => (part.kind === 'text' ? part.text : ''))).toEqual([
    '单元格甲',
    '单元格乙',
    '缓存字段',
  ]);
  expect(JSON.stringify(result)).not.toContain('DO NOT EXECUTE');
});

test('deleted text and hidden runs are excluded and the resulting omission is explicit', async () => {
  const result = await extract(
    fixture(
      '<w:p><w:del><w:r><w:t>deleted</w:t></w:r></w:del><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r><w:r><w:t>visible</w:t></w:r></w:p>',
    ),
  );
  expect(result.parts).toEqual([{ kind: 'text', paragraph: 1, text: 'visible' }]);
  expect(result.completeness).toBe('partial');
  expect(result.warnings).toHaveLength(2);
});

test('hyperlinks retain labels but never their external target in extracted teaching text', async () => {
  const zip = fixture(
    '<w:p><w:hyperlink r:id="link"><w:r><w:t>资源标签</w:t></w:r></w:hyperlink></w:p>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    relationships(
      `<Relationship Id="link" Type="${office}/hyperlink" Target="https://example.invalid/private" TargetMode="External"/>`,
    ),
  );
  const result = await extract(zip);
  expect(result.completeness).toBe('partial');
  expect(JSON.stringify(result)).not.toContain('https:');
  expect(result.parts[0]).toMatchObject({ text: '资源标签' });
});

test('unsupported image formats and side text cannot masquerade as complete extraction', async () => {
  const zip = fixture(`<w:p>${image}</w:p>${paragraph('正文')}`);
  zip.file(
    'word/_rels/document.xml.rels',
    relationships(`<Relationship Id="picture" Type="${office}/image" Target="media/picture.svg"/>`),
  );
  zip.file('word/media/picture.svg', '<svg/>');
  zip.file('word/header1.xml', `<w:hdr xmlns:w="${word}">${paragraph('PRIVATE HEADER')}</w:hdr>`);
  const result = await extract(zip);
  expect(result.completeness).toBe('partial');
  expect(result.warnings).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('PRIVATE HEADER');
});

test.each([
  'macro',
  'embedded',
  'external-image',
  'external-template',
  'dtd',
  'bad-xml',
  'bad-utf8',
  'dangling',
  'duplicate-ref',
  'traversal',
  'fake-namespace',
  'wrong-main',
  'missing-main-type',
] as const)('unsafe or malformed DOCX %s rejects atomically', async (kind) => {
  const zip = fixture();
  if (kind === 'macro') zip.file('word/vbaProject.bin', 'macro');
  if (kind === 'embedded') zip.file('word/embeddings/data.xlsx', 'embedded');
  if (kind === 'external-image' || kind === 'external-template')
    zip.file(
      'word/_rels/document.xml.rels',
      relationships(
        `<Relationship Id="ref" Type="${office}/${kind === 'external-image' ? 'image' : 'attachedTemplate'}" Target="https://example.invalid/file" TargetMode="External"/>`,
      ),
    );
  if (kind === 'dtd') zip.file('word/comments.xml', '<!DOCTYPE x [<!ENTITY a "abc">]><x>&a;</x>');
  if (kind === 'bad-xml') zip.file('word/comments.xml', '<x>');
  if (kind === 'bad-utf8') zip.file('word/comments.xml', Buffer.from([0xc3, 0x28]));
  if (kind === 'dangling')
    zip.file(
      'word/_rels/document.xml.rels',
      relationships(`<Relationship Id="p" Type="${office}/image" Target="media/missing.png"/>`),
    );
  if (kind === 'duplicate-ref')
    zip.file(
      '_rels/.rels',
      relationships(
        `<Relationship Id="x" Type="${office}/officeDocument" Target="word/document.xml"/><Relationship Id="x" Type="${office}/officeDocument" Target="word/document.xml"/>`,
      ),
    );
  if (kind === 'traversal')
    zip.file(
      'word/_rels/document.xml.rels',
      relationships(`<Relationship Id="p" Type="${office}/image" Target="../../outside.png"/>`),
    );
  if (kind === 'fake-namespace')
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="fake"><w:body><w:p><w:t>fake</w:t></w:p></w:body></w:document>',
    );
  if (kind === 'wrong-main')
    zip.file(
      '_rels/.rels',
      relationships(
        `<Relationship Id="main" Type="${office}/officeDocument" Target="[Content_Types].xml"/>`,
      ),
    );
  if (kind === 'missing-main-type') zip.remove('[Content_Types].xml');
  await expect(extract(zip)).rejects.toMatchObject({ code: 'MATERIAL_INVALID' });
});

test.each([
  'empty',
  'bad-zip',
  'file-size',
  'entry-size',
  'entry-count',
  'depth',
  'nodes',
  'paragraph',
  'characters',
  'fragments',
] as const)(
  'DOCX resource guard %s rejects rather than returning a successful prefix',
  async (kind) => {
    const zip = fixture();
    let input: Buffer | undefined;
    if (kind === 'empty') input = Buffer.alloc(0);
    if (kind === 'bad-zip') input = Buffer.from('not a zip');
    if (kind === 'file-size') input = Buffer.alloc(LESSON_LIMITS.fileBytes + 1);
    if (kind === 'entry-size')
      zip.file('word/media/large.png', Buffer.alloc(DOCX_LIMITS.entryBytes + 1));
    if (kind === 'entry-count')
      for (let i = 0; i < DOCX_LIMITS.entries; i++) zip.file(`extra-${i}`, '');
    if (kind === 'depth') zip.file('extra.xml', '<x>'.repeat(65) + '</x>'.repeat(65));
    if (kind === 'nodes')
      zip.file('extra.xml', '<x>' + '<y/>'.repeat(DOCX_LIMITS.xmlNodes) + '</x>');
    if (kind === 'paragraph') input = await bytes(fixture(paragraph('x'.repeat(8001))));
    if (kind === 'characters') input = await bytes(fixture(paragraph('x'.repeat(8000)).repeat(26)));
    if (kind === 'fragments') input = await bytes(fixture(paragraph('x').repeat(501)));
    await expect(extractDocxMaterial(input ?? (await bytes(zip)))).rejects.toMatchObject({
      code: 'MATERIAL_INVALID',
    });
  },
);

test('ZIP CRC mismatch and case-ambiguous paths reject', async () => {
  const zip = fixture();
  zip.file('WORD/DOCUMENT.XML', '<x/>');
  await expect(extract(zip)).rejects.toThrow(/重复/);
  const stored = await fixture().generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const position = stored.indexOf(Buffer.from('合成教学资料'));
  expect(position).toBeGreaterThan(0);
  stored[position] = stored[position]! ^ 1;
  await expect(extractDocxMaterial(stored)).rejects.toThrow(/校验/);
});

test('repeated image references cannot amplify a small archive beyond the output byte budget', async () => {
  const zip = fixture(`<w:p>${image.repeat(5)}</w:p>`);
  zip.file(
    'word/_rels/document.xml.rels',
    relationships(`<Relationship Id="picture" Type="${office}/image" Target="media/picture.png"/>`),
  );
  zip.file('word/media/picture.png', Buffer.alloc(DOCX_LIMITS.entryBytes));
  // Collapse a hypothetical resolved payload so assertion failures do not dump megabytes of bytes.
  await expect(extract(zip).then(() => 'unexpected success')).rejects.toThrow(/图片.*上限/);
});

test.each(['relationships', 'types', 'body'] as const)(
  'nested forged %s structure rejects',
  async (kind) => {
    const zip = fixture();
    if (kind === 'relationships')
      zip.file(
        '_rels/.rels',
        relationships(
          `<Relationship Id="main" Type="${office}/officeDocument" Target="word/document.xml"><Relationship Id="extra" Type="${office}/image" Target="word/document.xml"/></Relationship>`,
        ),
      );
    if (kind === 'types')
      zip.file(
        '[Content_Types].xml',
        `<Override xmlns="${types}" PartName="/word/document.xml" ContentType="${type}"/>`,
      );
    if (kind === 'body')
      zip.file(
        'word/document.xml',
        `<w:document xmlns:w="${word}"><w:p><w:body>${paragraph('fake')}</w:body></w:p></w:document>`,
      );
    await expect(extract(zip)).rejects.toMatchObject({ code: 'MATERIAL_INVALID' });
  },
);

test('equations and charts cannot disappear while claiming complete extraction', async () => {
  const result = await extract(
    fixture(
      `${paragraph('正文')}<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>公式</m:t></m:r></m:oMath>`,
    ),
  );
  expect(result.completeness).toBe('partial');
  expect(result.warnings.join('')).toMatch(/公式|不支持/);
});

test('vanish false is not hidden and style-based visibility is explicitly not resolved', async () => {
  const zip = fixture(
    '<w:p><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>visible</w:t></w:r></w:p>',
  );
  zip.file(
    'word/styles.xml',
    `<w:styles xmlns:w="${word}"><w:style><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`,
  );
  const result = await extract(zip);
  expect(result.parts).toEqual([{ kind: 'text', paragraph: 1, text: 'visible' }]);
  expect(result.completeness).toBe('partial');
  expect(result.warnings.join('')).toMatch(/样式/);
});

test('unapplied drawing crop or rotation and drawing text cannot claim full fidelity', async () => {
  const result = await extract(
    fixture(
      `${paragraph('正文')}<w:p><w:r><w:drawing><a:xfrm rot="5400000"/><a:srcRect l="20000"/><a:t>图形文字</a:t></w:drawing></w:r></w:p>`,
    ),
  );
  expect(result.completeness).toBe('partial');
  expect(result.warnings.join('')).toMatch(/裁剪/);
});
