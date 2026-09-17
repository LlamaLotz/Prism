import { expect, test } from '@playwright/test';

test('research, citations, drafts and navigation stay in one workspace', async ({ page }) => {
  await page.goto('/tests/notebook/harness.html');
  await page.getByRole('heading', { name: 'Learning how we learn' }).click();
  await expect(page.getByText('Retrieval practice and spaced repetition work together.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'source:memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The science of memory' })).toBeVisible();
  await page.getByRole('button', { name: 'Research summary', exact: true }).click();
  await page.getByLabel('Note', { exact: true }).fill('An unsaved idea');
  await page.keyboard.press('Control+2');
  await expect(page.getByText('Other Prism page')).toBeVisible();
  await page.keyboard.press('Control+5');
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue('An unsaved idea');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Switch test vault' }).click();
  await expect(page.getByText('Create your first notebook to start researching.')).toBeVisible();
  await expect(page.getByText('An unsaved idea')).toHaveCount(0);
});

test('imports only selected vault notes and exports answers with references', async ({ page }) => {
  await page.goto('/tests/notebook/harness.html');
  await page.getByRole('heading', { name: 'Learning how we learn' }).click();
  await page.getByRole('button', { name: 'From vault', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Study.md' }).check();
  await page.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixtureCalls.filter((c: any) => c.command === 'notebook_add_source').length)).toBe(1);
  const imported = await page.evaluate(() => (window as any).fixtureCalls.find((c: any) => c.command === 'notebook_add_source').args);
  expect(imported.fields.content).toContain('Original Prism note: Study.md');
  expect(imported.workspaceId).toBe('/vault-a');
  await page.getByRole('button', { name: 'Save to vault', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved Research answer.md' })).toBeVisible();
  const exported = await page.evaluate(() => (window as any).fixtureCalls.find((c: any) => c.command === 'notebook_export').args);
  expect(exported.content).toContain('[source:memory]');
});

for (const theme of ['industrial', 'glass', 'gloss']) for (const mode of ['light', 'dark']) {
  test(`${theme} ${mode} layout`, async ({ page }) => {
    await page.goto(`/tests/notebook/harness.html?theme=${theme}&mode=${mode}`);
    await page.getByRole('heading', { name: 'Learning how we learn' }).click();
    await expect(page.getByText('Retrieval practice and spaced repetition work together.', { exact: false })).toBeVisible();
    const contrasts = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const rgba = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data); };
      const luminosity = (rgb: number[]) => rgb.slice(0, 3).map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((v, c, i) => v + c * [.2126, .7152, .0722][i], 0);
      return Array.from(document.querySelectorAll<HTMLElement>('.nb-muted, .nb-citation, .nb-button:not(:disabled), .nb-input')).filter(el => el.getBoundingClientRect().width > 0).map(el => {
        let parent: HTMLElement | null = el; let bg = [255, 255, 255, 255];
        while (parent) { const c = rgba(getComputedStyle(parent).backgroundColor); if (c[3] === 255) { bg = c; break; } parent = parent.parentElement; }
        const foreground = luminosity(rgba(getComputedStyle(el).color)); const background = luminosity(bg);
        return { text: el.textContent?.slice(0, 40), ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
      });
    });
    for (const color of contrasts) expect(color.ratio, `${theme} ${mode}: ${color.text}`).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `test-results/notebook-${theme}-${mode}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 720, height: 850 });
    await expect(page.getByRole('button', { name: 'Sources', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page.getByRole('button', { name: 'The science of memory', exact: true })).toBeVisible();
    await expect(page.getByLabel('Question', { exact: true })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
