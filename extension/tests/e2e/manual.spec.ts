import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, test } from './fixtures';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const ORIGINAL_NAME = `${PERSON}.txt`;
const ORIGINAL_TEXT = `Договор\n${PERSON}\n${EMAIL}\n`;

async function extensionId(context: BrowserContext): Promise<string> {
  const worker =
    context
      .serviceWorkers()
      .find((candidate) => candidate.url().startsWith('chrome-extension://')) ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return new URL(worker.url()).host;
}

test.describe('M4 manual mode (popup)', () => {
  test('anonymizes and restores a file through the popup controls', async ({
    extensionContext: context,
  }) => {
    const id = await extensionId(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);

    await expect(page.locator('#anonymize-file')).toBeVisible();
    await expect(page.locator('#anonymize-button')).toBeEnabled();
    await expect(page.locator('#restore-file')).toBeVisible();
    await expect(page.locator('#restore-button')).toBeEnabled();

    await page.setInputFiles('#anonymize-file', {
      name: ORIGINAL_NAME,
      mimeType: 'text/plain',
      buffer: Buffer.from(ORIGINAL_TEXT, 'utf8'),
    });

    const anonymizeDownload = page.waitForEvent('download');
    await page.click('#anonymize-button');
    const maskedDownload = await anonymizeDownload;
    const maskedPath = await maskedDownload.path();
    expect(maskedPath, 'anonymized download path').toBeTruthy();
    const maskedText = readFileSync(maskedPath as string, 'utf8');
    const maskedName = maskedDownload.suggestedFilename();

    expect(maskedText).not.toContain(PERSON);
    expect(maskedText).not.toContain(EMAIL);
    expect(maskedText).toContain('[[');
    expect(maskedName).toContain('[[');
    expect(maskedName).not.toContain(PERSON);
    await expect(page.locator('#manual-status')).toContainText('Анонимизировано');

    await page.setInputFiles('#restore-file', {
      name: maskedName,
      mimeType: 'text/plain',
      buffer: Buffer.from(maskedText, 'utf8'),
    });

    const restoreDownload = page.waitForEvent('download');
    await page.click('#restore-button');
    const restoredDownload = await restoreDownload;
    const restoredPath = await restoredDownload.path();
    expect(restoredPath, 'restored download path').toBeTruthy();
    const restoredText = readFileSync(restoredPath as string, 'utf8');

    expect(restoredText).toBe(ORIGINAL_TEXT);
    expect(restoredDownload.suggestedFilename()).toBe(ORIGINAL_NAME);
    await expect(page.locator('#manual-status')).toContainText('Восстановлено');
  });
});
