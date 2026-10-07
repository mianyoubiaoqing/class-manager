import { strict as assert } from 'node:assert';

/** Last test before closing this isolated app: delay read-only IPC using real saved snapshots. */
export async function exerciseExplanationReadRaces(application, page, snapshot, examName) {
  const exams = await page.evaluate(
    (epoch) => window.classManager.listExams({ epoch }),
    snapshot.epoch,
  );
  const exam = exams.value.find((item) => item.definition.name === examName);
  const history = await page.evaluate((input) => window.classManager.scoreHistory(input), {
    epoch: snapshot.epoch,
    examId: exam.examId,
  });
  const previousId = history.value[1].id;
  const previous = await page.evaluate((input) => window.classManager.readScoreVersion(input), {
    epoch: snapshot.epoch,
    versionId: previousId,
  });
  await page.getByRole('button', { name: `查看 ${examName}`, exact: true }).click();
  const section = page.getByRole('region', { name: '成绩解释', exact: true });
  await section.getByRole('button', { name: '查看草案', exact: true }).first().click();
  const editor = section.getByLabel('教师复核记录');
  assert.equal(await editor.isEnabled(), true);
  await application.evaluate(({ ipcMain }, previous) => {
    ipcMain.removeHandler('cm:readScoreVersion');
    ipcMain.handle(
      'cm:readScoreVersion',
      () =>
        new Promise((resolve) => {
          globalThis.__cmExplanationReadRelease = () => resolve(previous);
        }),
    );
  }, previous);
  await page.getByLabel('选择成绩版本').selectOption(previousId);
  assert.equal(await editor.isDisabled(), true, 'Version read must freeze the existing editor');
  await application.evaluate(() => globalThis.__cmExplanationReadRelease());
  await section
    .getByText('历史成绩版本仅供查阅；新解释须选择最新成绩版本。', { exact: true })
    .waitFor();
  await section.getByRole('button', { name: '查看草案', exact: true }).first().click();
  assert.equal(await editor.isEnabled(), true);
  const refreshResult = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(refreshResult.ok, true);
  await application.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('cm:snapshot');
    ipcMain.handle(
      'cm:snapshot',
      () =>
        new Promise((resolve) => {
          globalThis.__cmExplanationSnapshotRelease = () => resolve(result);
        }),
    );
  }, refreshResult);
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  assert.equal(await editor.isDisabled(), true, 'Snapshot read must freeze the existing editor');
  await application.evaluate(() => globalThis.__cmExplanationSnapshotRelease());
  await page.getByRole('region', { name: '考试记录', exact: true }).waitFor();
}
