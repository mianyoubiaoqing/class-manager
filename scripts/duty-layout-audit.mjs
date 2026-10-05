import { nodeBundleOptions } from './node-bundle-options.ts';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';

const output = resolve('output/playwright/duty-layout-audit');
mkdirSync(output, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
const galleryResults = [];
let finished = false;
function writeReport(status) {
  writeFileSync(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        startedAt,
        at: new Date().toISOString(),
        status,
        visualReview: 'not-performed',
        results,
        galleryResults,
      },
      null,
      2,
    ),
  );
}
writeReport('running');
// Failed launch/build/decoding must not leave an older successful report as current evidence.
process.once('exit', () => {
  if (!finished) writeReport('failed');
});

// Audit-only rendering probe. Uses synthetic snapshots and no application data or network.
const source = buildSync(
  nodeBundleOptions({
    stdin: {
      contents: `export {createDutyPrintDocument} from './src/core/duty-print';
      export {dutyPrintView} from './tests/fixtures/duty-print-view';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  }),
).outputFiles[0].text;
const module = { exports: {} };
new Function('require', 'module', 'exports', source)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { createDutyPrintDocument, dutyPrintView } = module.exports;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', (route) => route.abort());
  for (const [name, label] of [
    ['long', '\u957f'.repeat(60)],
    ['line-separator', '\u957f\u2028'.repeat(30).trim()],
    ['paragraph-separator', '\u957f\u2029'.repeat(30).trim()],
    ['combining', 'A\u0301'.repeat(30)],
  ]) {
    const view = dutyPrintView(12, 2, 3);
    for (const member of view.payload.arrangement.members) member.displayName = label;
    view.payload.className = '\u73ed'.repeat(80);
    view.payload.title = '\u671f'.repeat(80);
    await page.setContent(createDutyPrintDocument(view).html);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('tbody tr').count(), 48);
    const pages = await page.locator('.sheet').evaluateAll((sheets) =>
      sheets.map((sheet) => {
        const bounds = sheet.getBoundingClientRect();
        const table = sheet.querySelector('table').getBoundingClientRect();
        const footer = sheet.querySelector('footer').getBoundingClientRect();
        const heading = sheet.querySelector('h3').getBoundingClientRect();
        const overflows = [...sheet.querySelectorAll('td')].filter((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          const text = range.getBoundingClientRect();
          const box = cell.getBoundingClientRect();
          return (
            text.top < box.top - 1 ||
            text.bottom > box.bottom + 1 ||
            text.left < box.left - 1 ||
            text.right > box.right + 1
          );
        }).length;
        return {
          page: sheet.dataset.page,
          headerOverlapsTable: heading.bottom > table.top,
          tableOverlapsFooter: table.bottom > footer.top,
          tableOutsidePage: table.bottom > bounds.bottom,
          emptyTable: table.width <= 0 || table.height <= 0,
          overflowingCells: overflows,
        };
      }),
    );
    await page
      .locator('.sheet')
      .first()
      .screenshot({ path: resolve(output, `${name}.png`) });
    const failures = pages.filter(
      (item) =>
        item.headerOverlapsTable ||
        item.tableOverlapsFooter ||
        item.tableOutsidePage ||
        item.emptyTable ||
        item.overflowingCells > 0,
    );
    results.push({ name, pageCount: pages.length, failures });
    console.log(JSON.stringify(results.at(-1)));
  }
  const gallery = await browser.newPage();
  await gallery.route('**/*', (route) =>
    route.request().url().startsWith('file:') ? route.continue() : route.abort(),
  );
  await gallery.goto(pathToFileURL(resolve('docs/handoff/evidence/07-visual-review.html')).href);
  await gallery.evaluate(async () => {
    for (const image of document.images) image.loading = 'eager';
    await Promise.all([...document.images].map((image) => image.decode()));
  });
  for (const width of [360, 1280]) {
    await gallery.setViewportSize({ width, height: 900 });
    const state = await gallery.evaluate(() => ({
      width: window.innerWidth,
      contentWidth: document.documentElement.scrollWidth,
      images: [...document.images].map((image) => ({
        source: image.getAttribute('src'),
        loaded: image.complete && image.naturalWidth > 0,
      })),
    }));
    assert.equal(state.images.length, 15);
    assert.ok(state.images.every((image) => image.loaded));
    assert.ok(state.contentWidth <= state.width);
    galleryResults.push(state);
  }
} finally {
  await browser.close();
}
const failed = results.some((item) => item.failures.length);
writeReport(failed ? 'failed' : 'passed');
finished = true;
if (failed) process.exitCode = 1;
