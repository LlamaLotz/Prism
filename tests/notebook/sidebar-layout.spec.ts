import { test, expect } from '@playwright/test';
import { sidebarLayout, savedPanelWidth } from '../../src/utils/sidebarLayout';

const base = { width: 1200, viewport: 1200, gap: 8, vault: 264, ai: 320, collapsed: false, aiVisible: true, manualExpanded: false };
test('sidebar allocation preserves preferences, bounds, and workspace space', () => {
  expect(savedPanelWidth(null, 'vault')).toBe(264);
  expect(savedPanelWidth('NaN', 'ai')).toBe(320);
  expect(savedPanelWidth('-1', 'ai')).toBe(320);
  expect(savedPanelWidth('9999', 'vault')).toBe(420);
  expect(savedPanelWidth('1', 'ai')).toBe(280);
  const fitted = sidebarLayout({ ...base, width: 1000, vault: 420, ai: 640 });
  expect(fitted.workspaceWidth).toBeCloseTo(360);
  expect(fitted.vaultWidth).toBeGreaterThanOrEqual(180);
  expect(fitted.aiWidth).toBeGreaterThanOrEqual(280);
  expect(fitted.vaultWidth + fitted.aiWidth + fitted.workspaceWidth + 16).toBeCloseTo(1000);
  expect(sidebarLayout({ ...base, viewport: 999 }).expanded).toBe(true);
  expect(sidebarLayout({ ...base, width: 699, viewport: 699 }).vaultWidth).toBe(44);
  expect(sidebarLayout({ ...base, width: 520, viewport: 520, aiVisible: false }).rail).toBe(true);
  expect(sidebarLayout({ ...base, aiVisible: false }).aiWidth).toBe(0);
  expect(sidebarLayout(base).vaultWidth).toBe(264);
});

for (const theme of ['industrial', 'glass', 'gloss']) for (const mode of ['light', 'dark']) {
  test(`sidebar sizing and controls ${theme} ${mode}`, async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(() => {
      localStorage.setItem('prism_sidebar_width', '264');
      localStorage.setItem('prism_ai_width', '320');
      const original = Storage.prototype.setItem;
      (window as any).__panelWrites = [];
      Storage.prototype.setItem = function(key, value) {
        if (key === 'prism_sidebar_width' || key === 'prism_ai_width') (window as any).__panelWrites.push([key, value]);
        return original.call(this, key, value);
      };
    });
    await page.goto(`/tests/notebook/app-harness.html?theme=${theme}&mode=${mode}&view=editor`);
    const vault = page.locator('.vault-shell');
    const ai = page.locator('.ai-shell');
    const vaultHandle = page.getByRole('separator', { name: 'Resize Vault sidebar' });
    const aiHandle = page.getByRole('separator', { name: 'Resize AI sidebar' });
    await expect(vaultHandle).toBeVisible({ timeout: 45000 });
    const width = async (el: typeof vault) => (await el.boundingBox())!.width;
    const boundary = async () => {
      const v = (await vault.boundingBox())!, a = (await ai.boundingBox())!;
      const vh = (await vaultHandle.boundingBox())!, ah = (await aiHandle.boundingBox())!;
      expect(Math.abs(vh.x + vh.width / 2 - v.x - v.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(ah.x + ah.width / 2 - a.x)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    await boundary();
    await vaultHandle.click();
    expect(await page.evaluate(() => (window as any).__panelWrites.length)).toBe(0);
    const initialAI = await width(ai);
    const handle = (await vaultHandle.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 100, handle.y + handle.height / 2, { steps: 15 });
    await expect.poll(() => width(vault)).toBeGreaterThan(340);
    expect(await width(ai)).toBeCloseTo(initialAI, 0);
    expect(await page.evaluate(() => (window as any).__panelWrites.length)).toBe(0);
    await boundary();
    await page.mouse.move(handle.x + 50, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).__panelWrites.length)).toBe(1);
    await vaultHandle.press('Home');
    await expect.poll(() => width(vault)).toBeCloseTo(180, 0);
    await aiHandle.press('Home');
    await expect.poll(() => width(ai)).toBeCloseTo(280, 0);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await boundary();
    const actions = page.getByRole('button', { name: 'Actions for Loose', exact: true });
    await actions.click();
    const menu = page.getByRole('menu', { name: 'Vault actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Rename Note', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(actions).toBeFocused();
    await page.screenshot({ path: `output/playwright/sidebar-narrow-${theme}-${mode}.png` });
    await vaultHandle.press('End');
    await expect.poll(() => width(vault)).toBeCloseTo(420, 0);
    const preferred = await width(vault);
    await page.getByTitle('Collapse sidebar', { exact: true }).click();
    await expect.poll(() => width(vault)).toBeCloseTo(44, 0);
    await page.getByTitle('Expand sidebar', { exact: true }).click();
    await expect.poll(() => width(vault)).toBeCloseTo(preferred, 0);
    await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
    await expect(aiHandle).toHaveCount(0);
    await page.getByRole('button', { name: 'Restore sidebar', exact: true }).click();
    await expect(aiHandle).toBeVisible();
    for (const size of [1001, 1000, 999, 700, 699, 390, 1440]) {
      await page.setViewportSize({ width: size, height: 960 });
      await expect.poll(() => page.locator('.sidebar-layout').getAttribute('data-animate')).toBe(null);
      if (size < 1000) {
        await expect(aiHandle).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Chat fills this narrow window' })).toBeDisabled();
      } else await expect(aiHandle).toBeVisible();
      if (size < 700) await expect.poll(() => width(vault)).toBeCloseTo(44, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await boundary();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByTitle('Collapse sidebar', { exact: true }).click();
    expect(await vault.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
    await page.getByTitle('Expand sidebar', { exact: true }).click();
    await page.screenshot({ path: `output/playwright/sidebar-resize-${theme}-${mode}.png` });
  });
}

test('capture cancellation, rapid events, keyboard steps, and draft retention', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/tests/notebook/app-harness.html?theme=gloss&mode=dark&view=editor');
  const handle = page.getByRole('separator', { name: 'Resize AI sidebar' });
  await expect(handle).toBeVisible({ timeout: 45000 });
  const draft = page.getByRole('textbox', { name: 'Message', exact: true });
  await draft.fill('Keep this draft while panels move');
  await handle.press('Home');
  await handle.press('Shift+ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '344');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 6, box.y + 40);
  await page.mouse.down();
  await handle.evaluate((el, origin) => {
    for (let i = 1; i <= 25; i++) el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: origin - i * 4, bubbles: true }));
  }, box.x + 6);
  await expect(handle).toHaveAttribute('aria-valuenow', '444');
  await handle.dispatchEvent('pointercancel', { pointerId: 1 });
  await expect(page.locator('.sidebar-layout')).not.toHaveAttribute('data-dragging');
  await page.mouse.up();
  await page.getByRole('button', { name: 'Collapse AI sidebar' }).click();
  await expect(page.locator('.ai-shell')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: /AI Co-Pilot|Toggle AI|AI assistant/i }).first().click();
  await expect(draft).toHaveValue('Keep this draft while panels move');
});

for (const mode of ['light', 'dark']) {
  test(`gloss ${mode} text contrast against rendered pixels`, async ({ page }) => {
    test.setTimeout(90000);
    await page.goto(`/tests/notebook/app-harness.html?theme=gloss&mode=${mode}&view=editor`);
    await expect(page.locator('.study-assistant')).toBeVisible({ timeout: 45000 });
    const samples = await page.evaluate(() => {
      const result: { label: string; color: number[]; x: number; y: number }[] = [];
      for (const el of document.querySelectorAll('.sidebar *, .ai-shell *')) {
        const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
        if (!rect.width || !rect.height || css.visibility === 'hidden' || el.closest('[hidden], [inert]')) continue;
        for (const node of el.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          if (r.width && r.height && r.x >= rect.x && r.right <= rect.right + 1 && r.y > 40 && r.bottom < innerHeight) {
            result.push({ label: node.textContent.trim(), color: css.color.match(/[\d.]+/g)!.map(Number), x: Math.floor(r.x + r.width / 2), y: Math.floor(r.y + r.height / 2) });
          }
        }
      }
      return result;
    });
    const style = await page.addStyleTag({ content: '.sidebar *, .ai-shell * { -webkit-text-fill-color: transparent !important; text-shadow: none !important; } .sidebar svg, .ai-shell svg { visibility: hidden !important; }' });
    const png = await page.screenshot();
    await style.evaluate(el => el.remove());
    const failures = await page.evaluate(async ({ data, samples }) => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
      const lum = (rgb: number[]) => rgb.slice(0, 3).map(c => c / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      return samples.flatMap(s => {
        const bg = [...ctx.getImageData(s.x, s.y, 1, 1).data];
        const a = s.color[3] ?? 1;
        const fg = s.color.slice(0,3).map((c,i) => c * a + bg[i] * (1-a));
        const l1 = lum(fg), l2 = lum(bg);
        const ratio = (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
        return ratio < 4.5 ? [{ text: s.label, ratio }] : [];
      });
    }, { data: png.toString('base64'), samples });
    expect(samples.length).toBeGreaterThan(10);
    expect(failures).toEqual([]);
  });
}

test('resize performance trace with both sidebars and an open note', async ({ page, context }) => {
  test.setTimeout(90000);
  await page.goto('/tests/notebook/app-harness.html?theme=gloss&mode=dark&view=editor');
  await expect(page.locator('.sidebar-note-row').first()).toBeVisible({ timeout: 45000 });
  await page.locator('.sidebar-note-row').first().click();
  await expect(page.locator('.vault-expanded')).toHaveCSS('overflow-x', 'hidden');
  await expect(page.locator('.ai-panel-clip')).toHaveCSS('overflow-x', 'hidden');
  const vaultHandle = page.getByRole('separator', { name: 'Resize Vault sidebar' });
  const saved = await page.evaluate(() => localStorage.getItem('prism_sidebar_width'));
  await vaultHandle.click();
  expect(await page.evaluate(() => localStorage.getItem('prism_sidebar_width'))).toBe(saved);
  const vertical = page.getByRole('separator', { name: 'Resize panel height' });
  await expect(vertical).toBeVisible();
  const initialHeight = await vertical.evaluate(el => el.parentElement!.getBoundingClientRect().height);
  await vertical.press('ArrowUp');
  await expect.poll(() => vertical.evaluate(el => el.parentElement!.getBoundingClientRect().height)).toBeCloseTo(initialHeight + 16, 0);
  await vertical.press('ArrowDown');
  await page.getByTitle('Collapse sidebar', { exact: true }).click();
  await expect.poll(() => page.locator('.vault-shell').evaluate(el => el.getBoundingClientRect().width)).toBe(44);
  await page.getByTitle('Expand sidebar', { exact: true }).click();
  await expect.poll(() => page.locator('.vault-shell').evaluate(el => el.getBoundingClientRect().width)).toBe(264);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const before = await cdp.send('Performance.getMetrics');
  await page.evaluate(() => {
    const state = { active: true, frames: [] as number[], longTasks: [] as number[], last: performance.now() };
    (window as any).__resizeTiming = state;
    const observer = new PerformanceObserver(list => { state.longTasks.push(...list.getEntries().map(e => e.duration)); });
    observer.observe({ type: 'longtask' });
    (window as any).__resizeObserver = observer;
    const frame = (time: number) => { if (!state.active) return; state.frames.push(time - state.last); state.last = time; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  for (const [name, delta] of [['Resize Vault sidebar', 120], ['Resize AI sidebar', -180]] as const) {
    const handle = page.getByRole('separator', { name });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 6 + delta, box.y + box.height / 2, { steps: 30 });
    await page.mouse.move(box.x + 6, box.y + box.height / 2, { steps: 30 });
    await page.mouse.up();
  }
  const timing = await page.evaluate(() => {
    const s = (window as any).__resizeTiming; s.active = false; (window as any).__resizeObserver.disconnect();
    const frames = s.frames.filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
    return { frameCount: frames.length, medianFrameMs: frames[Math.floor(frames.length / 2)], p95FrameMs: frames[Math.floor(frames.length * .95)], longTasks: s.longTasks };
  });
  const after = await cdp.send('Performance.getMetrics');
  const metrics = Object.fromEntries(after.metrics.filter(m => ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration'].includes(m.name)).map(m => [m.name, m.value - (before.metrics.find(b => b.name === m.name)?.value ?? 0)]));
  await test.info().attach('resize-timing', { body: JSON.stringify({ ...timing, metrics }, null, 2), contentType: 'application/json' });
  await context.tracing.stop({ path: 'output/playwright/sidebar-resize-trace.zip' });
  expect(timing.frameCount).toBeGreaterThan(30);
  await expect(page.locator('.sidebar-layout')).not.toHaveAttribute('data-dragging');
});
