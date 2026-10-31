import { test, expect, type Page } from '@playwright/test';

const NOTEBOOK = '/tests/notebook/study-harness.html';

const candidates = [
  {
    key: 'web:1',
    title: 'Deep learning overview',
    url: 'https://example.com/deep-learning',
    domain: 'example.com',
    snippet: 'A concise overview of deep learning methods and evidence.',
    extractedChars: 2400,
    relevance: { lexical: 0.9, domain: 0.8, freshness: 0.9, graphProximity: 0.2, finalScore: 0.87 },
    duplicateOf: null,
    why: 'Matches the topic and comes from a trusted domain.',
  },
  {
    key: 'web:2',
    title: 'Duplicate overview',
    url: 'https://example.com/deep-learning-copy',
    domain: 'example.com',
    snippet: 'The same page served from a mirrored address.',
    extractedChars: 2390,
    relevance: { lexical: 0.6, domain: 0.5, freshness: 0.8, graphProximity: 0.1, finalScore: 0.42 },
    duplicateOf: 'web:1',
    why: 'Same canonical URL as another candidate.',
  },
];

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
});

async function openNotebook(page: Page, suffix = '') {
  await page.goto(NOTEBOOK + suffix);
  await page.getByRole('button', { name: 'Open notebook', exact: true }).click();
}

async function openDiscover(page: Page) {
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await page.getByRole('menu', { name: 'Research options' }).getByRole('menuitem', { name: 'Discover' }).click();
  return page.getByRole('region', { name: 'Research' });
}

async function openDeepResearch(page: Page) {
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await page.getByRole('menu', { name: 'Research options' }).getByRole('menuitem', { name: 'Deep Research' }).click();
  return page.getByRole('region', { name: 'Research' });
}

async function waitForResearchListener(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).fixtureEventCount('research-phase'))).toBeGreaterThan(0);
}

async function emitPhase(page: Page, phase: string, progress: number) {
  await page.evaluate(([phase, progress]) => {
    (window as any).fixtureEmit('research-phase', { jobId: 'job1', sessionId: 'ses1', phase, progress });
  }, [phase, progress] as const);
}

async function emitCandidates(page: Page) {
  await page.evaluate((rows) => {
    (window as any).fixtureEmit('research-candidates', { jobId: 'job1', sessionId: 'ses1', candidates: rows });
  }, candidates);
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/;

test('Notebook Discover renders candidates, disables duplicates, and files a web source', async ({ page }) => {
  await openNotebook(page);
  const panel = await openDiscover(page);

  await expect(panel.getByLabel('Topic')).toHaveValue('Learning across disciplines');
  await panel.getByRole('button', { name: 'Start research' }).click();
  await waitForResearchListener(page);

  await emitPhase(page, 'reading', 0.4);
  await expect(panel.getByText('Reading pages', { exact: false })).toBeVisible();

  await emitCandidates(page);
  await expect(panel.getByRole('link', { name: 'Deep learning overview' })).toBeVisible();
  await expect(panel.getByText('87% relevant', { exact: true })).toBeVisible();
  await expect(panel.getByText('Duplicate', { exact: true })).toBeVisible();
  const duplicate = panel.getByRole('checkbox', { name: 'Select Duplicate overview' });
  await expect(duplicate).toBeDisabled();
  await expect(duplicate).not.toBeChecked();

  await panel.getByRole('button', { name: 'Preview Deep learning overview' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Extracted text for web:1.')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open page' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close preview' }).click();
  await expect(dialog).not.toBeVisible();

  await panel.getByRole('checkbox', { name: 'Select Deep learning overview' }).check();
  await panel.getByRole('button', { name: 'Save to notebook' }).click();
  await expect(panel.getByText(/Added 1 source to/)).toBeVisible();
  await expect(page.locator('.study-source-badge')).toContainText('Web');

  const calls = await page.evaluate(() => (window as any).fixtureCalls);
  const start = calls.find((call: any) => call.command === 'research_start');
  expect(start.args.depth).toBe('discover');
  expect(start.args.includeWeb).toBe(true);
  expect(start.args.useSources).toBe(true);
  expect(calls).toContainEqual({
    command: 'research_add_sources',
    args: { vaultPath: '/vault', collectionId: 'c1', keys: ['web:1'] },
  });
  expect(calls.some((call: any) => call.command === 'research_create_notes')).toBe(false);
});

test('Save as notes writes a timestamped folder and both actions keep the selection', async ({ page }) => {
  await openNotebook(page);
  const panel = await openDiscover(page);

  await panel.getByRole('button', { name: 'Start research' }).click();
  await waitForResearchListener(page);
  await emitCandidates(page);

  const checkbox = panel.getByRole('checkbox', { name: 'Select Deep learning overview' });
  await checkbox.check();

  const saveNotes = panel.getByRole('button', { name: 'Save as notes' });
  const saveNotebook = panel.getByRole('button', { name: 'Save to notebook' });
  await expect(saveNotes).toBeEnabled();
  await expect(saveNotebook).toBeEnabled();

  await saveNotes.click();
  await expect(panel.getByText(/Saved 1 note to Researched Sources\/\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\./)).toBeVisible();
  await expect(checkbox).toBeChecked();
  await expect(saveNotes).toBeDisabled();
  await expect(saveNotebook).toBeEnabled();

  await saveNotebook.click();
  await expect(panel.getByText(/Added 1 source to/)).toBeVisible();
  await expect(checkbox).toBeChecked();
  await expect(saveNotebook).toBeDisabled();

  const calls = await page.evaluate(() => (window as any).fixtureCalls);
  const noteCalls = calls.filter((call: any) => call.command === 'research_create_notes');
  const notebookCalls = calls.filter((call: any) => call.command === 'research_add_sources');
  expect(noteCalls).toHaveLength(1);
  expect(notebookCalls).toHaveLength(1);
  expect(noteCalls[0].args).toMatchObject({ vaultPath: '/vault', keys: ['web:1'] });
  expect(noteCalls[0].args.folder).toMatch(TIMESTAMP);
  expect(notebookCalls[0].args).toMatchObject({ vaultPath: '/vault', collectionId: 'c1', keys: ['web:1'] });
});

test('Save to notebook tracks completion per destination', async ({ page }) => {
  await page.goto(NOTEBOOK + '?library');
  await page.getByRole('button', { name: 'Switch to assistant view' }).click();
  const options = page.getByRole('button', { name: 'Search options' });
  await options.click();
  await page.getByRole('menu', { name: 'Search options' }).getByRole('menuitemcheckbox', { name: 'Discover sources' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Research deep learning');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await waitForResearchListener(page);
  await emitCandidates(page);

  const panel = page.getByRole('region', { name: 'Research' });
  await panel.getByRole('checkbox', { name: 'Select Deep learning overview' }).check();
  const save = panel.getByRole('button', { name: 'Save to notebook' });
  const select = panel.getByLabel('Save to notebook');
  await expect(select).toHaveValue('c1');
  await save.click();
  await expect(panel.getByText(/Added 1 source to/)).toBeVisible();
  await expect(save).toBeDisabled();

  await select.selectOption({ label: 'Research notebook 1' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).fixtureCalls))
    .filter((call: any) => call.command === 'research_add_sources' && call.args.collectionId === 'book0').length).toBe(1);
  await expect(save).toBeDisabled();

  await select.selectOption('c1');
  await expect(save).toBeDisabled();

  const calls = await page.evaluate(() => (window as any).fixtureCalls);
  const notebookCalls = calls.filter((call: any) => call.command === 'research_add_sources');
  expect(notebookCalls.map((call: any) => call.args)).toEqual([
    { vaultPath: '/vault', collectionId: 'c1', keys: ['web:1'] },
    { vaultPath: '/vault', collectionId: 'book0', keys: ['web:1'] },
  ]);
});

test('Cancel stops the job and returns the panel to idle', async ({ page }) => {
  await openNotebook(page);
  const panel = await openDiscover(page);

  await panel.getByRole('button', { name: 'Start research' }).click();
  await waitForResearchListener(page);
  await emitPhase(page, 'searching', 0.2);
  await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(panel.getByText('Searching', { exact: false })).toBeVisible();

  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByRole('button', { name: 'Start research' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await expect(panel.getByRole('status')).toHaveCount(0);

  const calls = await page.evaluate(() => (window as any).fixtureCalls);
  expect(calls).toContainEqual({ command: 'research_cancel', args: { jobId: 'job1' } });
});

test('Deep Research shows the not-available notice without leaving the panel', async ({ page }) => {
  await openNotebook(page);
  const panel = await openDeepResearch(page);

  await expect(panel.getByRole('heading', { name: /Research · Deep/ })).toBeVisible();
  await panel.getByRole('button', { name: 'Start research' }).click();
  await expect(panel.getByText('Deep Research is coming in a later update. Use Discover for now.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Start research' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Add sources', exact: true })).toBeVisible();

  const calls = await page.evaluate(() => (window as any).fixtureCalls);
  expect(calls.find((call: any) => call.command === 'research_start').args.depth).toBe('deep');
});

test('Deep Research candidates can be saved as notes', async ({ page }) => {
  await openNotebook(page, '?deepresearch');
  const panel = await openDeepResearch(page);

  await panel.getByRole('button', { name: 'Start research' }).click();
  await waitForResearchListener(page);
  await emitCandidates(page);
  await panel.getByRole('checkbox', { name: 'Select Deep learning overview' }).check();
  await panel.getByRole('button', { name: 'Save as notes' }).click();

  await expect(panel.getByText(/Saved 1 note to Researched Sources\/\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\./)).toBeVisible();
  const calls = await page.evaluate(() => (window as any).fixtureCalls);
  expect(calls.find((call: any) => call.command === 'research_start').args.depth).toBe('deep');
  expect(calls.filter((call: any) => call.command === 'research_create_notes')).toHaveLength(1);
  expect(calls.some((call: any) => call.command === 'research_add_sources')).toBe(false);
});

test('StudyWorkspace web-source preview has no Open page link', async ({ page }) => {
  await openNotebook(page, '?websource');
  await page.getByRole('button', { name: /Saved web page/ }).click();

  await expect(page.getByText('Captured web page text.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open page' })).toHaveCount(0);
  await expect(page.locator('.study-toolbar-link')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open in Notes' })).toHaveCount(0);
});

async function openAssistant(page: Page, suffix?: string) {
  await page.goto(NOTEBOOK + (suffix ?? ''));
  await page.getByRole('button', { name: 'Switch to assistant view' }).click();
}

test('AI sidebar Web menu turns on Discover and renders research candidates inline', async ({ page }) => {
  await openAssistant(page);
  const web = page.getByRole('button', { name: 'Web search', exact: true });
  await expect(web).toBeVisible();
  await expect(web).toHaveAttribute('aria-pressed', 'false');
  const options = page.getByRole('button', { name: 'Search options' });
  await expect(options).toHaveAttribute('aria-expanded', 'false');
  await options.click();
  await expect(options).toHaveAttribute('aria-expanded', 'true');

  const menu = page.getByRole('menu', { name: 'Search options' });
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Web search' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Deep research (soon)' })).toBeDisabled();
  await menu.getByRole('menuitemcheckbox', { name: 'Discover sources' }).click();
  await expect(menu).toHaveCount(0);
  await expect(options).toBeFocused();

  await page.getByLabel('Message', { exact: true }).fill('Research deep learning');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await waitForResearchListener(page);
  const calls = await page.evaluate(() => (window as any).fixtureCalls);
  const start = calls.find((call: any) => call.command === 'research_start');
  expect(start.args).toMatchObject({
    vaultPath: '/vault',
    query: 'Research deep learning',
    depth: 'discover',
    includeWeb: true,
    useSources: false,
  });

  await emitPhase(page, 'ranking', 0.8);
  await emitCandidates(page);
  const panel = page.getByRole('region', { name: 'Research' });
  await expect(panel.getByRole('link', { name: 'Deep learning overview' })).toBeVisible();
  await expect(panel.getByText('Ranking results', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Save to notebook')).toHaveValue('c1');
});

test('AI sidebar Web toggle grants the AI web_search tool access', async ({ page }) => {
  await openAssistant(page, '?webTool');
  await page.getByRole('button', { name: 'Web search', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('rust async runtime');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(page.getByRole('link', { name: 'Example result' })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).fixtureCalls);
  const webCall = calls.find((call: any) => call.command === 'agent_call_tool' && call.args.request.tool === 'web_search');
  expect(webCall).toBeTruthy();
  expect(webCall.args.request.webEnabled).toBe(true);
  expect(webCall.args.request.readOnly).toBe(false);
  expect(calls.some((call: any) => call.command === 'web_search')).toBe(false);
});
