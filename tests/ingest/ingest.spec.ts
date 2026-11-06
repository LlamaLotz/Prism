import { test, expect } from '@playwright/test';
test('URL method stays compatible with native adapter', async ({ page }) => {
  await page.goto('/tests/ingest/harness.html');
  await page.getByPlaceholder('https://www.youtube.com/watch?v=...').fill('https://youtu.be/example');
  await page.getByLabel('Vault folder', { exact: true }).getByRole('option', { name: 'Notes/Deep', exact: true }).click();
  await page.getByRole('button', { name: 'Whisper', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ingestion' }).click();
  expect(await page.evaluate(() => (window as any).ingestFixture.calls)).toEqual([
    [{ type: 'url', value: 'https://youtu.be/example', method: 'whisper' }, 'Notes/Deep'],
  ]);
});
test('multi-file OCR choice carries every selected file', async ({ page }) => {
  await page.goto('/tests/ingest/harness.html');
  await page.getByRole('button', { name: 'Files / Folder' }).click();
  await page.getByRole('button', { name: 'Add files' }).click();
  await page.getByRole('button', { name: 'Off', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ingestion' }).click();
  expect(await page.evaluate(() => (window as any).ingestFixture.calls)).toEqual([
    [
      {
        type: 'files',
        files: ['/fixtures/document.pdf'],
        folders: [],
        includeSubfolders: true,
        ocr: 'N',
      },
      '',
    ],
  ]);
});
test('folder ingestion carries the folder and subfolder preference', async ({ page }) => {
  await page.goto('/tests/ingest/harness.html');
  await page.getByRole('button', { name: 'Files / Folder' }).click();
  await page.getByRole('button', { name: 'Add folder' }).click();
  await page.getByRole('button', { name: 'Start Ingestion' }).click();
  expect(await page.evaluate(() => (window as any).ingestFixture.calls)).toEqual([
    [
      {
        type: 'files',
        files: [],
        folders: ['/fixtures/folder'],
        includeSubfolders: true,
        ocr: 'A',
      },
      '',
    ],
  ]);
});
