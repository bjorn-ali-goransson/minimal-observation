import { test, expect, type Page } from '@playwright/test';

const KEY = process.env.MO_API_KEY || 'dev-secret-key';

async function connect(page: Page) {
  await page.addInitScript((k) => localStorage.setItem('mo.apikey', k), KEY);
  await page.goto('/');
}

test('services list renders seeded services', async ({ page }) => {
  await connect(page);
  await expect(page.locator('.h1', { hasText: 'Services' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'api-gateway' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'checkout-service' })).toBeVisible();
});

test('drill service -> endpoint -> trace waterfall', async ({ page }) => {
  await connect(page);
  await page.getByRole('link', { name: 'checkout-service' }).click();
  await expect(page.locator('.h1', { hasText: 'checkout-service' })).toBeVisible();

  await page.getByRole('link', { name: 'GET /api/cart' }).first().click();
  // endpoint detail shows percentile stat cards
  await expect(page.locator('.stat .k', { hasText: 'p95' })).toBeVisible();
  await expect(page.locator('.stat .k', { hasText: 'Requests' })).toBeVisible();

  // open a request trace -> waterfall shows spans incl. a db span
  await page.locator('table a.mono, table .mono a').first().waitFor();
  await page.locator('a[href*="#/trace"]').first().click();
  await expect(page.locator('.wf-row')).not.toHaveCount(0);
  await expect(page.getByText('SELECT products').first()).toBeVisible();
});

test('dependencies view lists postgres and shows callers', async ({ page }) => {
  await connect(page);
  await page.getByRole('link', { name: 'Dependencies' }).click();
  await expect(page.getByRole('link', { name: 'postgresql:shop' })).toBeVisible();
  await page.getByRole('link', { name: 'postgresql:shop' }).click();
  await expect(page.locator('.h1', { hasText: 'postgresql:shop' })).toBeVisible();
  await expect(page.getByText('Top calling services')).toBeVisible();
});

test('custom SQL query returns rows', async ({ page }) => {
  await connect(page);
  await page.getByRole('link', { name: 'Query' }).click();
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('.panel h3', { hasText: /rows/ })).toBeVisible();
  await expect(page.locator('table tbody tr')).not.toHaveCount(0);
});

test('rejects a bad API key', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mo.apikey', 'wrong-key'));
  await page.goto('/');
  await expect(page.getByText('Enter your API key')).toBeVisible();
});
