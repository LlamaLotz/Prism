import { test, expect } from '@playwright/test';

const studyUrl = '/tests/notebook/study-harness.html';

test('notebook prompt model picker drives the model used for chat requests', async ({ page }) => {
  await page.goto('/tests/notebook/harness.html');
  await page.getByRole('heading', { name: 'Learning how we learn' }).click();
  const picker = page.getByRole('combobox', { name: 'Chat model' });
  await expect(picker).toContainText('Default chat model');
  await picker.click();
  await page.getByRole('option', { name: /Research model/ }).click();
  await expect(picker).toContainText('Research model');
  await page.getByLabel('Question', { exact: true }).fill('What helps us remember?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixtureCalls.filter((c: any) => c.command === 'notebook_request' && c.args.path === '/api/chat/execute').length)).toBe(1);
  const execute = await page.evaluate(() => (window as any).fixtureCalls.find((c: any) => c.command === 'notebook_request' && c.args.path === '/api/chat/execute').args);
  expect(execute.body.model_override).toBe('model:chat');
});

test('prompt bar model picker works in the study notebook and stays compact', async ({ page }) => {
  await page.goto(studyUrl);await page.getByRole('button',{name:'Open notebook',exact:true}).click();
  const picker = page.getByRole('combobox', { name: 'Chat model' });
  await expect(picker).toContainText('Fixture model');
  await picker.click();
  await page.getByRole('option', { name: /Other model/ }).click();
  await expect(picker).toContainText('Other model');
  expect(await page.evaluate(() => (window as any).fixtureCalls.some((c: any) => c.command === 'set_model' && c.args.value === 'm2'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('AI thinking status reflects real request phases and clears when done', async ({ page }) => {
  await page.goto(studyUrl + '?slow');await page.getByRole('button',{name:'Open notebook',exact:true}).click();
  await page.getByRole('button', { name: 'Agent OFF' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Compare these sources');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.ai-status-line__label').filter({hasText:'Generating…'})).toBeVisible();
  await expect(page.getByText('Agent answer using selected sources.', { exact: true })).toBeVisible();
  await expect(page.locator('.ai-status-line__label').filter({hasText:'Generating…'})).toHaveCount(0);
});

test('tool runs report per-task status and failed runs offer retry', async ({ page }) => {
  await page.goto(studyUrl + '?failure');await page.getByRole('button',{name:'Open notebook',exact:true}).click();
  await page.getByRole('button', { name: 'Quiz', exact: true }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('Generating Quiz…', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Generation failed');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Generating Quiz…', { exact: false })).toBeVisible();
});
