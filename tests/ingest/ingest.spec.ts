import { test, expect } from '@playwright/test';
test('URL method stays compatible with native adapter', async ({ page }) => {
  await page.goto('/tests/ingest/harness.html');
  await page.getByPlaceholder('https://www.youtube.com/watch?v=...').fill('https://youtu.be/example');
  await page.getByLabel('Vault folder', { exact: true }).selectOption('Notes/Deep');
  await page.getByRole('button', { name: 'Whisper', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ingestion' }).click();
  expect(await page.evaluate(() => (window as any).ingestFixture.calls)).toEqual([['url', 'https://youtu.be/example', 'whisper', 'Notes/Deep']]);
});
test('file OCR choice keeps the per-source override', async ({ page }) => {
  await page.goto('/tests/ingest/harness.html');
  await page.getByRole('button', { name: 'Local Document / Media' }).click();
  await page.getByPlaceholder('Click Browse to select file...').fill('/fixtures/document.pdf');
  await page.getByRole('button', { name: 'Off', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ingestion' }).click();
  expect(await page.evaluate(() => (window as any).ingestFixture.calls)).toEqual([['file', '/fixtures/document.pdf|N', undefined, '']]);
});
