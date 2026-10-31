import { test, expect, type Locator, type Page } from '@playwright/test';
import { openConversationMenu } from './assistant-menu';

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
  for (const theme of ['industrial', 'gloss']) for (const mode of ['light', 'dark']) {
    test(`notebook library in the app shell ${theme} ${mode}`, async ({ page }) => {
      test.setTimeout(90000);
      const errors = await boot(page, `?theme=${theme}&mode=${mode}`, page.getByRole('heading', { name: 'Notebooks', exact: true }));

      // App owns the theme classes; the fixture only supplies settings.
      const rootClass = await page.evaluate(() => document.documentElement.className);
      expect(rootClass).toContain(`theme-${theme}`);
      expect(rootClass).toContain(`mode-${mode}`);

      await expect(page.getByRole('group', { name: 'Notebook covers' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Open notebook/ }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /^Add notebook/ })).toBeVisible();
      // The retired Advanced Notebook entry point must not come back.
      await expect(page.getByRole('button', { name: 'Advanced Notebook', exact: true })).toHaveCount(0);

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
      // The Agent toggle now lives in the conversation ⋮ menu, and the panel no
      // longer shows a vault-context label or a jump to the other chat view.
      await openConversationMenu(page);
      await expect(shared.getByRole('button', { name: /Agent (ON|OFF)/ })).toBeVisible();
      await expect(shared.getByRole('button', { name: 'Open in other view' })).toHaveCount(0);
      await openConversationMenu(page);
      await expect(shared.getByText('Vault context')).toHaveCount(0);
      await expect(shared.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      let ratios = await contrast(page, '.study-assistant');
      expect(ratios.text).toBeGreaterThanOrEqual(4.5);
      expect(ratios.secondary).toBeGreaterThanOrEqual(4.5);

      // All conversations use the same chat, with a direct settings control.
      await expect(shared.getByRole('button', { name: 'AI settings', exact: true })).toBeVisible();
      await expect(shared.getByRole('button', { name: 'Web and advanced tools' })).toHaveCount(0);
      await expect(page.locator('.ai-sidebar')).toHaveCount(0);
      await expect(shared.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();

      await page.screenshot({ path: `output/playwright/app-sidebar-${theme}-${mode}.png` });
      expect(errors).toEqual([]);
    });
  }

  test('the AI assistant keeps the approval disclaimer in a popup', async ({ page }) => {
    test.setTimeout(90000);
    const errors = await boot(page, '?view=editor', page.locator('.study-assistant'));
    const shared = page.locator('.study-assistant');

    // New assistant chats start with Agent on; approval is an icon-only control.
    await openConversationMenu(page);
    await expect(shared.getByRole('button', { name: 'Agent ON', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const approve = shared.getByRole('button', { name: 'Approve for me OFF' });
    await expect(approve).toBeVisible();
    await expect(approve).toHaveText('');
    await expect(approve).toHaveAttribute('title', 'Approve for me OFF');
    await approve.hover();

    await approve.click();
    const notice = shared.getByRole('dialog', { name: 'Approval details' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Vault changes are approved automatically in this conversation. Undo is available in history. External processing still needs its own consent.');
    // The disclaimer is only in the popup, never parked under the composer.
    await expect(shared.getByText(/Vault changes are approved automatically/)).toHaveCount(1);

    // Escape dismisses it and leaves no inline copy behind.
    await page.keyboard.press('Escape');
    await expect(notice).toHaveCount(0);
    await expect(shared.getByText(/Vault changes are approved automatically/)).toHaveCount(0);

    // The info affordance beside the control reopens it.
    await shared.getByRole('button', { name: 'Approval details' }).click();
    await expect(notice).toBeVisible();

    // Turning Approve for me off closes the popup and drops the affordance.
    await shared.getByRole('button', { name: 'Approve for me ON' }).click();
    await expect(notice).toHaveCount(0);
    await expect(shared.getByRole('button', { name: 'Approval details' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('AI assistant title aligns with the conversation selector', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, '?view=editor', page.locator('.study-assistant'));
    const shared = page.locator('.study-assistant');
    const conversations = shared.getByRole('combobox', { name: 'Conversation' });
    const verifyAlignment = async () => {
      // The assistant sidebar animates width for 180ms. Measure only once the
      // heading and conversation selector have reached their resting positions.
      await expect.poll(async () => {
        const [heading, selector] = await Promise.all([
          shared.locator('.study-toolbar h2').boundingBox(),
          conversations.boundingBox(),
        ]);
        if (!heading || !selector) return Number.POSITIVE_INFINITY;
        return Math.abs(heading.x - selector.x);
      }, { timeout: 5000 }).toBeLessThanOrEqual(1);
    };

    await verifyAlignment();
    await shared.getByRole('button', { name: 'Expand chat' }).click();
    await verifyAlignment();
    await page.setViewportSize({ width: 420, height: 850 });
    await verifyAlignment();

  });

  test('AI assistant Default model sends without requiring a saved profile ID', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, '?view=editor&gemini', page.locator('.study-assistant'));
    const shared = page.locator('.study-assistant');
    await expect(shared.getByRole('combobox', { name: 'Chat model' })).toContainText('Default model');
    await openConversationMenu(page);
    await shared.getByRole('button', { name: 'Agent ON', exact: true }).click();
    await shared.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello Gemini');
    await shared.getByRole('button', { name: 'Send', exact: true }).click();

    const calls = () => page.evaluate(() => (window as any).fixtureCalls as Array<{ command: string; args: any }>);
    await expect.poll(async () => (await calls()).some(call => call.command === 'study_chat')).toBe(true);
    const sent = (await calls()).find(call => call.command === 'study_chat')!;
    const saved = (await calls()).find(call => call.command === 'study_request' && call.args.action === 'setChatProvider')!;
    expect(saved.args.payload.providerId).toBe('');
    expect(sent.args.providerId).toBe('');
    expect(JSON.stringify([saved, sent])).not.toContain('fixture-only-key');
    await expect(shared.getByRole('alert')).toHaveCount(0);
  });

  test('an unconfigured AI assistant defaults to None and explains what is missing', async ({ page }) => {
    test.setTimeout(90000);
    const errors = await boot(page, '?view=editor&unconfigured', page.locator('.study-assistant'));
    const shared = page.locator('.study-assistant');

    await expect(shared.getByRole('combobox', { name: 'Chat model' })).toContainText('None');
    await expect(shared.getByRole('alert')).toContainText('No AI model is configured yet');
    // Nothing is dispatched without a model: the composer refuses to send.
    await shared.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
    await expect(shared.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  });

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

  test('the sidebar model picker keeps its choice out of the shared chat route', async ({ page }) => {
    test.setTimeout(90000);
    const errors = await boot(page, '?view=editor', page.locator('.study-assistant'));
    await page.getByRole('combobox', { name: 'Chat model' }).click();
    await page.getByRole('option', { name: /Other model/ }).click();
    // The selection applies to this conversation's next request…
    await expect(page.getByRole('combobox', { name: 'Chat model' })).toContainText('Other model');
    // …while the feature-specific route shared by other conversations stays untouched.
    expect(await page.evaluate(() => (window as any).fixtureCalls.some((c: any) =>
      c.command === 'save_runtime_config' && c.args?.config?.models?.routes?.CHAT === 'm2'))).toBe(false);
    expect(errors).toEqual([]);
  });

  test('folder and note context menus create notes in place and move them between folders', async ({ page }) => {
    test.setTimeout(90000);
    const errors = await boot(page, '?view=editor', page.locator('[data-folder-path="Research"]'));

    // "Create note here" writes the note inside the clicked folder.
    await page.locator('[data-folder-path="Research"]').click({ button: 'right' });
    await page.getByRole('button', { name: 'Create note here', exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('Field notes 2');
    await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
    await expect.poll(() => page.evaluate(() =>
      (window as any).fixtureCalls.find((c: any) => c.command === 'create_file')?.args.relativePath)).toBe('Research/Field notes 2.md');

    // Moving into a folder that already holds that note is rejected and the dialog stays open.
    await page.locator('[data-note-path$="Drafts/Field notes.md"]').click({ button: 'right' });
    await page.getByRole('button', { name: 'Move to folder…', exact: true }).click();
    const move = page.getByRole('dialog', { name: 'Move note to folder' });
    const folders = move.getByLabel('Vault folder', { exact: true });
    await folders.getByRole('option', { name: 'Research', exact: true }).click();
    await move.getByRole('button', { name: 'Move note', exact: true }).click();
    await expect(move.getByRole('alert')).toContainText('already exists in that folder');
    await expect(move).toBeVisible();

    // Keyboard navigation starts from the current selection and wraps to the root.
    const search = move.getByLabel('Search vault folder', { exact: true });
    await search.focus();
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(folders.getByRole('option', { name: 'Vault root', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(folders.getByRole('option', { name: 'Research', exact: true })).toHaveAttribute('aria-selected', 'false');

    // Moving to the vault root succeeds.
    await folders.getByRole('option', { name: 'Vault root', exact: true }).click();
    await move.getByRole('button', { name: 'Move note', exact: true }).click();
    await expect.poll(() => page.evaluate(() =>
      (window as any).fixtureCalls.find((c: any) => c.command === 'rename_file')?.args.newPath)).toBe('/vault/Field notes.md');
    expect(errors).toEqual([]);
  });

  test('graph folder nodes exclude the vault root', async ({ page }) => {
    test.setTimeout(90000);
    const errors = await boot(page, '?view=editor', page.locator('[data-folder-path="Research"]'));
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('menuitemradio', { name: 'Graph', exact: true }).click();
    await expect(page.getByText('📁 Research', { exact: true })).toBeVisible();
    await expect(page.getByText('📁 A', { exact: true })).toBeVisible();
    // The vault root is the canvas, not a folder node.
    await expect(page.getByText('📁 Vault', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
