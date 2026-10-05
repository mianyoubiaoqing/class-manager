import { deflateSync } from 'node:zlib';

/** Small self-authored PDFs with exact cross-reference offsets; no external fixture content. */
export function syntheticPdf(
  pages: {
    text?: string;
    width?: number;
    height?: number;
    fontSize?: number;
    image?: { width: number; height: number; bytes: Buffer };
  }[],
  action?: string,
): Buffer {
  const objects: Buffer[] = [];
  const object = (value: string | Buffer) => {
    objects.push(typeof value === 'string' ? Buffer.from(value, 'latin1') : value);
    return objects.length;
  };
  object(
    `<< /Type /Catalog /Pages 2 0 R${action ? ` /OpenAction << /S /JavaScript /JS (${action}) >>` : ''} >>`,
  );
  object('');
  const font = object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const page of pages) {
    let imageId = 0;
    if (page.image) {
      const encoded = deflateSync(page.image.bytes);
      imageId = object(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${encoded.length} >>\nstream\n`,
          ),
          encoded,
          Buffer.from('\nendstream'),
        ]),
      );
    }
    const text = (page.text ?? '').replace(/[\\()]/g, '\\$&');
    const stream = Buffer.from(
      `${page.text ? `BT /F1 ${page.fontSize ?? 12} Tf 20 60 Td (${text}) Tj ET\n` : ''}${imageId ? 'q 100 0 0 40 20 10 cm /Im1 Do Q\n' : ''}`,
      'latin1',
    );
    const content = object(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
        stream,
        Buffer.from('endstream'),
      ]),
    );
    kids.push(
      object(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width ?? 180} ${page.height ?? 100}] /Resources << /Font << /F1 ${font} 0 R >>${imageId ? ` /XObject << /Im1 ${imageId} 0 R >>` : ''} >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`,
  );
  const chunks = [Buffer.from('%PDF-1.7\n%\xff\xff\xff\xff\n', 'latin1')];
  const offsets = [0];
  let offset = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}
