import { type BrowserContext, expect, type Page, type Request, test } from './fixtures';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const TXT_NAME = `${PERSON} договор.txt`;
const TXT_TEXT = `Договор\n${PERSON}\n${EMAIL}\n`;

const FILES_UPLOAD_URL = 'https://files.oaiusercontent.com/upload/abc?sv=1&sig=test';
const DOWNLOAD_JSON_PATH = '/backend-api/files/file_mock/download';
const DOWNLOAD_URL = 'https://chatgpt.com/backend-api/estuary/content?id=file-1';

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

interface DownloadFixture {
  json?: Record<string, unknown>;
  bytes?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

function decodeBody(request: { body: string }): Buffer {
  return Buffer.from(request.body, 'base64');
}

function bodyText(request: { body: string }): string {
  return decodeBody(request).toString('utf8');
}

async function waitForInjection(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as any).__DM_RELAY_MAIN__ === true))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.dmRelay))
    .toBe('isolated');
}

/** Fulfills chatgpt.com + oaiusercontent and records request bodies. */
async function openDownloadPage(
  context: BrowserContext,
  chatId: string,
): Promise<{ page: Page; requests: RecordedRequest[]; fixture: DownloadFixture }> {
  const requests: RecordedRequest[] = [];
  const fixture: DownloadFixture = {};
  const page = await context.newPage();

  const record = (request: Request): void => {
    const body = request.postDataBuffer();
    requests.push({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      body: body ? body.toString('base64') : '',
    });
  };

  const corsHeaders = {
    'access-control-allow-origin': 'https://chatgpt.com',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '600',
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
        body: JSON.stringify({ file_id: 'file_mock', upload_url: FILES_UPLOAD_URL }),
      });
      return;
    }

    if (request.method() === 'GET' && url.pathname === DOWNLOAD_JSON_PATH) {
      if (!fixture.json) {
        await route.fulfill({ status: 404, body: 'not found' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture.json),
      });
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/backend-api/estuary/content') {
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': fixture.contentType ?? 'application/octet-stream',
          ...(fixture.headers ?? {}),
        },
        body: fixture.bytes ?? Buffer.alloc(0),
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

  await page.goto(`https://chatgpt.com/c/${chatId}`);
  await waitForInjection(page);
  return { page, requests, fixture };
}

async function captureFile(page: Page, name: string, content: string, type: string): Promise<void> {
  await page.evaluate(
    ({ name: fileName, content: fileContent, type: mime }) => {
      const input = document.querySelector('#file') as HTMLInputElement;
      const file = new File([fileContent], fileName, { type: mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name, content, type },
  );
}

/** Uploads through the M3 hook and returns the masked name/body seen by the mock. */
async function uploadTxt(
  page: Page,
  requests: RecordedRequest[],
): Promise<{ maskedName: string; maskedBody: string }> {
  const status = await page.evaluate(async () => {
    const file = (document.querySelector('#file') as HTMLInputElement).files?.[0];
    if (!file) throw new Error('file missing');
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
  });
  expect(status).toBe(200);

  const metadata = requests.find(
    (request) =>
      request.method === 'POST' && new URL(request.url).pathname === '/backend-api/files',
  );
  const put = requests.find((request) => request.method === 'PUT');
  expect(metadata, 'upload metadata was not observed').toBeTruthy();
  expect(put, 'upload PUT was not observed').toBeTruthy();

  const parsed = JSON.parse(bodyText(metadata as RecordedRequest)) as { file_name: string };
  return { maskedName: parsed.file_name, maskedBody: bodyText(put as RecordedRequest) };
}

function setDownloadFixture(
  fixture: DownloadFixture,
  maskedName: string,
  maskedBody: string,
): void {
  fixture.json = {
    status: 'success',
    download_url: DOWNLOAD_URL,
    file_name: maskedName,
    mime_type: 'text/plain',
    file_size_bytes: Buffer.byteLength(maskedBody),
  };
  fixture.bytes = Buffer.from(maskedBody);
  fixture.contentType = 'text/plain; charset=utf-8';
}

async function fetchDownload(page: Page): Promise<{
  file_name: string;
  text: string;
  contentType: string | null;
  contentLength: string | null;
}> {
  return page.evaluate(async () => {
    const meta = (await (await fetch('/backend-api/files/file_mock/download')).json()) as {
      download_url: string;
      file_name: string;
    };
    const response = await fetch(meta.download_url);
    return {
      file_name: meta.file_name,
      text: await response.text(),
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
    };
  });
}

async function toastText(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('[data-dm-relay-toast]')?.shadowRoot?.textContent ?? '',
  );
}

test.describe('M4 download interception (mock chatgpt.com)', () => {
  test('A: JSON file_name + bytes are restored through the bridge', async ({
    extensionContext: context,
  }) => {
    const { page, requests, fixture } = await openDownloadPage(context, 'chat-dl-a');
    await captureFile(page, TXT_NAME, TXT_TEXT, 'text/plain');
    const { maskedName, maskedBody } = await uploadTxt(page, requests);

    expect(maskedName).toContain('[[');
    expect(maskedBody).toContain('[[');
    expect(maskedBody).not.toContain(PERSON);
    setDownloadFixture(fixture, maskedName, maskedBody);

    const result = await fetchDownload(page);
    expect(result.file_name).toBe(TXT_NAME);
    expect(result.text).toBe(TXT_TEXT);
    expect(result.contentType).toContain('text/plain');
    expect(result.contentLength).toBeNull();

    await expect.poll(() => toastText(page)).toContain('Восстановлено');
  });

  test('B: untagged metadata and bytes pass through unchanged', async ({
    extensionContext: context,
  }) => {
    const { page, fixture } = await openDownloadPage(context, 'chat-dl-b');
    fixture.json = {
      status: 'success',
      download_url: DOWNLOAD_URL,
      file_name: 'plain.txt',
      mime_type: 'text/plain',
    };
    fixture.bytes = Buffer.from('plain file\n');
    fixture.contentType = 'text/plain';

    const result = await fetchDownload(page);
    expect(result.file_name).toBe('plain.txt');
    expect(result.text).toBe('plain file\n');
    expect(result.contentType).toContain('text/plain');
    expect(await page.evaluate(() => document.querySelector('[data-dm-relay-toast]'))).toBeNull();
  });

  test('C: unknown prefix is left untouched and warns', async ({ extensionContext: context }) => {
    const { page, fixture } = await openDownloadPage(context, 'chat-dl-c');
    const tagged = '[[ZZZZZ_PERSON_1]] secret\n';
    fixture.json = {
      status: 'success',
      download_url: DOWNLOAD_URL,
      file_name: '[[ZZZZZ_PERSON_1]]_secret.txt',
      mime_type: 'text/plain',
    };
    fixture.bytes = Buffer.from(tagged);
    fixture.contentType = 'text/plain';

    const result = await fetchDownload(page);
    expect(result.file_name).toBe('[[ZZZZZ_PERSON_1]]_secret.txt');
    expect(result.text).toBe(tagged);

    await expect.poll(() => toastText(page)).toContain('Хранилище не найдено');
  });

  test('D: XHR metadata (text) + XHR bytes (blob) are restored', async ({
    extensionContext: context,
  }) => {
    const { page, requests, fixture } = await openDownloadPage(context, 'chat-dl-xhr');
    await captureFile(page, TXT_NAME, TXT_TEXT, 'text/plain');
    const { maskedName, maskedBody } = await uploadTxt(page, requests);
    setDownloadFixture(fixture, maskedName, maskedBody);

    const result = await page.evaluate(async () => {
      interface DownloadResult {
        file_name: string;
        text: string;
        type: string;
      }

      const downloadWithHandlers = async (): Promise<DownloadResult> => {
        const meta = await new Promise<{ download_url: string; file_name: string }>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', '/backend-api/files/file_mock/download');
            xhr.onload = () => {
              try {
                resolve(
                  JSON.parse(xhr.responseText) as { download_url: string; file_name: string },
                );
              } catch (error) {
                reject(error);
              }
            };
            xhr.onerror = () => reject(new Error('metadata xhr error'));
            xhr.send();
          },
        );

        return new Promise<DownloadResult>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', meta.download_url);
          xhr.responseType = 'blob';
          xhr.onload = () => {
            const blob = xhr.response as Blob;
            void blob.text().then((text) => {
              resolve({ file_name: meta.file_name, text, type: blob.type });
            }, reject);
          };
          xhr.onerror = () => reject(new Error('bytes xhr error'));
          xhr.send();
        });
      };

      const downloadWithListeners = async (): Promise<DownloadResult> => {
        const meta = await new Promise<{ download_url: string; file_name: string }>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', '/backend-api/files/file_mock/download');
            xhr.addEventListener('load', () => {
              try {
                resolve(
                  JSON.parse(xhr.responseText) as { download_url: string; file_name: string },
                );
              } catch (error) {
                reject(error);
              }
            });
            xhr.onerror = () => reject(new Error('metadata xhr error'));
            xhr.send();
          },
        );

        return new Promise<DownloadResult>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', meta.download_url);
          xhr.responseType = 'blob';
          xhr.addEventListener('load', () => {
            const blob = xhr.response as Blob;
            void blob.text().then((text) => {
              resolve({ file_name: meta.file_name, text, type: blob.type });
            }, reject);
          });
          xhr.onerror = () => reject(new Error('bytes xhr error'));
          xhr.send();
        });
      };

      return {
        handlers: await downloadWithHandlers(),
        listeners: await downloadWithListeners(),
      };
    });

    for (const output of [result.handlers, result.listeners]) {
      expect(output.file_name).toBe(TXT_NAME);
      expect(output.text).toBe(TXT_TEXT);
      expect(output.type).toContain('text/plain');
    }

    await expect.poll(() => toastText(page)).toContain('Восстановлено');
  });
});
