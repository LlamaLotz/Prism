import { test, expect } from '@playwright/test';

for (const theme of ['industrial', 'glass', 'gloss']) for (const mode of ['light', 'dark']) {
  test(`accent updates open dropdowns and text selection in ${theme} ${mode}`, async ({ page }) => {
    await page.goto(`/tests/notebook/study-harness.html?theme=${theme}&mode=${mode}`);
    await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
    await page.getByRole('combobox', { name: 'Chat model' }).click();
    const selected = page.getByRole('listbox', { name: 'Chat model' }).getByRole('option', { selected: true });
    await expect(selected).toBeVisible();
    const colors = [];
    for (const accent of ['#f97316', '#a855f7']) {
      colors.push(await selected.evaluate(async (option, accent) => {
        const modulePath = '/src/utils/accentColor.ts';
        const { applyAccentColor } = await import(/* @vite-ignore */ modulePath);
        applyAccentColor(accent);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const rgb = (color: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const probe = document.createElement('span');
        probe.style.color = 'var(--nb-focus)';
        document.body.append(probe);
        const focus = rgb(getComputedStyle(probe).color);
        probe.remove();
        const input = document.querySelector('.prompt-bar textarea')!;
        return {
          selection: rgb(getComputedStyle(input, '::selection').backgroundColor),
          dropdown: rgb(getComputedStyle(option).backgroundColor),
          focus,
        };
      }, accent));
      await expect(selected).toBeVisible();
    }
    expect(colors[0].selection).toEqual([249, 115, 22]);
    expect(colors[1].selection).toEqual([168, 85, 247]);
    expect(colors[0].dropdown).not.toEqual(colors[1].dropdown);
    expect(colors[0].focus).not.toEqual(colors[1].focus);
    expect(colors[0].dropdown[0]).toBeGreaterThan(colors[0].dropdown[2]);
    expect(colors[1].dropdown[2]).toBeGreaterThan(colors[1].dropdown[0]);
  });
}
