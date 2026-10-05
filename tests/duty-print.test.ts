import { expect, test } from 'vitest';
import { createDutyPrintDocument } from '../src/core/duty-print';
import { dutyPrintView } from './fixtures/duty-print-view';
import { replaceDutySlot, setDutyUnavailable } from '../src/core/duty';
import { PRINT_BATCH_BYTES, PRINT_BATCH_PAGES } from '../src/core/print-document';
import { serializeDuty } from '../src/core/duty-records';

test.each([
  [1, 1, 1],
  [60, 5, 7],
  [400, 1, 1],
  [400, 100, 2],
])(
  'prints every current group member, date snapshot and slot exactly once (%i/%i/%i)',
  (count, groups, dates) => {
    const view = dutyPrintView(count, groups, dates);
    const original = structuredClone(view);
    const document = createDutyPrintDocument(view);
    const rows = [...document.html.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1]!);
    const draft = view.payload.arrangement;
    expect(rows.filter((key) => key.startsWith('group:'))).toHaveLength(count!);
    expect(rows.filter((key) => key.startsWith('slot:'))).toHaveLength(
      draft.days.reduce(
        (sum, day) => sum + day.posts.reduce((sum, post) => sum + post.slots.length, 0),
        0,
      ),
    );
    expect(rows.filter((key) => key.startsWith('day:'))).toHaveLength(
      draft.days.reduce((sum, day) => sum + day.groupMemberIds.length, 0),
    );
    expect(new Set(rows).size).toBe(rows.length);
    expect(document.pageCount).toBe([...document.html.matchAll(/class="sheet"/g)].length);
    expect(document.pageCount).toBe([...document.html.matchAll(/<thead>/g)].length);
    expect(document.html).toContain(`第 ${document.pageCount} / ${document.pageCount} 页`);
    expect(view).toEqual(original);
  },
);

test('long labels create more pages without shrinking or dropping rows', () => {
  const view = dutyPrintView(400, 10, 2);
  const short = createDutyPrintDocument(view);
  view.payload.className = '班'.repeat(80);
  view.payload.title = '期'.repeat(80);
  for (const member of view.payload.arrangement.members) {
    member.displayName = '长'.repeat(60);
    member.studentNumber = `号${member.studentId.replaceAll('-', '').slice(1)}`;
  }
  const long = createDutyPrintDocument(view);
  expect(long.pageCount).toBeGreaterThan(short.pageCount);
  expect(long.html.match(/data-row=/g)).toHaveLength(560);
  expect(long.html).toContain('font-size:9pt');
  expect(long.html).toContain('长'.repeat(60));
});

test('saved absences, temporary substitutes and completed history remain visible and escaped', () => {
  const view = dutyPrintView();
  let draft = view.payload.arrangement;
  const first = draft.days[0]!;
  const id = first.posts[0]!.slots[0]!.studentId;
  draft = setDutyUnavailable(draft, first.date, [id], '2026-09-30').draft;
  draft = replaceDutySlot(
    draft,
    first.date,
    draft.posts[0]!.id,
    0,
    draft.groups[1]!.studentIds[0]!,
    '2026-09-30',
  ).draft;
  draft.days[0]!.completed = true;
  draft.members[0]!.displayName = '<script>alert(1)</script>&"\'';
  view.payload.className = '<img src=x onerror="x">';
  view.payload.arrangement = draft;
  view.stale = true;
  view.latestVersionId = '20000000-0000-4000-8000-000000009999';
  const document = createDutyPrintDocument(view);
  expect(document.html).toContain('临时替换');
  expect(document.html).toContain('全天');
  expect(document.html).toContain('已完成');
  expect(document.html).toContain('data-row="absence:2026-10-01:');
  expect(document.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
  expect(document.html).not.toContain('<script>');
  expect(document.html).not.toContain('<img ');
  expect(document.html).not.toContain(view.latestVersionId);
  expect(document.html).toContain("default-src 'none'");
});

test('mismatched and incomplete snapshots are rejected before printing', () => {
  const view = dutyPrintView();
  view.payload.arrangement.days[0]!.posts[0]!.slots[0] = null;
  expect(() => createDutyPrintDocument(view)).toThrow();
  const mismatch = dutyPrintView();
  mismatch.record.classId = '20000000-0000-4000-8000-000000009999';
  expect(() => createDutyPrintDocument(mismatch)).toThrow(/不一致/);
});

test('large legal periods retain only a bounded HTML batch and expose the final page', () => {
  const view = dutyPrintView(400, 1, 250);
  expect(Buffer.byteLength(serializeDuty(view.payload))).toBeLessThan(16 * 1024 * 1024);
  const first = createDutyPrintDocument(view);
  expect(first.totalPageCount).toBeGreaterThan(10000);
  expect(first.pageCount).toBe(PRINT_BATCH_PAGES);
  expect(Buffer.byteLength(first.html)).toBeLessThan(PRINT_BATCH_BYTES);
  const lastOffset =
    Math.floor((first.totalPageCount! - 1) / PRINT_BATCH_PAGES) * PRINT_BATCH_PAGES;
  const last = createDutyPrintDocument(view, lastOffset);
  expect(last.totalPageCount).toBe(first.totalPageCount);
  expect(last.pageCount).toBe(first.totalPageCount! - lastOffset);
  expect(Buffer.byteLength(last.html)).toBeLessThan(PRINT_BATCH_BYTES);
  expect(last.html).toContain(`第 ${first.totalPageCount} / ${first.totalPageCount} 页`);
  expect(last.html).toContain(view.payload.arrangement.dates.at(-1));
}, 15000);

test('all adjacent batches collectively contain every row once without missing pages', () => {
  const view = dutyPrintView(400, 1, 3);
  const first = createDutyPrintDocument(view);
  const keys: string[] = [];
  const pages: number[] = [];
  for (let offset = 0; offset < first.totalPageCount!; offset += PRINT_BATCH_PAGES) {
    const document = offset === 0 ? first : createDutyPrintDocument(view, offset);
    keys.push(...[...document.html.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1]!));
    pages.push(
      ...[...document.html.matchAll(/data-page="(\d+)"/g)].map((match) => Number(match[1])),
    );
  }
  expect(keys).toHaveLength(400 + 3 * 800);
  expect(new Set(keys).size).toBe(keys.length);
  expect(pages).toEqual(Array.from({ length: first.totalPageCount! }, (_, index) => index + 1));
  expect(() => createDutyPrintDocument(view, 1)).toThrow(/批次/);
  expect(() => createDutyPrintDocument(view, -100)).toThrow(/批次/);
  expect(() => createDutyPrintDocument(view, 100000)).toThrow(/批次/);
});
