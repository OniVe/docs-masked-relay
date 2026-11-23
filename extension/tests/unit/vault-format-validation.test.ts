import { describe, expect, it } from 'vitest';
import { parseVaultValue } from '../../src/background/crypto';
import {
  AmbiguousVaultFileError,
  createVault,
  IdentityMismatchVaultFileError,
  resolveVaultFile,
  sha256Hex,
  type Vault,
  type VaultFile,
} from '../../src/core';

const HEX = 'a'.repeat(64);

function record(format: string, name: string, maskedSha256?: string): VaultFile {
  return {
    originalName: name,
    maskedName: name,
    format: format as VaultFile['format'],
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

function jsonRoundTrip(vault: Vault): Record<string, unknown> {
  return JSON.parse(JSON.stringify(vault)) as Record<string, unknown>;
}

describe('R22-IDENT-1: imported files[].format is validated fail-closed', () => {
  it('accepts ordinary legacy DOC/XLS records', () => {
    const vault = vaultWith([record('doc', 'legacy.doc'), record('xls', 'legacy.xls')]);
    const parsed = parseVaultValue(jsonRoundTrip(vault));
    expect(parsed.files.map((file) => file.format)).toEqual(['doc', 'xls']);
  });

  it('rejects a vault whose file format is not a FileFormat', () => {
    const vault = vaultWith([record('rft', 'weird.rft')]);
    expect(() => parseVaultValue(jsonRoundTrip(vault))).toThrow(/integrity check failed/u);
  });

  it('rejects a non-record file entry', () => {
    const value = jsonRoundTrip(vaultWith([]));
    value.files = ['rft'];
    expect(() => parseVaultValue(value)).toThrow(/integrity check failed/u);
  });
});

describe('R2/R23-IDENT-2: the whole VaultFile shape is validated fail-closed', () => {
  function valueWithFile(file: unknown): Record<string, unknown> {
    const value = jsonRoundTrip(vaultWith([]));
    value.files = [file];
    return value;
  }

  it('rejects a record that only carries format and maskedSha256', () => {
    expect(() => parseVaultValue(valueWithFile({ format: 'docx', maskedSha256: HEX }))).toThrow(
      /integrity check failed/u,
    );
  });

  it('rejects missing names, a bad size, non-hex hashes and fractional scope', () => {
    const valid = record('docx', 'ok.docx', HEX);
    const cases: unknown[] = [
      { ...valid, originalName: '' },
      { ...valid, maskedName: undefined },
      { ...valid, size: '1' },
      { ...valid, size: -1 },
      { ...valid, sha256: 'not-a-hash' },
      { ...valid, sha256: HEX.toUpperCase() },
      { ...valid, maskedSha256: 'abc' },
      { ...valid, occurrenceStart: 1.5 },
      { ...valid, occurrenceCount: -2 },
    ];
    for (const file of cases) {
      expect(() => parseVaultValue(valueWithFile(file))).toThrow(/integrity check failed/u);
    }
  });

  it('rejects malformed optional encoding/declarationEncoding/bom/eol', () => {
    const valid = record('docx', 'ok.docx', HEX);
    const cases: unknown[] = [
      { ...valid, encoding: 123 },
      { ...valid, encoding: 'koi8-r' },
      { ...valid, declarationEncoding: 42 },
      { ...valid, declarationEncoding: 'bad label' },
      { ...valid, bom: 'yes' },
      { ...valid, eol: 'weird' },
    ];
    for (const file of cases) {
      expect(() => parseVaultValue(valueWithFile(file))).toThrow(/integrity check failed/u);
    }
  });

  it('accepts a complete record with documented optional fields', () => {
    const value = valueWithFile({
      ...record('xml', 'ok.xml', HEX),
      encoding: 'windows-1251',
      declarationEncoding: 'cp1251',
      bom: true,
      eol: 'crlf',
      occurrenceStart: 0,
      occurrenceCount: 3,
    });
    const parsed = parseVaultValue(value);
    expect(parsed.files[0]).toMatchObject({
      format: 'xml',
      encoding: 'windows-1251',
      declarationEncoding: 'cp1251',
      bom: true,
      eol: 'crlf',
      occurrenceCount: 3,
    });
    // Missing optional fields stay allowed for legacy records.
    expect(parseVaultValue(valueWithFile(record('docx', 'legacy.docx'))).files[0]).toMatchObject({
      format: 'docx',
    });
  });
});

describe('R2/R23-IDENT-2: legacy/mixed resolution rejects unknown formats', () => {
  const bytes = new TextEncoder().encode('masked legacy bytes');

  it('rejects a legacy-only record with an unknown format', async () => {
    const vault = vaultWith([record('rft', 'legacy.rft')]);
    await expect(resolveVaultFile(vault, { name: 'legacy.rft', bytes })).rejects.toBeInstanceOf(
      IdentityMismatchVaultFileError,
    );
  });

  it('rejects a legacy-only record with a missing format', async () => {
    const legacy = record('doc', 'legacy.doc');
    delete (legacy as Partial<VaultFile>).format;
    const vault = vaultWith([legacy]);
    await expect(resolveVaultFile(vault, { name: 'legacy.doc', bytes })).rejects.toBeInstanceOf(
      IdentityMismatchVaultFileError,
    );
  });

  it('rejects the name fallback for an unknown format in a mixed vault', async () => {
    const maskedBytes = new TextEncoder().encode('hashed masked bytes');
    const hashed = record('docx', 'fresh.docx', await sha256Hex(maskedBytes));
    const vault = vaultWith([hashed, record('rft', 'legacy.rft')]);
    await expect(resolveVaultFile(vault, { name: 'legacy.rft', bytes })).rejects.toBeInstanceOf(
      IdentityMismatchVaultFileError,
    );
  });

  it('keeps the name fallback for a normal legacy DOC record in a mixed vault', async () => {
    const maskedBytes = new TextEncoder().encode('hashed masked bytes');
    const hashed = record('docx', 'fresh.docx', await sha256Hex(maskedBytes));
    const vault = vaultWith([hashed, record('doc', 'legacy.doc')]);
    const resolved = await resolveVaultFile(vault, { name: 'legacy.doc', bytes });
    expect(resolved?.format).toBe('doc');
  });
});

describe('R22-IDENT-1: runtime-unknown formats are never resolved as a match', () => {
  it('never returns a hashed record while a legacy record has an unknown class', async () => {
    const bytes = new TextEncoder().encode('docx masked bytes');
    const maskedSha256 = await sha256Hex(bytes);
    // Only a runtime/corrupted vault can still hold an unknown format: import
    // rejects it, so this is the defense-in-depth path.
    const vault = vaultWith([
      record('rft', 'legacy.rft'),
      record('docx', 'fresh.docx', maskedSha256),
    ]);

    await expect(resolveVaultFile(vault, { name: 'fresh.docx', bytes })).rejects.toBeInstanceOf(
      AmbiguousVaultFileError,
    );
  });

  it('never returns a hashed record whose own format is unknown', async () => {
    const bytes = new TextEncoder().encode('weird masked bytes');
    const maskedSha256 = await sha256Hex(bytes);
    const vault = vaultWith([
      record('rft', 'fresh.rft', maskedSha256),
      record('pdf', 'legacy.pdf'),
    ]);

    await expect(resolveVaultFile(vault, { name: 'fresh.rft', bytes })).rejects.toBeInstanceOf(
      IdentityMismatchVaultFileError,
    );
  });

  it('keeps legacy DOC/XLS restores working without hashes', async () => {
    for (const [format, name] of [
      ['doc', 'legacy.doc'],
      ['xls', 'legacy.xls'],
    ] as const) {
      const vault = vaultWith([record(format, name)]);
      const resolved = await resolveVaultFile(vault, {
        name,
        bytes: new TextEncoder().encode('masked legacy bytes'),
      });
      expect(resolved?.format).toBe(format);
    }
  });
});
