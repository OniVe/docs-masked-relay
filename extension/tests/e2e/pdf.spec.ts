import { PDFDocument, PDFName } from 'pdf-lib';
import { assertNoPdfCarriers, hasRawPiiSurface } from '../../src/core/formats/pdf';
import {
  carrierTrapPdf,
  nestedCarrierTrapPdf,
  PDF_CARRIER_MARKERS,
  PDF_EMAIL,
  PDF_NESTED_MARKERS,
  PDF_PERSON,
  PDF_PHONE,
  PDF_PUBLIC,
  PDF_RESIDUAL_NUMBERS,
  pdfWithPages,
  residualDigitsPdf,
  samplePdf,
  scannedPdf,
  twoPagePiiPdf,
} from '../fixtures/pdf';
import { type BrowserContext, expect, type Page, test } from './fixtures';

interface RelayResponse {
  ok: boolean;
  result?: {
    maskedBytes: string;
    maskedName: string;
    format: string;
    entities: unknown[];
    warnings: string[];
    vaultPrefix: string;
  };
  error?: { code: string; message: string };
}

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

async function extensionId(context: BrowserContext): Promise<string> {
  const worker =
    context
      .serviceWorkers()
      .find((candidate) => candidate.url().startsWith('chrome-extension://')) ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return new URL(worker.url()).host;
}

async function openPopup(context: BrowserContext): Promise<Page> {
  const id = await extensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  return page;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function anonymize(
  page: Page,
  bytes: Uint8Array,
  options: { name?: string; chatId?: string } = {},
): Promise<RelayResponse> {
  const response = await page.evaluate(
    async ({ payload, name, chatId }) =>
      chrome.runtime.sendMessage({
        type: 'dm:anonymize-file',
        requestId: crypto.randomUUID(),
        payload: { bytes: payload, name, mime: 'application/pdf', chatId },
      }),
    {
      payload: base64(bytes),
      name: options.name ?? 'personnel.pdf',
      chatId: options.chatId ?? 'pdf-e2e',
    },
  );
  return response as RelayResponse;
}

async function restore(page: Page, bytes: Uint8Array, chatId: string): Promise<RelayResponse> {
  const response = await page.evaluate(
    async ({ payload, chatId: id }) =>
      chrome.runtime.sendMessage({
        type: 'dm:restore-file',
        requestId: crypto.randomUUID(),
        payload: {
          bytes: payload,
          name: 'personnel.pdf',
          mime: 'application/pdf',
          chatId: id,
        },
      }),
    { payload: base64(bytes), chatId },
  );
  return response as RelayResponse;
}

/** pdfjs-dist is an independent extractor (not PDFium and not pdf-lib). */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  let text = '';
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    text += `${content.items.map((item) => ('str' in item ? item.str : '')).join(' ')}\n`;
  }
  await loadingTask.destroy();
  return text;
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

async function expectMetadataCleared(bytes: Uint8Array): Promise<void> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(document.getTitle()).toBeFalsy();
  expect(document.getAuthor()).toBeFalsy();
  expect(document.getSubject()).toBeFalsy();
  expect(document.getKeywords()).toBeFalsy();
  expect(document.getCreator()).toBeFalsy();
  expect(document.getProducer()).toBeFalsy();
  expect(document.catalog.has(PDFName.of('Metadata'))).toBe(false);
  expect(document.catalog.has(PDFName.of('Names'))).toBe(false);
  expect(document.catalog.has(PDFName.of('AcroForm'))).toBe(false);
}

test.describe('M5a PDF true redaction (offscreen + PDFium)', () => {
  test('redacts PII, keeps public text, clears metadata and opens with pdfjs', async ({
    extensionContext: context,
  }) => {
    const page = await openPopup(context);
    const input = await samplePdf();

    const started = Date.now();
    const response = await anonymize(page, input, { chatId: 'pdf-e2e-sample' });
    const elapsed = Date.now() - started;
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    if (!response.result) throw new Error('missing result');

    expect(response.result.format).toBe('pdf');
    expect(response.result.entities).toEqual([]);
    expect(response.result.maskedName).toBe('personnel.pdf');
    expect(response.result.vaultPrefix).toMatch(/^[A-Z0-9]{5}$/u);
    expect(response.result.warnings.join(' ')).toContain('redacted');

    const masked = new Uint8Array(Buffer.from(response.result.maskedBytes, 'base64'));
    expect(masked.byteLength).toBeGreaterThan(0);

    const text = normalized(await extractPdfText(masked));
    expect(text).not.toContain(PDF_PERSON);
    expect(text).not.toContain(PDF_EMAIL);
    expect(text).not.toContain(PDF_PHONE);
    expect(text).toContain(PDF_PUBLIC);

    await expectMetadataCleared(masked);

    // Cold WASM boot + one page should stay well below the relay timeout.
    expect(elapsed).toBeLessThan(30_000);
  });

  test('removes page-level XMP/PieceInfo/widget/FreeText carriers end to end', async ({
    extensionContext: context,
  }) => {
    const page = await openPopup(context);
    const input = await carrierTrapPdf({ withTextPii: true });
    const markers = Object.values(PDF_CARRIER_MARKERS);
    expect(hasRawPiiSurface(input, markers)).toBe(true);

    const response = await anonymize(page, input, { chatId: 'pdf-e2e-carriers' });
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    if (!response.result) throw new Error('missing result');

    const masked = new Uint8Array(Buffer.from(response.result.maskedBytes, 'base64'));
    expect(hasRawPiiSurface(masked, markers)).toBe(false);

    const text = normalized(await extractPdfText(masked));
    expect(text).not.toContain(PDF_CARRIER_MARKERS.email);
    expect(text).toContain(PDF_PUBLIC);

    const document = await PDFDocument.load(masked, { updateMetadata: false });
    for (const key of ['Metadata', 'Names', 'AF', 'AcroForm', 'PieceInfo', 'StructTreeRoot']) {
      expect(document.catalog.has(PDFName.of(key)), `catalog /${key}`).toBe(false);
    }
    for (const outputPage of document.getPages()) {
      for (const key of ['Metadata', 'PieceInfo', 'AF', 'Annots', 'AA']) {
        expect(outputPage.node.has(PDFName.of(key)), `page /${key}`).toBe(false);
      }
    }
  });

  test('removes nested image/Form/font/pattern XMP carriers end to end', async ({
    extensionContext: context,
  }) => {
    const page = await openPopup(context);
    const input = await nestedCarrierTrapPdf();
    const markers = Object.values(PDF_NESTED_MARKERS);
    expect(hasRawPiiSurface(input, markers)).toBe(true);

    const response = await anonymize(page, input, { chatId: 'pdf-e2e-nested' });
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    if (!response.result) throw new Error('missing result');

    const masked = new Uint8Array(Buffer.from(response.result.maskedBytes, 'base64'));
    expect(hasRawPiiSurface(masked, markers)).toBe(false);
    await expect(assertNoPdfCarriers(masked)).resolves.toBeUndefined();

    const text = normalized(await extractPdfText(masked));
    expect(text).not.toContain(PDF_CARRIER_MARKERS.email);
    expect(text).toContain(PDF_PUBLIC);
  });

  test('redacts every page, not only the first', async ({ extensionContext: context }) => {
    const page = await openPopup(context);
    const input = await twoPagePiiPdf();
    const response = await anonymize(page, input, { chatId: 'pdf-e2e-pages' });
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    if (!response.result) throw new Error('missing result');

    const masked = new Uint8Array(Buffer.from(response.result.maskedBytes, 'base64'));
    const text = normalized(await extractPdfText(masked));
    expect(text).not.toContain(PDF_PERSON);
    expect(text).not.toContain(PDF_EMAIL);
    expect(text).toContain(PDF_PUBLIC);
    expect(text).toContain('Page 1');
    expect(text).toContain('Page 2');
  });

  test('fails closed on a scanned page without a text layer', async ({
    extensionContext: context,
  }) => {
    const page = await openPopup(context);
    const input = await scannedPdf();
    const response = await anonymize(page, input, { chatId: 'pdf-e2e-scan' });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('UNSUPPORTED');
    expect(response.error?.message).toContain('scanned page 1');
    expect(response.error?.message).toContain('OCR not supported');
  });

  test('over-masks unclassified long digit tokens instead of failing LeakGuard', async ({
    extensionContext: context,
  }) => {
    const page = await openPopup(context);
    const input = await residualDigitsPdf();
    const response = await anonymize(page, input, { chatId: 'pdf-e2e-residual-digits' });
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    if (!response.result) throw new Error('missing result');

    const masked = new Uint8Array(Buffer.from(response.result.maskedBytes, 'base64'));
    const text = normalized(await extractPdfText(masked));
    expect(text).not.toMatch(/\d{7,}/u);
    for (const value of [
      PDF_RESIDUAL_NUMBERS.application,
      PDF_RESIDUAL_NUMBERS.decimal,
      PDF_RESIDUAL_NUMBERS.certificate,
      PDF_RESIDUAL_NUMBERS.contract,
    ]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain(PDF_PUBLIC);
  });

  test('rejects restore and enforces the 200-page limit', async ({ extensionContext: context }) => {
    const page = await openPopup(context);
    const input = await samplePdf();

    const anonymized = await anonymize(page, input, { chatId: 'pdf-e2e-restore' });
    expect(anonymized.ok).toBe(true);

    const restored = await restore(page, input, 'pdf-e2e-restore');
    expect(restored.ok).toBe(false);
    expect(restored.error?.code).toBe('UNSUPPORTED');
    expect(restored.error?.message).toContain('irreversible');

    const many = await pdfWithPages(201);
    const limited = await anonymize(page, many, { chatId: 'pdf-e2e-limit' });
    expect(limited.ok).toBe(false);
    expect(limited.error?.code).toBe('LIMIT');
    expect(limited.error?.message).toContain('201');
  });
});
