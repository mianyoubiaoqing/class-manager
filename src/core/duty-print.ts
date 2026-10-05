import { dutyVersionSchema, type DutyVersionView } from '../shared/duty-records';
import type { DutyMember } from '../shared/duty';
import { validateDutyPayload } from './duty-records';
import { DomainError } from './errors';
import {
  escapePrintHtml as escape,
  PRINT_BATCH_PAGES,
  PRINT_BATCH_BYTES,
  type PrintDocument,
} from './print-document';

interface Row {
  key: string;
  kind: string;
  groupOrPost: string;
  time: string;
  member: DutyMember;
  note: string;
}
interface Sheet {
  heading: string;
  rows: Row[];
}
const widths = [18, 72, 30, 45, 80, 32];
const time = (minute: number) =>
  `${Math.floor(minute / 60)
    .toString()
    .padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`;
const cells = (row: Row) => [
  row.kind,
  row.groupOrPost,
  row.time,
  row.member.studentNumber,
  row.member.displayName,
  row.note,
];
function height(row: Row): number {
  // Worst-case full-width glyphs at 9pt, with 4mm line height and cell padding.
  return (
    4 +
    4 *
      Math.max(
        ...cells(row).map((text, index) =>
          Math.ceil(text.length / Math.max(1, Math.floor((widths[index]! - 4) / 3.2))),
        ),
      )
  );
}

/**
 * Pure confirmed-version report: current groups plus each date's frozen group, posts and absences.
 * Never reads live roster/date or mutates snapshots. Invalid/incomplete data rejects as validation.
 * Text is escaped; row bounds split pages rather than shrink labels or omit participants.
 */
export function createDutyPrintDocument(view: DutyVersionView, pageOffset = 0): PrintDocument {
  if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || pageOffset % PRINT_BATCH_PAGES !== 0)
    throw new DomainError('VALIDATION', '打印批次位置无效。');
  const record = dutyVersionSchema.parse(view.record);
  const payload = validateDutyPayload(view.payload);
  if (record.classId !== payload.classId)
    throw new DomainError('VALIDATION', '打印版本与班级快照不一致。');
  const draft = payload.arrangement;
  const members = new Map(draft.members.map((member) => [member.studentId, member]));
  const posts = new Map(draft.posts.map((post) => [post.id, post]));
  const sheets: Sheet[] = [];
  let totalPageCount = 0;
  function collect(sheet: Sheet) {
    // Retain only the requested batch. All pages are counted, never silently truncated.
    if (totalPageCount >= pageOffset && totalPageCount < pageOffset + PRINT_BATCH_PAGES)
      sheets.push(sheet);
    totalPageCount++;
  }
  function section(heading: string, rows: Row[]) {
    let sheet: Sheet = { heading, rows: [] };
    let used = 0;
    for (const row of rows) {
      const measured = height(row);
      if (used + measured > 120 && sheet.rows.length) {
        collect(sheet);
        sheet = { heading, rows: [] };
        used = 0;
      }
      sheet.rows.push(row);
      used += measured;
    }
    if (sheet.rows.length) collect(sheet);
  }
  section(
    '当期分组 · 当前参与名单',
    draft.groups.flatMap((group) =>
      group.studentIds.map((id) => ({
        key: `group:${group.id}:${id}`,
        kind: '当期组员',
        groupOrPost: group.name,
        time: '—',
        member: members.get(id)!,
        note: '当前参与',
      })),
    ),
  );
  for (const day of draft.days) {
    const rows: Row[] = [];
    for (const post of day.posts) {
      const definition = posts.get(post.postId)!;
      post.slots.forEach((slot, index) => {
        rows.push({
          key: `slot:${day.date}:${post.postId}:${index}`,
          kind: '岗位安排',
          groupOrPost: definition.name,
          time: `${time(definition.startMinute)}–${time(definition.endMinute)}`,
          member: members.get(slot!.studentId)!,
          note: slot!.temporaryReplacement ? '临时替换' : '组内安排',
        });
      });
    }
    for (const id of day.groupMemberIds)
      rows.push({
        key: `day:${day.date}:${id}`,
        kind: '当日组员',
        groupOrPost: day.groupName,
        time: '—',
        member: members.get(id)!,
        note: '当日快照',
      });
    for (const id of draft.unavailable.find((item) => item.date === day.date)?.studentIds ?? [])
      rows.push({
        key: `absence:${day.date}:${id}`,
        kind: '不可用',
        groupOrPost: day.groupName,
        time: '全天',
        member: members.get(id)!,
        note: '当日不可用',
      });
    section(`${day.date} · ${day.groupName} · ${day.completed ? '已完成' : '未完成'}`, rows);
  }
  if (pageOffset >= totalPageCount)
    throw new DomainError('VALIDATION', '打印批次超出当前版本页数。');
  const pages = sheets
    .map(
      (sheet, index) => `<section class="sheet" data-page="${pageOffset + index + 1}">
    <header><h1>${escape(payload.className)} · 值日表</h1><h2>${escape(payload.title)}</h2>
      <p>第 ${record.revision} 版 · 确认时间 ${escape(record.createdAt)}</p>
      <h3>${escape(sheet.heading)}</h3></header>
    <table><colgroup>${widths.map((width) => `<col style="width:${width}mm">`).join('')}</colgroup>
      <thead><tr>${['项目', '岗位／分组', '时段', '编号', '姓名', '备注'].map((label) => `<th>${label}</th>`).join('')}</tr></thead>
      <tbody>${sheet.rows
        .map(
          (row) =>
            `<tr data-row="${row.key}" data-student-id="${row.member.studentId}" style="height:${height(row)}mm">${cells(
              row,
            )
              .map((cell) => `<td>${escape(cell)}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody></table>
    <footer><span>确认版本 ${record.id}</span><span>第 ${pageOffset + index + 1} / ${totalPageCount} 页</span></footer>
    </section>`,
    )
    .join('');
  const document: PrintDocument = {
    versionId: record.id,
    revision: record.revision,
    pageCount: sheets.length,
    pageOffset,
    totalPageCount,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>值日打印 · 第 ${record.revision} 版</title><style>
    @page { size:A4 landscape; margin:0; }
    * { box-sizing:border-box; letter-spacing:0; }
    body { margin:0; background:#e8eceb; color:#111; font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif; }
    .sheet { width:297mm; height:210mm; padding:10mm; margin:8mm auto; background:white; position:relative; break-after:page; }
    .sheet:last-child { break-after:auto; }
    header { height:48mm; }
    h1,h2,h3,p { margin:0 0 2mm; overflow-wrap:anywhere; word-break:break-all; }
    h1,h2 { font-size:12pt; line-height:5mm; }
    h3 { font-size:10pt; line-height:4.5mm; }
    p { font-size:8pt; line-height:4mm; }
    table { width:277mm; table-layout:fixed; border-collapse:collapse; }
    thead { display:table-header-group; }
    th,td { border:0.2mm solid #777; font-size:9pt; line-height:4mm; padding:2mm; vertical-align:top; overflow-wrap:anywhere; word-break:break-all; }
    th { font-weight:600; background:#eef1ef; }
    tr { break-inside:avoid; }
    footer { position:absolute; bottom:10mm; left:10mm; right:10mm; display:flex; justify-content:space-between; gap:4mm; font-size:8pt; }
    @media print { body { background:white; } .sheet { margin:0; } }
    </style></head><body>${pages}</body></html>`,
  };
  if (Buffer.byteLength(document.html, 'utf8') > PRINT_BATCH_BYTES)
    throw new DomainError('STORAGE_LIMIT', '打印批次超过安全大小，未生成部分文档。');
  return document;
}
