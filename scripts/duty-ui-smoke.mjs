import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

/** Teacher-facing flows use real IPC/worker/storage in the isolated synthetic desktop suite. */
export async function exerciseDutyUi(application, page, output) {
  await openWorkspacePage(page, '班主任管理', '值日轮换');
  const area = page.getByRole('region', { name: '值日轮换工作区' });
  const classId = await area.getByLabel('值日班级', { exact: true }).inputValue();
  const snapshot = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(snapshot.ok, true);
  const members = snapshot.value.students.filter((s) => s.active && s.classId === classId);
  assert.ok(members.length >= 5);
  const dates = [0, 1, 2].map((offset) =>
    new Date(Date.now() + offset * 86400000 + 8 * 3600000).toISOString().slice(0, 10),
  );
  async function begin(title, required = 1, secondPost = false) {
    await area.getByRole('button', { name: '新建一期值日', exact: true }).click();
    await area.getByLabel('值日计划名称').fill(title);
    await area.getByLabel('值日开始日期').fill(dates[0]);
    await area.getByLabel('值日结束日期').fill(dates[2]);
    await area.getByRole('button', { name: '添加日期', exact: true }).click();
    assert.equal(await area.getByLabel('已选值日日期').locator('li').count(), 3);
    await area.getByLabel('岗位 1 开始', { exact: true }).fill('14:00');
    await area.getByLabel('岗位 1 结束', { exact: true }).fill('14:20');
    await area.getByLabel('岗位 1 人数', { exact: true }).fill(String(required));
    if (secondPost) {
      await area.getByRole('button', { name: '添加岗位', exact: true }).click();
      await area.getByLabel('岗位 2 名称', { exact: true }).fill('走廊清扫');
      await area.getByLabel('岗位 2 开始', { exact: true }).fill('14:00');
      await area.getByLabel('岗位 2 结束', { exact: true }).fill('14:20');
    }
    await area.getByRole('button', { name: '清空选择', exact: true }).click();
    const choices = area.getByRole('group', { name: '值日参与成员', exact: true });
    for (const member of members.slice(0, 4))
      await choices
        .getByRole('checkbox', {
          name: `${member.studentNumber} · ${member.displayName}`,
          exact: true,
        })
        .check();
    await area.getByRole('button', { name: '生成值日草案', exact: true }).click();
    await area.getByText('未保存值日草案', { exact: true }).waitFor();
    await area.getByText('查看与调整当天岗位', { exact: true }).click();
  }
  async function save(reason, revision) {
    await area.getByLabel('值日保存原因').fill(reason);
    await area.getByRole('button', { name: '确认保存值日', exact: true }).click();
    await page.getByRole('dialog', { name: '确认保存值日计划' }).waitFor();
    await page.getByRole('button', { name: '保存确认版本', exact: true }).click();
    await area
      .getByRole('status')
      .filter({ hasText: `第 ${revision} 版已保存` })
      .waitFor();
    await area
      .getByLabel('已确认值日版本')
      .locator('option')
      .filter({ hasText: `第 ${revision} 版` })
      .waitFor({ state: 'attached' });
  }
  async function latest() {
    await area.getByRole('button', { name: '调整本期最新版本', exact: true }).click();
    await area.getByText('未保存值日草案', { exact: true }).waitFor();
    await area.getByText('查看与调整当天岗位', { exact: true }).click();
  }
  await begin('合成缺口计划', 3);
  await area.getByText('缺口 3', { exact: true }).waitFor();
  assert.equal(
    await area.getByRole('button', { name: '确认保存值日', exact: true }).isDisabled(),
    true,
  );
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '教师备课', exact: true })
    .click();
  await page.getByText('先完成值日表中的当前操作', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '值日表', exact: true, level: 1 }).waitFor();
  await area.getByText('未保存值日草案', { exact: true }).waitFor();
  await area.getByRole('button', { name: '取消值日草案', exact: true }).click();
  await area.getByRole('status').filter({ hasText: '已核对确认历史' }).waitFor();
  await begin('合成页面值日计划', 1, true);
  const firstSlot = area.getByRole('combobox', { name: '教室清扫 第 1 人', exact: true });
  const secondSlot = area.getByRole('combobox', { name: '走廊清扫 第 1 人', exact: true });
  const firstId = await firstSlot.inputValue();
  const secondId = await secondSlot.inputValue();
  await firstSlot.selectOption(secondId);
  await area.getByRole('alert').waitFor();
  assert.equal(await firstSlot.inputValue(), firstId);
  await area.getByText('当日不可用 · 0 人', { exact: true }).click();
  const absentMember = members.find((m) => m.id === firstId);
  const absence = area.getByRole('group', { name: '当天不可用成员', exact: true });
  await absence
    .getByRole('checkbox', {
      name: `${absentMember.studentNumber} · ${absentMember.displayName}`,
      exact: true,
    })
    .click();
  await area.getByText('缺口 1', { exact: true }).waitFor();
  assert.equal(await firstSlot.inputValue(), '');
  await firstSlot.selectOption(firstId);
  await area.getByRole('alert').waitFor();
  assert.equal(await firstSlot.inputValue(), '');
  await absence
    .getByRole('checkbox', {
      name: `${absentMember.studentNumber} · ${absentMember.displayName}`,
      exact: true,
    })
    .click();
  await area.getByText('当日不可用 · 0 人', { exact: true }).waitFor();
  assert.equal(
    await firstSlot.inputValue(),
    '',
    'Restoring availability must not silently fill a vacancy',
  );
  const substitute = members.slice(0, 4).find((m) => m.id !== firstId && m.id !== secondId);
  await firstSlot.selectOption(substitute.id);
  await area.getByText('缺口 0', { exact: true }).waitFor();
  await area.getByText('临时替换', { exact: true }).waitFor();
  await area.getByLabel('查看值日日期').selectOption(dates[2]);
  assert.equal(
    await area.getByRole('button', { name: '标记当天完成', exact: true }).isDisabled(),
    true,
  );
  await area.getByLabel('查看值日日期').selectOption(dates[0]);
  await page.screenshot({ path: join(output, 'duty-draft-desktop.png'), fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await application.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setBounds({ width, height: 844 }),
      width,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await area
        .locator('button')
        .evaluateAll((buttons) =>
          buttons.every((button) => button.scrollWidth <= button.clientWidth + 1),
        ),
      true,
    );
    await page.screenshot({ path: join(output, `duty-draft-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 900 }),
  );
  await save('合成首次保存', 1);
  const versionId = await area.getByLabel('已确认值日版本').inputValue();
  const original = await page.evaluate((input) => window.classManager.readDutyVersion(input), {
    epoch: snapshot.value.epoch,
    versionId,
  });
  assert.equal(original.ok, true);
  const planId = original.value.record.planId;
  const historyInput = { epoch: snapshot.value.epoch, classId, planId };
  await latest();
  await area.getByRole('button', { name: '标记当天完成', exact: true }).click();
  await page.getByRole('button', { name: '应用调整', exact: true }).click();
  await area.locator('.duty-day-detail').getByText('已完成 · 已冻结', { exact: true }).waitFor();
  assert.equal(await firstSlot.isDisabled(), true);
  await save('合成完成记录', 2);
  await latest();
  await area.getByRole('button', { name: '调整分组与参与名单', exact: true }).click();
  const grouping = area.getByRole('region', { name: '当期分组调整' });
  const removing = grouping.getByLabel(`成员分组 ${members[0].studentNumber}`, { exact: true });
  const groupId = await removing.inputValue();
  await removing.selectOption('');
  await grouping
    .getByLabel(`成员分组 ${members[4].studentNumber}`, { exact: true })
    .selectOption(groupId);
  await grouping.getByLabel('第 1 组名称', { exact: true }).fill('合成修订组');
  await grouping.getByRole('button', { name: '应用分组与参与名单', exact: true }).click();
  await page.getByRole('dialog', { name: '确认调整值日草案' }).waitFor();
  await page.getByRole('button', { name: '应用调整', exact: true }).click();
  await area.getByText('草案已调整，尚未保存。', { exact: true }).waitFor();
  await area.getByText('查看与调整当天岗位', { exact: true }).click();
  assert.equal(
    await firstSlot.isDisabled(),
    true,
    'Completed date remains frozen after participant replacement',
  );
  await area.getByRole('button', { name: '重新轮换未冻结日期', exact: true }).click();
  await page.getByRole('button', { name: '应用调整', exact: true }).click();
  await area.getByText('草案已调整，尚未保存。', { exact: true }).waitFor();
  await save('合成名单增删', 3);
  const thirdId = await area.getByLabel('已确认值日版本').inputValue();
  const third = await page.evaluate((input) => window.classManager.readDutyVersion(input), {
    epoch: snapshot.value.epoch,
    versionId: thirdId,
  });
  assert.equal(third.ok, true);
  assert.deepEqual(third.value.payload.arrangement.days[0], {
    ...original.value.payload.arrangement.days[0],
    completed: true,
  });
  assert.equal(third.value.payload.arrangement.participantIds.includes(members[0].id), false);
  assert.equal(third.value.payload.arrangement.participantIds.includes(members[4].id), true);
  await area.getByLabel('已确认值日版本').selectOption(versionId);
  await area.getByText(/历史版本 ·/).waitFor();
  await page.screenshot({ path: join(output, 'duty-history-desktop.png'), fullPage: true });

  async function loseReply(channel) {
    await application.evaluate(({ ipcMain }, channel) => {
      const original = ipcMain._invokeHandlers.get(`cm:${channel}`);
      if (typeof original !== 'function') throw new Error('Missing duty handler');
      globalThis.__cmDutyReplyFixture = { channel, original, lose: true, requests: [] };
      ipcMain.removeHandler(`cm:${channel}`);
      ipcMain.handle(`cm:${channel}`, async (event, input) => {
        const fixture = globalThis.__cmDutyReplyFixture;
        fixture.requests.push(structuredClone(input));
        const result = await original(event, input);
        if (result.ok && fixture.lose) {
          fixture.lose = false;
          throw new Error('Synthetic lost duty reply after successful write');
        }
        return result;
      });
    }, channel);
  }
  async function restoreReply() {
    await application.evaluate(({ ipcMain }) => {
      const fixture = globalThis.__cmDutyReplyFixture;
      ipcMain.removeHandler(`cm:${fixture.channel}`);
      ipcMain.handle(`cm:${fixture.channel}`, fixture.original);
      delete globalThis.__cmDutyReplyFixture;
    });
  }
  await latest();
  await loseReply('adjustDuty');
  try {
    await area.getByRole('button', { name: '重新轮换未冻结日期', exact: true }).click();
    await page.getByRole('button', { name: '应用调整', exact: true }).click();
    await area.getByText(/调整结果未知/).waitFor();
    assert.equal(
      await area.getByRole('button', { name: '确认保存值日', exact: true }).isDisabled(),
      true,
    );
    await area.getByRole('button', { name: '取消值日草案', exact: true }).click();
    await area.getByRole('button', { name: '关闭草案并核对历史', exact: true }).click();
    await area.getByRole('status').filter({ hasText: '已核对确认历史' }).waitFor();
  } finally {
    await restoreReply();
  }
  await latest();
  await area.getByLabel('值日保存原因').fill('合成丢失确认回复');
  await loseReply('confirmDuty');
  try {
    await area.getByRole('button', { name: '确认保存值日', exact: true }).click();
    await page.getByRole('button', { name: '保存确认版本', exact: true }).click();
    await area.getByText(/操作响应中断/).waitFor();
    await area.getByRole('button', { name: '使用原请求重试', exact: true }).click();
    await area.getByRole('status').filter({ hasText: '第 4 版已保存' }).waitFor();
    const requests = await application.evaluate(() => globalThis.__cmDutyReplyFixture.requests);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
  } finally {
    await restoreReply();
  }
  const history = await page.evaluate(
    (input) => window.classManager.dutyHistory(input),
    historyInput,
  );
  assert.equal(history.value.length, 4);
  const old = await page.evaluate((input) => window.classManager.readDutyVersion(input), {
    epoch: snapshot.value.epoch,
    versionId,
  });
  assert.deepEqual(old.value.payload, original.value.payload);
  await begin('合成确认冲突后修正', 1, true);
  await area.getByLabel('值日保存原因').fill('合成跨计划冲突');
  await area.getByRole('button', { name: '确认保存值日', exact: true }).click();
  await page.getByRole('button', { name: '保存确认版本', exact: true }).click();
  await area.getByRole('alert').filter({ hasText: 'DUTY_CONFLICT' }).waitFor();
  assert.equal(await area.getByRole('button', { name: '使用原请求重试', exact: true }).count(), 0);
  await area.getByRole('button', { name: '调整分组与参与名单', exact: true }).click();
  const correction = area.getByRole('region', { name: '当期分组调整' });
  const groupIds = await correction
    .getByLabel(`成员分组 ${members[0].studentNumber}`, { exact: true })
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
  for (const member of members.slice(0, 4))
    await correction
      .getByLabel(`成员分组 ${member.studentNumber}`, { exact: true })
      .selectOption('');
  for (const [index, member] of members.slice(5, 9).entries())
    await correction
      .getByLabel(`成员分组 ${member.studentNumber}`, { exact: true })
      .selectOption(groupIds[index % 2]);
  await correction.getByRole('button', { name: '应用分组与参与名单', exact: true }).click();
  await page.getByRole('button', { name: '应用调整', exact: true }).click();
  await area.getByText('草案已调整，尚未保存。', { exact: true }).waitFor();
  await save('合成修正冲突后确认', 1);
  assert.equal(await area.getByLabel('已确认值日版本').locator('option').count(), 1);
  return { versionId, payload: original.value.payload };
}
