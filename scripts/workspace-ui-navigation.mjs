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
