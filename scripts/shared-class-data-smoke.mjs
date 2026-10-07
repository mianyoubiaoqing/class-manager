import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

const parent = path.resolve('output/playwright/shared-class-data');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const { local, executablePath } = isolatedElectronRuntime('shared-class-data-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: path.join(root, 'data'),
  TEMP: path.join(local, 'temp'),
  TMP: path.join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.CLASS_MANAGER_SHARED_EXECUTABLE;
const report = {
  status: 'running',
  root,
  packaged: !!packaged,
  gates: [],
  errors: [],
  networkRequests: 0,
};
let app, page;
const save = async () =>
  fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
const gate = async (name) => {
  report.gates.push(name);
  await save();
};
const call = async (method, input) => {
  const result = await page.evaluate(({ method, input }) => window.classManager[method](input), {
    method,
    input,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
async function launch() {
  app = await electron.launch({
    executablePath: packaged || executablePath,
    args: packaged ? [] : ['.'],
    env,
  });
  await app.evaluate(() => {
    globalThis.__sharedNetwork = 0;
    globalThis.fetch = async () => {
      globalThis.__sharedNetwork++;
      throw Error('Isolated offline shared class smoke');
    };
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
}
async function files(paths) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, paths);
}
async function screenshot(name) {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await page.screenshot({ path: path.join(root, `${name}.png`), fullPage: true });
}
async function size(width, height) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(380, 600);
      window.setContentSize(width, height);
    },
    { width, height },
  );
  await page.waitForFunction((width) => window.innerWidth === width, width);
}
const main = () => page.getByRole('navigation', { name: '主导航', exact: true });
const tabs = () => page.getByRole('navigation', { name: '班主任管理功能', exact: true });
try {
  await launch();
  await size(1440, 960);
  await main().getByRole('button', { name: '班主任管理', exact: true }).click();
  await page.getByRole('heading', { name: '先把班级资料准备好', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建班级', exact: true }).click();
  await page.getByLabel('班级名称', { exact: true }).fill('共享资料合成班');
  await page.getByRole('button', { name: '保存班级', exact: true }).click();
  await screenshot('37-initial');
  const roster = path.join(root, '名单.csv'),
    scores = path.join(root, '成绩.csv');
  await fs.writeFile(roster, '学号,姓名\n001,合成甲\n002,合成乙\n003,合成丙');
  await fs.writeFile(
    scores,
    '姓名,语文,数学,英语\n合成甲,116,128,120\n合成乙,108,119,105\n合成丙,95,缺考,100',
  );
  await files([roster, scores]);
  await page.getByRole('button', { name: '选择学生信息 / 成绩文件', exact: true }).click();
  await page.getByRole('heading', { name: '核对资料，保存后就能使用', exact: true }).waitFor();
  let snapshot = await call('snapshot');
  assert.equal(snapshot.students.length, 0);
  assert.equal((await call('listExams', { epoch: snapshot.epoch })).length, 0);
  await page.getByLabel('统一导入考试名称', { exact: true }).fill('合成十月考试');
  await page.getByRole('button', { name: '更新核对结果', exact: true }).click();
  await page
    .getByRole('button', { name: '确认保存并开始使用', exact: true })
    .waitFor({ state: 'visible' });
  assert.equal(await page.locator('.shared-table-scroll tbody tr').count(), 3);
  await page.getByRole('cell', { name: '116', exact: true }).waitFor();
  await page.getByRole('cell', { name: '128', exact: true }).waitFor();
  await page.getByText('共 3 条核对结果 · 原表 6 行 · 每页 3 条', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '资料下一页' }).isDisabled(), true);
  await screenshot('38-preview');
  await page.getByRole('button', { name: '确认保存并开始使用', exact: true }).click();
  await page.getByRole('heading', { name: '共享资料合成班，资料已准备好', exact: true }).waitFor();
  await page.getByText('已保存 3 名学生和 1 次考试', { exact: true }).waitFor();
  snapshot = await call('snapshot');
  assert.equal(snapshot.students.length, 3);
  assert.deepEqual(snapshot.students.map((s) => s.studentNumber).sort(), ['001', '002', '003']);
  await screenshot('40-overview');
  await gate(
    'Two files preview without writes, then save one shared roster and one exam through real Main/worker/SQLite.',
  );
  await tabs().getByRole('button', { name: '学生与成绩', exact: true }).click();
  await page.getByRole('heading', { name: '学生与成绩，放在一起看', exact: true }).waitFor();
  await page
    .getByRole('navigation', { name: '学生资料分类', exact: true })
    .getByRole('button', { name: '考试成绩', exact: true })
    .click();
  await page.getByRole('heading', { name: '成绩变化', exact: true }).waitFor();
  await page.getByRole('cell', { name: '116', exact: true }).waitFor();
  await screenshot('41-student-scores');
  await page.getByRole('button', { name: /合成丙.*003/ }).click();
  await page.getByRole('cell', { name: '缺考', exact: true }).waitFor();
  await gate(
    'Student detail reads saved raw scores; absent values remain absent and incomplete totals are labelled.',
  );
  await tabs().getByRole('button', { name: '上课与排班', exact: true }).click();
  await page.getByRole('heading', { name: '上课点名', exact: true }).waitFor();
  await page.getByRole('button', { name: '到课并下一位', exact: true }).click();
  await page.getByRole('button', { name: '迟到并下一位', exact: true }).click();
  await page.getByRole('button', { name: '请假', exact: true }).click();
  await page.getByRole('button', { name: '保存点名记录', exact: true }).click();
  await page.getByRole('button', { name: '确认保存点名', exact: true }).click();
  await page.getByText('点名记录已保存，后续更正会保留原版本。', { exact: true }).waitFor();
  await tabs().getByRole('button', { name: '学生与成绩', exact: true }).click();
  await page
    .getByRole('navigation', { name: '学生资料分类' })
    .getByRole('button', { name: '点名记录', exact: true })
    .click();
  await page.locator('.shared-attendance-row').getByText('请假', { exact: true }).waitFor();
  await gate(
    'The imported roster is immediately usable for roll call; saved attendance reappears in the same student detail.',
  );
  await tabs().getByRole('button', { name: '班级总览', exact: true }).click();
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  await fs.writeFile(
    scores,
    '姓名,语文,数学,英语\n合成甲,120,132,125\n合成乙,110,120,110\n合成丙,100,115,108',
  );
  await files([scores]);
  await page.getByRole('button', { name: '选择学生信息 / 成绩文件', exact: true }).click();
  await page.getByRole('heading', { name: '核对资料，保存后就能使用', exact: true }).waitFor();
  await page.getByLabel('统一导入考试名称', { exact: true }).fill('合成十一月考试');
  await page.getByRole('button', { name: '更新核对结果', exact: true }).click();
  await page.getByRole('button', { name: '确认保存并开始使用', exact: true }).click();
  await page.getByText('已保存 3 名学生和 2 次考试', { exact: true }).waitFor();
  snapshot = await call('snapshot');
  assert.equal(snapshot.students.length, 3);
  await tabs().getByRole('button', { name: '学生与成绩', exact: true }).click();
  await page.getByRole('button', { name: /合成甲.*001/ }).click();
  await page
    .getByRole('navigation', { name: '学生资料分类' })
    .getByRole('button', { name: '考试成绩', exact: true })
    .click();
  await page.getByText(/同口径总分较上次增加 13 分/).waitFor();
  await page.getByRole('button', { name: '用这些成绩整理成长总结', exact: true }).click();
  await page.getByRole('heading', { name: '成长档案', exact: true }).waitFor();
  await gate(
    'Another score-only exam matches the original student IDs, compares identical scoring scales and seeds the existing growth workflow.',
  );
  await openWorkspacePage(page, '班主任管理', '班级名册');
  await page.getByRole('heading', { name: '班级名册', exact: true }).waitFor();
  await gate('Legacy manual roster tools remain accessible under Student and scores.');
  await main().getByRole('button', { name: '班主任管理', exact: true }).click();
  await tabs().getByRole('button', { name: '班级总览', exact: true }).click();
  for (const [width, height] of [
    [1440, 960],
    [1280, 720],
    [900, 720],
    [390, 700],
  ]) {
    await size(width, height);
    await screenshot(`overview-${width}`);
    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(layout.scroll <= width + 1, `Global horizontal overflow: ${JSON.stringify(layout)}`);
  }
  await size(1440, 960);
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  const bad = path.join(root, '不支持.xlsx');
  await fs.writeFile(bad, 'invalid workbook');
  await files([bad]);
  await page.getByRole('button', { name: '选择学生信息 / 成绩文件', exact: true }).click();
  await page.getByRole('heading', { name: '这个文件还没有读成功', exact: true }).waitFor();
  await screenshot('39-error-recovery');
  assert.equal((await call('snapshot')).students.length, 3);
  await gate(
    'Unreadable files show actionable recovery and do not alter existing data; dashboard avoids global overflow at four widths.',
  );
  report.networkRequests += await app.evaluate(() => globalThis.__sharedNetwork);
  await app.close();
  app = undefined;
  await launch();
  snapshot = await call('snapshot');
  assert.equal(snapshot.students.length, 3);
  assert.equal((await call('listExams', { epoch: snapshot.epoch })).length, 2);
  snapshot = await call('createClass', { epoch: snapshot.epoch, name: '同名核对合成班' });
  const matchingClass = snapshot.classes.find((c) => c.name === '同名核对合成班').id;
  for (const studentNumber of ['M001', 'M002'])
    snapshot = await call('saveStudent', {
      epoch: snapshot.epoch,
      classId: matchingClass,
      studentNumber,
      displayName: '合成同名',
    });
  await page.reload();
  await main().getByRole('button', { name: '班主任管理', exact: true }).click();
  await page.getByLabel('工作台当前管理班级', { exact: true }).selectOption(matchingClass);
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  await fs.writeFile(scores, '姓名,数学\n合成同名,120\n合成新同学,118');
  await files([scores]);
  await page.getByRole('button', { name: '选择学生信息 / 成绩文件', exact: true }).click();
  await page.getByRole('heading', { name: '有 2 条资料，需要你确认是谁', exact: true }).waitFor();
  await screenshot('42-identity-matching');
  await page
    .getByLabel('第2行匹配学生', { exact: true })
    .selectOption(snapshot.students.find((s) => s.studentNumber === 'M001').id);
  await page
    .locator('.shared-match-row')
    .filter({ hasText: '姓名：合成同名' })
    .getByRole('button', { name: '确认这位学生', exact: true })
    .click();
  await page
    .locator('.shared-match-row')
    .filter({ hasText: '姓名：合成新同学' })
    .getByRole('button', { name: '确认新增到本班', exact: true })
    .click();
  await page.getByRole('heading', { name: '核对资料，保存后就能使用', exact: true }).waitFor();
  assert.equal((await call('snapshot')).students.length, 5);
  await page.getByRole('button', { name: '确认保存并开始使用', exact: true }).click();
  await page.getByText('已保存 3 名学生和 1 次考试', { exact: true }).waitFor();
  assert.equal((await call('snapshot')).students.length, 6);
  await gate(
    'Ambiguous names require explicit identity selection; unmatched pupils require explicit addition before any write.',
  );
  report.networkRequests += await app.evaluate(() => globalThis.__sharedNetwork);
  assert.equal(report.networkRequests, 0);
  assert.deepEqual(report.errors, []);
  await gate(
    'Restart preserves shared identities and exams with zero external model calls and zero renderer exceptions.',
  );
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack;
  if (page) {
    await fs
      .writeFile(path.join(root, 'failure-ui.txt'), await page.locator('body').innerText())
      .catch(() => {});
    await screenshot('failure').catch(() => {});
  }
  throw error;
} finally {
  await save();
  if (app) await app.close();
  console.log(JSON.stringify(report, null, 2));
}
