import { test, expect, type Page } from '@playwright/test';

const editor = '[data-workspace-pane="editor"]';
const graph = '[data-workspace-pane="graph"]';
const divider = (page: Page) => page.getByRole('separator', { name: 'Resize note and graph' });
async function boot(page: Page, theme = 'industrial', mode = 'dark', view = 'editor') {
  await page.goto(`/tests/notebook/app-harness.html?theme=${theme}&mode=${mode}&view=${view}`);
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 45000 });
  await page.keyboard.press('Control+Shift+A');
}
async function note(page: Page) { await page.locator('[data-note-path="/vault/Loose.md"]').click(); }

for (const theme of ['industrial', 'glass', 'gloss']) for (const mode of ['light', 'dark']) {
  test(`graph mode button contrast ${theme} ${mode}`, async ({ page }) => {
    await boot(page, theme, mode, 'graph');
    const modes = page.locator(`${graph} .graph-mode-group`);
    const twoD = modes.getByRole('button', { name: '2D Graph', exact: true });
    const threeD = modes.getByRole('button', { name: '3D Graph', exact: true });
    await expect(twoD).toHaveAttribute('aria-pressed', 'true');
    await expect(threeD).toHaveAttribute('aria-pressed', 'false');
    const highContrastText = await page.locator('html').evaluate(el =>
      getComputedStyle(el).getPropertyValue('--nb-text').trim()
    );
    const expectedInactiveColor = await page.evaluate(value => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }, highContrastText);
    await expect.poll(() => threeD.evaluate(el => getComputedStyle(el).color)).toBe(expectedInactiveColor);
    await threeD.focus();
    await expect(threeD).toBeFocused();
    await threeD.click();
    await expect(twoD).toHaveAttribute('aria-pressed', 'false');
    await expect(threeD).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => twoD.evaluate(el => getComputedStyle(el).color)).toBe(
      expectedInactiveColor
    );
  });

  test(`automatic split and both arrangements ${theme} ${mode}`, async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, theme, mode);
    await note(page);
    await expect(page.locator(`${editor} [data-region="editor"]`)).toBeVisible();
    await page.keyboard.press('Control+2');
    await expect(divider(page)).toBeVisible();
    await expect(divider(page)).toHaveAttribute('aria-orientation', 'vertical');
    const before = (await page.locator(editor).boundingBox())!.width;
    await divider(page).press('ArrowRight');
    await expect.poll(async () => (await page.locator(editor).boundingBox())!.width).toBeGreaterThan(before + 10);
    await divider(page).dblclick();
    await expect.poll(async () => Math.abs((await page.locator(editor).boundingBox())!.width - (await page.locator(graph).boundingBox())!.width)).toBeLessThan(2);
    await page.getByRole('button', { name: 'Stack note and graph' }).click();
    await expect(divider(page)).toHaveAttribute('aria-orientation', 'horizontal');
    const first = (await page.locator(editor).boundingBox())!;
    const second = (await page.locator(graph).boundingBox())!;
    expect(second.y).toBeGreaterThan(first.y + first.height);
    const handle = (await divider(page).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 60, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await page.locator(editor).boundingBox())!.height).toBeGreaterThan(first.height + 40);
    await page.keyboard.press('Control+1');
    await expect(divider(page)).toBeVisible();
    await page.keyboard.press('Control+2');
    await expect(page.locator(graph)).toBeFocused();
    await page.getByRole('button', { name: 'Close graph pane' }).click();
    await expect(page.locator(graph)).toBeHidden();
    await expect(page.locator(editor)).toBeVisible();
    await page.keyboard.press('Control+2');
    await expect(divider(page)).toHaveAttribute('aria-orientation', 'horizontal');
    await page.getByRole('button', { name: 'Close note pane' }).click();
    await expect(page.locator(editor)).toBeHidden();
    await note(page);
    await expect(divider(page)).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem('prism_note_graph_layout'));
    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 45000 });
    await page.keyboard.press('Control+4');
    await expect(divider(page)).toHaveAttribute('aria-orientation', 'horizontal');
    expect(await page.evaluate(() => localStorage.getItem('prism_note_graph_layout'))).toBe(stored);
    await expect(page.getByText('Split View', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('graph navigation ignores hidden notes; divider preserves editor and graph nodes', async ({ page }) => {
  await boot(page);
  await note(page);
  await page.keyboard.press('Control+5');
  await page.keyboard.press('Control+2');
  await expect(page.locator(graph)).toBeVisible();
  await expect(divider(page)).toHaveCount(0);
  await note(page);
  await page.locator(editor).getByTitle('Edit mode: Switch to the raw markdown editor.', { exact: true }).click();
  const content = page.locator(`${editor} .cm-content`);
  await expect(content).toBeVisible();
  await content.fill('Unsaved split layout text');
  await content.evaluate(el => { (window as any).__editorNode = el; });
  await page.locator(`${graph} svg`).last().evaluate(el => { (window as any).__graphNode = el; });
  await divider(page).press('ArrowRight');
  await page.getByRole('button', { name: 'Stack note and graph' }).click();
  await divider(page).press('ArrowDown');
  await expect(content).toContainText('Unsaved split layout text');
  expect(await content.evaluate(el => el === (window as any).__editorNode)).toBe(true);
  expect(await page.evaluate(() => (window as any).__graphNode.isConnected)).toBe(true);
  await page.getByRole('button', { name: 'Arrange side by side' }).click();
  const saved = await page.evaluate(() => localStorage.getItem('prism_note_graph_layout'));
  await page.setViewportSize({ width: 600, height: 700 });
  await expect(divider(page)).toHaveAttribute('aria-orientation', 'vertical');
  await expect.poll(async () => Math.abs((await page.locator(editor).boundingBox())!.width - (await page.locator(graph).boundingBox())!.width)).toBeLessThan(2);
  expect(await page.evaluate(() => localStorage.getItem('prism_note_graph_layout'))).toBe(saved);
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect.poll(async () => (await page.locator(editor).boundingBox())!.width).toBeGreaterThan((await page.locator(graph).boundingBox())!.width);
});

test('invalid saved split preferences fall back safely', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('prism_note_graph_layout', '{"arrangement":"broken","ratios":{"stacked":-2,"side-by-side":"NaN"}}'));
  await boot(page);
  await page.keyboard.press('Control+4');
  await expect(divider(page)).toHaveAttribute('aria-orientation', 'vertical');
  await expect.poll(async () => Math.abs((await page.locator(editor).boundingBox())!.width - (await page.locator(graph).boundingBox())!.width)).toBeLessThan(2);
});

test('opening a graph node splits, replacing a note keeps the graph, and 3D follows pane size', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, 'gloss', 'dark', 'graph');
  await expect(divider(page)).toHaveCount(0);
  // Folder nodes coexist with note nodes; select by the graph's bound note id.
  const node = page.locator('[data-region="graph"] .nodes > g').filter({ hasText: 'Loose' });
  await expect(node).toBeVisible();
  await node.dispatchEvent('click');
  await expect(divider(page)).toBeVisible();
  await page.locator('[data-note-path="/vault/Loose.md"]').dblclick();
  await expect(divider(page)).toBeVisible();
  const otherNote = page.locator('[data-note-path="/vault/Research/Field notes.md"]');
  if (!(await otherNote.isVisible())) await page.locator('[data-folder-path="Research"]').click();
  await otherNote.click();
  await expect(divider(page)).toBeVisible();
  await expect(page.locator(editor)).toContainText('Field notes');
  await page.locator(graph).getByRole('button', { name: '3D Graph', exact: true }).click();
  const canvas = page.locator(`${graph} canvas`).first();
  await expect(canvas).toBeVisible();
  const checkCanvas = async () => {
    await expect.poll(async () => canvas.evaluate(el => {
      const bounds = el.getBoundingClientRect();
      const parent = el.closest('.relative.w-full.h-full') ?? el.parentElement?.parentElement;
      if (!parent) return false;
      const outer = document.querySelector('[data-workspace-pane="graph"]')!.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.width <= outer.width + 2 && bounds.height <= outer.height + 2;
    })).toBe(true);
  };
  await checkCanvas();
  const first = (await canvas.boundingBox())!;
  await page.getByRole('button', { name: 'Stack note and graph' }).click();
  await checkCanvas();
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(first.width);
  const height = (await canvas.boundingBox())!.height;
  await divider(page).press('ArrowDown');
  await expect.poll(async () => (await canvas.boundingBox())!.height).toBeLessThan(height);
});
