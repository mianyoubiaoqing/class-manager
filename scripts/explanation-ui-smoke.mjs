import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** All teacher actions are real UI clicks; only provider transport and native file choice are doubles. */
export async function exerciseExplanationUi(application, page, root, output, examName) {
  const ledgerPath = join(
    await application.evaluate(({ app }) => app.getPath('userData')),
    'deepseek-ledger.json',
  );
  let savedLedger;
  await application.evaluate(() => {
    globalThis.__cmExplanationUi = { mode: 'success', calls: 0, release: null };
    globalThis.__cmExplanationUiFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const fixture = globalThis.__cmExplanationUi;
      fixture.calls++;
      if (fixture.mode === 'offline') throw new TypeError('Synthetic offline transport');
      const wire = JSON.parse(JSON.parse(init.body).messages[1].content);
      const response = () =>
        new Response(
          JSON.stringify({
            id: 'synthetic-teacher-ui',
            model: 'deepseek-flash',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content:
                    fixture.mode === 'invalid'
                      ? '{}'
                      : JSON.stringify({
                          formatVersion: 1,
                          observations: wire.facts.map(({ id, value }) => ({ factId: id, value })),
                          interpretations: [
                            {
                              text: '合成模型解释，尚未核实',
                              uncertainty: '缺少题目资料，无法判断具体原因',
                              evidenceIds: [wire.facts[0].id],
                            },
                          ],
                          questions: [
                            { text: '是否有缺考情况待核实', evidenceIds: [wire.facts[0].id] },
                          ],
                          actions: [
                            { text: '建议教师核对原卷，尚未执行', evidenceIds: [wire.facts[0].id] },
                          ],
                          limitations: ['仅有科目分数，无法判断知识点掌握'],
                        }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      if (fixture.mode === 'pending' || fixture.mode === 'ledger-failure')
        return new Promise((resolve) => {
          fixture.release = () => {
            fixture.mode = 'success';
            resolve(response());
          };
        });
      return response();
    };
  });
  const setMode = (mode) =>
    application.evaluate((_electron, value) => {
      globalThis.__cmExplanationUi.mode = value;
    }, mode);
  const section = page.getByRole('region', { name: '成绩解释', exact: true });
  const prepare = async () => {
    await section.getByRole('button', { name: '预览出站指标', exact: true }).click();
    await section.getByRole('region', { name: '出站确认', exact: true }).waitFor();
  };
  const generate = async () => {
    await prepare();
    await section.getByLabel('我确认发送这些指标并承担 API 费用', { exact: true }).check();
    await section.getByRole('button', { name: '确认生成解释', exact: true }).click();
  };
  try {
    const snapshot = await page.evaluate(() => window.classManager.snapshot());
    assert.equal(snapshot.ok, true);
    const epoch = snapshot.value.epoch;
    assert.equal(
      (
        await page.evaluate(() =>
          window.classManager.saveDeepSeekKey({ apiKey: 'synthetic-teacher-ui-key' }),
        )
      ).ok,
      true,
    );
    await page.getByRole('button', { name: '成绩管理', exact: true }).click();
    await page.getByRole('button', { name: `查看 ${examName}`, exact: true }).click();
    await section.waitFor();
    await prepare();
    assert.equal(
      await section.getByRole('button', { name: '确认生成解释', exact: true }).isDisabled(),
      true,
    );
    await section.getByRole('checkbox', { name: '均分', exact: true }).uncheck();
    assert.equal(await section.getByRole('region', { name: '出站确认', exact: true }).count(), 0);
    await section.getByRole('checkbox', { name: '均分', exact: true }).check();
    await generate();
    await section.getByRole('status').filter({ hasText: '解释草案已保存' }).waitFor();
    const detail = section.getByRole('region', { name: '解释草案详情', exact: true });
    await detail.getByText('模型原稿与引用（未经核实，不随编辑改变）', { exact: true }).click();
    await detail.getByText('合成模型解释，尚未核实', { exact: true }).waitFor();
    await detail.getByLabel('教师复核记录', { exact: true }).fill('教师合成修订：等待核对原卷');
    assert.equal(
      await page.getByRole('button', { name: '班级名册', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: '重新读取数据', exact: true }).isDisabled(),
      true,
    );
    assert.equal(await page.getByLabel('选择成绩版本').isDisabled(), true);
    await detail.getByRole('button', { name: '保存教师编辑', exact: true }).click();
    await section.getByRole('status').filter({ hasText: '教师编辑已保存' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '班级名册', exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await detail.getByLabel('教师复核记录').inputValue(),
      '教师合成修订：等待核对原卷',
    );
    await detail.getByLabel('教师复核记录').fill('未保存内容');
    await detail.getByRole('button', { name: '放弃本次编辑', exact: true }).click();
    assert.equal(
      await detail.getByLabel('教师复核记录').inputValue(),
      '教师合成修订：等待核对原卷',
    );
    await detail.getByRole('button', { name: '丢弃草案', exact: true }).click();
    await detail.getByLabel('教师复核记录').fill('确认期间的新编辑');
    assert.equal(
      await detail.getByRole('button', { name: '确认丢弃草案', exact: true }).count(),
      0,
    );
    await detail.getByRole('button', { name: '放弃本次编辑', exact: true }).click();
    await section.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: join(output, 'explanations-desktop.png') });
    await detail.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: join(output, 'explanation-draft-desktop.png') });
    await page.setViewportSize({ width: 360, height: 780 });
    await section.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: join(output, 'explanations-360.png') });
    await detail.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: join(output, 'explanation-draft-360.png') });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'Explanation page overflow',
    );
    await page.setViewportSize({ width: 1240, height: 820 });

    const countBeforeFailure = await section
      .getByRole('button', { name: '查看草案', exact: true })
      .count();
    await setMode('ledger-failure');
    await generate();
    await application.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!globalThis.__cmExplanationUi.release) {
        if (Date.now() > deadline) throw new Error('Ledger-failure fixture did not start');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    savedLedger = readFileSync(ledgerPath, 'utf8');
    writeFileSync(ledgerPath, '{synthetic-corruption');
    await application.evaluate(() => {
      globalThis.__cmExplanationUi.release();
      globalThis.__cmExplanationUi.release = null;
    });
    await section.getByRole('alert').filter({ hasText: '已重新读取草案列表' }).waitFor();
    assert.equal(
      await section.getByRole('button', { name: '查看草案', exact: true }).count(),
      countBeforeFailure + 1,
    );
    assert.equal(
      await detail.getByLabel('教师复核记录').inputValue(),
      '教师合成修订：等待核对原卷',
    );
    writeFileSync(ledgerPath, savedLedger);
    savedLedger = undefined;

    const savedCount = await section.getByRole('button', { name: '查看草案', exact: true }).count();
    const callsBeforeOffline = await application.evaluate(() => globalThis.__cmExplanationUi.calls);
    await setMode('offline');
    await generate();
    await section.getByRole('alert').filter({ hasText: '连接失败' }).waitFor();
    assert.equal(
      await application.evaluate(() => globalThis.__cmExplanationUi.calls),
      callsBeforeOffline + 1,
      'Offline generation must not automatically retry',
    );
    assert.equal(
      await section.getByRole('button', { name: '查看草案', exact: true }).count(),
      savedCount,
    );
    assert.equal(
      await detail.getByLabel('教师复核记录').inputValue(),
      '教师合成修订：等待核对原卷',
    );
    await page.getByRole('button', { name: '班级名册', exact: true }).click();
    await page.getByRole('button', { name: '成绩管理', exact: true }).click();
    await page.getByRole('button', { name: `查看 ${examName}`, exact: true }).click();
    await section.getByRole('button', { name: '查看草案', exact: true }).last().click();
    assert.equal(
      await detail.getByLabel('教师复核记录').inputValue(),
      '教师合成修订：等待核对原卷',
    );

    await setMode('invalid');
    await generate();
    await section.getByRole('alert').filter({ hasText: '格式不符合' }).waitFor();
    assert.equal(
      await detail.getByLabel('教师复核记录').inputValue(),
      '教师合成修订：等待核对原卷',
    );
    await setMode('pending');
    await generate();
    await section.getByRole('button', { name: '取消解释生成' }).waitFor();
    await application.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!globalThis.__cmExplanationUi.release) {
        if (Date.now() > deadline) throw new Error('Generation transport did not start');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    await section.getByRole('button', { name: '取消解释生成' }).click();
    await application.evaluate(() => {
      globalThis.__cmExplanationUi.release();
      globalThis.__cmExplanationUi.release = null;
    });
    await section.getByRole('alert').filter({ hasText: /取消/ }).waitFor();
    assert.equal(
      await detail.getByLabel('教师复核记录').inputValue(),
      '教师合成修订：等待核对原卷',
    );

    await setMode('success');
    await section.getByLabel('解释范围', { exact: true }).selectOption('student');
    await generate();
    await section.getByRole('status').filter({ hasText: '解释草案已保存' }).waitFor();
    await detail.getByRole('button', { name: '丢弃草案', exact: true }).click();
    await detail.getByRole('button', { name: '确认丢弃草案', exact: true }).click();
    await section.getByRole('status').filter({ hasText: '草案已丢弃' }).waitFor();
    await section.getByLabel('包含已丢弃草案').check();
    assert.match(await section.getByRole('region', { name: '已保存解释' }).innerText(), /已丢弃/);
    await section.getByLabel('包含已丢弃草案').uncheck();

    const exams = await page.evaluate((epoch) => window.classManager.listExams({ epoch }), epoch);
    const exam = exams.value.find((item) => item.definition.name === examName);
    const before = await page.evaluate((input) => window.classManager.readScoreVersion(input), {
      epoch,
      versionId: exam.versionId,
    });
    const roster = before.value.payload.analysis.roster;
    const subject = before.value.payload.analysis.subjects[0];
    const path = join(root, 'explanation-correction.csv');
    writeFileSync(path, `学生编号,${subject.name}\n${roster[0].studentNumber},101\n`);
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: '更正本次考试', exact: true }).click();
    await page.getByRole('button', { name: '选择成绩文件', exact: true }).click();
    await page.getByRole('region', { name: '版本差异' }).waitFor();
    await page.getByLabel('导入或更正原因').fill('合成解释过期验证');
    await page.getByRole('button', { name: '确认入库', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '成绩已保存' }).waitFor();
    await page.getByRole('button', { name: `查看 ${examName}`, exact: true }).click();
    await section
      .getByRole('region', { name: '已保存解释' })
      .getByText(/来源已过期/)
      .first()
      .waitFor();
    await section.getByRole('button', { name: '查看草案', exact: true }).last().click();
    await detail.getByRole('status').filter({ hasText: '来源已过期' }).waitFor();
    assert.equal(
      await detail.getByLabel('教师复核记录').inputValue(),
      '教师合成修订：等待核对原卷',
    );
    const countBeforeRegeneration = await section
      .getByRole('button', { name: '查看草案', exact: true })
      .count();
    await generate();
    await section.getByRole('status').filter({ hasText: '解释草案已保存' }).waitFor();
    assert.equal(
      await section.getByRole('button', { name: '查看草案', exact: true }).count(),
      countBeforeRegeneration + 1,
    );
  } finally {
    if (savedLedger !== undefined) writeFileSync(ledgerPath, savedLedger);
    await page.evaluate(() => window.classManager.deleteDeepSeekKey());
    await application.evaluate(() => {
      if (globalThis.__cmExplanationUi.release) globalThis.__cmExplanationUi.release();
      globalThis.fetch = globalThis.__cmExplanationUiFetch;
      delete globalThis.__cmExplanationUiFetch;
    });
  }
}
