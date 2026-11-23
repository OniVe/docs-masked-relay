import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

import { ERROR_TEXT, errorText, mimeForName } from '../../src/ui/api';

describe('mimeForName', () => {
  it('maps JSON/JSONL/XML extensions when the File has no useful type', () => {
    expect(mimeForName('data.json', '')).toBe('application/json');
    expect(mimeForName('data.jsonl', '')).toBe('application/x-ndjson');
    expect(mimeForName('data.ndjson', 'application/octet-stream')).toBe('application/x-ndjson');
    expect(mimeForName('data.xml', '')).toBe('application/xml');
    expect(mimeForName('DATA.JSON', '')).toBe('application/json');
  });

  it('keeps an explicit meaningful MIME and existing formats', () => {
    expect(mimeForName('data.json', 'application/json')).toBe('application/json');
    expect(mimeForName('data.json', 'text/custom')).toBe('text/custom');
    expect(mimeForName('letter.txt', '')).toBe('text/plain');
    expect(mimeForName('noext', '')).toBe('application/octet-stream');
  });

  it('maps MD/PDF/DOCX/XLSX by extension, including uppercase names', () => {
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    expect(mimeForName('notes.md', '')).toBe('text/markdown');
    expect(mimeForName('NOTES.MD', 'application/octet-stream')).toBe('text/markdown');
    expect(mimeForName('scan.pdf', '')).toBe('application/pdf');
    expect(mimeForName('SCAN.PDF', 'application/octet-stream')).toBe('application/pdf');
    expect(mimeForName('report.docx', '')).toBe(docxMime);
    expect(mimeForName('REPORT.DOCX', '')).toBe(docxMime);
    expect(mimeForName('table.xlsx', '')).toBe(xlsxMime);
    expect(mimeForName('TABLE.XLSX', 'application/octet-stream')).toBe(xlsxMime);
  });
});

describe('ERROR_TEXT', () => {
  it('renders the explicit archive rejection instead of the generic INTERNAL text', () => {
    const text = errorText('UNSUPPORTED_ARCHIVE');
    expect(text).toContain('ZIP64');
    expect(text).toContain('зашифрованный ZIP');
    expect(text).not.toBe(ERROR_TEXT.INTERNAL);
  });

  it('renders the name-dense rejection instead of the generic INTERNAL text', () => {
    const text = errorText('TOO_MANY_ENTITIES');
    expect(text).toContain('слишком много имён или сущностей');
    expect(text).toContain('Разбейте его на части');
    expect(text).not.toBe(ERROR_TEXT.INTERNAL);
  });
});
