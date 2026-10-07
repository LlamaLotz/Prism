import { test, expect, type Page } from '@playwright/test';

/**
 * The three appearances must be recognisably different, not just legible:
 * Industrial is opaque and square, Liquid Glass is translucent and rounded, and
 * Liquid Gloss is the deepest translucency with the largest radii and a sheen.
 * Frost is carried by static alpha plus a specular edge/sheen, never by a
 * per-element `backdrop-filter` (see the guard in notebook-tokens.css). These
 * assertions read the real rendered surfaces.
 */

const EXPECTED: Record<string, { radius: number; opaque: boolean; shadow: boolean; sheen: boolean }> = {
  industrial: { radius: 0, opaque: true, shadow: false, sheen: false },
  glass: { radius: 16, opaque: false, shadow: true, sheen: false },
  gloss: { radius: 20, opaque: false, shadow: true, sheen: true },
};

const probe = (page: Page) => page.evaluate(() => {
  const panel = document.querySelector('.study-panel') as HTMLElement;
  const style = getComputedStyle(panel);
  const alpha = Number((style.backgroundColor.match(/[\d.]+/g) ?? ['0', '0', '0', '1'])[3] ?? 1);
  const nonZero = /-?\d+(?:\.\d+)?px/g;
  const shadowValues = (style.boxShadow.match(nonZero) ?? []).map(parseFloat);
  return {
    radius: parseFloat(style.borderTopLeftRadius),
    alpha,
    blur: style.backdropFilter !== 'none' && style.backdropFilter !== '',
    // A shadow with only zero offsets is the transparent no-op the Industrial
    // archetype uses, so it counts as no shadow.
    shadow: style.boxShadow !== 'none' && shadowValues.some(v => v !== 0),
    sheen: style.backgroundImage !== 'none' && style.backgroundImage !== '',
    tokenBorder: getComputedStyle(panel).getPropertyValue('--nb-border').trim(),
    tokenHairline: getComputedStyle(panel).getPropertyValue('--nb-hairline').trim(),
  };
});

const open = async (page: Page, theme: string, mode = 'dark') => {
  await page.goto(`/tests/notebook/study-harness.html?theme=${theme}&mode=${mode}&library`);
  await page.getByRole('button', { name: /Open notebook/ }).first().click();
  await expect(page.locator('.study-panel')).toHaveCount(3);
};

test.describe('archetype differentiation', () => {
  for (const [theme, expected] of Object.entries(EXPECTED)) {
    test(`${theme} renders its own shape, surface and depth`, async ({ page }) => {
      await open(page, theme);
      const result = await probe(page);
      expect(result.radius).toBe(expected.radius);
      expect(result.alpha === 1).toBe(expected.opaque);
      expect(result.shadow).toBe(expected.shadow);
      // Notebook surfaces must never stack backdrop filters: they composite over
      // a flat opaque canvas, so the filter samples nothing, changes nothing and
      // only costs GPU work (the app guards against this on WebView2 too).
      expect(result.blur).toBe(false);
      expect(result.sheen).toBe(expected.sheen);
      // Boundary and divider tokens must stay distinct from each other.
      expect(result.tokenBorder).not.toBe(result.tokenHairline);
    });
  }

  test('the three archetypes are not interchangeable', async ({ page }) => {
    const seen: unknown[] = [];
    for (const theme of Object.keys(EXPECTED)) {
      await open(page, theme);
      seen.push(await probe(page));
    }
    const [industrial, glass, gloss] = seen as Array<{ radius: number; alpha: number; blur: boolean }>;
    expect(industrial.radius).toBeLessThan(glass.radius);
    expect(glass.radius).toBeLessThan(gloss.radius);
    // Translucency deepens archetype by archetype: opaque -> glass -> gloss.
    expect(industrial.alpha).toBeGreaterThan(glass.alpha);
    expect(glass.alpha).toBeGreaterThan(gloss.alpha);
    expect(seen.some(surface => (surface as { blur: boolean }).blur)).toBe(false);
  });

  test('light and dark resolve different token values for every archetype', async ({ page }) => {
    for (const theme of Object.keys(EXPECTED)) {
      await open(page, theme, 'dark');
      const dark = await probe(page);
      await open(page, theme, 'light');
      const light = await probe(page);
      expect(dark.tokenBorder).not.toBe(light.tokenBorder);
      expect(dark.alpha === 1).toBe(light.alpha === 1);
    }
  });
});
