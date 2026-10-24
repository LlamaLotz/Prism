import { expect, test } from '@playwright/test';

type RGB = { r: number; g: number; b: number; a: number };
type Failure = {
  kind: 'text' | 'boundary' | 'icon';
  selector: string;
  text: string;
  ratio: number;
  required: number;
};

const HELPERS = `
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext('2d');
  const parse = (color) => {
    if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return null;
    const rgb = color.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
    if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
    const hex = color.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16), a: 1 };
    }
    // color-mix()/gradients compute to color(srgb ...) or oklab(...) in
    // Chromium; convert those through a canvas instead of dropping the fill.
    if (!colorContext || !CSS.supports('color', color)) return null;
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = '#010203';
    colorContext.fillStyle = color;
    colorContext.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const linear = (v) => { const c = v/255; return c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4; };
  const luminance = (c) => 0.2126*linear(c.r)+0.7152*linear(c.g)+0.0722*linear(c.b);
  const over = (fg, bg) => {
    const alpha = 1 - (1 - fg.a)*(1 - bg.a);
    if (alpha <= 0) return {r:255,g:255,b:255,a:0};
    return {
      r: (fg.r*fg.a + bg.r*bg.a*(1-fg.a)) / alpha,
      g: (fg.g*fg.a + bg.g*bg.a*(1-fg.a)) / alpha,
      b: (fg.b*fg.a + bg.b*bg.a*(1-fg.a)) / alpha,
      a: alpha
    };
  };
  const ratio = (fg, bg) => {
    const L1 = luminance(fg), L2 = luminance(bg);
    const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
    return (hi + 0.05)/(lo + 0.05);
  };
  const effectiveBackground = (element) => {
    if (!element) return { background: {r:0,g:0,b:0,a:1} };
    const nodes = [];
    for (let node = element; node; node = node.parentElement) nodes.push(node);
    let backgrounds = [{ r: 255, g: 255, b: 255, a: 1 }];
    while (nodes.length) {
      const style = getComputedStyle(nodes.pop());
      const bg = parse(style.backgroundColor);
      if (bg) backgrounds = backgrounds.map(base => over(bg, base));
      const stops = (style.backgroundImage.match(/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^)]*\\)/g) || []).map(parse).filter(Boolean);
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
  const roots = () => Array.from(document.querySelectorAll('.settings-page-overlay, .liquid-gloss-header, .titlebar, .toolbar'));
`;

const AUDIT = `(() => {${HELPERS}
  const failures = [];
  const seen = new Set();
  for (const root of roots()) {
    for (const element of root.querySelectorAll('*')) {
      if (element.closest('[hidden], [aria-hidden="true"], [inert]')) continue;
      // Button contrast is the contract under test; the settings page's
      // secondary helper copy is intentionally muted and outside this audit.
      const interactive = element.closest('button, a, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="menuitem"], input, textarea, select');
      if (!interactive) continue;
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

const report = (label: string, failures: Failure[]) => {
  if (!failures.length) return '';
  const unique = failures.filter((f, i) => failures.findIndex(g => g.kind === f.kind && g.selector === f.selector) === i).slice(0, 14);
  return `\n${label}: ${failures.length} failure(s)\n` + unique
    .map(f => `  [${f.kind}] ${f.ratio} < ${f.required}  "${f.text}"\n      ${f.selector}`)
    .join('\n');
};

test.describe('settings rendered contrast', () => {
  for (const theme of ['industrial', 'gloss']) for (const mode of ['light', 'dark']) {
    test(`settings ${theme} ${mode} with default accent`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(`/tests/settings/harness.html?theme=${theme}&mode=${mode}`);
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      const failures: Failure[] = await page.evaluate<Failure[]>(AUDIT);
      expect(report(`settings ${theme} ${mode}`, failures)).toBe('');
    });

    test(`settings ${theme} ${mode} with dark accent #1D4ED8`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(`/tests/settings/harness.html?theme=${theme}&mode=${mode}&accent=%231D4ED8`);
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      // The harness applies the accent in an effect; let the brand tokens
      // finish their transition before measuring.
      await page.waitForTimeout(600);
      const failures: Failure[] = await page.evaluate<Failure[]>(AUDIT);
      expect(report(`settings ${theme} ${mode} dark-accent`, failures)).toBe('');
    });
  }
});
