export async function openWorkspacePage(page, area, label) {
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: area, exact: true })
    .click();
  await page.getByRole('heading', { name: area, exact: true, level: 1 }).waitFor();
  await page
    .getByRole('region', { name: `${area}入口`, exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
  await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
}
