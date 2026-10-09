import { randomUUID } from 'node:crypto';
import { resourceExportInput, resourceSection, resourceTypes } from '../shared/resource-library';
import { escapePrintHtml, type PrintDocument } from './print-document';
/** Render only escaped text. Conservative wrapping gives a stable A4 preview, including long lines. */
export function createResourcePrintDocument(raw: unknown): PrintDocument {
  const input = resourceExportInput.parse(raw),
    section = resourceSection(input.key),
    title = `${section.section.title} · ${resourceTypes[input.type]}`;
  const lines = input.body.split('\n').flatMap((line) => {
    const chars = Array.from(line);
    return chars.length
      ? Array.from({ length: Math.ceil(chars.length / 38) }, (_, i) =>
          chars.slice(i * 38, (i + 1) * 38).join(''),
        )
      : [''];
  });
  const pages = Array.from(
    { length: Math.max(1, Math.ceil(lines.length / 36)) },
    (_, i) =>
      `<section class="page"><h1>${escapePrintHtml(title)}</h1><p class="subtitle">高中${escapePrintHtml(section.subject.name)} · ${escapePrintHtml(section.version.name)} · 本次编辑内容</p><div class="body">${lines
        .slice(i * 36, (i + 1) * 36)
        .map((line) => `<div>${escapePrintHtml(line) || '&nbsp;'}</div>`)
        .join(
          '',
        )}</div><footer>第 ${i + 1} / ${Math.max(1, Math.ceil(lines.length / 36))} 页</footer></section>`,
  );
  return {
    versionId: randomUUID(),
    revision: 1,
    pageCount: pages.length,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapePrintHtml(title)}</title><style>@page{size:A4 portrait;margin:0}*{box-sizing:border-box}body{margin:0;background:#eee;font-family:'Microsoft YaHei',sans-serif}.page{width:210mm;height:297mm;margin:8mm auto;background:white;padding:18mm;break-after:page;overflow:hidden}h1{font-size:17pt;margin:0 0 5mm}.subtitle{font-size:10pt;margin:0 0 7mm;color:#555}.body{font-size:11pt;line-height:6mm;white-space:pre-wrap}footer{font-size:9pt;text-align:right;margin-top:6mm}@media print{body{background:white}.page{margin:0}}</style></head><body>${pages.join('')}</body></html>`,
  };
}
