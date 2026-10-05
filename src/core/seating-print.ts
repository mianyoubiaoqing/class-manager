import { DomainError } from './errors';
import { validateSeatingPayload } from './seating-records';
import { seatingVersionSchema, type SeatingVersionView } from '../shared/seating-records';
import { seatKey } from '../shared/seating';
import { escapePrintHtml as escapeHtml, type PrintDocument } from './print-document';
export type SeatingPrintDocument = PrintDocument;

/**
 * Build one immutable, script-free print document from a confirmed snapshot, never a UI draft.
 * Pure, no I/O. All user text is escaped. Invalid/incomplete snapshots reject before rendering.
 * Six-column tiles keep labels legible; row tiles use a conservative bound for maximum label length.
 */
export function createSeatingPrintDocument(view: SeatingVersionView): SeatingPrintDocument {
  const record = seatingVersionSchema.parse(view.record);
  const payload = validateSeatingPayload(view.payload);
  if (record.classId !== payload.classId)
    throw new DomainError('VALIDATION', '打印版本与班级快照不一致。');
  const draft = payload.arrangement;
  const members = new Map(draft.members.map((item) => [item.studentId, item]));
  const assigned = new Map(draft.assignments.map((item) => [seatKey(item), item.studentId]));
  const unavailable = new Set(draft.layout.unavailable.map(seatKey));
  const locked = new Set(draft.lockedStudentIds);
  const cellHeight = Math.max(
    21,
    ...draft.members.map(
      (item) =>
        10 +
        Math.ceil(item.displayName.length / 11) * 3.9 +
        Math.ceil(item.studentNumber.length / 14) * 3.5,
    ),
  );
  const rowsPerPage = Math.max(1, Math.floor(148 / (cellHeight + 2)));
  const tiles: Array<{
    firstRow: number;
    lastRow: number;
    firstColumn: number;
    lastColumn: number;
  }> = [];
  for (let firstRow = 1; firstRow <= draft.layout.rows; firstRow += rowsPerPage)
    for (let firstColumn = 1; firstColumn <= draft.layout.columns; firstColumn += 6)
      tiles.push({
        firstRow,
        lastRow: Math.min(draft.layout.rows, firstRow + rowsPerPage - 1),
        firstColumn,
        lastColumn: Math.min(draft.layout.columns, firstColumn + 5),
      });
  const sheets = tiles
    .map((tile, index) => {
      const cells: string[] = [];
      for (let row = tile.firstRow; row <= tile.lastRow; row++)
        for (let column = tile.firstColumn; column <= tile.lastColumn; column++) {
          const key = seatKey({ row, column });
          const studentId = assigned.get(key);
          const member = studentId ? members.get(studentId) : undefined;
          const blocked = unavailable.has(key);
          cells.push(`<div class="seat${blocked ? ' unavailable' : ''}" data-position="${key}"${member ? ` data-student-id="${member.studentId}"` : ''}>
          <div class="position">${row}排${column}列${studentId && locked.has(studentId) ? ' · 锁定' : ''}</div>
          <strong>${blocked ? '不可用' : member ? escapeHtml(member.displayName) : '空位'}</strong>
          <span class="number">${member ? escapeHtml(member.studentNumber) : ''}</span></div>`);
        }
      return `<section class="sheet" data-page="${index + 1}">
      <header><h1>${escapeHtml(payload.className)} · 座位表</h1>
      <div class="metadata">第 ${record.revision} 版 · 确认时间 ${escapeHtml(record.createdAt)} · 第 ${tile.firstRow}–${tile.lastRow} 排 / 第 ${tile.firstColumn}–${tile.lastColumn} 列</div>
      <div class="front">↑ 教室前方 · 第一排朝向讲台</div></header>
      <div class="grid" style="grid-template-columns:repeat(6,1fr);grid-auto-rows:${cellHeight}mm">${cells
        .map(
          (cell, offset) =>
            `<div style="grid-column:${(offset % (tile.lastColumn - tile.firstColumn + 1)) + 1};grid-row:${Math.floor(offset / (tile.lastColumn - tile.firstColumn + 1)) + 1}">${cell}</div>`,
        )
        .join('')}</div>
      <footer><span>确认版本 ${record.id}</span><span>第 ${index + 1} / ${tiles.length} 页</span></footer>
    </section>`;
    })
    .join('');
  return {
    versionId: record.id,
    revision: record.revision,
    pageCount: tiles.length,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>座位打印 · 第 ${record.revision} 版</title><style>
    @page { size:A4 landscape; margin:0; }
    * { box-sizing:border-box; letter-spacing:0; }
    body { margin:0; background:#e8eceb; color:#111; font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif; }
    .sheet { width:297mm; height:210mm; padding:10mm; margin:8mm auto; background:white; position:relative; break-after:page; }
    .sheet:last-child { break-after:auto; }
    header { height:32mm; }
    h1 { margin:0 0 2mm; font-size:13pt; line-height:1.25; overflow-wrap:anywhere; }
    .metadata { font-size:8pt; line-height:1.3; overflow-wrap:anywhere; }
    .front { margin:2mm 0; border-bottom:0.3mm solid #777; text-align:center; font-size:9pt; padding:1mm; }
    .grid { display:grid; gap:2mm; }
    .grid > div { min-width:0; }
    .seat { height:100%; border:0.25mm solid #666; padding:2mm; display:flex; flex-direction:column; gap:1mm; overflow-wrap:anywhere; word-break:break-all; }
    .position { font-size:8pt; line-height:3.5mm; color:#444; }
    strong { font-size:9pt; line-height:3.9mm; font-weight:600; }
    .number { font-size:8pt; line-height:3.5mm; }
    .unavailable { border-style:dashed; background:#eee; color:#555; }
    footer { position:absolute; bottom:10mm; left:10mm; right:10mm; display:flex; justify-content:space-between; gap:4mm; font-size:8pt; }
    @media print { body { background:white; } .sheet { margin:0; } }
    </style></head><body>${sheets}</body></html>`,
  };
}
