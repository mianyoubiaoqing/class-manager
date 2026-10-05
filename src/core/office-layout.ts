import { DomainError } from './errors';
import { OFFICE_LIMITS } from '../shared/office-export';
import type { LessonBlock } from '../shared/lessons';

/** Conservative glyph budget in points; keep original graphemes and whitespace in each piece.
 * Native objects wrap the pieces. Extra room accommodates Chinese font fallback and Office's
 * line metrics; visual acceptance is still required in the documented target office application. */
export function textLines(text: string, width: number, fontSize: number): string[] {
  const maximum = width * 72 - 12;
  const result: string[] = [];
  let line = '';
  let used = 0;
  for (const { segment } of new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(
    text,
  )) {
    const cost = fontSize * (/^[\x20-\x7e]$/u.test(segment) ? 1 : 1.2);
    if (segment === '\n' || segment === '\r\n') {
      result.push(line + segment);
      line = '';
      used = 0;
    } else {
      if (line && used + cost > maximum) {
        result.push(line);
        line = '';
        used = 0;
      }
      line += segment;
      used += cost;
    }
  }
  if (line || !result.length) result.push(line);
  return result;
}

export type OfficeSlideObject =
  | { kind: 'text'; text: string; y: number; h: number; bullet: boolean; fontSize: number }
  | { kind: 'table'; rows: string[][]; y: number; h: number; rowHeights: number[] }
  | { kind: 'image'; block: Extract<LessonBlock, { kind: 'image' }>; y: number; h: number };
export interface OfficeSlidePage {
  title: string;
  titleHeight: number;
  objects: OfficeSlideObject[];
}

/** Long blocks and even a single oversized table row continue as native objects on following
 * pages. No text is shortened, rasterized or silently shrunk. Table headers repeat on each part. */
export function paginateOfficeSlide(title: string, blocks: LessonBlock[]): OfficeSlidePage[] {
  const titleHeight = Math.max(0.55, textLines(title, 12.05, 26).length * 0.5);
  const firstY = 0.3 + titleHeight + 0.22;
  const bottom = 6.82;
  const pages: OfficeSlidePage[] = [];
  let page!: OfficeSlidePage;
  let y = firstY;
  const next = () => {
    if (pages.length >= OFFICE_LIMITS.pages)
      throw new DomainError('EXPORT_LIMIT', '课件超过 1000 页，请创建精简备课版本。');
    page = { title, titleHeight, objects: [] };
    pages.push(page);
    y = firstY;
  };
  next();
  const text = (value: string, bullet = false, fontSize = 19) => {
    const lines = textLines(value, bullet ? 11.65 : 12.05, fontSize);
    const lineH = (fontSize * 1.55) / 72;
    let offset = 0;
    while (offset < lines.length) {
      let capacity = Math.floor((bottom - y - 0.12) / lineH);
      if (capacity < 1) {
        next();
        capacity = Math.floor((bottom - y - 0.12) / lineH);
      }
      if (capacity < 1) throw new DomainError('EXPORT_LAYOUT', '标题过长，无法放置课件正文。');
      const piece = lines.slice(offset, offset + capacity).join('');
      const count = Math.min(capacity, lines.length - offset);
      const h = count * lineH + 0.09;
      page.objects.push({
        kind: 'text',
        text: piece,
        y,
        h,
        bullet: bullet && offset === 0,
        fontSize,
      });
      y += h + 0.12;
      offset += count;
    }
  };
  for (const block of blocks) {
    if (block.kind === 'paragraph') text(block.text);
    else if (block.kind === 'list') for (const item of block.items) text(item, true);
    else if (block.kind === 'image') {
      // Caption is its own editable text object; images always retain their aspect ratio.
      const room = Math.min(3.35, bottom - firstY);
      if (bottom - y < room + 0.1) next();
      page.objects.push({ kind: 'image', block, y, h: room });
      y += room + 0.1;
      text(block.caption, false, 16);
    } else {
      const fontSize = 16;
      const lineH = 0.34;
      const columnWidth = 12.05 / block.columns.length;
      const fullHeaderH =
        Math.max(...block.columns.map((cell) => textLines(cell, columnWidth, fontSize).length)) *
          lineH +
        0.18;
      // Oversized headers themselves continue like a data row; numbered headers retain the
      // column mapping on every following part, with the full labels preserved at the start.
      const header =
        fullHeaderH + lineH + 0.18 > bottom - firstY
          ? block.columns.map((_, index) => `列 ${index + 1}`)
          : block.columns;
      const headerH =
        Math.max(...header.map((cell) => textLines(cell, columnWidth, fontSize).length)) * lineH +
        0.18;
      const dataRows = header === block.columns ? block.rows : [block.columns, ...block.rows];
      let table: Extract<OfficeSlideObject, { kind: 'table' }> | undefined;
      const startTable = () => {
        if (bottom - y < headerH + lineH + 0.18) next();
        table = { kind: 'table', rows: [header], y, h: headerH, rowHeights: [headerH] };
        page.objects.push(table);
        y += headerH;
      };
      startTable();
      for (const row of dataRows) {
        const cells = row.map((cell) => textLines(cell, columnWidth, fontSize));
        const length = Math.max(...cells.map((cell) => cell.length));
        let offset = 0;
        while (offset < length) {
          let capacity = Math.floor((bottom - y - 0.18) / lineH);
          if (capacity < 1) {
            next();
            startTable();
            capacity = Math.floor((bottom - y - 0.18) / lineH);
          }
          const count = Math.min(capacity, length - offset);
          const h = count * lineH + 0.18;
          table!.rows.push(cells.map((cell) => cell.slice(offset, offset + count).join('')));
          table!.rowHeights.push(h);
          table!.h += h;
          y += h;
          offset += count;
        }
      }
      y += 0.16;
    }
  }
  return pages;
}
