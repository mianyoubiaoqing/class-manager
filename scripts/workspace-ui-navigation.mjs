export async function openWorkspacePage(page, area, label) {
  const minimise = page.getByRole('button', { name: '收起对话窗口', exact: true });
  if (await minimise.isVisible()) await minimise.click();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: area, exact: true })
    .click();
  const tabs = page.getByRole('navigation', {
    name: area === '班主任管理' ? '班主任资料与记录' : `${area}功能`,
    exact: true,
  });
  await tabs.waitFor();
  const aliases = { 资料备课: '本地备课', 模型设置: '模型连接', 数据与维护: '数据与备份' };
  const currentLabel = aliases[label] ?? label;
  if (area === '班主任管理') {
    const labels = {
      班级名册: '名册与在籍状态',
      学生资料: '学生详细资料',
      成绩管理: '成绩导入与历史',
      座位编排: '智能座位方案',
      值日轮换: '值日轮换',
      成长档案: '成长档案',
    };
    const target = labels[label] ?? label;
    await tabs.getByRole('button', { name: target, exact: true }).click();
    await page
      .getByRole('heading', {
        name:
          {
            班级名册: '花名册',
            学生资料: '学生资料',
            成绩管理: '成绩分析',
            座位编排: '座次表',
            值日轮换: '值日表',
            成长档案: '成长档案',
          }[label] ?? target,
        exact: true,
        level: 1,
      })
      .waitFor();
    return;
  }
  await page
    .getByRole('navigation', { name: `${area}功能`, exact: true })
    .getByRole('button', { name: currentLabel, exact: true })
    .click();
  await page.waitForFunction(
    ({ area, currentLabel }) =>
      [...document.querySelectorAll('nav')]
        .find((nav) => nav.getAttribute('aria-label') === `${area}功能`)
        ?.querySelector('[aria-current="page"]')
        ?.textContent?.trim()
        .endsWith(currentLabel),
    { area, currentLabel },
  );
  await page
    .getByRole('heading', {
      name: currentLabel === '本地备课' ? '从手边资料，开始一节课' : currentLabel,
      exact: true,
      level: 1,
    })
    .waitFor();
  if (label === '模型设置') {
    await page.getByRole('button', { name: '交付人员设置', exact: true }).click();
  }
}
