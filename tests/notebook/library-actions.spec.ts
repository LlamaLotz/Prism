import { test, expect, type Page } from '@playwright/test';
const url = '/tests/notebook/study-harness.html?library';
const title = 'Learning across disciplines';
async function options(page: Page, name = title) {
  await page.getByLabel(`Options for ${name}`, { exact: true }).click();
}
async function cover(page: Page) {
  await options(page);
  await page.getByRole('button', { name: 'Choose cover image', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Notebook cover' })).toBeVisible();
}
for (const theme of ['industrial', 'glass', 'gloss']) for (const mode of ['light', 'dark']) {
  test(`card options, focus and covers ${theme} ${mode}`, async ({ page }, info) => {
    await page.goto(`${url}&theme=${theme}&mode=${mode}`);
    await expect(page.getByLabel(`Options for ${title}`)).toBeVisible();
    for (const layout of ['Cards', 'Grid']) {
      await page.getByRole('button', { name: layout, exact: true }).click();
      await options(page);
      await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
      const bounds = await page.locator('.notebook-cover__menu[open] .study-menu-body').boundingBox();
      expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
      await page.getByRole('button', { name: 'Rename', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByLabel(`Options for ${title}`)).toBeFocused();
      await expect(page.getByRole('heading', { name: 'Notebooks', exact: true })).toBeVisible();
    }
    for (const colour of ['Black', 'Grey', 'Accent colour']) {
      await cover(page);
      await page.getByRole('button', { name: colour, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByLabel(`Options for ${title}`)).toBeFocused();
      await expect(page.locator('.notebook-cover').first().locator('.notebook-cover__art')).toHaveAttribute('data-cover', colour === 'Accent colour' ? 'accent' : colour.toLowerCase());
    }
    await page.setViewportSize({ width: 390, height: 700 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await options(page);
    await expect(page.getByRole('button', { name: 'Choose cover image' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('notebook-menu.png') });
  });
}

test('duplicate names, rename, cancel/delete and reuse', async ({ page }) => {
  await page.goto(url);
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await options(page);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('  RESEARCH NOTEBOOK 1  ');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
  await options(page);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('New title');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByLabel('Options for New title')).toBeFocused();
  await options(page, 'New title');
  await page.getByRole('button', { name: 'Delete notebook', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Options for New title')).toBeFocused();
  await options(page, 'New title');
  await page.getByRole('button', { name: 'Delete notebook', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete notebook', exact: true }).click();
  await expect(page.getByLabel('Options for New title')).toHaveCount(0);
  await expect(page.getByLabel('Options for Research notebook 1')).toBeFocused();
  await page.getByRole('button', { name: /^Add notebook/ }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('New title');
  await page.getByRole('dialog').getByRole('textbox').press('Enter');
  await expect(page.getByRole('button', { name: 'Back to notebooks' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to notebooks' }).click();
  await page.getByRole('button', { name: /^Add notebook/ }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(' new TITLE ');
  await page.getByRole('dialog').getByRole('textbox').press('Enter');
  await expect(page.getByRole('alert')).toContainText('already exists');
});

test('image selection, decoding errors and retained cover', async ({ page }) => {
  await page.goto(url);
  await cover(page);
  await page.getByLabel('Cover image', { exact: true }).setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('could not be read');
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40; const c = canvas.getContext('2d')!; c.fillStyle = '#654321'; c.fillRect(0,0,40,40); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.getByLabel('Cover image', { exact: true }).setInputFiles({ name: 'my cover.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const image = page.locator('.notebook-cover').first().locator('img');
  await expect(image).toBeVisible();
  expect(await image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Back to notebooks' }).click();
  await expect(image).toBeVisible();
});

test('add card works in empty and filtered libraries', async ({ page }) => {
  for (const layout of ['Cards', 'Grid']) {
    await page.goto('/tests/notebook/study-harness.html?empty');
    await page.getByRole('button', { name: layout, exact: true }).click();
    await page.getByRole('button', { name: /^Add notebook/ }).click();
    await page.getByRole('dialog').getByRole('textbox').fill(`First ${layout}`);
    await page.getByRole('dialog').getByRole('textbox').press('Enter');
    await page.getByRole('button', { name: 'Back to notebooks' }).click();
    await page.getByLabel('Search notebooks').fill('No matching name');
    await page.getByRole('button', { name: /^Add notebook/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});

test('tool status stays centred through animation, cancellation and retry', async ({ page }) => {
  await page.goto('/tests/notebook/study-harness.html?slowTools');
  await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Quiz', exact: true }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const running = page.locator('.status-mark[data-status="running"]');
  await expect(running).toBeVisible();
  for (let i = 0; i < 4; i++) {
    const offset = await running.evaluate(el => {
      const ring = el.querySelector<SVGCircleElement>('.status-mark__ring')!;
      const dot = el.querySelector<SVGCircleElement>('.status-mark__dot')!;
      const centre = (circle: SVGCircleElement) => new DOMPoint(12,12).matrixTransform(circle.getScreenCTM()!);
      const a = centre(ring), b = centre(dot);
      return Math.hypot(a.x-b.x,a.y-b.y);
    });
    expect(offset).toBeLessThan(.5);
    await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Quiz cancelled', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Generating Quiz…', { exact: false })).toBeVisible();
  await expect(page.locator('.status-mark[data-status="done"]')).toBeVisible();
});
