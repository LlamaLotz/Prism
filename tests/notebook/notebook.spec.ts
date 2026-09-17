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

for (const theme of ['industrial', 'glass', 'gloss']) for (const mode of ['light', 'dark']) {
  test(`${theme} ${mode} layout`, async ({ page }) => {
    await page.goto(`/tests/notebook/harness.html?theme=${theme}&mode=${mode}`);
    await page.getByRole('heading', { name: 'Learning how we learn' }).click();
    await expect(page.getByText('Retrieval practice and spaced repetition work together.', { exact: false })).toBeVisible();
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
