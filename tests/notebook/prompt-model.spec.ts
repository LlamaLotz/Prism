import { test, expect } from '@playwright/test';

const studyUrl = '/tests/notebook/study-harness.html';

for (const target of ['unrelated panel', 'menu', 'ancestor', 'document'] as const) {
  test(`model picker handles scrolling in ${target}`, async ({ page }) => {
    await page.goto(studyUrl);
    await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
    const picker = page.getByRole('combobox', { name: 'Chat model' });
    const menu = page.getByRole('listbox', { name: 'Chat model' });
    await picker.click();
    await expect(menu).toBeVisible();

    // Dispatch at the actual DOM boundary to exercise the captured scroll
    // listener without depending on fixture content overflowing at this size.
    await picker.evaluate(async (trigger, target) => {
      const eventTarget = target === 'document' ? document
        : target === 'ancestor' ? trigger.parentElement!
        : target === 'menu' ? document.querySelector('.model-picker__menu')!
        : document.querySelector('[data-panel="sources"]')!;
      if (!eventTarget) throw new Error(`Missing scroll target: ${target}`);
      eventTarget.dispatchEvent(new Event('scroll'));
      // Allow React to commit dismissal before asserting the menu stays open.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, target);

    const staysOpen = target === 'unrelated panel' || target === 'menu';
    await expect(picker).toHaveAttribute('aria-expanded', String(staysOpen));
    if (staysOpen) {
      await expect(menu).toBeVisible();
      await page.getByRole('option', { name: /Other model/ }).click();
      await expect(picker).toContainText('Other model');
    } else {
      await expect(menu).toBeHidden();
    }
  });
}

for (const action of ['resize', 'outside click', 'Escape'] as const) {
  test(`model picker dismisses on ${action}`, async ({ page }) => {
    await page.goto(studyUrl);
    await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
    const picker = page.getByRole('combobox', { name: 'Chat model' });
    const menu = page.getByRole('listbox', { name: 'Chat model' });
    await picker.click();
    await expect(menu).toBeVisible();
    if (action === 'resize') await page.setViewportSize({ width: 1400, height: 900 });
    else if (action === 'outside click') await page.getByRole('heading', { name: 'Sources', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
    if (action === 'Escape') await expect(picker).toBeFocused();
  });
}


test('prompt bar model picker works in the study notebook and stays compact', async ({ page }) => {
  await page.goto(studyUrl);await page.getByRole('button',{name:'Open notebook',exact:true}).click();
  const picker = page.getByRole('combobox', { name: 'Chat model' });
  await expect(picker).toContainText('Fixture model');
  await picker.click();
  await page.getByRole('option', { name: /Other model/ }).click();
  await expect(picker).toContainText('Other model');
  await page.getByLabel('Message',{exact:true}).fill('Use this model');await page.getByRole('button',{name:'Send',exact:true}).click();
  expect(await page.evaluate(() => (window as any).fixtureCalls.some((c: any) => c.command === 'study_request' && c.args.action === 'setChatProvider' && c.args.payload.providerId === 'm2'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('AI thinking status reflects real request phases and clears when done', async ({ page }) => {
  await page.goto(studyUrl + '?slow');await page.getByRole('button',{name:'Open notebook',exact:true}).click();
  await page.getByRole('button', { name: 'Agent OFF' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Compare these sources');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.ai-status-line__label').filter({hasText:'Generating…'})).toBeVisible();
  await expect(page.getByText('Agent answer using selected sources.', { exact: true })).toBeVisible();
  await expect(page.locator('.ai-status-line__label').filter({hasText:'Generating…'})).toHaveCount(0);
});

test('tool runs report per-task status and failed runs offer retry', async ({ page }) => {
  await page.goto(studyUrl + '?failure');await page.getByRole('button',{name:'Open notebook',exact:true}).click();
  await page.getByRole('button', { name: 'Quiz', exact: true }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('Generating Quiz…', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Generation failed');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Generating Quiz…', { exact: false })).toBeVisible();
});
