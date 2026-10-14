import { test, expect } from '@playwright/test';

for (const failure of ['runtime-warning', 'settings-save-error']) {
  test(`editor preference distinguishes ${failure}`, async ({ page }) => {
    await page.goto(`/tests/notebook/app-harness.html?view=editor&research&${failure}`);
    await page.locator('[data-note-path="/vault/Loose.md"]').click();
    await page.locator('[data-region="editor"]').getByRole('button', { name: 'Source', exact: true }).click();
    if (failure === 'runtime-warning') {
      await expect(page.getByText('Editor preference saved. Semantic search is unavailable.', { exact: true })).toBeVisible();
      await expect(page.getByText('Could not save editor preference', { exact: true })).toHaveCount(0);
      await expect(page.locator('[data-region="editor"]').getByRole('button', { name: 'Source', exact: true })).toHaveAttribute('aria-pressed', 'true');
    } else {
      await expect(page.getByText('Could not save editor preference', { exact: true })).toBeVisible();
      await expect(page.getByText('Editor preference saved. Semantic search is unavailable.', { exact: true })).toHaveCount(0);
    }
  });
}
