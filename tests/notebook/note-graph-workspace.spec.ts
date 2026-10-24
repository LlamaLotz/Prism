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
const focusChip = (page: Page) => page.locator(`${graph} [data-graph-focus-chip]`);
async function enableTopics(page: Page) {
  const show = page.locator(graph).getByRole('button', { name: 'Show graph layers' });
  await show.click();
  await page.locator(graph).getByRole('checkbox', { name: 'Topics', exact: true }).check();
  await show.click();
  await expect(page.locator(`${graph} .nodes > g[data-node-kind="topic"][data-node-id="topic:research"]`)).toBeVisible();
}

for (const theme of ['industrial', 'gloss']) for (const mode of ['light', 'dark']) {
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

    for (const accent of ['#FDE047', '#4F46E5']) {
      await twoD.click();
      await page.evaluate(async value => {
        const modulePath = '/src/utils/accentColor.ts';
        const { applyAccentColor } = await import(/* @vite-ignore */ modulePath);
        applyAccentColor(value);
      }, accent);
      const expectedAccent = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--color-brand-500)';
        document.body.append(probe);
        const resolved = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return resolved;
      });
      const assertAccentPill = async (button: typeof twoD) => {
        await expect.poll(() => button.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(expectedAccent);
        const style = await button.evaluate(el => {
          const parse = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
          const luminance = (color: string) => {
            const [r, g, b] = parse(color).map(channel => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const background = getComputedStyle(el).backgroundColor;
          const foreground = getComputedStyle(el).color;
          const [lighter, darker] = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
          return { background, contrast: (lighter + 0.05) / (darker + 0.05) };
        });
        expect(style.background).toBe(expectedAccent);
        expect(style.contrast).toBeGreaterThanOrEqual(4.5);
      };

      await expect(twoD).toHaveAttribute('aria-pressed', 'true');
      await assertAccentPill(twoD);
      await threeD.click();
      await expect(twoD).toHaveAttribute('aria-pressed', 'false');
      await expect(threeD).toHaveAttribute('aria-pressed', 'true');
      await assertAccentPill(threeD);
    }

    await threeD.focus();
    await expect(threeD).toBeFocused();
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

test('graph Show menu toggles folder and topic layers and persists them', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, 'industrial', 'dark', 'graph');

  const folderNodes = page.locator(`${graph} .nodes > g[data-node-kind="folder"]`);
  const noteNodes = page.locator(`${graph} .nodes > g[data-node-kind="note"]`);
  const topicResearch = page.locator(`${graph} .nodes > g[data-node-kind="topic"][data-node-id="topic:research"]`);
  const topicLoose = page.locator(`${graph} .nodes > g[data-node-kind="topic"][data-node-id="topic:loose"]`);
  const show = page.locator(graph).getByRole('button', { name: 'Show graph layers' });

  // Folders are on by default.
  await expect(noteNodes.first()).toBeVisible();
  await expect(folderNodes.first()).toBeVisible();
  await show.click();
  const folders = page.locator(graph).getByRole('checkbox', { name: 'Folders', exact: true });
  const topics = page.locator(graph).getByRole('checkbox', { name: 'Topics', exact: true });
  await expect(folders).toBeChecked();
  await expect(topics).not.toBeChecked();

  // Unchecking Folders hides folder nodes immediately and persists.
  await folders.uncheck();
  await expect(folderNodes).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('prism_graph_folders'))).toBe('false');

  await page.reload();
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 45000 });
  await page.keyboard.press('Control+Shift+A');
  await expect(noteNodes.first()).toBeVisible();
  await expect(folderNodes).toHaveCount(0);

  // Enabling Topics adds @tag nodes resolved from full vault paths.
  await show.click();
  await expect(folders).not.toBeChecked();
  await expect(topics).not.toBeChecked();
  await topics.check();
  await expect(topicResearch).toBeVisible();
  await expect(topicLoose).toBeVisible();
  await expect(topicResearch).toContainText('@research');
  expect(await page.evaluate(() => localStorage.getItem('prism_graph_topics'))).toBe('true');
  // The checkbox row click must not dismiss the menu.
  await expect(topics).toBeChecked();
  await expect(page.locator(graph).getByRole('menu', { name: 'Show graph layers' })).toBeVisible();

  // Topic activation focuses the tag set: no editor split, no missing-note
  // dialog, and no Topics view navigation.
  await page.locator(`${graph} .graph-canvas`).click({ position: { x: 20, y: 20 } });
  await topicResearch.dispatchEvent('click');
  await expect(divider(page)).toHaveCount(0);
  await expect(page.locator(editor)).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-region="topics"]')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 45000 });
  await page.keyboard.press('Control+Shift+A');
  await expect(topicResearch).toBeVisible();
  await expect(topicLoose).toBeVisible();

  await show.click();
  await expect(topics).toBeChecked();
  await topics.uncheck();
  await expect(topicResearch).toHaveCount(0);
  await expect(topicLoose).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('prism_graph_topics'))).toBe('false');
});

test('graph header keeps one row and hides the hint by container width', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, 'industrial', 'dark', 'graph');

  const hint = page.locator(`${graph} .graph-hint`);
  const title = page.locator(`${graph} .graph-header-title`);
  const controls = page.locator(`${graph} .graph-header-controls`);
  const showLabel = page.locator(`${graph} .graph-show-label`);
  const assertOneRow = async () => {
    const titleBox = (await title.boundingBox())!;
    const controlsBox = (await controls.boundingBox())!;
    expect(Math.abs((titleBox.y + titleBox.height / 2) - (controlsBox.y + controlsBox.height / 2))).toBeLessThan(6);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(controlsBox.x + 2);
  };

  // Wide pane: the inline hint is visible and the header is one row.
  await expect(hint).toBeVisible();
  await assertOneRow();

  // Narrow pane (~436px after the sidebar rail collapses): hint hides, but
  // title and controls still share a row.
  await page.setViewportSize({ width: 700, height: 960 });
  await expect(hint).toBeHidden();
  expect(await page.locator(graph).evaluate((el) => el.clientWidth)).toBeLessThan(720);
  await assertOneRow();

  // Very narrow pane: the Show label is icon-only, mode buttons stay compact.
  await page.setViewportSize({ width: 500, height: 960 });
  await expect(showLabel).toBeHidden();
  expect(await page.locator(graph).evaluate((el) => el.clientWidth)).toBeLessThanOrEqual(520);
  await assertOneRow();
  const modeWidths = await page.locator(`${graph} .graph-mode-group .seg-button`).evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().width)
  );
  for (const width of modeWidths) expect(width).toBeGreaterThanOrEqual(30);
  for (const width of modeWidths) expect(width).toBeLessThanOrEqual(36);
  await expect(page.locator(`${graph}`).getByRole('button', { name: 'Show graph layers' })).toBeVisible();
});

test('folder hub hover previews and click pins its subtree', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, 'industrial', 'dark', 'graph');

  const folder = page.locator(`${graph} .nodes > g[data-node-id="folder:A"]`);
  const folderCircle = folder.locator('circle.node-circle');
  const noteA = page.locator(`${graph} .nodes > g[data-node-id="A/Note.md"]`);
  const loose = page.locator(`${graph} .nodes > g[data-node-id="Loose.md"]`);
  const chip = focusChip(page);
  const status = page.locator('[data-graph-focus-status]');
  await expect(folderCircle).toBeVisible();

  // Hover is a transient preview of the folder plus its descendants. The
  // wiki-linked note outside the folder stays dimmed, and previews are silent.
  await folderCircle.hover();
  await expect(chip).toContainText('Preview: A');
  await expect(chip).toHaveAttribute('data-graph-focus-pinned', 'false');
  expect((await status.textContent())?.trim()).toBe('');
  await expect.poll(() => noteA.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect.poll(() => loose.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.2');

  // Click pins it; moving the pointer away must not clear the focus.
  await folderCircle.click();
  await expect(chip).toContainText('Focus: A');
  await expect(chip).toHaveAttribute('data-graph-focus-pinned', 'true');
  await expect(status).toContainText('Graph focus: A');
  await expect(chip.getByRole('button', { name: 'Clear graph focus' })).toBeVisible();
  await expect(folder.locator('circle.node-focus-ring')).toHaveAttribute('opacity', '1');
  await page.mouse.move(5, 5);
  await expect(chip).toContainText('Focus: A');

  // Clicking the pinned hub again clears it and suppresses the hover preview
  // until the pointer leaves the hub.
  await folderCircle.click();
  await expect(chip).toHaveCount(0);
  expect((await status.textContent())?.trim()).toBe('');
  await page.mouse.move(5, 5);
  await folderCircle.hover();
  await expect(chip).toContainText('Preview: A');
});

test('topic hub focus stays a tag set and never navigates', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, 'industrial', 'dark', 'graph');
  await enableTopics(page);

  const topic = page.locator(`${graph} .nodes > g[data-node-kind="topic"][data-node-id="topic:research"]`);
  const topicCircle = topic.locator('circle.node-circle');
  const noteA = page.locator(`${graph} .nodes > g[data-node-id="A/Note.md"]`);
  const loose = page.locator(`${graph} .nodes > g[data-node-id="Loose.md"]`);
  const folder = page.locator(`${graph} .nodes > g[data-node-id="folder:A"]`);
  const chip = focusChip(page);

  // A topic focuses its hub and directly tagged notes only; the containing
  // folder is not part of the tag set.
  await topicCircle.hover();
  await expect(chip).toContainText('Preview: @research');
  await expect.poll(() => noteA.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect.poll(() => loose.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect.poll(() => folder.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.2');

  await topicCircle.click();
  await expect(chip).toContainText('Focus: @research');
  await expect(divider(page)).toHaveCount(0);
  await expect(page.locator(editor)).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-region="topics"]')).toHaveCount(0);

  await chip.getByRole('button', { name: 'Clear graph focus' }).click();
  await expect(chip).toHaveCount(0);
});

test('graph focus clears on Escape, empty canvas, layer removal, and note open; 2D/3D keeps it', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, 'industrial', 'dark', 'graph');

  const folder = page.locator(`${graph} .nodes > g[data-node-id="folder:A"]`);
  const folderCircle = folder.locator('circle.node-circle');
  const chip = focusChip(page);
  const show = page.locator(graph).getByRole('button', { name: 'Show graph layers' });

  await folderCircle.click();
  await expect(chip).toContainText('Focus: A');

  // Switching views must preserve the focus.
  await page.locator(graph).getByRole('button', { name: '3D Graph', exact: true }).click();
  await expect(page.locator(`${graph} canvas`).first()).toBeVisible();
  await expect(chip).toContainText('Focus: A');
  await page.locator(graph).getByRole('button', { name: '2D Graph', exact: true }).click();
  await expect(folderCircle).toBeVisible();
  await expect(chip).toContainText('Focus: A');

  // Escape clears the pinned focus.
  await page.keyboard.press('Escape');
  await expect(chip).toHaveCount(0);

  // Empty canvas clears it too.
  await folderCircle.click();
  await expect(chip).toContainText('Focus: A');
  await page.locator(`${graph} .graph-canvas > svg`).dispatchEvent('click');
  await expect(chip).toHaveCount(0);

  // Turning off the focused layer drops the focus.
  await folderCircle.click();
  await expect(chip).toContainText('Focus: A');
  await show.click();
  const folders = page.locator(graph).getByRole('checkbox', { name: 'Folders', exact: true });
  await folders.uncheck();
  await expect(chip).toHaveCount(0);
  await folders.check();
  await show.click();
  await expect(folderCircle).toBeVisible();

  // Opening a note returns the graph to neutral.
  await folderCircle.click();
  await expect(chip).toContainText('Focus: A');
  await page.locator(`${graph} .nodes > g[data-node-id="Loose.md"] circle.node-circle`).click();
  await expect(divider(page)).toBeVisible();
  await expect(chip).toHaveCount(0);
});
