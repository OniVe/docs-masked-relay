import { docFixtureBase64 } from '../fixtures/doc';
import { DATE_SERIAL, legacyXls, readXls } from '../fixtures/xls';
import { type BrowserContext, expect, type Page, type Request, test } from './fixtures';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const TXT_NAME = `${PERSON} договор.txt`;
const TXT_TEXT = `Договор\n${PERSON}\n${EMAIL}\n`;
const PDF_NAME = `${PERSON} скан.pdf`;

const FILES_UPLOAD_URL = 'https://files.oaiusercontent.com/upload/abc?sv=1&sig=test';
const ESTUARY_URL = 'https://chatgpt.com/backend-api/estuary/upload_content_bytes';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const MOCK_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Mock ChatGPT</title></head>
  <body>
    <h1>Mock ChatGPT</h1>
    <input id="file" type="file" multiple>
    <div id="drop"></div>
    <script>window.__REQUESTS__ = [];</script>
  </body>
</html>`;

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** base64 so binary bodies survive page.evaluate. */
  body: string;
}

interface PageRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
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

/** Fulfills chatgpt.com + oaiusercontent and records what actually reaches the wire. */
async function openMockPage(
  context: BrowserContext,
  chatId: string,
  uploadUrl: string,
): Promise<{ page: Page; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
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
        body: JSON.stringify({ file_id: 'file_mock', upload_url: uploadUrl }),
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
  return { page, requests };
}

/** The mock page owns `window.__REQUESTS__`; the test reads it back via evaluate. */
async function readPageRequests(page: Page, requests: RecordedRequest[]): Promise<PageRequest[]> {
  return page.evaluate((entries) => {
    (window as any).__REQUESTS__ = entries;
    return (window as any).__REQUESTS__ as PageRequest[];
  }, requests);
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

/** Captures a binary fixture: base64 crosses into the page, exact bytes stay. */
async function captureBinaryFile(
  page: Page,
  name: string,
  base64: string,
  type: string,
): Promise<void> {
  await page.evaluate(
    ({ name: fileName, base64: encoded, type: mime }) => {
      const raw = atob(encoded);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
      const input = document.querySelector('#file') as HTMLInputElement;
      const file = new File([bytes], fileName, { type: mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name, base64, type },
  );
}

/** Uploads the captured file via metadata JSON + PUT; returns the PUT status. */
async function uploadCaptured(page: Page, uploadUrl: string): Promise<number> {
  return page.evaluate(async (url) => {
    const file = (document.querySelector('#file') as HTMLInputElement).files?.[0];
    if (!file) throw new Error('file missing');

    const metadataResponse = await fetch('/backend-api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
        client_resolved_mime_type: file.type,
        mime_resolution_source: 'client',
        use_case: 'my_files',
      }),
    });
    const metadata = (await metadataResponse.json()) as { upload_url: string };
    if (metadata.upload_url !== url) throw new Error('unexpected upload url');

    const put = await fetch(metadata.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    return put.status;
  }, uploadUrl);
}

function metadataOf(requests: PageRequest[]): Record<string, unknown> {
  const metadata = requests.find(
    (request) =>
      request.method === 'POST' && new URL(request.url).pathname === '/backend-api/files',
  );
  expect(metadata, 'metadata POST was not observed').toBeTruthy();
  return JSON.parse(bodyText(metadata as PageRequest)) as Record<string, unknown>;
}

function expectMaskedNotPii(body: Buffer): void {
  const text = body.toString('utf8');
  expect(text).not.toContain(PERSON);
  expect(text).not.toContain(EMAIL);
  expect(text).toMatch(/\[\[[A-Z0-9]{5}_PERSON_1\]\]/u);
  expect(text).toContain('_EMAIL_1]]');
}

function multipartPart(body: Buffer, contentType: string, fieldName: string): Buffer | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) return undefined;

  const raw = body.toString('latin1');
  const parts = raw.split(`--${marker}`);
  for (const part of parts) {
    if (!part.includes(`name="${fieldName}"`)) continue;
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const payload = part.slice(split + 4);
    const end = payload.lastIndexOf('\r\n');
    const content = end === -1 ? payload : payload.slice(0, end);
    return Buffer.from(content, 'latin1');
  }
  return undefined;
}

test.describe('M3b upload interception (mock chatgpt.com)', () => {
  test('A: fetch metadata + PUT sends only masked TXT bytes', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-a', FILES_UPLOAD_URL);
    await captureFile(page, TXT_NAME, TXT_TEXT, 'text/plain');

    const result = await page.evaluate(async () => {
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
          store_in_library: true,
        }),
      });
      const metadata = (await metadataResponse.json()) as { upload_url: string };
      const put = await fetch(metadata.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      return { status: put.status, uploadUrl: metadata.upload_url };
    });

    expect(result.status).toBe(200);
    expect(result.uploadUrl).toBe(FILES_UPLOAD_URL);

    const pageRequests = await readPageRequests(page, requests);
    const metadata = metadataOf(pageRequests);

    expect(metadata.file_name).toContain('[[');
    expect(String(metadata.file_name)).not.toContain(PERSON);
    expect(metadata.mime_type).toBe('text/plain');
    expect(metadata.use_case).toBe('my_files');
    expect(metadata.store_in_library).toBe(true);

    const puts = pageRequests.filter((request) => request.method === 'PUT');
    expect(puts).toHaveLength(1);
    const putBody = decodeBody(puts[0] as PageRequest);
    expect(metadata.file_size).toBe(putBody.byteLength);
    expectMaskedNotPii(putBody);

    for (const request of pageRequests) {
      expect(bodyText(request)).not.toContain(PERSON);
      expect(bodyText(request)).not.toContain(EMAIL);
    }

    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-dm-relay-toast]')?.shadowRoot?.textContent ?? '',
        ),
      )
      .toContain('Анонимизировано');
  });

  test('B: XHR metadata + XHR PUT sends only masked TXT bytes', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-b', FILES_UPLOAD_URL);
    await captureFile(page, TXT_NAME, TXT_TEXT, 'text/plain');

    const result = await page.evaluate(async () => {
      const file = (document.querySelector('#file') as HTMLInputElement).files?.[0];
      if (!file) throw new Error('file missing');

      const xhr = (
        method: string,
        url: string,
        body: Document | XMLHttpRequestBodyInit | null,
        headers: Record<string, string>,
      ): Promise<{ status: number; text: string }> =>
        new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open(method, url);
          for (const [key, value] of Object.entries(headers)) {
            request.setRequestHeader(key, value);
          }
          request.onload = () => resolve({ status: request.status, text: request.responseText });
          request.onerror = () => reject(new Error('xhr error'));
          request.onabort = () => reject(new Error('xhr abort'));
          request.send(body);
        });

      const metadataText = await xhr(
        'POST',
        '/backend-api/files',
        JSON.stringify({
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type,
          use_case: 'my_files',
        }),
        { 'Content-Type': 'application/json' },
      );
      const metadata = JSON.parse(metadataText.text) as { upload_url: string };
      const put = await xhr('PUT', metadata.upload_url, file, { 'Content-Type': file.type });
      return { status: put.status, uploadUrl: metadata.upload_url };
    });

    expect(result.status).toBe(200);

    const pageRequests = await readPageRequests(page, requests);
    const metadata = metadataOf(pageRequests);
    expect(metadata.file_name).toContain('[[');
    expect(String(metadata.file_name)).not.toContain(PERSON);

    const puts = pageRequests.filter((request) => request.method === 'PUT');
    expect(puts).toHaveLength(1);
    const putBody = decodeBody(puts[0] as PageRequest);
    expect(metadata.file_size).toBe(putBody.byteLength);
    expectMaskedNotPii(putBody);
  });

  test('C: estuary multipart replaces the file part', async ({ extensionContext: context }) => {
    const { page, requests } = await openMockPage(context, 'chat-c', ESTUARY_URL);
    await captureFile(page, TXT_NAME, TXT_TEXT, 'text/plain');

    const result = await page.evaluate(async () => {
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

      const form = new FormData();
      form.append('file', file);
      form.append('upload_url', metadata.upload_url);
      const response = await fetch('/backend-api/estuary/upload_content_bytes', {
        method: 'POST',
        body: form,
      });
      return { status: response.status };
    });

    expect(result.status).toBe(200);

    const pageRequests = await readPageRequests(page, requests);
    const metadata = metadataOf(pageRequests);
    expect(metadata.file_name).toContain('[[');

    const estuary = pageRequests.find(
      (request) =>
        request.method === 'POST' &&
        new URL(request.url).pathname === '/backend-api/estuary/upload_content_bytes',
    );
    expect(estuary, 'estuary multipart POST was not observed').toBeTruthy();
    const raw = decodeBody(estuary as PageRequest);
    expectMaskedNotPii(raw);
    expect(bodyText(estuary as PageRequest)).toContain(ESTUARY_URL);

    const filePart = multipartPart(
      raw,
      (estuary as PageRequest).headers?.['content-type'] ?? '',
      'file',
    );
    expect(filePart, 'multipart file part was not parsed').toBeTruthy();
    if (filePart) {
      expect(filePart.byteLength).toBe(metadata.file_size);
      expectMaskedNotPii(filePart);
    }
  });

  test('G: legacy .doc is uploaded as DOCX with updated metadata', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-g', FILES_UPLOAD_URL);
    await captureBinaryFile(page, 'test01.doc', docFixtureBase64('test01'), 'application/msword');

    expect(await uploadCaptured(page, FILES_UPLOAD_URL)).toBe(200);

    const pageRequests = await readPageRequests(page, requests);
    const metadata = metadataOf(pageRequests);
    expect(metadata.file_name).toBe('test01.docx');
    expect(metadata.mime_type).toBe(DOCX_MIME);
    expect(metadata.client_resolved_mime_type).toBe(DOCX_MIME);

    const puts = pageRequests.filter((request) => request.method === 'PUT');
    expect(puts).toHaveLength(1);
    const putBody = decodeBody(puts[0] as PageRequest);
    expect(putBody.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(metadata.file_size).toBe(putBody.byteLength);
  });

  test('H: legacy .xls is uploaded as XLSX with hidden sheets masked', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-h', FILES_UPLOAD_URL);
    const xls = legacyXls();
    await captureBinaryFile(
      page,
      'legacy.xls',
      Buffer.from(xls).toString('base64'),
      'application/vnd.ms-excel',
    );

    expect(await uploadCaptured(page, FILES_UPLOAD_URL)).toBe(200);

    const pageRequests = await readPageRequests(page, requests);
    const metadata = metadataOf(pageRequests);
    expect(metadata.file_name).toBe('legacy.xlsx');
    expect(metadata.mime_type).toBe(XLSX_MIME);
    expect(metadata.client_resolved_mime_type).toBe(XLSX_MIME);

    const puts = pageRequests.filter((request) => request.method === 'PUT');
    expect(puts).toHaveLength(1);
    const putBody = decodeBody(puts[0] as PageRequest);
    expect(putBody.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(metadata.file_size).toBe(putBody.byteLength);

    const workbook = readXls(putBody);
    expect(workbook.SheetNames).toContain('Скрытый');
    const values = workbook.SheetNames.flatMap((name) => {
      const sheet = workbook.Sheets[name];
      if (!sheet) return [];
      return Object.entries(sheet)
        .filter(([address]) => !address.startsWith('!'))
        .map(([, cell]) =>
          cell && typeof cell === 'object' && 'v' in cell ? String(cell.v ?? '') : '',
        );
    }).join('\n');
    expect(values).not.toContain(PERSON);
    expect(values).not.toContain(EMAIL);
    expect(values).toContain('_PERSON_1]]');
    expect(values).toContain('_EMAIL_1]]');
    const dateCell = workbook.Sheets.Данные?.F2 as { v?: number } | undefined;
    expect(dateCell?.v).toBe(DATE_SERIAL);
  });

  test('I: legacy .doc multipart part uses the DOCX MIME', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-i', ESTUARY_URL);
    await captureBinaryFile(page, 'test01.doc', docFixtureBase64('test01'), 'application/msword');

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
          client_resolved_mime_type: file.type,
        }),
      });
      const metadata = (await metadataResponse.json()) as { upload_url: string };
      const form = new FormData();
      form.append('file', file);
      form.append('upload_url', metadata.upload_url);
      const response = await fetch('/backend-api/estuary/upload_content_bytes', {
        method: 'POST',
        body: form,
      });
      return response.status;
    });
    expect(status).toBe(200);

    const pageRequests = await readPageRequests(page, requests);
    const metadata = metadataOf(pageRequests);
    expect(metadata.file_name).toBe('test01.docx');
    expect(metadata.mime_type).toBe(DOCX_MIME);

    const estuary = pageRequests.find(
      (request) =>
        request.method === 'POST' &&
        new URL(request.url).pathname === '/backend-api/estuary/upload_content_bytes',
    );
    expect(estuary, 'estuary multipart POST was not observed').toBeTruthy();
    const raw = decodeBody(estuary as PageRequest);
    expect(bodyText(estuary as PageRequest)).toContain(`Content-Type: ${DOCX_MIME}`);
    const filePart = multipartPart(
      raw,
      (estuary as PageRequest).headers?.['content-type'] ?? '',
      'file',
    );
    expect(filePart?.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(metadata.file_size).toBe(filePart?.byteLength);
  });

  test('H: adapter warnings are shown in the auto upload toast', async ({
    extensionContext: context,
  }) => {
    const { page } = await openMockPage(context, 'chat-warn', FILES_UPLOAD_URL);
    const utf16 = Buffer.from(`Договор\n${PERSON}\n${EMAIL}\n`, 'utf16le');
    await captureBinaryFile(page, 'warn.txt', utf16.toString('base64'), 'text/plain');

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

    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-dm-relay-toast]')?.shadowRoot?.textContent ?? '',
        ),
      )
      .toContain('UTF-16 without BOM');
  });

  test('D: metadata without a captured File is aborted and never hits the network', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-d', FILES_UPLOAD_URL);

    const fetchResult = await page.evaluate(async () => {
      try {
        await fetch('/backend-api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_name: 'ghost.txt',
            file_size: 123,
            mime_type: 'text/plain',
            use_case: 'my_files',
          }),
        });
        return 'resolved';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(fetchResult).toBe('AbortError');

    const xhrResult = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const request = new XMLHttpRequest();
          request.open('POST', '/backend-api/files');
          request.setRequestHeader('Content-Type', 'application/json');
          request.onload = () => resolve('load');
          request.onabort = () => resolve('abort');
          request.onerror = () => resolve('error');
          request.send(
            JSON.stringify({
              file_name: 'ghost-2.txt',
              file_size: 123,
              mime_type: 'text/plain',
              use_case: 'my_files',
            }),
          );
        }),
    );
    expect(xhrResult).toBe('abort');

    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    expect(
      requests.filter((request) => new URL(request.url).pathname.startsWith('/backend-api/')),
    ).toHaveLength(0);

    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-dm-relay-toast]')?.shadowRoot?.textContent ?? '',
        ),
      )
      .toContain('Файл не найден в очереди');
  });

  test('E: unsupported PDF is aborted by the background router', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-e', FILES_UPLOAD_URL);
    await captureFile(page, PDF_NAME, '%PDF-1.4\n% mock\n', 'application/pdf');

    const result = await page.evaluate(async () => {
      const file = (document.querySelector('#file') as HTMLInputElement).files?.[0];
      if (!file) throw new Error('file missing');
      try {
        await fetch('/backend-api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_name: file.name,
            file_size: file.size,
            mime_type: file.type,
            use_case: 'my_files',
          }),
        });
        return 'resolved';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(result).toBe('AbortError');

    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    expect(
      requests.filter((request) => new URL(request.url).pathname.startsWith('/backend-api/')),
    ).toHaveLength(0);

    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-dm-relay-toast]')?.shadowRoot?.textContent ?? '',
        ),
      )
      .toContain('не поддерживается');
  });

  test('F: unrelated PUT/POST pass through without pending uploads', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-f', FILES_UPLOAD_URL);

    const statuses = await page.evaluate(async () => {
      const putBody = 'unrelated-put-body';
      const postBody = 'unrelated-post-body';
      const put = await fetch('https://files.oaiusercontent.com/other', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: putBody,
      });
      const post = await fetch('/backend-api/estuary/upload_content_bytes', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: postBody,
      });
      const metadata = await fetch('/backend-api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'not a file create' }),
      });
      return { put: put.status, post: post.status, metadata: metadata.status };
    });

    expect(statuses).toEqual({ put: 200, post: 200, metadata: 200 });

    const pageRequests = await readPageRequests(page, requests);
    const put = pageRequests.find(
      (request) => request.method === 'PUT' && new URL(request.url).pathname === '/other',
    );
    const post = pageRequests.find(
      (request) =>
        request.method === 'POST' &&
        new URL(request.url).pathname === '/backend-api/estuary/upload_content_bytes',
    );
    const metadata = pageRequests.find(
      (request) =>
        request.method === 'POST' && new URL(request.url).pathname === '/backend-api/files',
    );
    expect(put, 'unrelated PUT did not reach the mock server').toBeTruthy();
    expect(post, 'unrelated POST did not reach the mock server').toBeTruthy();
    expect(metadata, 'non-file metadata did not reach the mock server').toBeTruthy();
    expect(bodyText(put as PageRequest)).toBe('unrelated-put-body');
    expect(bodyText(post as PageRequest)).toBe('unrelated-post-body');
    expect(bodyText(metadata as PageRequest)).toBe('{"note":"not a file create"}');

    expect(
      await page.evaluate(() => document.querySelector('[data-dm-relay-toast]') === null),
    ).toBe(true);
  });

  test('G: unreadable metadata bodies are aborted before the network', async ({
    extensionContext: context,
  }) => {
    const { page, requests } = await openMockPage(context, 'chat-g', FILES_UPLOAD_URL);

    const fetchResult = await page.evaluate(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ file_name: 'ghost.txt', file_size: 1 })),
          );
          controller.close();
        },
      });
      const init = {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' };
      try {
        await fetch('/backend-api/files', init);
        return 'resolved';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(fetchResult).toBe('AbortError');

    const xhrResult = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const request = new XMLHttpRequest();
          request.open('POST', '/backend-api/files');
          request.onload = () => resolve('load');
          request.onabort = () => resolve('abort');
          request.onerror = () => resolve('error');
          const form = new FormData();
          form.append('file_name', 'ghost.txt');
          form.append('file_size', '1');
          request.send(form);
        }),
    );
    expect(xhrResult).toBe('abort');

    expect(
      requests.filter((request) => new URL(request.url).pathname === '/backend-api/files'),
    ).toHaveLength(0);

    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-dm-relay-toast]')?.shadowRoot?.textContent ?? '',
        ),
      )
      .toContain('Ошибка обработки');
  });
});
