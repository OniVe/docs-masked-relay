import 'fake-indexeddb/auto';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { resetDb } from '../../src/background/db';
import { processRestore } from '../../src/background/process';
import { closeVaultStore, initVaultStore } from '../../src/background/vault-store';
import {
  anonymizePdf,
  assertNoPdfCarriers,
  hasRawPiiSurface,
  MAX_RAW_SCAN_SURFACES,
  pdfFormatAdapter,
  restorePdf,
  sanitizePdfOutput,
  selectRawScanSurfaces,
} from '../../src/core/formats/pdf';
import { PDF_IRREVERSIBLE_MESSAGE } from '../../src/core/formats/pdf-errors';
import type { AnonymizeContext } from '../../src/core/types';
import { createVault } from '../../src/core/vault';
import {
  carrierTrapPdf,
  metadataTrapPdf,
  nestedCarrierTrapPdf,
  PDF_CARRIER_MARKERS,
  PDF_METADATA_MARKERS,
  PDF_NESTED_MARKERS,
  PDF_PUBLIC,
  pdfWithPages,
} from '../fixtures/pdf';

const PDF_MIME = 'application/pdf';

/** pdf-lib writes text strings as hex; decode both forms before scanning. */
const NUL = String.fromCharCode(0);

function decodedPdfStrings(raw: string): string {
  let decoded = raw;
  for (const match of raw.matchAll(/<([0-9A-Fa-f\s]+)>/gu)) {
    const hex = (match[1] ?? '').replace(/\s+/gu, '');
    if (hex.length > 0 && hex.length % 2 === 0) {
      // UTF-16BE strings are hex with a FE FF BOM; dropping NULs is enough to
      // expose the ASCII markers used by the fixture.
      decoded += `\n${Buffer.from(hex, 'hex').toString('latin1').replaceAll(NUL, '')}`;
    }
  }
  for (const match of raw.matchAll(/\(((?:\\.|[^\\()])*)\)/gu)) {
    decoded += `\n${match[1] ?? ''}`;
  }
  return decoded;
}

/** Decodes the first page's content streams (the public text lives there). */
function pageContentText(document: PDFDocument): string {
  const context = document.context;
  const parts: Uint8Array[] = [];
  const collect = (value: unknown): void => {
    const resolved = value instanceof PDFRef ? context.lookup(value) : value;
    if (resolved instanceof PDFRawStream) {
      parts.push(decodePDFRawStream(resolved).decode());
    } else if (resolved instanceof PDFArray) {
      for (let index = 0; index < resolved.size(); index += 1) {
        collect(resolved.get(index));
      }
    }
  };
  collect(document.getPages()[0]?.node.Contents());
  const raw = new TextDecoder().decode(Buffer.concat(parts.map((part) => Buffer.from(part))));
  // pdf-lib writes ASCII text as hex strings in the content stream.
  let decoded = raw;
  for (const match of raw.matchAll(/<([0-9A-Fa-f\s]+)>/gu)) {
    const hex = (match[1] ?? '').replace(/\s+/gu, '');
    if (hex.length > 0 && hex.length % 2 === 0) {
      decoded += `\n${Buffer.from(hex, 'hex').toString('latin1')}`;
    }
  }
  return decoded;
}

/** Every dictionary that survived in the saved document (incl. stream dicts). */
function indirectDicts(document: PDFDocument): PDFDict[] {
  const dicts: PDFDict[] = [];
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) dicts.push(object);
    else if (object instanceof PDFStream) dicts.push(object.dict);
  }
  return dicts;
}

function context(maxBytes = 25 * 1024 * 1024): AnonymizeContext {
  return { vault: createVault(''), maxBytes };
}

describe('PDF adapter preflight (no engine boot)', () => {
  it('routes .pdf names and the PDF MIME type', () => {
    expect(pdfFormatAdapter.canHandle({ name: 'record.pdf', mimeType: '' })).toBe(true);
    expect(
      pdfFormatAdapter.canHandle({ name: 'blob', mimeType: 'application/pdf; charset=binary' }),
    ).toBe(true);
    expect(pdfFormatAdapter.canHandle({ name: 'record.docx', mimeType: '' })).toBe(false);
    expect(pdfFormatAdapter.canHandle({ name: 'record.txt', mimeType: 'text/plain' })).toBe(false);
  });

  it('rejects a file over 25 MB before touching the engine', async () => {
    const bytes = new Uint8Array(25 * 1024 * 1024 + 1);
    await expect(
      anonymizePdf({ name: 'big.pdf', mimeType: PDF_MIME, bytes }, context()),
    ).rejects.toMatchObject({ code: 'PDF_SIZE' });
  });

  it('rejects more than 200 pages before touching the engine', async () => {
    const bytes = await pdfWithPages(201);
    await expect(
      anonymizePdf({ name: 'many.pdf', mimeType: PDF_MIME, bytes }, context()),
    ).rejects.toMatchObject({ code: 'PDF_PAGES', message: expect.stringContaining('201') });
  });

  it('rejects an invalid PDF', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\nnot really a pdf\n');
    await expect(
      anonymizePdf({ name: 'broken.pdf', mimeType: PDF_MIME, bytes }, context()),
    ).rejects.toMatchObject({ code: 'PDF_INVALID' });
  });

  it('sanitizes Info/XMP/attachments/annotations and prunes unreferenced objects', async () => {
    const input = await metadataTrapPdf();
    const rawInput = decodedPdfStrings(Buffer.from(input).toString('latin1'));
    for (const marker of Object.values(PDF_METADATA_MARKERS)) {
      expect(rawInput).toContain(marker);
    }

    const warnings: string[] = [];
    const output = await sanitizePdfOutput(input, warnings, { useObjectStreams: false });
    const rawOutput = decodedPdfStrings(Buffer.from(output).toString('latin1'));
    for (const marker of Object.values(PDF_METADATA_MARKERS)) {
      expect(rawOutput).not.toContain(marker);
    }
    expect(warnings.length).toBeGreaterThan(0);

    const document = await PDFDocument.load(output, { updateMetadata: false });
    expect(document.getTitle()).toBeFalsy();
    expect(document.getAuthor()).toBeFalsy();
    expect(document.getPageCount()).toBe(1);
    expect(output.byteLength).toBeGreaterThan(0);
  });

  it('removes page-level carriers, every annotation and form field value', async () => {
    const input = await carrierTrapPdf();
    const markers = Object.values(PDF_CARRIER_MARKERS);
    expect(hasRawPiiSurface(input, markers)).toBe(true);

    const warnings: string[] = [];
    const output = await sanitizePdfOutput(input, warnings, { useObjectStreams: false });

    expect(hasRawPiiSurface(output, markers)).toBe(false);
    await expect(assertNoPdfCarriers(output)).resolves.toBeUndefined();

    const document = await PDFDocument.load(output, { updateMetadata: false });
    for (const key of ['Metadata', 'Names', 'AF', 'AcroForm', 'PieceInfo', 'StructTreeRoot']) {
      expect(document.catalog.has(PDFName.of(key)), `catalog /${key}`).toBe(false);
    }
    const page = document.getPages()[0];
    expect(page).toBeDefined();
    for (const key of ['Metadata', 'PieceInfo', 'AF', 'Annots', 'AA']) {
      expect(page?.node.has(PDFName.of(key)), `page /${key}`).toBe(false);
    }

    const text = warnings.join('\n');
    expect(text).toContain('PDF page metadata/private data removed');
    expect(text).toMatch(/PDF annotation\(s\) removed/);
    expect(text).toContain('Interactive PDF form fields removed');

    // Public text survives: the sanitizer only drops carriers.
    expect(pageContentText(document)).toContain(PDF_PUBLIC);
  });

  it('detects nested image/Form/font/pattern XMP carriers (R4)', async () => {
    // The old structural check only looked at the catalog and page nodes, so
    // this crafted input passed it. The recursive check must reject it.
    await expect(assertNoPdfCarriers(await nestedCarrierTrapPdf())).rejects.toMatchObject({
      code: 'PDF_METADATA',
    });
  });

  it('removes nested carriers from image/Form/font/pattern objects (R4)', async () => {
    const input = await nestedCarrierTrapPdf();
    const markers = Object.values(PDF_NESTED_MARKERS);
    expect(hasRawPiiSurface(input, markers)).toBe(true);

    const warnings: string[] = [];
    const output = await sanitizePdfOutput(input, warnings, { useObjectStreams: false });

    expect(hasRawPiiSurface(output, markers)).toBe(false);
    await expect(assertNoPdfCarriers(output)).resolves.toBeUndefined();

    const document = await PDFDocument.load(output, { updateMetadata: false });
    for (const dict of indirectDicts(document)) {
      for (const key of ['Metadata', 'PieceInfo', 'AF', 'AA']) {
        expect(dict.has(PDFName.of(key)), `nested /${key}`).toBe(false);
      }
    }
    expect(warnings.join('\n')).toContain('PDF embedded object metadata/private data removed');
    expect(pageContentText(document)).toContain(PDF_PUBLIC);
  });

  it('bounds the raw residual scan to a deterministic surface count (R7)', () => {
    const surfaces = Array.from(
      { length: MAX_RAW_SCAN_SURFACES + 3 },
      (_, index) => `surface-${index}-marker`,
    );
    const selected = selectRawScanSurfaces([...surfaces, surfaces[0] as string]);
    expect(selected.scanned).toHaveLength(MAX_RAW_SCAN_SURFACES);
    expect(selected.skipped).toBe(3);
  });

  it('does not claim form/annotation removal when the page has none', async () => {
    const warnings: string[] = [];
    await sanitizePdfOutput(await pdfWithPages(1), warnings, { useObjectStreams: false });
    const text = warnings.join('\n');
    expect(text).not.toContain('form fields removed');
    expect(text).not.toContain('annotation');
  });

  it('rejects restore: PDF redaction is one-way', async () => {
    await expect(
      restorePdf({ name: 'x.pdf', mimeType: PDF_MIME, bytes: new Uint8Array() }, createVault('')),
    ).rejects.toMatchObject({
      code: 'PDF_IRREVERSIBLE',
      message: PDF_IRREVERSIBLE_MESSAGE,
    });

    // processRestore reads settings first (enabled/DISABLED), so it needs the
    // background store even though the PDF branch never touches a vault.
    await closeVaultStore();
    await resetDb();
    await initVaultStore();
    try {
      await expect(
        processRestore({ name: 'x.pdf', mime: PDF_MIME, bytes: Uint8Array.of(1) }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED', message: PDF_IRREVERSIBLE_MESSAGE });
    } finally {
      await closeVaultStore();
    }
  });
});
