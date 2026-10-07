import { chromium, type FullConfig } from '@playwright/test';

/** Harness pages whose module graphs must be warm before the workers start. */
const HARNESS_PAGES = [
  '/tests/notebook/study-harness.html',
  '/tests/notebook/app-harness.html',
];

/**
 * Vite transforms a page's module graph on first request, and these harness
 * pages pull in the whole application. That cold compile measured ~25s and,
 * combined with a screenshot on a 1440x960 viewport, pushed whichever test
 * happened to load a harness page first past the 30s per-test timeout.
 *
 * Loading each harness once here fills Vite's transform cache, so every worker
 * gets the ~3s warm path. Failures are swallowed: warm-up is an optimisation,
 * and a suite that cannot reach the server will report the real error itself.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.webServer?.url ? new URL(config.webServer.url).origin : 'http://127.0.0.1:5178';
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    for (const path of HARNESS_PAGES) {
      await page.goto(new URL(path, baseURL).href, { waitUntil: 'load' });
    }
  } catch (error) {
    console.warn(`Harness warm-up skipped: ${(error as Error).message}`);
  } finally {
    await browser?.close();
  }
}
