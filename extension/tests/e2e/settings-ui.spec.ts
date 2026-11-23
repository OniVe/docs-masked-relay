import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, type Request, test } from './fixtures';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const TXT_NAME = `${PERSON} договор.txt`;
const TXT_TEXT = `Договор\n${PERSON}\n${EMAIL}\n`;
const UPLOAD_URL = 'https://files.oaiusercontent.com/upload/settings-ui?sv=1&sig=test';
const PASSPHRASE = 'settings-ui passphrase';

const MOCK_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Mock ChatGPT</title></head>
  <body>
    <h1>Mock ChatGPT</h1>
    <input id="file" type="file" multiple>
    <script>window.__REQUESTS__ = [];</script>
  </body>
</html>`;

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function extensionId(context: BrowserContext): Promise<string> {
  const worker =
    context
      .serviceWorkers()
      .find((candidate) => candidate.url().startsWith('chrome-extension://')) ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return new URL(worker.url()).host;
}

async function openPopup(context: BrowserContext, id: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await expect(page.locator('#enabled-toggle')).toBeVisible();
  return page;
}

async function openOptions(context: BrowserContext, id: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.locator('#max-bytes')).toBeVisible();
  return page;
}

/** Fulfills chatgpt.com + oaiusercontent and records the wire requests. */
async function openMockPage(context: BrowserContext): Promise<{
  page: Page;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const page = await context.newPage();

  const corsHeaders = {
    'access-control-allow-origin': 'https://chatgpt.com',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '600',
  };

  const record = (request: Request): void => {
    const body = request.postDataBuffer();
    requests.push({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      body: body ? body.toString('base64') : '',
    });
  };

  await page.route('https://chatgpt.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.resourceType() === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_HTML });
      return;
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    record(request);
    if (request.method() === 'POST' && url.pathname === '/backend-api/files') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ file_id: 'file_settings', upload_url: UPLOAD_URL }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: '{"ok":true}',
    });
  });

  await page.route('https://files.oaiusercontent.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    record(request);
    await route.fulfill({
      status: 200,
      headers: corsHeaders,
      contentType: 'application/json',
      body: '{"ok":true}',
    });
  });

  await page.goto('https://chatgpt.com/c/settings-ui');
  await expect
    .poll(() => page.evaluate(() => (window as any).__DM_RELAY_MAIN__ === true))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.dmRelay))
    .toBe('isolated');
  return { page, requests };
}

async function captureFile(page: Page, name: string, content: string): Promise<void> {
  await page.evaluate(
    ({ name: fileName, content: fileContent }) => {
      const input = document.querySelector('#file') as HTMLInputElement;
      const file = new File([fileContent], fileName, { type: 'text/plain' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name, content },
  );
}

async function uploadCaptured(page: Page): Promise<number | string> {
  return page.evaluate(async () => {
    const file = (document.querySelector('#file') as HTMLInputElement).files?.[0];
    if (!file) throw new Error('file missing');
    try {
      const metadataResponse = await fetch('/backend-api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type,
          use_case: 'my_files',
        }),
      });
      const metadata = (await metadataResponse.json()) as { upload_url: string };
      const put = await fetch(metadata.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      return put.status;
    } catch (error) {
      return (error as Error).name;
    }
  });
}

function bodyText(request: RecordedRequest): string {
  return Buffer.from(request.body, 'base64').toString('utf8');
}

function metadataOf(requests: RecordedRequest[]): Record<string, unknown> {
  const metadata = requests.find(
    (request) =>
      request.method === 'POST' && new URL(request.url).pathname === '/backend-api/files',
  );
  expect(metadata, 'metadata POST was not observed').toBeTruthy();
  return JSON.parse(bodyText(metadata as RecordedRequest)) as Record<string, unknown>;
}

function putsOf(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.method === 'PUT');
}

test.describe('M6b settings UI', () => {
  test('options persist settings across a reload', async ({ extensionContext: context }) => {
    const id = await extensionId(context);
    const page = await openOptions(context, id);

    await expect(page.locator('#onboarding')).toBeVisible();
    await page.click('#onboarding-dismiss');
    await expect(page.locator('#onboarding')).toBeHidden();

    await page.fill('#max-bytes', '7');
    await page.fill('#vault-lock-minutes', '30');
    await page.check('#aggressive');
    await page.fill('#custom-terms', 'Феникс\nПроект Альфа');
    await page.fill('#allowlist', 'example.ru');
    await page.locator('input[data-label="EMAIL"]').uncheck();
    await page.check('#enable-url');
    await page.click('#save-button');
    await expect(page.locator('#save-status')).toContainText('сохранены');

    await page.reload();
    await expect(page.locator('#max-bytes')).toHaveValue('7');
    await expect(page.locator('#vault-lock-minutes')).toHaveValue('30');
    await expect(page.locator('#aggressive')).toBeChecked();
    await expect(page.locator('#custom-terms')).toHaveValue('Феникс\nПроект Альфа');
    await expect(page.locator('#allowlist')).toHaveValue('example.ru');
    await expect(page.locator('input[data-label="EMAIL"]')).not.toBeChecked();
    await expect(page.locator('#enable-url')).toBeChecked();
    await expect(page.locator('#strip-metadata')).toBeChecked();
    await expect(page.locator('#strip-metadata')).toBeDisabled();
    await expect(page.locator('#onboarding')).toBeHidden();
  });

  test('popup toggle stops and restarts interception without reload', async ({
    extensionContext: context,
  }) => {
    const id = await extensionId(context);
    const popup = await openPopup(context, id);
    await expect(popup.locator('#enabled-toggle')).toBeChecked();

    const { page, requests } = await openMockPage(context);
    await expect
      .poll(() => page.evaluate(() => (window as any).__DM_RELAY_ENABLED__ === true))
      .toBe(true);

    await captureFile(page, TXT_NAME, TXT_TEXT);
    expect(await uploadCaptured(page)).toBe(200);
    const firstMetadata = metadataOf(requests);
    expect(String(firstMetadata.file_name)).toContain('[[');
    expect(String(firstMetadata.file_name)).not.toContain(PERSON);

    await popup.uncheck('#enabled-toggle');
    await expect(popup.locator('#protection-message')).toContainText('выключен');
    await expect
      .poll(() => page.evaluate(() => (window as any).__DM_RELAY_ENABLED__ === false))
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.dmProtection))
      .toBe('off');

    requests.length = 0;
    await captureFile(page, TXT_NAME, TXT_TEXT);
    expect(await uploadCaptured(page)).toBe(200);
    const passMetadata = metadataOf(requests);
    expect(passMetadata.file_name).toBe(TXT_NAME);
    const passPuts = putsOf(requests);
    expect(passPuts).toHaveLength(1);
    expect(bodyText(passPuts[0] as RecordedRequest)).toContain(PERSON);
    expect(bodyText(passPuts[0] as RecordedRequest)).toContain(EMAIL);

    await popup.check('#enabled-toggle');
    await expect(popup.locator('#protection-message')).toContainText('включён');
    await expect
      .poll(() => page.evaluate(() => (window as any).__DM_RELAY_ENABLED__ === true))
      .toBe(true);

    requests.length = 0;
    await captureFile(page, TXT_NAME, TXT_TEXT);
    expect(await uploadCaptured(page)).toBe(200);
    const maskedMetadata = metadataOf(requests);
    expect(String(maskedMetadata.file_name)).toContain('[[');
    expect(String(maskedMetadata.file_name)).not.toContain(PERSON);
    expect([...putsOf(requests)].some((request) => !bodyText(request).includes(PERSON))).toBe(true);
  });

  test('locked vault aborts uploads and unlocks through the popup', async ({
    extensionContext: context,
  }) => {
    const id = await extensionId(context);
    const options = await openOptions(context, id);
    await options.fill('#passphrase-new', PASSPHRASE);
    await options.fill('#passphrase-new-confirm', PASSPHRASE);
    await options.click('#passphrase-enable-button');
    await expect(options.locator('#security-message')).toContainText('включена');

    const popup = await openPopup(context, id);
    await expect(popup.locator('#vault-state')).toHaveText('Разблокирован');
    await popup.click('#lock-button');
    await expect(popup.locator('#vault-state')).toHaveText('Заблокирован');
    await expect(popup.locator('#unlock-form')).toBeVisible();

    const { page, requests } = await openMockPage(context);
    await captureFile(page, TXT_NAME, TXT_TEXT);
    expect(await uploadCaptured(page)).toBe('AbortError');
    expect(requests).toHaveLength(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-dm-relay-toast]')?.shadowRoot?.textContent ?? '',
        ),
      )
      .toContain('Хранилище заблокировано');

    await popup.fill('#unlock-passphrase', 'wrong passphrase');
    await popup.click('#unlock-button');
    await expect(popup.locator('#vault-message')).toContainText('Неверная');
    await expect(popup.locator('#vault-state')).toHaveText('Заблокирован');

    await popup.fill('#unlock-passphrase', PASSPHRASE);
    await popup.click('#unlock-button');
    await expect(popup.locator('#vault-state')).toHaveText('Разблокирован');

    requests.length = 0;
    await captureFile(page, TXT_NAME, TXT_TEXT);
    expect(await uploadCaptured(page)).toBe(200);
    expect(String(metadataOf(requests).file_name)).toContain('[[');
  });

  test('exports an encrypted backup and imports it after clearing data', async ({
    extensionContext: context,
  }) => {
    const id = await extensionId(context);
    const popup = await openPopup(context, id);
    await popup.setInputFiles('#anonymize-file', {
      name: TXT_NAME,
      mimeType: 'text/plain',
      buffer: Buffer.from(TXT_TEXT, 'utf8'),
    });
    const download = popup.waitForEvent('download');
    await popup.click('#anonymize-button');
    const masked = await download;
    const maskedPath = await masked.path();
    expect(maskedPath).toBeTruthy();
    await expect(popup.locator('#manual-status')).toContainText('Анонимизировано');

    const options = await openOptions(context, id);
    await expect(options.locator('#vault-list li')).toHaveCount(1);
    const prefix = (await options.locator('.vault-prefix').first().textContent())?.trim();
    expect(prefix).toMatch(/^[A-Z0-9]{5}$/u);

    await options.fill('#export-passphrase', 'backup passphrase');
    const backupDownload = options.waitForEvent('download');
    await options.click('#export-button');
    const backup = await backupDownload;
    const backupPath = await backup.path();
    expect(backupPath).toBeTruthy();
    const backupText = readFileSync(backupPath as string, 'utf8');
    expect(backupText).not.toContain(PERSON);
    expect(backupText).not.toContain(EMAIL);
    const parsed = JSON.parse(backupText) as Record<string, unknown>;
    expect(typeof parsed.salt).toBe('string');
    expect(typeof parsed.iv).toBe('string');
    expect(typeof parsed.ciphertext).toBe('string');

    await options.click('#clear-data-button');
    await expect(options.locator('#clear-data-panel')).toBeVisible();
    await expect(options.locator('#clear-data-confirm')).toBeVisible();
    await options.click('#clear-data-confirm');
    await expect(options.locator('#data-message')).toContainText('удалены');
    await expect(options.locator('#vault-empty')).toBeVisible();

    await options.setInputFiles('#import-file', backupPath as string);
    await options.fill('#import-passphrase', 'backup passphrase');
    await options.click('#import-button');
    await expect(options.locator('#import-message')).toContainText('Импортировано: 1 хранилище');
    await expect(options.locator('#vault-list li')).toHaveCount(1);
    await expect(options.locator('.vault-prefix').first()).toHaveText(prefix as string);
  });
});
