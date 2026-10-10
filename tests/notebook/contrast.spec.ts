import { test, expect, type Page } from '@playwright/test';

/**
 * Rendered contrast + boundary audit.
 *
 * Text: measures the *effective* background of every text-bearing element by
 * walking the ancestor chain and compositing each background layer over the one
 * behind it (translucent glass/gloss surfaces included), then applies the WCAG
 * AA threshold for that element's own font size and weight.
 *
 * Boundaries: for the surfaces that must be distinguishable, composites the
 * border colour over the surface behind it and requires 3:1, which is what
 * catches white-on-white glass borders and menus that blend into content.
 *
 * Deliberately reads computed styles rather than theme tokens: a token can be
 * legible in isolation and still fail once composited into the real layout.
 */

interface Failure { kind: string; selector: string; text: string; ratio: number; required: number }

const HELPERS = `
  const parse = (value) => {
    const match = value.match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const channel = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return channel(r) * 0.2126 + channel(g) * 0.7152 + channel(b) * 0.0722;
  };
  const ratio = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const effectiveBackground = (element) => {
    const nodes = [];
    for (let node = element; node; node = node.parentElement) nodes.push(node);
    let backgrounds = [{ r: 255, g: 255, b: 255, a: 1 }];
    while (nodes.length) {
      const style = getComputedStyle(nodes.pop());
      const bg = parse(style.backgroundColor);
      if (bg) backgrounds = backgrounds.map(base => over(bg, base));
      // Test both extrema of the neutral sheen, including nested translucency.
      const stops = (style.backgroundImage.match(/rgba?\\([^)]*\\)/g) || []).map(parse).filter(Boolean);
      if (stops.length) backgrounds = backgrounds.flatMap(base => stops.map(stop => over(stop, base)));
      backgrounds.sort((a, b) => luminance(a) - luminance(b));
      backgrounds = [backgrounds[0], backgrounds[backgrounds.length - 1]];
    }
    return { background: backgrounds[0], backgrounds };
  };
  const path = (element, root) => {
    const parts = [];
    for (let node = element; node && node !== root && parts.length < 3; node = node.parentElement) {
      parts.unshift(node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\\s+/).join('.') : ''));
    }
    return parts.join(' > ');
  };
  const roots = () => Array.from(document.querySelectorAll('.study-workspace, .study-assistant, .ai-sidebar, .sidebar, .sidebar-collapsed-rail, .sidebar-context-menu, .notebook-library, .prompt-bar, .prism-navigation-menu'));
`;

const AUDIT = `(() => {${HELPERS}
  const failures = [];
  const seen = new Set();
  for (const root of roots()) {
    for (const element of root.querySelectorAll('*')) {
      if (element.closest('[hidden], [aria-hidden="true"], [inert]')) continue;
      const field = element.matches('input, textarea');
      if (!field && !Array.from(element.childNodes).some(node => node.nodeType === 3 && node.textContent.trim())) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const foreground = field && !element.value && element.placeholder ? getComputedStyle(element, '::placeholder').color : style.color;
      const fg = parse(foreground);
      if (!fg || fg.a === 0) continue;
      const { backgrounds } = effectiveBackground(element);
      const size = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      const value = Math.min(...backgrounds.map(background => ratio(fg.a < 1 ? over(fg, background) : fg, background)));
      const key = 'text|' + element.className + '|' + style.color + '|' + style.fontSize;
      if (value < required && !seen.has(key)) {
        seen.add(key);
        failures.push({ kind: 'text', selector: path(element, root), text: (element.value || element.placeholder || element.textContent).trim().slice(0, 50), ratio: Math.round(value * 100) / 100, required });
      }
    }
  }
  return failures;
})()`;

const BOUNDARIES = `(() => {${HELPERS}
  const failures = [];
  const surfaces = ['.study-panel', '.study-menu-body', '.model-picker__menu', '.notebook-cover', '.prompt-bar', '.study-choice', '.study-tools button', '.study-chat-header select', '.agent-history', '.study-source-picker input', '.study-table td', '.prism-navigation-menu', '.prism-navigation-item'];
  for (const root of roots()) {
    for (const selector of surfaces) {
      for (const element of root.querySelectorAll(selector)) {
        if (element.closest('[hidden], [inert]')) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const style = getComputedStyle(element);
        const border = parse(style.borderTopColor) || parse(style.borderLeftColor);
        const width = parseFloat(style.borderTopWidth) || parseFloat(style.borderLeftWidth);
        if (!border || border.a === 0 || !width) continue;
        const behind = effectiveBackground(element.parentElement || element).background;
        const value = ratio(border.a < 1 ? over(border, behind) : border, behind);
        if (value < 3) failures.push({ kind: 'boundary', selector: selector + ' :: ' + path(element, root), text: element.className.toString().slice(0, 40), ratio: Math.round(value * 100) / 100, required: 3 });
      }
    }
  }
  return failures;
})()`;

const INDICATORS = `(() => {${HELPERS}
  const failures = [];
  for (const el of document.querySelectorAll('.sidebar button svg, .sidebar-collapsed-rail button svg, .ai-shell button svg, .resize-handle-grip')) {
    if (el.closest('[inert], [hidden], [aria-hidden="true"]:not(svg)')) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.visibility === 'hidden') continue;
    const fg = parse(el.classList.contains('resize-handle-grip') ? style.backgroundColor : style.color);
    if (!fg) continue;
    const { backgrounds } = effectiveBackground(el.parentElement);
    const value = Math.min(...backgrounds.map(bg => ratio(over(fg, bg), bg)));
    if (value < 3) failures.push({kind: 'icon', selector: el.parentElement.outerHTML.slice(0,180), text: el.parentElement.getAttribute('aria-label') || '', ratio: value, required: 3});
  }
  return failures;
})()`;

const audit = async (page: Page) => [
  ...(await page.evaluate<Failure[]>(AUDIT)),
  ...(await page.evaluate<Failure[]>(BOUNDARIES)),
  ...(await page.evaluate<Failure[]>(INDICATORS)),
];

const report = (label: string, failures: Failure[]) => {
  if (!failures.length) return '';
  const unique = failures.filter((f, i) => failures.findIndex(g => g.kind === f.kind && g.selector === f.selector) === i).slice(0, 14);
  return `\n${label}: ${failures.length} failure(s)\n` + unique
    .map(f => `  [${f.kind}] ${f.ratio} < ${f.required}  "${f.text}"\n      ${f.selector}`)
    .join('\n');
};

test.describe('rendered contrast', () => {
  for (const theme of ['industrial', 'glass', 'gloss']) for (const mode of ['light', 'dark']) {
    test(`notebook ${theme} ${mode}`, async ({ page }) => {
      test.setTimeout(120000);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(`/tests/notebook/study-harness.html?theme=${theme}&mode=${mode}&library`);
      await expect(page.getByRole('heading', { name: 'Notebooks', exact: true })).toBeVisible();
      const failures: Failure[] = await audit(page);

      await page.getByRole('button', { name: /Open notebook/ }).first().click();
      await expect(page.locator('.study-panel')).toHaveCount(3);
      failures.push(...(await audit(page)));

      // Sources: picker rows and search chrome.
      await page.getByRole('button', { name: 'Add sources', exact: true }).click();
      failures.push(...(await audit(page)));
      await page.getByRole('button', { name: 'Done adding sources' }).click();

      // Material viewers: quiz, table, mind map, podcast, flashcards.
      for (const material of ['Thirukkural Structure', 'Learning check', 'Learning comparison', 'Connected ideas', 'A conversation about learning']) {
        await page.getByRole('button', { name: new RegExp(material) }).first().click();
        await expect(page.locator('.study-artifact:visible').first()).toBeVisible();
        failures.push(...(await audit(page)));
        await page.getByRole('button', { name: 'Tools', exact: true }).first().click();
      }

      // Agent history drawer, expanded.
      await page.getByRole('button', { name: 'Agent OFF' }).click();
      await page.getByLabel('Message', { exact: true }).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
      failures.push(...(await audit(page)));

      // Narrow layout: panel tabs become the primary navigation.
      await page.setViewportSize({ width: 700, height: 850 });
      await expect(page.getByRole('navigation', { name: 'Notebook areas' })).toBeVisible();
      failures.push(...(await audit(page)));

      expect(report(`notebook ${theme} ${mode}`, failures)).toBe('');
    });

    test(`AI sidebar ${theme} ${mode}`, async ({ page }) => {
      test.setTimeout(120000);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(`/tests/notebook/app-harness.html?theme=${theme}&mode=${mode}&view=editor`);
      const shared = page.locator('.study-assistant');
      await expect(shared).toBeVisible({ timeout: 45000 });
      const failures: Failure[] = await audit(page);
      const collapse = page.getByTitle('Collapse sidebar', { exact: true });
      await collapse.hover();
      failures.push(...(await audit(page)));
      await collapse.focus();
      failures.push(...(await audit(page)));
      await page.getByRole('separator', { name: 'Resize Vault sidebar' }).press('Home');
      await page.getByRole('button', { name: 'Actions for Loose', exact: true }).click();
      await expect(page.getByRole('menu', { name: 'Vault actions' })).toBeVisible();
      failures.push(...(await audit(page)));
      await page.keyboard.press('Escape');
      await collapse.click();
      await expect(page.getByTitle('Expand sidebar', { exact: true })).toBeVisible();
      failures.push(...(await audit(page)));
      await page.getByTitle('Expand sidebar', { exact: true }).click();
      // The portaled model menu floats over page content.
      await shared.getByRole('combobox', { name: 'Chat model' }).click();
      await expect(page.locator('.model-picker__menu')).toBeVisible();
      failures.push(...(await audit(page)));
      await page.keyboard.press('Escape');
      await shared.getByLabel('Assistant options').click();
      await shared.getByRole('button', { name: 'Web and advanced tools' }).click();
      await expect(page.locator('.ai-sidebar')).toBeVisible();
      failures.push(...(await audit(page)));

      // The portaled navigation popover reported as blending into the content
      // behind it. It lives on document.body, outside every other audited root.
      await page.getByRole('button', { name: /^More/ }).first().click();
      await expect(page.locator('.prism-navigation-menu')).toBeVisible();
      failures.push(...(await audit(page)));
      await page.keyboard.press('Escape');

      expect(report(`sidebar ${theme} ${mode}`, failures)).toBe('');
    });
  }
});
