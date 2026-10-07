export async function openWorkspacePage(page, area, label) {
  const minimise = page.getByRole('button', { name: '收起对话窗口', exact: true });
  if (await minimise.isVisible()) await minimise.click();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: area, exact: true })
    .click();
  const tabs = page.getByRole('navigation', { name: `${area}功能`, exact: true });
  await tabs.waitFor();
  const aliases = { 资料备课: '本地备课', 模型设置: '模型连接', 数据与维护: '数据与备份' };
  const currentLabel = aliases[label] ?? label;
  if (area === '班主任管理') {
    if (['班级名册', '学生资料', '成绩管理'].includes(label)) {
      await tabs.getByRole('button', { name: '学生与成绩', exact: true }).click();
      await page.getByRole('button', { name: '管理班级名册', exact: true }).click();
      await page
        .getByRole('navigation', { name: '学生与成绩工具', exact: true })
        .getByRole('button', { name: label, exact: true })
        .click();
    } else if (['上课点名', '座位编排', '值日轮换'].includes(label)) {
      await tabs.getByRole('button', { name: '上课与排班', exact: true }).click();
      await page
        .getByRole('navigation', { name: '上课与排班工具', exact: true })
        .getByRole('button', { name: label, exact: true })
        .click();
    } else {
      await tabs
        .getByRole('button', { name: label === '成长档案' ? '成长记录' : label, exact: true })
        .click();
    }
    await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
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
        ?.querySelector('[aria-current="page"]')?.textContent === currentLabel,
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
