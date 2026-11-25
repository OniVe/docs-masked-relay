import { describe, expect, it } from 'vitest';
import {
  AmbiguousVaultFileError,
  createVault,
  type FileFormat,
  resolveVaultFile,
  sha256Hex,
  type Vault,
  type VaultFile,
} from '../../src/core';
import { type FormatClass, formatClassOf } from '../../src/core/formats/txt';

/**
 * R21-N1/R21-BINARY-CLASS-OVERBLOCK: every persisted `FileFormat` belongs to
 * exactly one byte-compatible class. DOCX/DOC masks are WordprocessingML and
 * XLSX/XLS masks are SpreadsheetML, so the old single `binary` class blocked
 * unrelated word/sheet restores.
 */
const EXPECTED_CLASSES: readonly (readonly [FileFormat, FormatClass])[] = [
  ['txt', 'text'],
  ['md', 'text'],
  ['json', 'text'],
  ['xml', 'text'],
  ['html', 'text'],
  ['docx', 'word'],
  ['doc', 'word'],
  ['xlsx', 'sheet'],
  ['xls', 'sheet'],
  ['pdf', 'pdf'],
];

const HEX = 'a'.repeat(64);

function record(format: FileFormat, name: string, maskedSha256?: string): VaultFile {
  return {
    originalName: name,
    maskedName: name,
    format,
    size: 1,
    sha256: HEX,
    ...(maskedSha256 === undefined ? {} : { maskedSha256 }),
  };
}

function vaultWith(records: readonly VaultFile[]): Vault {
  const vault = createVault('', { prefix: 'DM7F3' });
  vault.files.push(...records);
  return vault;
}

describe('R21-N1: formatClassOf covers every FileFormat', () => {
  it('maps each format to its byte-compatible class', () => {
    for (const [format, formatClass] of EXPECTED_CLASSES) {
      expect(formatClassOf(format)).toBe(formatClass);
    }
  });

  it('has exactly one mapping per persisted format and four classes', () => {
    const formats = EXPECTED_CLASSES.map(([format]) => format);
    expect([...formats].sort()).toEqual(
      ['txt', 'md', 'json', 'xml', 'html', 'docx', 'doc', 'xlsx', 'xls', 'pdf'].sort(),
    );
    const classes = new Set(EXPECTED_CLASSES.map(([, formatClass]) => formatClass));
    expect([...classes].sort()).toEqual(['pdf', 'sheet', 'text', 'word']);
  });
});

describe('R21-BINARY-CLASS-OVERBLOCK: legacy ambiguity is per word/sheet class', () => {
  it('resolves a hashed DOCX while legacy XLSX/XLS records remain', async () => {
    const bytes = new TextEncoder().encode('docx masked bytes');
    const maskedSha256 = await sha256Hex(bytes);
    const vault = vaultWith([
      record('xlsx', 'legacy.xlsx'),
      record('xls', 'legacy.xls'),
      record('pdf', 'legacy.pdf'),
      record('docx', 'fresh.docx', maskedSha256),
    ]);

    const resolved = await resolveVaultFile(vault, { name: 'fresh.docx', bytes });
    expect(resolved?.format).toBe('docx');
    expect(resolved?.maskedSha256).toBe(maskedSha256);
  });

  it('resolves a hashed XLSX while legacy DOCX/DOC records remain', async () => {
    const bytes = new TextEncoder().encode('xlsx masked bytes');
    const maskedSha256 = await sha256Hex(bytes);
    const vault = vaultWith([
      record('docx', 'legacy.docx'),
      record('doc', 'legacy.doc'),
      record('xlsx', 'fresh.xlsx', maskedSha256),
    ]);

    const resolved = await resolveVaultFile(vault, { name: 'fresh.xlsx', bytes });
    expect(resolved?.format).toBe('xlsx');
  });

  it('fails closed when a legacy DOC/DOCX record shares the word class', async () => {
    const bytes = new TextEncoder().encode('word masked bytes');
    const maskedSha256 = await sha256Hex(bytes);
    const vault = vaultWith([
      record('doc', 'legacy.doc'),
      record('docx', 'fresh.docx', maskedSha256),
    ]);

    await expect(resolveVaultFile(vault, { name: 'fresh.docx', bytes })).rejects.toBeInstanceOf(
      AmbiguousVaultFileError,
    );
  });

  it('fails closed when a legacy XLS/XLSX record shares the sheet class', async () => {
    const bytes = new TextEncoder().encode('sheet masked bytes');
    const maskedSha256 = await sha256Hex(bytes);
    const vault = vaultWith([
      record('xlsx', 'legacy.xlsx'),
      record('xls', 'fresh.xls', maskedSha256),
    ]);

    await expect(resolveVaultFile(vault, { name: 'fresh.xls', bytes })).rejects.toBeInstanceOf(
      AmbiguousVaultFileError,
    );
  });

  it('keeps text and PDF classes unchanged', async () => {
    const textBytes = new TextEncoder().encode('text masked bytes');
    const textSha = await sha256Hex(textBytes);
    const textVault = vaultWith([
      record('md', 'legacy.md'),
      record('json', 'legacy.json'),
      record('txt', 'fresh.txt', textSha),
    ]);
    // A legacy text record of another spelling is the same class: ambiguous.
    await expect(
      resolveVaultFile(textVault, { name: 'fresh.txt', bytes: textBytes }),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);

    const pdfBytes = new TextEncoder().encode('%PDF masked bytes');
    const pdfSha = await sha256Hex(pdfBytes);
    const pdfVault = vaultWith([
      record('txt', 'legacy.txt'),
      record('docx', 'legacy.docx'),
      record('pdf', 'fresh.pdf', pdfSha),
    ]);
    const resolved = await resolveVaultFile(pdfVault, { name: 'fresh.pdf', bytes: pdfBytes });
    expect(resolved?.format).toBe('pdf');

    const ambiguousPdf = vaultWith([record('pdf', 'legacy.pdf'), record('pdf', 'new.pdf', pdfSha)]);
    await expect(
      resolveVaultFile(ambiguousPdf, { name: 'new.pdf', bytes: pdfBytes }),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
  });
});
