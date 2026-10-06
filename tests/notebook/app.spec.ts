import { test, expect, type Locator, type Page } from '@playwright/test';

const url = '/tests/notebook/app-harness.html';

// The real app boots behind the startup splash; the heavy UI mounts once boot
// finishes. Waiting for the composition's landing element is the readiness
// signal, and every test asserts the app never hit its error boundary.
const boot = async (page: Page, search: string, ready: Locator) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}${search}`);
  await expect(ready).toBeVisible({ timeout: 45000 });
  return errors;
};

/** Rendered contrast of the shared notebook text tokens against the panel plane. */
const contrast = (page: Page, selector: string) => page.locator(selector).evaluate(el => {
  const luminance = (value: string) => {
    const [r, g, b] = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };
  const probe = document.createElement('span');
  el.append(probe);
  const read = (name: string) => { probe.style.color = `var(${name})`; return luminance(getComputedStyle(probe).color); };
  const background = read('--nb-panel');
  const text = read('--nb-text');
  const secondary = read('--nb-secondary');
  probe.remove();
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return { text: ratio(text, background), secondary: ratio(secondary, background) };
});

test.describe('full application composition', () => {
  for (const theme of ['industrial', 'glass', 'gloss']) for (const mode of ['light', 'dark']) {
    test(`notebook library in the app shell ${theme} ${mode}`, async ({ page }) => {
      test.setTimeout(90000);
      const errors = await boot(page, `?theme=${theme}&mode=${mode}`, page.getByRole('heading', { name: 'Notebooks', exact: true }));

      // App owns the theme classes; the fixture only supplies settings.
      const rootClass = await page.evaluate(() => document.documentElement.className);
      expect(rootClass).toContain(`theme-${theme}`);
      expect(rootClass).toContain(`mode-${mode}`);

      await expect(page.getByRole('group', { name: 'Notebook covers' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Open notebook/ }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'New notebook', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Advanced Notebook', exact: true })).toBeVisible();

      const ratios = await contrast(page, '.notebook-library');
      expect(ratios.text).toBeGreaterThanOrEqual(4.5);
      expect(ratios.secondary).toBeGreaterThanOrEqual(4.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      await page.screenshot({ path: `output/playwright/app-library-${theme}-${mode}.png` });
      expect(errors).toEqual([]);
    });

    test(`AI sidebar in the app shell ${theme} ${mode}`, async ({ page }) => {
      test.setTimeout(90000);
      const errors = await boot(page, `?theme=${theme}&mode=${mode}&view=editor`, page.locator('.study-assistant'));

      // The sidebar opens on the shared conversation, which owns the composer.
      const shared = page.locator('.study-assistant');
      await expect(shared.getByRole('combobox', { name: 'Chat model' })).toBeVisible();
      await expect(shared.getByRole('button', { name: /Agent (ON|OFF)/ })).toBeVisible();
      await expect(shared.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      let ratios = await contrast(page, '.study-assistant');
      expect(ratios.text).toBeGreaterThanOrEqual(4.5);
      expect(ratios.secondary).toBeGreaterThanOrEqual(4.5);

      // The advanced assistant keeps its own transcript and shares the tokens.
      await shared.getByRole('button', { name: /Advanced assistant/ }).click();
      const advanced = page.locator('.ai-sidebar');
      await expect(advanced).toBeVisible();
      await expect(advanced.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      expect(await advanced.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      ratios = await contrast(page, '.ai-sidebar');
      expect(ratios.text).toBeGreaterThanOrEqual(4.5);
      expect(ratios.secondary).toBeGreaterThanOrEqual(4.5);

      await page.screenshot({ path: `output/playwright/app-sidebar-${theme}-${mode}.png` });
      expect(errors).toEqual([]);
    });
  }

  test('opening a notebook from the library loads the workspace panels', async ({ page }) => {
    test.setTimeout(90000);
    const errors = await boot(page, '', page.getByRole('heading', { name: 'Notebooks', exact: true }));
    await page.getByRole('button', { name: /Learning across disciplines/ }).first().click();
    await expect(page.locator('.study-panel')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Back to notebooks' })).toBeVisible();
    await expect(page.locator('[data-panel="chat"]').getByRole('combobox', { name: 'Chat model' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to notebooks' }).click();
    await expect(page.getByRole('heading', { name: 'Notebooks', exact: true })).toBeVisible();
    await page.screenshot({ path: 'output/playwright/app-workspace.png' });
    expect(errors).toEqual([]);
  });

  test('the sidebar model picker persists the chat route through settings', async ({ page }) => {
    test.setTimeout(90000);
    const errors = await boot(page, '?view=editor', page.locator('.study-assistant'));
    await page.getByRole('combobox', { name: 'Chat model' }).click();
    await page.getByRole('option', { name: /Other model/ }).click();
    await expect.poll(() => page.evaluate(() => {
      const call = (window as any).fixtureCalls.find((c: any) => c.command === 'save_runtime_config');
      return call?.args.config.models.routes.CHAT ?? null;
    })).toBe('m2');
    expect(errors).toEqual([]);
  });
});
