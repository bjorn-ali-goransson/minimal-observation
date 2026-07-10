import { test, expect, type Page } from '@playwright/test';

/**
 * Exercises the AI investigator end-to-end with the Anthropic API mocked at the HTTP
 * boundary (see mocks/anthropic.mjs). The real agent loop runs: it issues a tool call,
 * the server dispatches it and queries DuckDB, then the mock returns a final analysis.
 * Skipped when running against an external server (compose) that isn't wired to the mock.
 */
const KEY = process.env.MO_API_KEY || 'dev-secret-key';

// Runs whenever a mock-wired server is the target (self-managed run sets this; the SQLite
// CI job sets it too). Off by default so plain external runs don't hit a real API.
test.skip(process.env.MO_AGENT_E2E !== '1', 'set MO_AGENT_E2E=1 with the Anthropic mock wired');

async function connect(page: Page) {
  await page.addInitScript((k) => localStorage.setItem('mo.apikey', k), KEY);
  await page.goto('/#/agent');
}

test('AI investigator runs the real tool loop against the mocked LLM', async ({ page }) => {
  await connect(page);
  await expect(page.locator('.h1', { hasText: 'AI Investigator' })).toBeVisible();
  // Agent must be enabled (server has a key + mock base URL).
  await expect(page.getByText('Agent disabled')).toHaveCount(0);

  await page.locator('button.primary', { hasText: 'Investigate' }).click();

  // Final analysis from the mock.
  await expect(page.locator('pre.answer')).toContainText('MOCK ANALYSIS', { timeout: 15_000 });
  // The investigation trail shows the real tool call that was dispatched.
  await expect(page.getByText('Investigation trail')).toBeVisible();
  await expect(page.locator('.step .t', { hasText: 'list_services' })).toBeVisible();
});
