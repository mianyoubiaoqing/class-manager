import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

/** Real UI and worker operations, using only the smoke suite's isolated synthetic roster. */
export async function exerciseSeatingUi(application, page, output) {
  await openWorkspacePage(page, '班主任管理', '座位编排');
  const area = page.getByRole('region', { name: '座位编排工作区' });
  await area.getByRole('button', { name: '新建座位草案', exact: true }).waitFor();
  await area.getByRole('button', { name: '新建座位草案', exact: true }).click();
  await area.getByText('未保存草案', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '学生与成绩', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await area.getByRole('button', { name: '确认保存座位', exact: true }).isDisabled(),
    true,
  );
  await area.getByRole('button', { name: '布局', exact: true }).click();
  await area.locator('[data-seat="10:6"]').click();
  await area.locator('[data-seat="10:6"][aria-label*="不可用"]').waitFor();
  await area.getByRole('button', { name: '随机编排', exact: true }).click();
  await area.getByText('未安排 0', { exact: true }).waitFor();
  const classId = await area.getByLabel('座位班级', { exact: true }).inputValue();
  const snapshot = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(snapshot.ok, true);
  const member = snapshot.value.students.find((item) => item.active && item.classId === classId);
  await area.getByLabel('调位学生', { exact: true }).selectOption(member.id);
  const selected = area.locator('.seating-cell.selected');
  const originalSeat = await selected.getAttribute('data-seat');
  await area.getByRole('button', { name: '锁定学生座位', exact: true }).click();
  await selected.locator('svg').waitFor();
  await area.getByRole('button', { name: '随机编排', exact: true }).click();
  await area.getByRole('button', { name: '随机编排', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[aria-label="调位学生"]').disabled);
  assert.equal(await selected.getAttribute('data-seat'), originalSeat);
  await area.getByRole('button', { name: '调位', exact: true }).click();
  const target = originalSeat === '1:1' ? '1:2' : '1:1';
  await area.locator(`[data-seat="${target}"]`).click();
  await area.getByRole('alert').filter({ hasText: /解锁/ }).waitFor();
  assert.equal(await selected.getAttribute('data-seat'), originalSeat);
  await area.getByRole('button', { name: '解锁学生座位', exact: true }).click();
  await area.getByRole('button', { name: '锁定学生座位', exact: true }).waitFor();
  await area.locator(`[data-seat="${target}"]`).click();
  await area.locator(`[data-seat="${target}"].selected`).waitFor();
  await area.getByRole('button', { name: '布局', exact: true }).click();
  await area.locator(`[data-seat="${target}"]`).click();
  await area.getByRole('alert').waitFor();
  assert.equal(
    await area.locator(`[data-seat="${target}"]`).getAttribute('class'),
    'seating-cell  selected',
  );
  await area.getByLabel('座位行数', { exact: true }).fill('1');
  await area.getByRole('button', { name: '应用行列', exact: true }).click();
  await area.getByRole('alert').waitFor();
  assert.equal(await area.locator('[data-seat]').count(), 60);
  await area.getByLabel('座位行数', { exact: true }).fill('10');
  await area.getByLabel('座位保存原因', { exact: true }).fill('合成首次座位方案');
  await page.screenshot({ path: join(output, 'seating-draft-desktop.png'), fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await application.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setBounds({ width, height: 844 }),
      width,
    );
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.screenshot({ path: join(output, 'seating-draft-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1240, height: 820 });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1240, height: 820 }),
  );
  await area.getByRole('button', { name: '确认保存座位', exact: true }).click();
  await page.getByRole('dialog', { name: '确认保存座位方案' }).waitFor();
  await page.getByRole('button', { name: '返回调整', exact: true }).click();
  assert.equal(await area.getByText('未保存草案', { exact: true }).count(), 1);
  await area.getByRole('button', { name: '确认保存座位', exact: true }).click();
  await page.getByRole('button', { name: '保存确认版本', exact: true }).click();
  await area.getByRole('status').filter({ hasText: '第 1 版已保存' }).waitFor();
  await area
    .getByLabel('已确认座位版本')
    .locator('option')
    .filter({ hasText: '第 1 版' })
    .waitFor({ state: 'attached' });
  const historyInput = { epoch: snapshot.value.epoch, classId };
  const firstHistory = await page.evaluate(
    (input) => window.classManager.seatingHistory(input),
    historyInput,
  );
  assert.equal(firstHistory.ok, true);
  assert.equal(firstHistory.value.length, 1);
  const versionId = firstHistory.value[0].id;
  const read = await page.evaluate((input) => window.classManager.readSeatingVersion(input), {
    epoch: historyInput.epoch,
    versionId,
  });
  assert.equal(read.ok, true);
  assert.equal(
    read.value.payload.arrangement.assignments.some((item) => item.row === 10 && item.column === 6),
    false,
  );
  assert.equal(
    read.value.payload.arrangement.assignments.find((item) => item.studentId === member.id).row,
    Number(target.split(':')[0]),
  );
  await area.getByRole('button', { name: '从最新版本调整', exact: true }).click();
  await area.getByRole('button', { name: '随机编排', exact: true }).click();
  await area.getByRole('button', { name: '取消座位草案', exact: true }).click();
  await area.getByRole('status').filter({ hasText: '草案已关闭' }).waitFor();
  const afterCancel = await page.evaluate(
    (input) => window.classManager.readSeatingVersion(input),
    { epoch: historyInput.epoch, versionId },
  );
  assert.deepEqual(afterCancel, read);
  await area.getByRole('button', { name: '从最新版本调整', exact: true }).click();
  await area.getByRole('button', { name: '随机编排', exact: true }).click();
  await area.getByLabel('座位保存原因', { exact: true }).fill('合成再次确认');
  await area.getByRole('button', { name: '确认保存座位', exact: true }).click();
  await page.getByRole('button', { name: '保存确认版本', exact: true }).click();
  await area.getByRole('status').filter({ hasText: '第 2 版已保存' }).waitFor();
  await area
    .getByLabel('已确认座位版本')
    .locator('option')
    .filter({ hasText: '第 2 版' })
    .waitFor({ state: 'attached' });
  await area.getByLabel('已确认座位版本').selectOption(versionId);
  await area.getByText(/历史版本 ·/).waitFor();
  const old = await page.evaluate((input) => window.classManager.readSeatingVersion(input), {
    epoch: historyInput.epoch,
    versionId,
  });
  assert.deepEqual(old.value.payload, read.value.payload);
  await page.screenshot({ path: join(output, 'seating-history-desktop.png'), fullPage: true });
  // Test-only transport fault around the real registered handler: writes still reach the worker.
  async function loseNextReply(channel) {
    await application.evaluate(({ ipcMain }, channel) => {
      const original = ipcMain._invokeHandlers.get(`cm:${channel}`);
      if (typeof original !== 'function') throw new Error('Missing test handler');
      globalThis.__cmSeatReplyFixture = { channel, original, requests: [], lose: true };
      ipcMain.removeHandler(`cm:${channel}`);
      ipcMain.handle(`cm:${channel}`, async (event, input) => {
        const fixture = globalThis.__cmSeatReplyFixture;
        fixture.requests.push(structuredClone(input));
        const result = await original(event, input);
        if (result.ok && fixture.lose) {
          fixture.lose = false;
          throw new Error('Synthetic lost seating reply after successful worker response');
        }
        return result;
      });
    }, channel);
  }
  async function restoreReply() {
    await application.evaluate(({ ipcMain }) => {
      const fixture = globalThis.__cmSeatReplyFixture;
      if (!fixture) return;
      ipcMain.removeHandler(`cm:${fixture.channel}`);
      ipcMain.handle(`cm:${fixture.channel}`, fixture.original);
      delete globalThis.__cmSeatReplyFixture;
    });
  }
  await area.getByRole('button', { name: '从最新版本调整', exact: true }).click();
  await loseNextReply('adjustSeating');
  try {
    await area.getByRole('button', { name: '随机编排', exact: true }).click();
    await area.getByText('操作响应超时，请刷新后重试。', { exact: true }).waitFor();
    await area.getByRole('button', { name: '取消座位草案', exact: true }).click();
    await area.getByRole('button', { name: '关闭草案并核对历史', exact: true }).click();
    await area.getByText(/本地草案已关闭/).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '学生与成绩', exact: true }).isEnabled(),
      true,
    );
  } finally {
    await restoreReply();
  }
  for (const recovery of ['cancel', 'retry']) {
    await area.getByRole('button', { name: '从最新版本调整', exact: true }).click();
    await area.getByLabel('座位保存原因', { exact: true }).fill(`响应丢失合成-${recovery}`);
    await loseNextReply('confirmSeating');
    try {
      await area.getByRole('button', { name: '确认保存座位', exact: true }).click();
      await page.getByRole('button', { name: '保存确认版本', exact: true }).click();
      await area.getByText('操作响应超时，请刷新后重试。', { exact: true }).waitFor();
      if (recovery === 'cancel') {
        await area.getByRole('button', { name: '取消座位草案', exact: true }).click();
        await area.getByRole('status').filter({ hasText: '已核对确认历史' }).waitFor();
      } else {
        await area.getByRole('button', { name: '使用原请求重试', exact: true }).click();
        await area.getByRole('status').filter({ hasText: '第 4 版已保存' }).waitFor();
        const requests = await application.evaluate(() => globalThis.__cmSeatReplyFixture.requests);
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[0], requests[1]);
      }
      const expected = recovery === 'cancel' ? 3 : 4;
      await area
        .getByLabel('已确认座位版本')
        .locator('option')
        .filter({ hasText: `第 ${expected} 版` })
        .waitFor({ state: 'attached' });
      const all = await page.evaluate(
        (input) => window.classManager.seatingHistory(input),
        historyInput,
      );
      assert.equal(all.value.length, expected);
      assert.doesNotMatch(await area.innerText(), /已确认版本未改变/);
    } finally {
      await restoreReply();
    }
  }
  return { versionId, payload: read.value.payload };
}

/** Run after score race fixtures: transfers keep the total roster count unchanged. */
export async function exerciseSeatingCapacity(application, page, snapshot, output) {
  const target = snapshot.classes[0].id;
  const members = snapshot.students.filter(
    (student) => student.active && student.classId === target,
  );
  const moving = snapshot.students
    .filter((student) => student.active && student.classId !== target)
    .slice(0, 61 - members.length);
  let latest = snapshot;
  for (const student of moving) {
    const response = await page.evaluate((input) => window.classManager.saveStudent(input), {
      epoch: snapshot.epoch,
      id: student.id,
      expectedRevision: student.revision,
      classId: target,
      studentNumber: student.studentNumber,
      displayName: student.displayName,
    });
    assert.equal(response.ok, true);
    latest = response.value;
  }
  assert.equal(
    latest.students.filter((student) => student.active && student.classId === target).length,
    61,
  );
  const longMember = latest.students.find(
    (student) => student.classId === target && student.studentNumber.startsWith('DEMO-'),
  );
  const renamed = await page.evaluate((input) => window.classManager.saveStudent(input), {
    epoch: latest.epoch,
    id: longMember.id,
    expectedRevision: longMember.revision,
    classId: target,
    studentNumber: 'Z'.repeat(32),
    displayName: '长'.repeat(60),
  });
  assert.equal(renamed.ok, true);
  latest = renamed.value;
  // Replace the earlier intentionally hanging snapshot fixture with this real mutation receipt.
  await application.evaluate(({ ipcMain }, snapshot) => {
    ipcMain.removeHandler('cm:snapshot');
    ipcMain.handle('cm:snapshot', () => ({ ok: true, value: snapshot }));
  }, latest);
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  await openWorkspacePage(page, '班主任管理', '座位编排');
  const area = page.getByRole('region', { name: '座位编排工作区' });
  await area.getByRole('button', { name: '从最新版本调整', exact: true }).click();
  await area.getByRole('alert').filter({ hasText: '成员或姓名已变化' }).waitFor();
  await area.getByRole('button', { name: '新建座位草案', exact: true }).click();
  await area.getByRole('alert').filter({ hasText: '可用座位不足' }).waitFor();
  await area.getByLabel('座位行数', { exact: true }).fill('11');
  await area.getByRole('button', { name: '应用行列', exact: true }).click();
  await area.getByRole('button', { name: '新建座位草案', exact: true }).click();
  await area.getByText('成员 61', { exact: true }).waitFor();
  await area.getByRole('button', { name: '随机编排', exact: true }).click();
  await area.getByText('未安排 0', { exact: true }).waitFor();
  assert.equal(
    await area.locator('.seating-cell').evaluateAll((cells) =>
      cells.every((cell) => {
        const parent = cell.getBoundingClientRect();
        return [...cell.querySelectorAll('strong, small, .seating-position')].every((text) => {
          const bounds = text.getBoundingClientRect();
          return (
            bounds.bottom <= parent.bottom &&
            bounds.right <= parent.right &&
            bounds.left >= parent.left &&
            text.scrollWidth <= text.clientWidth
          );
        });
      }),
    ),
    true,
    'Longest supported labels must fit their cells',
  );
  await page.screenshot({ path: join(output, 'seating-capacity.png'), fullPage: true });
  await area.getByRole('button', { name: '取消座位草案', exact: true }).click();
  await area.getByRole('status').filter({ hasText: '已核对确认历史' }).waitFor();
}
