import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

/** Native file dialogs are deterministic doubles; every score action uses the real visible UI. */
export async function exerciseScoreUi(application, page, root, output) {
  await openWorkspacePage(page, '班主任管理', '成绩管理');
  if (!(await page.getByRole('button', { name: '高级考试配置', exact: true }).isVisible()))
    await page.getByText('更多考试设置', { exact: true }).click();
  await page.getByRole('button', { name: '高级考试配置', exact: true }).click();
  await page.getByLabel('考试名称', { exact: true }).fill('桌面点击合成考试');
  assert.equal(await page.getByLabel('分数口径', { exact: true }).inputValue(), 'unknown');
  await page.getByLabel('分数口径', { exact: true }).selectOption('raw');
  await page.getByRole('button', { name: '移除科目 语文', exact: true }).click();
  await page.getByRole('button', { name: '移除科目 英语', exact: true }).click();
  await page.getByLabel('数学小数位').selectOption('2');
  await page.getByLabel('数学目标分').fill('90');
  const templatePath = join(root, 'ui-template.csv');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, templatePath);
  await page.getByRole('button', { name: 'CSV 模板', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '模板已保存' }).waitFor();
  assert.match(readFileSync(templatePath, 'utf8'), /数学/);
  const snapshot = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(snapshot.ok, true);
  const classId = await page.getByLabel('应考班级').inputValue();
  const roster = snapshot.value.students.filter(
    (student) => student.classId === classId && student.active,
  );
  const path = join(root, 'ui-scores.csv');
  function writeTable(firstScore, header = '数学') {
    writeFileSync(
      path,
      `学生编号,姓名,${header}\n` +
        roster
          .map(
            (student, index) =>
              `${student.studentNumber},${student.displayName},${index === 0 ? firstScore : index === 1 ? '缺考' : index === 2 ? '' : '0'}`,
          )
          .join('\n'),
    );
  }
  writeTable('151');
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, path);
  await page.getByRole('button', { name: '选择成绩文件', exact: true }).click();
  await page.getByRole('region', { name: '导入预览' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '确认入库', exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel('排除行号').fill('2');
  await page.getByLabel('排除原因').fill('合成越界样本，等待核实');
  await page.getByRole('button', { name: '排除此行', exact: true }).click();
  await page.getByRole('button', { name: '重新预览', exact: true }).click();
  await page.getByText(/已排除：合成越界样本/).waitFor();
  writeTable('99', '数学原始分');
  await page.getByRole('button', { name: '选择成绩文件', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '正在预览' }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '取消排除第 2 行', exact: true }).count(), 0);
  await page.getByLabel('原始成绩列').selectOption('数学原始分');
  await page.getByRole('button', { name: '应用列映射', exact: true }).click();
  await page.getByRole('button', { name: '重新预览', exact: true }).click();
  await page
    .getByRole('region', { name: '导入预览' })
    .getByText(/可确认/, { exact: false })
    .waitFor();
  await page.getByLabel('导入或更正原因').fill('首次合成导入');
  assert.equal(await page.getByRole('button', { name: '确认入库', exact: true }).isEnabled(), true);
  await page.getByLabel('数学目标分').fill('95');
  assert.equal(
    await page.getByRole('button', { name: '确认入库', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: '重新预览', exact: true }).click();
  await page
    .getByRole('region', { name: '导入预览' })
    .getByText(/可确认/, { exact: false })
    .waitFor();
  await page.screenshot({ path: join(output, 'scores-preview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '确认入库', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '成绩已保存 · 第 1 版' }).waitFor();
  await page.getByRole('button', { name: '查看 桌面点击合成考试', exact: true }).click();
  await page.getByRole('region', { name: '成绩版本', exact: true }).waitFor();
  await page.getByRole('button', { name: '查询历次成绩', exact: true }).click();
  await page
    .getByRole('region', { name: '学生历次成绩', exact: true })
    .getByText('66.00%', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '更正本次考试', exact: true }).click();
  writeTable('100');
  await page.getByRole('button', { name: '选择成绩文件', exact: true }).click();
  await page.getByRole('region', { name: '版本差异' }).waitFor();
  assert.match(await page.getByRole('region', { name: '版本差异' }).innerText(), /99[\s\S]*100/);
  await page.getByLabel('导入或更正原因').fill('核对原始试卷后的合成更正');
  await page.getByRole('button', { name: '确认入库', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '成绩已保存 · 第 2 版' }).waitFor();
  await page.getByRole('button', { name: '查看 桌面点击合成考试', exact: true }).click();
  const versions = page.getByLabel('选择成绩版本');
  await versions.locator('option').filter({ hasText: '第 1 版' }).waitFor({ state: 'attached' });
  const oldId = await versions
    .locator('option')
    .filter({ hasText: '第 1 版' })
    .getAttribute('value');
  await versions.selectOption(oldId);
  await page.getByText('正在查看历史版本，已有更新。', { exact: false }).waitFor();
  await page
    .getByRole('region', { name: '成绩统计', exact: true })
    .getByText(new RegExp(`目标 ≥ 95(?:\\.00)? 分；1/${roster.length - 2}`))
    .waitFor();
  assert.equal(
    await page.getByRole('button', { name: '更正本次考试', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: '查看最新版本', exact: true }).click();
  await page.getByRole('heading', { name: '桌面点击合成考试 · 第 2 版', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'scores-history-desktop.png'), fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      `Scores overflow ${width}`,
    );
    await page.screenshot({ path: join(output, `scores-history-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: '更正本次考试', exact: true }).click();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'Score editor overflow',
  );
  await page.screenshot({ path: join(output, 'scores-editor-360.png'), fullPage: true });
  await page.setViewportSize({ width: 1240, height: 820 });
  await page.getByRole('button', { name: '选择成绩文件', exact: true }).click();
  await page.getByText(/与当前版本相同/).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '确认入库', exact: true }).isDisabled(),
    true,
  );
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: '选择成绩文件', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已取消文件选择' }).waitFor();
  await page.getByRole('button', { name: '考试记录', exact: true }).click();
  // A delayed header refresh invalidates the page while a real Main file picker is pending.
  const currentSnapshot = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(currentSnapshot.ok, true);
  await application.evaluate(({ ipcMain, dialog }, snapshot) => {
    globalThis.__cmScoreRefreshFixture = {
      originalSnapshot: ipcMain._invokeHandlers.get('cm:snapshot'),
    };
    ipcMain.removeHandler('cm:snapshot');
    ipcMain.handle(
      'cm:snapshot',
      () =>
        new Promise((resolve) => {
          globalThis.__cmScoreRefreshFixture.refresh = () => resolve(snapshot);
        }),
    );
    dialog.showOpenDialog = () =>
      new Promise((resolve) => {
        globalThis.__cmScoreRefreshFixture.picker = () =>
          resolve({ canceled: true, filePaths: [] });
      });
  }, currentSnapshot);
  if (!(await page.getByRole('button', { name: '高级考试配置', exact: true }).isVisible()))
    await page.getByText('更多考试设置', { exact: true }).click();
  await page.getByRole('button', { name: '高级考试配置', exact: true }).click();
  await page.getByLabel('考试名称', { exact: true }).fill('刷新交错合成考试');
  await page.getByLabel('自定义科目名称').fill('校本A');
  await page.getByRole('button', { name: '添加科目', exact: true }).click();
  await page.getByRole('button', { name: '移除科目 校本A', exact: true }).waitFor();
  await page.getByRole('button', { name: '移除科目 校本A', exact: true }).click();
  await page.getByLabel('分数口径', { exact: true }).selectOption('raw');
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  await page.getByRole('button', { name: '选择成绩文件', exact: true }).click();
  await page.getByRole('button', { name: '取消预览', exact: true }).waitFor();
  await application.evaluate(async () => {
    const fixture = globalThis.__cmScoreRefreshFixture;
    const deadline = Date.now() + 5000;
    while (!fixture.refresh || !fixture.picker) {
      if (Date.now() > deadline) throw new Error('Score refresh fixture not reached');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fixture.refresh();
  });
  await page.getByRole('region', { name: '考试记录', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '新建考试导入', exact: true }).isEnabled(),
    true,
  );
  await application.evaluate(() => globalThis.__cmScoreRefreshFixture.picker());
  await page.evaluate(
    (epoch) => window.classManager.listExams({ epoch }),
    currentSnapshot.value.epoch,
  );
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cm:snapshot');
    ipcMain.handle('cm:snapshot', globalThis.__cmScoreRefreshFixture.originalSnapshot);
  });
  return currentSnapshot.value;
}
