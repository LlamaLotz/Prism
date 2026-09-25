import { test, expect } from '@playwright/test';
test('URL method stays compatible with native adapter', async ({ page }) => {
  await page.goto('/tests/ingest/harness.html');
  await page.locator('input').fill('https://youtu.be/example');
  await page.getByRole('button', { name: 'Whisper', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ingestion' }).click();
  expect(await page.evaluate(() => (window as any).ingestFixture.calls)).toEqual([['url', 'https://youtu.be/example', 'whisper']]);
});
test('file OCR choice keeps the per-source override', async ({ page }) => {
  await page.goto('/tests/ingest/harness.html');
  await page.getByRole('button', { name: 'Local Document / Media' }).click();
  await page.locator('input').fill('/fixtures/document.pdf');
  await page.getByRole('button', { name: 'Off', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ingestion' }).click();
  expect(await page.evaluate(() => (window as any).ingestFixture.calls)).toEqual([['file', '/fixtures/document.pdf|N']]);
});
