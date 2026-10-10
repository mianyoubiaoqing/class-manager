import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { schoolRosterHeaders } from '../src/shared/roster-fields.ts';

const output = path.resolve('output/playwright/school-roster');
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(path.join(output, 'run-'));
const runtime = isolatedElectronRuntime('school-roster-');
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: path.join(root, 'data'),
  TEMP: path.join(runtime.local, 'temp'),
  TMP: path.join(runtime.local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE;
const report = { status: 'running', root, packaged: !!packaged, checks: [], errors: [] };
let app, page;
const call = async (method, input) => {
  const result = await page.evaluate(({ method, input }) => window.classManager[method](input), {
    method,
    input,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const files = (paths) =>
  app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, paths);
const saveFile = (file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
const gate = (text) => report.checks.push(text);
try {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('学校花名册');
  sheet.mergeCells('B1:R1');
  sheet.getCell('B1').value = '合成学校花名册';
  sheet.getRow(2).values = schoolRosterHeaders;
  sheet.getRow(4).values = [
    '0001',
    '合成甲',
    '女',
    '2010年9月',
    '110101201009010012',
    'G110101201009010012',
    '0003456',
    '0007890',
    '13800000001',
    '合成父亲',
    '110101198001010012',
    '13800000002',
    '合成母亲',
    '110101198201010012',
    '13800000003',
    '合成街道1号',
    '是',
    '是，建档立卡',
  ];
  sheet.mergeCells('B77:Q77');
  const roster = path.join(root, '合成花名册.xlsx');
  const archive = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  const sheetXml = 'xl/worksheets/sheet1.xml';
  archive.file(
    sheetXml,
    (await archive.file(sheetXml).async('string')).replace(
      '<sheetData>',
      '<cols><col min="19" max="16384" width="10" customWidth="1"/></cols><sheetData>',
    ),
  );
  await fs.writeFile(
    roster,
    await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  app = await electron.launch({
    executablePath: packaged ?? runtime.executablePath,
    args: packaged ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw Error('Offline synthetic acceptance');
    };
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  const main = page.getByRole('navigation', { name: '主导航', exact: true });
  await main.getByRole('button', { name: '班主任管理', exact: true }).click();
  await page.getByRole('button', { name: '新建班级', exact: true }).click();
  await page.getByLabel('班级名称', { exact: true }).fill('合成花名册班');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '导入学生信息与成绩', exact: true }).click();
  await files([roster]);
  await page.getByRole('button', { name: '选择学生信息 / 成绩文件', exact: true }).click();
  await page.getByRole('heading', { name: '核对资料，保存后就能使用', exact: true }).waitFor();
  await page.getByText('核对 16 项资料', { exact: true }).click();
  await page.getByText('合成父亲', { exact: true }).waitFor();
  await page.getByText('合成母亲', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'import-preview.png'), fullPage: true });
  assert.equal((await call('snapshot')).students.length, 0);
  await page.getByRole('button', { name: '确认保存并开始使用', exact: true }).click();
  const snapshot = await call('snapshot'),
    student = snapshot.students[0];
  const profile = await call('readStudentProfile', {
    epoch: snapshot.epoch,
    studentId: student.id,
  });
  assert.equal(profile.content.fatherPhone, '13800000002');
  assert.equal(profile.content.motherPhone, '13800000003');
  assert.equal(profile.content.birthMonth, '2010-09');
  gate(
    'School XLSX title, row-2 header, repeated parent labels and all 18 fields import through real UI/IPC.',
  );
  await page.getByRole('button', { name: '学生管理', exact: true }).click();
  await page.getByRole('button', { name: '查看 合成甲', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '合成甲 · 学生档案', exact: true });
  assert.equal(await detail.getByLabel('父亲姓名', { exact: true }).inputValue(), '合成父亲');
  assert.equal(
    await detail.getByLabel('母亲联系电话', { exact: true }).inputValue(),
    '13800000003',
  );
  assert.equal(await detail.getByLabel('是否住校', { exact: true }).inputValue(), 'yes');
  await detail.getByLabel('母亲联系电话', { exact: true }).fill('13900000003');
  await detail.getByRole('button', { name: '保存资料', exact: true }).click();
  await detail.waitFor({ state: 'hidden' });
  const exported = path.join(root, '合成导出.xlsx');
  await saveFile(exported);
  await page.getByRole('button', { name: '导出 Excel', exact: true }).click();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.stat(exported).catch(() => null)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const exportedBook = new ExcelJS.Workbook();
  await exportedBook.xlsx.readFile(exported);
  assert.deepEqual(exportedBook.worksheets[0].getRow(1).values.slice(1), schoolRosterHeaders);
  assert.equal(exportedBook.worksheets[0].getCell('O2').value, '13900000003');
  gate('Student management edits parent fields; Excel export round-trips the 18-column roster.');
  await openWorkspacePage(page, '班主任管理', '学生资料');
  await page.getByLabel('档案学生', { exact: true }).selectOption(student.id);
  assert.equal(await page.getByLabel('父亲姓名', { exact: true }).inputValue(), '合成父亲');
  assert.equal(await page.getByLabel('母亲联系电话', { exact: true }).inputValue(), '13900000003');
  await page.screenshot({ path: path.join(root, 'profile-details.png'), fullPage: true });
  gate('The separate student-profile page reads the same complete roster fields.');
  await main.getByRole('button', { name: '教师备课', exact: true }).click();
  const library = page.getByRole('region', { name: '学科教学资源库', exact: true });
  await library.locator('.rl-book').first().click();
  await library.getByRole('heading', { name: '我的课件文件', exact: true }).waitFor();
  await library.getByRole('heading', { name: '课件文字提纲', exact: true }).waitFor();
  const outline = library.getByLabel('课件文字提纲内容', { exact: true });
  await outline.fill('合成课件文字提纲\n教学目标与课堂活动');
  const docx = path.join(root, '合成提纲.docx');
  await saveFile(docx);
  await library.getByRole('button', { name: '导出 Word 提纲（.docx）', exact: true }).click();
  await library.getByText('Word 已导出：', { exact: false }).waitFor();
  assert.ok((await fs.stat(docx)).size > 0);
  await library.getByRole('button', { name: '保存修改', exact: true }).click();
  await library.getByText('已保存到本机，备份会包含此内容。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'courseware-separated.png'), fullPage: true });
  gate(
    'Courseware files and text outline are clearly separate; outline DOCX export and save remain functional.',
  );
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-4000));
  }
  throw error;
} finally {
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await app?.close();
}
