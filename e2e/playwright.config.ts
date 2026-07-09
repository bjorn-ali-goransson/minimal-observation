import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');

// Use the environment's pre-installed Chromium if present, else Playwright's own.
const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = existsSync(preinstalled) ? preinstalled : undefined;

// Two modes:
//  - external: MO_BASE_URL is set (e.g. `docker compose up` with MinIO-mocked S3) — test that.
//  - self-managed (default): Playwright boots the app + a MOCK Anthropic server, so the whole
//    suite runs offline with nothing external. Cold tier is local Parquet; the LLM is mocked.
const external = !!process.env.MO_BASE_URL;
const APP_PORT = 4318;
const MOCK_PORT = 4390;
const baseURL = process.env.MO_BASE_URL || `http://localhost:${APP_PORT}`;
const KEY = process.env.MO_API_KEY || 'dev-secret-key';
const dataDir = '/tmp/mo-e2e-data';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: { executablePath },
  },
  webServer: external
    ? undefined
    : [
        {
          command: `node mocks/anthropic.mjs`,
          cwd: __dirname,
          env: { MOCK_ANTHROPIC_PORT: String(MOCK_PORT) },
          url: `http://localhost:${MOCK_PORT}/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 20_000,
        },
        {
          command: `sh -c "rm -rf ${dataDir} && node dist/index.js"`,
          cwd: resolve(repo, 'packages/server'),
          env: {
            MO_PORT: String(APP_PORT),
            MO_API_KEY: KEY,
            MO_DATA_DIR: dataDir,
            MO_COLD_KIND: 'local',
            MO_LOG_LEVEL: 'warn',
            MO_UI_DIR: resolve(repo, 'packages/ui/dist'),
            // Agent enabled, pointed at the local mock — no external Anthropic call.
            ANTHROPIC_API_KEY: 'test-key',
            ANTHROPIC_BASE_URL: `http://localhost:${MOCK_PORT}`,
            MO_AGENT_MODEL: 'mock-model',
          },
          url: `${baseURL}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
      ],
});
