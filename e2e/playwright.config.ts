import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Use the environment's pre-installed Chromium if present (e.g. cloud dev containers),
// otherwise fall back to Playwright's own managed browser.
const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = existsSync(preinstalled) ? preinstalled : undefined;

const baseURL = process.env.MO_BASE_URL || 'http://localhost:4318';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: { executablePath },
  },
});
