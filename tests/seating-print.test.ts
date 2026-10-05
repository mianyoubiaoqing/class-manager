import { expect, test } from 'vitest';
import { createSeatingPrintDocument } from '../src/core/seating-print';
import { printView } from './fixtures/seating-print-view';

test.each([
  [1, 1],
  [10, 6],
  [20, 20],
  [1, 20],
  [20, 1],
])('printing %sx%s covers each original position and member exactly once', (rows, columns) => {
  const view = printView(rows!, columns!);
  const original = structuredClone(view);
  const document = createSeatingPrintDocument(view);
  const seats = [...document.html.matchAll(/data-position="([^"]+)"/g)].map((match) => match[1]);
  const members = [...document.html.matchAll(/data-student-id="([^"]+)"/g)].map(
    (match) => match[1],
  );
  expect(seats).toHaveLength(rows! * columns!);
  expect(new Set(seats).size).toBe(seats.length);
  expect(members).toHaveLength(view.payload.arrangement.members.length);
  expect(new Set(members).size).toBe(members.length);
  expect(document.pageCount).toBe([...document.html.matchAll(/class="sheet"/g)].length);
  expect(document.versionId).toBe(view.record.id);
  expect(document.html).toContain(`第 1 / ${document.pageCount} 页`);
  expect(view).toEqual(original);
});

test('maximum labels increase pagination instead of shrinking fonts or omitting members', () => {
  const view = printView(20, 20);
  const short = createSeatingPrintDocument(view);
  view.payload.className = '班'.repeat(80);
  for (const member of view.payload.arrangement.members) {
    member.displayName = '长'.repeat(60);
    member.studentNumber = member.studentId.replaceAll('-', '');
  }
  const long = createSeatingPrintDocument(view);
  expect(long.pageCount).toBeGreaterThan(short.pageCount);
  expect(long.html).toContain('font-size:9pt');
  expect(long.html.match(/data-student-id=/g)).toHaveLength(400);
  expect(long.html).toContain('第 19–20 列');
});

test('history rendering uses only its snapshot and escapes executable-looking text', () => {
  const view = printView(2, 3, 5);
  view.stale = true;
  view.rosterChanged = true;
  view.latestVersionId = '10000000-0000-4000-8000-000000009999';
  view.payload.className = '<img src=x onerror="alert(1)">';
  view.payload.arrangement.members[0]!.displayName = '<script>alert(1)</script>&"\'';
  view.payload.arrangement.layout.unavailable = [{ row: 2, column: 3 }];
  const document = createSeatingPrintDocument(view);
  expect(document.html).not.toContain('<script>');
  expect(document.html).not.toContain('<img ');
  expect(document.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
  expect(document.html).toContain("default-src 'none'");
  expect(document.html).toContain('不可用');
  expect(document.html).toContain('锁定');
  expect(document.html).not.toContain(view.latestVersionId);
});

test('print rejects incomplete or mismatched input without producing a partial document', () => {
  const view = printView();
  view.payload.arrangement.assignments.pop();
  expect(() => createSeatingPrintDocument(view)).toThrow();
  const mismatch = printView();
  mismatch.record.classId = '10000000-0000-4000-8000-000000009999';
  expect(() => createSeatingPrintDocument(mismatch)).toThrow(/不一致/);
});
