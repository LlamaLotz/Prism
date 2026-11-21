import { test, expect } from '@playwright/test';

const url = '/tests/notebook/app-harness.html';

/**
 * The optical engine is opt-in and must never replace the stable CSS titlebar
 * when WebGPU is unavailable. Headless Chromium is forced here to simulate a
 * device without a usable adapter.
 */
const withoutWebGpu = () => {
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: undefined,
  });
};

test.describe('optical titlebar fallback', () => {
  test('stable gloss keeps the CSS titlebar only', async ({ page }) => {
    await page.addInitScript(withoutWebGpu);
    await page.goto(`${url}?theme=gloss&mode=dark&view=editor&glass=stable`);
    await expect(page.locator('.titlebar-host')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('.optical-titlebar-backdrop')).toHaveCount(0);
  });

  test('optical requests fall back when WebGPU is missing', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.addInitScript(withoutWebGpu);
    await page.goto(`${url}?theme=gloss&mode=dark&view=editor&glass=optical&bg=stars`);
    await expect(page.locator('.titlebar-host')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('.optical-titlebar-backdrop')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
