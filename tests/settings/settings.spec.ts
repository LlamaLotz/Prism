import { expect, test } from '@playwright/test';

for (const action of ['Save Changes', 'Apply & Close']) {
  test(`${action} awaits completion and prevents duplicate saves and closing`, async ({ page }) => {
    await page.goto('/tests/settings/harness.html');
    const input = page.getByPlaceholder('/path/to/your/notes');
    await input.fill('/draft-vault');
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(input).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).settingsFixture.calls.length)).toBe(1);
    await page.evaluate(() => {
      const f = (window as any).settingsFixture;
      f.resolve({ ...f.calls[0], vaultPath: '/canonical-vault' });
    });
    if (action === 'Save Changes') {
      await expect(input).toHaveValue('/canonical-vault');
      await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0);
  });

  test(`${action} retains edits on failure and allows retry`, async ({ page }) => {
    await page.goto('/tests/settings/harness.html');
    const input = page.getByPlaceholder('/path/to/your/notes');
    await input.fill('/unsaved-vault');
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.evaluate(() => (window as any).settingsFixture.reject(new Error('Disk unavailable')));
    await expect(page.getByRole('alert')).toContainText('Settings were not saved');
    await expect(input).toHaveValue('/unsaved-vault');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Unsaved changes', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.evaluate(() => { const f = (window as any).settingsFixture; f.resolve(f.calls[1]); });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('Apply from the unsaved guard waits; committed warnings keep settings open', async ({ page }) => {
  await page.goto('/tests/settings/harness.html');
  const input = page.getByPlaceholder('/path/to/your/notes');
  await input.fill('/saved-vault');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Apply changes & close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).settingsFixture;
    f.reject(new (window as any).SettingsApplyError('Restart Prism to repair semantic search.', f.calls[0]));
  });
  await expect(page.getByRole('alert')).toContainText('Settings were saved, but could not be fully applied');
  await expect(input).toHaveValue('/saved-vault');
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0);
});
