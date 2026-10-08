import { expect, test, type Page } from '@playwright/test';

// A 1x1 PNG. The browser decodes it, downsizes it if needed and uploads it to the mock staged target.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function pickFile(page: Page, buttonName: string | RegExp, index = 0): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: buttonName }).nth(index).click(),
  ]);
  await chooser.setFiles({ name: 'reference.png', mimeType: 'image/png', buffer: PNG });
}

// Mock mode: no Shopify, no backend. Runs the whole core flow of the embedded app in a plain tab.
test('select products, add references, generate, follow the batch, retry and view outputs', async ({ page }) => {
  // 1. Products: filter tabs and selection
  await page.goto('/products');
  await expect(page.getByText('Ceramic Table Lamp')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Draft' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Ceramic Table Lamp' }).click();
  await page.getByRole('checkbox', { name: 'Select Linen Throw Blanket' }).click();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Generate content' }).click();

  // 2. New generation: both products start unresolved
  await expect(page).toHaveURL(/\/generate/);
  // Polaris renders a banner heading twice in the DOM (light DOM and slot), so match the first.
  await expect(page.getByText('2 products need a reference.').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^Generate 2 products/ })).toBeDisabled();

  // 3. One product gets its own reference, the other needs the common one
  await pickFile(page, 'Add references to Ceramic Table Lamp');
  await expect(page.getByText('1 product needs a reference.').first()).toBeVisible({ timeout: 20_000 });
  await pickFile(page, 'Add files');
  await expect(page.getByText(/needs? a reference\./)).toHaveCount(0, { timeout: 30_000 });
  const generate = page.getByRole('button', { name: /^Generate 2 products/ });
  await expect(generate).toBeEnabled({ timeout: 30_000 });
  await generate.click();

  // 4. Batch detail follows the mock timeline to a finished batch with a failed video
  await expect(page).toHaveURL(/\/generations\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByText('2 products').first()).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry failed' });
  await expect(retry).toBeVisible({ timeout: 60_000 });
  await retry.click();
  await expect(page.getByText('Retrying the failed jobs')).toBeVisible();

  // 5. Media viewer
  await page.getByRole('button', { name: /^Open image 1 of/ }).first().click();
  await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible();
  await page.keyboard.press('Escape');

  // 6. The new batch is in the list
  await page.goto('/generations');
  await expect(page.getByRole('link', { name: '2 products' }).first()).toBeVisible({ timeout: 20_000 });
});
