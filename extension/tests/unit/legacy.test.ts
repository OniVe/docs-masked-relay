import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../src/background/db';
import {
  processAnonymize,
  processRestore,
  selectFormatAdapter,
} from '../../src/background/process';
import { closeVaultStore, getVault, initVaultStore } from '../../src/background/vault-store';
import {
  anonymizeDoc,
  anonymizeXls,
  createVault,
  DOC_LOSS_WARNING,
  DOCX_MIME,
  decodeXml,
  docFormatAdapter,
  docxFormatAdapter,
  extractDocSections,
  restoreDoc,
  restoreXls,
  scanXml,
  unzipPackage,
  XLS_LOSS_WARNING,
  XLS_MIME,
  XLSX_MIME,
  xlsFormatAdapter,
  xlsxFormatAdapter,
} from '../../src/core';
import { docFixture, piiDocSections } from '../fixtures/doc';
import {
  DATE_SERIAL,
  EMAIL,
  XLS_MIME as FIXTURE_XLS_MIME,
  legacyXls,
  numericAccountXls,
  numericInnXls,
  PERSON,
  PHONE,
  readXls,
  STRING_INN,
} from '../fixtures/xls';

const MAX_BYTES = 64 * 1024 * 1024;

function docxText(bytes: Uint8Array): string {
  const parts = unzipPackage(bytes);
  const part = parts.get('word/document.xml');
  if (!part) throw new Error('generated DOCX has no document.xml');
  const decoded = decodeXml(part);
  const scan = scanXml(decoded.text, decoded.encoding, decoded.bom);
  return scan.textNodes
    .filter((node) => node.local === 't')
    .map((node) => node.text)
    .join('');
}

function cellValues(bytes: Uint8Array): string[] {
  const workbook = readXls(bytes);
  const values: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue;
      if (cell && typeof cell === 'object' && 'v' in cell && typeof cell.v === 'string') {
        values.push(cell.v);
      }
    }
  }
  return values;
}

describe('legacy adapter selection', () => {
  it('routes .doc/.xls and keeps .docm/.xlsm/.xlsb away', () => {
    expect(selectFormatAdapter('letter.doc', 'application/msword')?.format).toBe('doc');
    expect(selectFormatAdapter('table.xls', 'application/vnd.ms-excel')?.format).toBe('xls');
    expect(selectFormatAdapter('letter.docx', DOCX_MIME)?.format).toBe('docx');
    expect(selectFormatAdapter('table.xlsx', XLSX_MIME)?.format).toBe('xlsx');

    expect(
      selectFormatAdapter('letter.docm', 'application/vnd.ms-word.document.macroEnabled.12'),
    ).toBeUndefined();
    expect(
      selectFormatAdapter('table.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'),
    ).toBeUndefined();
    expect(
      selectFormatAdapter('table.xlsb', 'application/vnd.ms-excel.sheet.binary.macroEnabled.12'),
    ).toBeUndefined();
    expect(selectFormatAdapter('letter.dot', 'application/msword')).toBeUndefined();

    expect(docFormatAdapter.canHandle({ name: 'letter.doc', mimeType: 'application/msword' })).toBe(
      true,
    );
    expect(
      docFormatAdapter.canHandle({ name: 'letter.doc', mimeType: 'application/octet-stream' }),
    ).toBe(true);
    expect(
      docFormatAdapter.canHandle({ name: 'letter.docm', mimeType: 'application/msword' }),
    ).toBe(false);
    expect(docFormatAdapter.canHandle({ name: 'letter.bin', mimeType: 'application/msword' })).toBe(
      false,
    );

    expect(xlsFormatAdapter.canHandle({ name: 'table.xls', mimeType: FIXTURE_XLS_MIME })).toBe(
      true,
    );
    expect(xlsFormatAdapter.canHandle({ name: 'table.xlsm', mimeType: FIXTURE_XLS_MIME })).toBe(
      false,
    );
    expect(
      xlsFormatAdapter.canHandle({ name: 'table.bin', mimeType: 'application/vnd.ms-excel' }),
    ).toBe(false);
    expect(xlsxFormatAdapter.canHandle({ name: 'table.xls', mimeType: XLSX_MIME })).toBe(false);
    expect(docxFormatAdapter.canHandle({ name: 'letter.doc', mimeType: DOCX_MIME })).toBe(false);
  });
});

describe('DOC adapter', () => {
  it('extracts real .doc stories and writes a .docx', async () => {
    const bytes = docFixture('test04');
    const sections = await extractDocSections(bytes);
    const kinds = sections.map((section) => section.kind);
    expect(kinds).toContain('body');
    expect(kinds).toContain('headers');
    expect(kinds).toContain('footers');
    expect(sections.find((section) => section.kind === 'body')?.text).toContain(
      'This is a fairly simple word document',
    );

    const noteSections = await extractDocSections(docFixture('test13'));
    expect(noteSections.find((section) => section.kind === 'footnotes')?.text).toContain(
      'This is a footnote',
    );
    expect(noteSections.find((section) => section.kind === 'endnotes')?.text).toContain(
      'This is an endnote',
    );

    const vault = createVault('');
    const result = await anonymizeDoc(
      { name: 'test04.doc', mimeType: 'application/msword', bytes },
      { vault, maxBytes: MAX_BYTES },
    );

    expect(result.format).toBe('docx');
    expect(result.maskedName).toBe('test04.docx');
    expect(result.maskedMime).toBe(DOCX_MIME);
    expect(result.warnings).toContain(DOC_LOSS_WARNING);
    expect(result.maskedBytes[0]).toBe(0x50);
    expect(result.maskedBytes[1]).toBe(0x4b);

    const text = docxText(result.maskedBytes);
    expect(text).toContain('This is a fairly simple word document');
    expect(text).toContain('This is a simple header');
    expect(text).toContain('The footer, with Molière');

    expect(vault.files).toHaveLength(1);
    expect(vault.files[0]).toMatchObject({
      originalName: 'test04.doc',
      maskedName: 'test04.docx',
      format: 'docx',
      size: bytes.byteLength,
    });
    expect(vault.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(vault.files[0]?.maskedSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(vault.files[0]?.occurrenceStart).toBe(0);
    expect(vault.files[0]?.occurrenceCount).toBeTypeOf('number');
  });

  it('masks body/headers/footnotes/comments/textboxes through the extractor seam', async () => {
    const vault = createVault('');
    const result = await anonymizeDoc(
      { name: 'pii.doc', mimeType: 'application/msword', bytes: Uint8Array.of(1) },
      { vault, maxBytes: MAX_BYTES },
      { extractor: async () => piiDocSections() },
    );

    const text = docxText(result.maskedBytes);
    for (const value of [PERSON, EMAIL, PHONE, '7707083893']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain(`[[${vault.prefix}_PERSON_1]]`);
    expect(text).toContain(`[[${vault.prefix}_EMAIL_1]]`);
    expect(text).toContain(`[[${vault.prefix}_INN_1]]`);

    const labels = result.entities.map((entity) => entity.label);
    expect(labels).toEqual(expect.arrayContaining(['PERSON', 'EMAIL', 'PHONE', 'INN']));
    expect(result.warnings).toContain('Текст комментариев перенесён в тело документа');

    const restored = await restoreDoc(
      { name: 'pii.docx', mimeType: DOCX_MIME, bytes: result.maskedBytes },
      vault,
    );
    const restoredText = docxText(restored.bytes);
    expect(restoredText).toContain(PERSON);
    expect(restoredText).toContain(EMAIL);
    expect(restoredText).toContain(PHONE);
    expect(restoredText).toContain('7707083893');
    expect(restored.fileName).toBe('pii.docx');
    expect(restored.warnings[0]).toContain('DOCX');
  });

  it('rejects .docm and extraction failures (fail-closed)', async () => {
    const vault = createVault('');
    await expect(
      anonymizeDoc(
        { name: 'macro.docm', mimeType: 'application/msword', bytes: Uint8Array.of(1) },
        { vault, maxBytes: MAX_BYTES },
      ),
    ).rejects.toThrow(/only accepts legacy .doc/u);

    await expect(
      anonymizeDoc(
        { name: 'broken.doc', mimeType: 'application/msword', bytes: Uint8Array.of(1, 2, 3) },
        { vault, maxBytes: MAX_BYTES },
      ),
    ).rejects.toThrow(/не удалось извлечь текст/u);

    await expect(
      anonymizeDoc(
        { name: 'empty.doc', mimeType: 'application/msword', bytes: Uint8Array.of(1) },
        { vault, maxBytes: MAX_BYTES },
        { extractor: async () => [] },
      ),
    ).rejects.toThrow(/не найден текст/u);
    expect(vault.files).toHaveLength(0);
  });
});

describe('XLS adapter', () => {
  it('reads BIFF8 including hidden sheets, masks text, keeps dates', async () => {
    const bytes = legacyXls();
    const vault = createVault('');
    const result = await anonymizeXls(
      { name: 'legacy.xls', mimeType: FIXTURE_XLS_MIME, bytes },
      { vault, maxBytes: MAX_BYTES },
    );

    expect(result.format).toBe('xlsx');
    expect(result.maskedName).toBe('legacy.xlsx');
    expect(result.maskedMime).toBe(XLSX_MIME);
    expect(result.warnings).toContain(XLS_LOSS_WARNING);

    const workbook = readXls(result.maskedBytes);
    expect(workbook.SheetNames).toEqual(['Данные', 'Скрытый', 'Очень скрытый']);
    expect(workbook.Workbook?.Sheets?.[1]?.Hidden).toBe(1);
    expect(workbook.Workbook?.Sheets?.[2]?.Hidden).toBe(2);

    const values = cellValues(result.maskedBytes);
    for (const value of [PERSON, EMAIL, PHONE, STRING_INN]) {
      expect(values.some((item) => item.includes(value))).toBe(false);
    }
    expect(values.join('\n')).toContain(`[[${vault.prefix}_PERSON_1]]`);
    expect(values.join('\n')).toContain(`[[${vault.prefix}_EMAIL_1]]`);

    const dateCell = workbook.Sheets.Данные?.F2 as { v?: number; z?: string } | undefined;
    expect(dateCell?.v).toBe(DATE_SERIAL);
    expect(dateCell?.z).toContain('dd.mm.yyyy');

    expect(vault.files[0]).toMatchObject({
      originalName: 'legacy.xls',
      maskedName: 'legacy.xlsx',
      format: 'xlsx',
      size: bytes.byteLength,
    });
    expect(vault.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(vault.files[0]?.maskedSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(vault.files[0]?.occurrenceStart).toBe(0);
    expect(vault.files[0]?.occurrenceCount).toBeGreaterThan(0);
  });

  it('round-trips cell text through restoreXlsx', async () => {
    const bytes = legacyXls();
    const vault = createVault('');
    const result = await anonymizeXls(
      { name: 'legacy.xls', mimeType: FIXTURE_XLS_MIME, bytes },
      { vault, maxBytes: MAX_BYTES },
    );

    const restored = await restoreXls(
      { name: 'legacy.xlsx', mimeType: XLSX_MIME, bytes: result.maskedBytes },
      vault,
    );
    const values = cellValues(restored.bytes).join('\n');
    expect(values).toContain(PERSON);
    expect(values).toContain(EMAIL);
    expect(values).toContain(PHONE);
    expect(values).toContain(`ИНН ${STRING_INN}`);
    expect(restored.fileName).toBe('legacy.xlsx');
    expect(restored.warnings[0]).toContain('XLSX');
  });

  it('fails closed on numeric INN and rejects .xlsm', async () => {
    const vault = createVault('');
    await expect(
      anonymizeXls(
        { name: 'numeric.xls', mimeType: XLS_MIME, bytes: numericInnXls() },
        { vault, maxBytes: MAX_BYTES },
      ),
    ).rejects.toThrow(/numeric INN/u);
    expect(vault.files).toHaveLength(0);
    expect(vault.entities).toEqual({});

    await expect(
      anonymizeXls(
        { name: 'account.xls', mimeType: XLS_MIME, bytes: numericAccountXls() },
        { vault, maxBytes: MAX_BYTES },
      ),
    ).rejects.toThrow(/numeric ACCOUNT\/CARD/u);
    expect(vault.files).toHaveLength(0);

    await expect(
      anonymizeXls(
        { name: 'macro.xlsm', mimeType: FIXTURE_XLS_MIME, bytes: Uint8Array.of(1) },
        { vault, maxBytes: MAX_BYTES },
      ),
    ).rejects.toThrow(/only accepts legacy .xls/u);
  });
});

describe('processAnonymize maskedMime chain', () => {
  beforeEach(async () => {
    await closeVaultStore();
    await resetDb();
    await initVaultStore();
  });

  afterEach(async () => {
    await closeVaultStore();
  });

  it('converts .doc to DOCX bytes and metadata', async () => {
    const result = await processAnonymize({
      bytes: docFixture('test01'),
      name: 'test01.doc',
      mime: 'application/msword',
      chatId: 'chat-doc',
    });

    expect(result.format).toBe('docx');
    expect(result.maskedName).toBe('test01.docx');
    expect(result.maskedMime).toBe(DOCX_MIME);
    expect(result.warnings).toContain(DOC_LOSS_WARNING);
    expect(result.maskedBytes.byteLength).toBeGreaterThan(0);

    const vault = await getVault(result.vaultId);
    expect(vault?.files[0]).toMatchObject({
      originalName: 'test01.doc',
      maskedName: 'test01.docx',
      format: 'docx',
    });
  });

  it('converts .xls to XLSX bytes and metadata', async () => {
    const bytes = legacyXls();
    const result = await processAnonymize({
      bytes,
      name: 'legacy.xls',
      mime: XLS_MIME,
      chatId: 'chat-xls',
    });

    expect(result.format).toBe('xlsx');
    expect(result.maskedName).toBe('legacy.xlsx');
    expect(result.maskedMime).toBe(XLSX_MIME);
    expect(result.warnings).toContain(XLS_LOSS_WARNING);
    expect(new Uint8Array(result.maskedBytes).byteLength).toBeGreaterThan(0);

    const vault = await getVault(result.vaultId);
    expect(vault?.files[0]).toMatchObject({
      originalName: 'legacy.xls',
      maskedName: 'legacy.xlsx',
      format: 'xlsx',
      size: bytes.byteLength,
    });
  });

  it('keeps the source/standard MIME for non-legacy formats', async () => {
    const result = await processAnonymize({
      bytes: new TextEncoder().encode(`${PERSON}\n${EMAIL}\n`),
      name: 'letter.txt',
      mime: 'text/plain; charset=utf-8',
      chatId: 'chat-mime',
    });
    expect(result.maskedMime).toBe('text/plain; charset=utf-8');

    const fallback = await processAnonymize({
      bytes: new TextEncoder().encode(`${PERSON}\n`),
      name: 'note.md',
      mime: 'application/octet-stream',
      chatId: 'chat-mime-fallback',
    });
    expect(fallback.maskedMime).toBe('text/markdown');
  });
});

describe('R3-LEGACY-NAME: restored legacy files carry the DOCX/XLSX output name', () => {
  beforeEach(async () => {
    await closeVaultStore();
    await resetDb();
    await initVaultStore();
  });

  afterEach(async () => {
    await closeVaultStore();
  });

  it('returns a .docx name when a legacy .doc record is restored', async () => {
    const masked = await processAnonymize({
      bytes: docFixture('test04'),
      name: 'test04.doc',
      mime: 'application/msword',
      chatId: 'chat-doc-name',
    });
    expect(masked.maskedName).toBe('test04.docx');

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: DOCX_MIME,
    });
    // The bytes are DOCX even though the vault record's originalName is
    // `test04.doc`; the download must not be named after the binary source.
    expect(restored.fileName).toBe('test04.docx');
  });

  it('returns a .xlsx name when a legacy .xls record is restored', async () => {
    const masked = await processAnonymize({
      bytes: legacyXls(),
      name: 'legacy.xls',
      mime: FIXTURE_XLS_MIME,
      chatId: 'chat-xls-name',
    });
    expect(masked.maskedName).toBe('legacy.xlsx');

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: XLSX_MIME,
    });
    expect(restored.fileName).toBe('legacy.xlsx');
  });
});
