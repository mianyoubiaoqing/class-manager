import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';

const parent = resolve('output/playwright/floating-assistant');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const { local, executablePath } = isolatedElectronRuntime('floating-assistant-');
const packaged = process.env.CLASS_MANAGER_FLOATING_EXECUTABLE;
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'data'),
  TEMP: join(local, 'temp'),
  TMP: join(local, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: packaged ?? executablePath,
  args: packaged ? [] : ['.'],
  env,
});
const report = {
  status: 'running',
  root,
  packaged: !!packaged,
  gates: [],
  viewports: [],
  errors: [],
  requests: 0,
};
let page;
try {
  await app.evaluate(() => {
    globalThis.__floating = { calls: 0, mode: 'pending', resolve: undefined, aborts: 0 };
    globalThis.fetch = async (_url, init) => {
      const a = globalThis.__floating;
      a.calls++;
      if (a.mode === 'unauthorized') return new Response('{}', { status: 401 });
      if (a.mode === 'proposal') {
        const action = a.proposalSent
          ? { kind: 'reply', text: '合成确认完成。' }
          : { kind: 'createClass', name: '合成浮窗新班' };
        a.proposalSent = true;
        return new Response(
          JSON.stringify({
            id: 'synthetic-floating-proposal',
            model: 'synthetic',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    formatVersion: 1,
                    explanation: '创建合成班级须明确确认',
                    action,
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
      return new Promise((resolve) => {
        a.resolve = () =>
          resolve(
            new Response(
              JSON.stringify({
                id: 'synthetic-floating-response',
                model: 'synthetic',
                choices: [
                  {
                    finish_reason: 'stop',
                    message: { content: '合成回复：小窗收起后任务仍完整完成。' },
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
            ),
          );
        init.signal?.addEventListener('abort', () => {
          a.aborts++;
        });
      });
    };
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button').count(),
    3,
    'Only teaching, class management and settings remain in the sidebar',
  );
  assert.equal(
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '智能对话', exact: true })
      .count(),
    0,
  );
  const call = async (name, input) => {
    const r = await page.evaluate(({ name, input }) => window.classManager[name](input), {
      name,
      input,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.value;
  };
  let snapshot = await call('snapshot');
  snapshot = await call('seedDemo', { epoch: snapshot.epoch });
  await call('saveModelProviderKey', {
    provider: 'deepseek',
    apiKey: 'sk-synthetic-floating-only',
  });
  await page.getByRole('button', { name: '重新读取数据', exact: true }).click();
  const open = () => page.getByRole('button', { name: '打开智能对话小窗', exact: true }).click();
  const close = () => page.getByRole('button', { name: '收起对话窗口', exact: true }).click();
  const input = page.getByLabel('发送消息', { exact: true });
  const panel = page.getByRole('dialog', { name: '业务助手', exact: true });
  await openWorkspacePage(page, '班主任管理', '班级名册');
  await open();
  await input.fill('未发送的合成草稿');
  const file = join(root, '合成参考.txt');
  writeFileSync(file, '这是测试附件，只有合成数据。');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await page.getByRole('button', { name: '上传文件', exact: true }).click();
  await page.getByLabel('待发送附件', { exact: true }).waitFor();
  await close();
  await openWorkspacePage(page, '教师备课', '本地备课');
  await open();
  assert.equal(await input.inputValue(), '未发送的合成草稿');
  await page.getByRole('button', { name: '移除附件 合成参考.txt', exact: true }).waitFor();
  report.gates.push(
    'Draft and actual uploaded attachment survive minimise and cross-page navigation',
  );
  await page.getByLabel('对话当前班级', { exact: true }).selectOption(snapshot.classes[0].id);
  await input.fill('请结合参考资料给我课堂开场白的建议');
  await input.press('Enter');
  await page.getByRole('heading', { name: '理解需求中', exact: true }).waitFor();
  await close();
  await openWorkspacePage(page, '班主任管理', '上课点名');
  await open();
  await page.getByRole('heading', { name: '理解需求中', exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.__floating.calls), 1);
  assert.equal(await app.evaluate(() => globalThis.__floating.aborts), 0);
  await app.evaluate(() => globalThis.__floating.resolve());
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  await page.getByText('合成回复：小窗收起后任务仍完整完成。', { exact: true }).waitFor();
  report.gates.push(
    'In-flight task survives minimise/reopen and cross-page use without abort or repeated transport',
  );
  await page.getByRole('button', { name: '查看全部与管理', exact: true }).click();
  await page.getByRole('heading', { name: '历史会话', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回智能对话', exact: true }).click();
  await input.waitFor();
  report.gates.push(
    'History management and returning to the same conversation work inside the floating window',
  );
  await page.getByRole('button', { name: '展开对话窗口', exact: true }).click();
  await page.getByRole('button', { name: '缩小对话窗口', exact: true }).waitFor();
  assert.equal(await panel.locator('.conversation-page').count(), 1);
  await page.getByRole('button', { name: '缩小对话窗口', exact: true }).click();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await app.evaluate(() => {
    globalThis.__floating.mode = 'unauthorized';
  });
  await input.fill('请给我一条合成课堂建议');
  await input.press('Enter');
  await page.getByRole('heading', { name: '本轮暂停 · 查看原因', exact: true }).waitFor();
  await panel.getByText(/HTTP 401/).waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__floating.calls),
    2,
    '401 is not retried as an argument correction',
  );
  report.gates.push('401 is displayed and stops after one request without argument-retry loops');
  await close();
  await openWorkspacePage(page, '教师备课', '课堂与倒计时');
  await page.getByRole('button', { name: '开始计时', exact: true }).click();
  await open();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await app.evaluate(() => {
    globalThis.__floating.mode = 'proposal';
  });
  await input.fill('请为本地测试创建一个合成班级');
  await input.press('Enter');
  const confirm = page.getByRole('button', { name: '确认正式写入', exact: true });
  await confirm.waitFor();
  assert.equal(await confirm.isDisabled(), true);
  const before = await call('snapshot');
  assert.equal(
    before.classes.some((c) => c.name === '合成浮窗新班'),
    false,
  );
  await close();
  await page
    .getByRole('navigation', { name: '教师备课功能', exact: true })
    .getByRole('button', { name: '本地备课', exact: true })
    .click();
  await page.getByText('先完成课堂与倒计时中的当前操作', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '课堂与倒计时', level: 1, exact: true }).waitFor();
  await page.getByRole('button', { name: '暂停倒计时', exact: true }).click();
  await open();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.conversation-card button')].some(
      (b) => b.textContent === '确认正式写入' && !b.disabled,
    ),
  );
  await confirm.click();
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  const after = await call('snapshot');
  assert.equal(after.classes.filter((c) => c.name === '合成浮窗新班').length, 1);
  report.gates.push(
    'Unsaved/running business work visibly blocks navigation and assistant execution; explicit confirmation writes exactly once after the business work is settled',
  );
  await input.fill('长草稿'.repeat(150));
  for (const [width, height] of [
    [1440, 960],
    [1024, 768],
    [760, 720],
    [390, 760],
    [640, 500],
  ]) {
    await page.setViewportSize({ width, height });
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setMinimumSize(320, 400);
        w.setSize(width, height);
      },
      { width, height },
    );
    await page.waitForTimeout(100);
    for (const expanded of [false, true]) {
      const expander = page.getByRole('button', {
        name: expanded ? '展开对话窗口' : '缩小对话窗口',
        exact: true,
      });
      if (await expander.isVisible()) await expander.click();
      const geometry = await page.evaluate(() => {
        const box = document.querySelector('.assistant-surface').getBoundingClientRect();
        const composer = document.querySelector('.conversation-composer').getBoundingClientRect();
        const launcher = document.querySelector('.assistant-capsule');
        const l = launcher.getBoundingClientRect();
        const failures = [];
        if (document.documentElement.scrollWidth > innerWidth + 1) failures.push('page overflow');
        if (
          box.left < -1 ||
          box.right > innerWidth + 1 ||
          box.top < -1 ||
          box.bottom > innerHeight + 1
        )
          failures.push('panel outside viewport');
        if (composer.bottom > box.bottom + 1 || composer.right > box.right + 1)
          failures.push('composer clipped');
        if (!launcher.contains(document.elementFromPoint(l.x + l.width / 2, l.y + l.height / 2)))
          failures.push('capsule covered');
        return {
          width: innerWidth,
          height: innerHeight,
          box: {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
            height: box.height,
          },
          failures,
        };
      });
      report.viewports.push({ requestedWidth: width, expanded, ...geometry });
      assert.deepEqual(geometry.failures, [], JSON.stringify(geometry));
      await page.screenshot({
        path: join(root, `floating-${width}-${expanded ? 'large' : 'small'}.png`),
        fullPage: true,
      });
    }
  }
  await input.press('Escape');
  await page.getByRole('button', { name: '打开智能对话小窗', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: '打开智能对话小窗', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  report.gates.push('Escape minimises and returns keyboard focus to the capsule');
  await page.setViewportSize({ width: 1440, height: 960 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await openWorkspacePage(page, '班主任管理', '班级名册');
  await open();
  const shrink = page.getByRole('button', { name: '缩小对话窗口', exact: true });
  if (await shrink.isVisible()) await shrink.click();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByRole('heading', { name: '告诉助手，你想完成什么？', exact: true }).waitFor();
  await page.screenshot({ path: join(root, 'floating-assistant-preview.png') });
  assert.deepEqual(report.errors, []);
  report.requests = await app.evaluate(() => globalThis.__floating.calls);
  report.status = 'passed';
} catch (e) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {});
    report.failureState = await page
      .locator('.assistant-surface')
      .innerText()
      .catch(() => 'not available');
  }
  report.status = 'failed';
  report.errors.push(e.message);
  throw e;
} finally {
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.status === 'failed') await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
