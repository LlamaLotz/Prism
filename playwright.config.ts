import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5178', viewport: { width: 1440, height: 960 } },
  webServer: { command: 'npm run web -- --host 127.0.0.1 --port 5178 --strictPort', url: 'http://127.0.0.1:5178/tests/notebook/harness.html', reuseExistingServer: false },
});
