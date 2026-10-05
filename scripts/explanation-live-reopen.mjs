import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Separate from paid verification: inspect the saved synthetic draft without any credentials.
const output = resolve('output/live-explanation');
const live = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
assert.equal(live.status, 'passed');
assert.equal(live.requestCount, 1);
assert.equal(existsSync(join(live.dataDirectory, 'credentials', 'deepseek.enc')), false);
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: live.dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  executablePath: live.executablePath,
  args: [],
  cwd: process.cwd(),
  env,
  timeout: 45000,
});
try {
  await application.evaluate(() => {
    globalThis.__unexpectedLiveReopenFetches = 0;
    globalThis.fetch = async () => {
      globalThis.__unexpectedLiveReopenFetches++;
      throw new Error('Live reopen verification forbids networking');
    };
  });
  const page = await application.firstWindow();
  await page.getByText('本地就绪', { exact: true }).waitFor();
  const snapshot = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(snapshot.ok, true);
  const draft = await page.evaluate((input) => window.classManager.readExplanation(input), {
    epoch: snapshot.value.epoch,
    id: live.generation.value.id,
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.value.record.revision, 2);
  assert.equal(
    draft.value.payload.content.teacherNotes,
    '合成数据验收：模型建议未经业务核实，不代表正式评价。',
  );
  assert.deepEqual(draft.value.payload.original, live.original);
  const ledger = await page.evaluate(() => window.classManager.getDeepSeekLedger());
  assert.equal(ledger.ok, true);
  assert.deepEqual(ledger.value, live.ledger);
  await page.getByRole('button', { name: '成绩管理', exact: true }).click();
  await page.getByRole('button', { name: '查看 合成真实接口验收', exact: true }).click();
  await page.getByRole('button', { name: '查看草案', exact: true }).click();
  const detail = page.getByRole('region', { name: '解释草案详情', exact: true });
  await detail.getByText('模型原稿与引用（未经核实，不随编辑改变）', { exact: true }).click();
  await detail.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(output, 'live-draft-reopened.png') });
  assert.equal(await application.evaluate(() => globalThis.__unexpectedLiveReopenFetches), 0);
  const report = {
    status: 'passed',
    at: new Date().toISOString(),
    requestCount: 0,
    persistedRevision: 2,
    originalPreserved: true,
    teacherNotesPreserved: true,
    ledgerPreserved: true,
  };
  writeFileSync(join(output, 'reopen-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application.close();
}
