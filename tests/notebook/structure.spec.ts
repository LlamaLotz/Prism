import { test, expect, type Page } from '@playwright/test';
import { parseStructureError, STRUCTURE_ERROR_CODES } from '../../src/services/structure';

test.setTimeout(90000);

const url = '/tests/notebook/app-harness.html?view=editor&research';

async function boot(page: Page, content: string, search = '') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}${search}`);
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 45000 });
  await page.evaluate((text) => {
    (window as any).fixtureNoteContents['/vault/Loose.md'] = text;
  }, content);
  await page.locator('[data-note-path="/vault/Loose.md"]').click();
  const editor = page.locator('[data-region="editor"]');
  await expect(editor.locator('.cm-content')).toContainText(
    content.split('\n')[0].replace(/^#+\s*/, '')
  );
  return { editor, errors };
}

async function openToolsMenu(editor: ReturnType<Page['locator']>) {
  const tools = editor.getByRole('button', { name: 'Tools', exact: true });
  if (!(await tools.isVisible().catch(() => false))) {
    await editor.locator('.editor-overflow > summary').click();
  }
  await tools.click();
}

async function openToolsAction(editor: ReturnType<Page['locator']>, name: string) {
  await openToolsMenu(editor);
  await editor.getByRole('button', { name, exact: true }).click();
}

async function savedContent(page: Page) {
  return page.evaluate(() => (window as any).fixtureNoteContents['/vault/Loose.md'] as string);
}

async function fixtureCalls(page: Page) {
  return page.evaluate(
    () => (window as any).fixtureCalls as Array<{ command: string; args: any }>
  );
}

test('structure error prefixes map to actionable codes', () => {
  for (const code of STRUCTURE_ERROR_CODES) {
    const info = parseStructureError(`${code}: fixture detail`);
    expect(info.code).toBe(code);
    expect(info.detail).toBe('fixture detail');
    expect(info.action.length).toBeGreaterThan(0);
  }
  const unknown = parseStructureError(new Error('plain failure'));
  expect(unknown.code).toBe('UNKNOWN');
  expect(unknown.detail).toContain('plain failure');
});

test('safe format preview applies only after confirmation and undo restores the note', async ({
  page,
}) => {
  const original = '# Loose\n\n##  Methods  \n\nBody line.';
  const { editor, errors } = await boot(page, original);

  await openToolsAction(editor, 'Format');
  const dialog = page.getByRole('dialog', { name: 'Format preview' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/This preview changes the note/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Before' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'After' })).toBeVisible();
  await expect(dialog.locator('pre[aria-label="Formatted text"]')).toContainText('## Methods');

  // Nothing is written before the explicit apply.
  expect(await savedContent(page)).toBe(original);
  await dialog.getByRole('button', { name: 'Apply formatting' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => savedContent(page)).toBe('# Loose\n\n## Methods\n\nBody line.\n');

  const calls = await fixtureCalls(page);
  expect(calls.some((call) => call.command === 'preview_note_format')).toBe(true);
  expect(calls.some((call) => call.command === 'write_file')).toBe(true);

  await openToolsAction(editor, 'Undo format');
  await expect.poll(() => savedContent(page)).toBe(original);
  expect(errors).toEqual([]);
});

test('format preview reports a no-op and does not enable apply or undo', async ({ page }) => {
  const canonical = '# Loose\n\n## Methods\n\nBody\n';
  const { editor } = await boot(page, canonical);

  await openToolsAction(editor, 'Format');
  const dialog = page.getByRole('dialog', { name: 'Format preview' });
  await expect(dialog.getByText(/already formatted/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Apply formatting' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await openToolsMenu(editor);
  await expect(editor.getByRole('button', { name: 'Undo format' })).toBeDisabled();
});

test('split options expose real heading levels and counts; Topics is disabled without the model', async ({
  page,
}) => {
  const content =
    '# Research\n\nIntro.\n\n## Alpha\n\nA.\n\n### A1\n\nA1 text.\n\n## Beta\n\nB.\n\n### B1\n\nB1 text.\n';
  const { editor, errors } = await boot(page, content, '&structure-model=missing');

  await openToolsAction(editor, 'Split note');
  const dialog = page.getByRole('dialog', { name: 'Split note' });
  await expect(dialog).toBeVisible();

  // Auto preview is planned immediately from the inspection.
  await expect(dialog.getByRole('heading', { name: /2 sections/ })).toBeVisible();

  await dialog.getByRole('radio', { name: 'Headings' }).check();
  await expect(dialog.getByRole('radio', { name: 'Heading 1 · 1 section' })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: 'Heading 2 · 2 sections' })).toBeEnabled();
  await expect(dialog.getByRole('radio', { name: 'Heading 3 · 2 sections' })).toBeEnabled();
  await expect(dialog.getByRole('radio', { name: 'Topics' })).toBeDisabled();
  await expect(dialog.getByText(/Topics is unavailable/)).toBeVisible();

  await dialog.getByRole('radio', { name: 'Heading 3 · 2 sections' }).check();
  await expect(dialog.getByRole('heading', { name: /2 sections/ })).toBeVisible();
  const planCall = (await fixtureCalls(page))
    .filter((call) => call.command === 'plan_note_split')
    .at(-1);
  expect(planCall?.args.request.mode).toBe('headings');
  expect(planCall?.args.request.level).toBe(3);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('topics plan previews, applies the returned text exactly, and undoes cleanly', async ({
  page,
}) => {
  const original =
    '# Research\n\nFirst topic paragraph with enough words to look like a topic.\n\nSecond topic paragraph with more supporting detail.';
  const { editor, errors } = await boot(page, original, '&structure-model=ready');

  await openToolsAction(editor, 'Split note');
  const dialog = page.getByRole('dialog', { name: 'Split note' });
  await expect(dialog.getByRole('radio', { name: 'Topics' })).toBeEnabled();
  await dialog.getByRole('radio', { name: 'Topics' }).check();
  await dialog.getByRole('button', { name: 'Preview split' }).click();

  await expect(dialog.getByRole('heading', { name: /2 sections/ })).toBeVisible();
  await expect(dialog.getByText(/Local model used/)).toBeVisible();
  const plan = await page.evaluate(() => (window as any).fixtureStructurePlan);
  expect(plan.modelUsed).toBe(true);
  expect(plan.sections).toHaveLength(2);

  await dialog.getByRole('button', { name: 'Split note' }).click();
  await expect(dialog).toHaveCount(0);

  const callsAfterApply = await fixtureCalls(page);
  const creates = callsAfterApply.filter((call) => call.command === 'create_file');
  expect(creates.map((call) => call.args.content)).toEqual(
    plan.sections.map((section: any) => section.content)
  );
  const parentWrite = callsAfterApply
    .filter((call) => call.command === 'write_file' && call.args.filePath === '/vault/Loose.md')
    .at(-1);
  expect(parentWrite?.args.content).toBe(plan.parentContent);
  expect(await savedContent(page)).toBe(plan.parentContent);

  await openToolsAction(editor, 'Undo split');
  await expect.poll(() => savedContent(page)).toBe(original);
  const callsAfterUndo = await fixtureCalls(page);
  expect(callsAfterUndo.filter((call) => call.command === 'delete_file')).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('format preview closes on Escape and returns focus to the Tools trigger', async ({ page }) => {
  const { editor } = await boot(page, '# Loose\n\nBody\n');
  await openToolsAction(editor, 'Format');
  const dialog = page.getByRole('dialog', { name: 'Format preview' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Tools', exact: true })).toBeFocused();
});

test('format command failure falls back to the built-in formatter with an actionable error', async ({
  page,
}) => {
  const original = '# Loose\n\n##  Methods  \n\nBody line.';
  const { editor } = await boot(page, original, '&structure-error=format&structure-error-code=LIMIT');

  await openToolsAction(editor, 'Format');
  const dialog = page.getByRole('dialog', { name: 'Format preview' });
  await expect(dialog.locator('[data-error-code="LIMIT"]')).toBeVisible();
  await expect(dialog.getByText(/built-in formatter/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Apply formatting' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Apply formatting' }).click();
  await expect.poll(() => savedContent(page)).toBe('# Loose\n\n## Methods\n\nBody line.\n');
});

test('split plan failure surfaces the code and keeps the built-in heading split available', async ({
  page,
}) => {
  const original = '# Research\n\nIntro.\n\n## Alpha\n\nA.\n\n## Beta\n\nB.\n';
  const { editor } = await boot(
    page,
    original,
    '&structure-model=ready&structure-error=plan&structure-error-code=MODEL_UNAVAILABLE'
  );

  await openToolsAction(editor, 'Split note');
  const dialog = page.getByRole('dialog', { name: 'Split note' });
  const alert = dialog.locator('[data-error-code="MODEL_UNAVAILABLE"]');
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Refresh preview' })).toBeVisible();

  await alert.getByRole('button', { name: 'Use built-in heading split' }).click();
  await expect(dialog.getByText(/Built-in H2 splitter/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /2 sections/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Split note' }).click();
  await expect(dialog).toHaveCount(0);
  const creates = (await fixtureCalls(page)).filter((call) => call.command === 'create_file');
  expect(creates).toHaveLength(2);
});
