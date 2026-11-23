import { describe, expect, it } from 'vitest';
import type { FileInput, Vault } from '../../src/core';
import {
  AmbiguousVaultFileError,
  anonymizeDocx,
  anonymizeJson,
  anonymizeMd,
  anonymizeTxt,
  anonymizeXlsx,
  anonymizeXml,
  createVault,
  decodeXml,
  IdentityMismatchVaultFileError,
  restoreDocx,
  restoreJson,
  restoreMd,
  restoreTxt,
  restoreXlsx,
  restoreXml,
  sha256Hex,
  unzipPackage,
} from '../../src/core';
import { minimalDocx } from '../fixtures/docx';
import { minimalXlsx } from '../fixtures/xlsx';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BYTES = 1_000_000;

function docxBody(...texts: string[]): string {
  return texts.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
}

function partText(bytes: Uint8Array, part: string): string {
  const data = unzipPackage(bytes).get(part);
  return data ? decodeXml(data).text : '';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fileOf(name: string, mimeType: string, bytes: Uint8Array): FileInput {
  return { name, mimeType, bytes };
}

/** Sets the EOCD entry counts to the ZIP64 sentinel (0xffff). */
function withZip64EocdCounts(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  for (let index = copy.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) !== 0x06054b50) continue;
    view.setUint16(index + 8, 0xffff, true);
    view.setUint16(index + 10, 0xffff, true);
    return copy;
  }
  throw new Error('EOCD not found');
}

async function maskJson(vault: Vault, name: string, source: string) {
  return anonymizeJson(fileOf(name, 'application/json', encoder.encode(source)), {
    vault,
    maxBytes: 1_000_000,
  });
}

async function maskXml(vault: Vault, name: string, source: string) {
  return anonymizeXml(fileOf(name, 'application/xml', encoder.encode(source)), {
    vault,
    maxBytes: 1_000_000,
  });
}

async function restoreJsonText(name: string, result: { maskedBytes: Uint8Array }, vault: Vault) {
  const restored = await restoreJson(fileOf(name, 'application/json', result.maskedBytes), vault);
  return decoder.decode(restored.bytes);
}

async function restoreXmlText(name: string, result: { maskedBytes: Uint8Array }, vault: Vault) {
  const restored = await restoreXml(fileOf(name, 'application/xml', result.maskedBytes), vault);
  return decoder.decode(restored.bytes);
}

function dropScope(vault: Vault, index: number): void {
  const record = vault.files[index];
  expect(record).toBeDefined();
  if (!record) return;
  delete record.occurrenceStart;
  delete record.occurrenceCount;
}

describe('R16-RESTORE-IDENTITY: duplicate names and legacy scopes', () => {
  it('restores duplicate JSON names by masked bytes, not by the last record', async () => {
    const vault = createVault('');
    const first = '{"id":1,"email":"ivan@example.ru"}';
    const second = '{"id":2,"email":"IVAN@example.ru"}';
    const firstResult = await maskJson(vault, 'same.json', first);
    const secondResult = await maskJson(vault, 'same.json', second);

    expect(vault.files.map((record) => record.maskedName)).toEqual(['same.json', 'same.json']);
    expect(vault.files[0]?.maskedSha256).toBeDefined();
    expect(vault.files[1]?.maskedSha256).toBeDefined();
    expect(vault.files[0]?.maskedSha256).not.toBe(vault.files[1]?.maskedSha256);

    // Before the fix the first restore picked the last record and replayed the
    // second file's uppercase surface into the first document.
    expect(await restoreJsonText('same.json', firstResult, vault)).toBe(first);
    expect(await restoreJsonText('same.json', secondResult, vault)).toBe(second);
  });

  it('restores duplicate XML names with oblique person forms', async () => {
    const vault = createVault('');
    const first = '<root id="1"><name>Иванов Иван Иванович</name></root>';
    const second = '<root id="2"><name>ИВАНОВ ИВАН ИВАНОВИЧ</name></root>';
    const firstResult = await maskXml(vault, 'same.xml', first);
    const secondResult = await maskXml(vault, 'same.xml', second);

    expect(await restoreXmlText('same.xml', firstResult, vault)).toBe(first);
    expect(await restoreXmlText('same.xml', secondResult, vault)).toBe(second);
  });

  it('resolves masked bytes by hash even when the download name changed', async () => {
    const vault = createVault('');
    const first = '{"id":1,"email":"ivan@example.ru"}';
    const second = '{"id":2,"email":"IVAN@example.ru"}';
    const firstResult = await maskJson(vault, 'same.json', first);
    await maskJson(vault, 'same.json', second);

    expect(await restoreJsonText('renamed.json', firstResult, vault)).toBe(first);
  });

  it('fails closed for legacy multi-file records instead of consuming global surfaces', async () => {
    const vault = createVault('');
    const first = '{"email":"ivan@example.ru"}';
    const second = '{"email":"petr@example.ru"}';
    const firstResult = await maskJson(vault, 'first.json', first);
    const secondResult = await maskJson(vault, 'second.json', second);
    dropScope(vault, 0);

    // The legacy first record cannot claim the whole occurrence list: the
    // second file's surface was already appended to it.
    await expect(restoreJsonText('first.json', firstResult, vault)).rejects.toMatchObject({
      code: 'AMBIGUOUS_VAULT_FILE',
    });
    // The scoped second record keeps working.
    expect(await restoreJsonText('second.json', secondResult, vault)).toBe(second);
  });

  it('derives a missing count from the next scoped record', async () => {
    const vault = createVault('');
    const first = '{"id":1,"email":"ivan@example.ru"}';
    const second = '{"id":2,"email":"IVAN@example.ru"}';
    const firstResult = await maskJson(vault, 'first.json', first);
    const secondResult = await maskJson(vault, 'second.json', second);
    const record = vault.files[0];
    if (record) delete record.occurrenceCount;

    expect(await restoreJsonText('first.json', firstResult, vault)).toBe(first);
    expect(await restoreJsonText('second.json', secondResult, vault)).toBe(second);
  });

  it('keeps the global fallback for a single legacy record', async () => {
    const vault = createVault('');
    const source = '{"a":"ivan@example.ru","b":"IVAN@example.ru"}';
    const result = await maskJson(vault, 'legacy.json', source);
    dropScope(vault, 0);

    expect(await restoreJsonText('legacy.json', result, vault)).toBe(source);
  });

  it('restores duplicate TXT names from their own occurrence scopes', async () => {
    const vault = createVault('');
    const first = 'Первая почта ivan@example.ru';
    const second = 'Вторая почта IVAN@example.ru';
    const firstResult = await anonymizeTxt(
      fileOf('same.txt', 'text/plain', encoder.encode(first)),
      { vault, maxBytes: 1_000_000 },
    );
    const secondResult = await anonymizeTxt(
      fileOf('same.txt', 'text/plain', encoder.encode(second)),
      { vault, maxBytes: 1_000_000 },
    );

    const restoredFirst = await restoreTxt(
      fileOf('same.txt', 'text/plain', firstResult.maskedBytes),
      vault,
    );
    const restoredSecond = await restoreTxt(
      fileOf('same.txt', 'text/plain', secondResult.maskedBytes),
      vault,
    );

    expect(decoder.decode(restoredFirst.bytes)).toBe(first);
    expect(decoder.decode(restoredSecond.bytes)).toBe(second);
  });

  it('restores duplicate MD names from their own occurrence scopes', async () => {
    const vault = createVault('');
    const first = 'Первая почта ivan@example.ru';
    const second = 'Вторая почта IVAN@example.ru';
    const firstResult = await anonymizeMd(
      fileOf('same.md', 'text/markdown', encoder.encode(first)),
      { vault, maxBytes: 1_000_000 },
    );
    const secondResult = await anonymizeMd(
      fileOf('same.md', 'text/markdown', encoder.encode(second)),
      { vault, maxBytes: 1_000_000 },
    );

    const restoredFirst = await restoreMd(
      fileOf('same.md', 'text/markdown', firstResult.maskedBytes),
      vault,
    );
    const restoredSecond = await restoreMd(
      fileOf('same.md', 'text/markdown', secondResult.maskedBytes),
      vault,
    );

    expect(decoder.decode(restoredFirst.bytes)).toBe(first);
    expect(decoder.decode(restoredSecond.bytes)).toBe(second);
  });

  it('fails closed when duplicate names produced identical masked bytes', async () => {
    const vault = createVault('');
    const first = '{"email":"ivan@example.ru"}';
    const second = '{"email":"IVAN@example.ru"}';
    const firstResult = await maskJson(vault, 'same.json', first);
    const secondResult = await maskJson(vault, 'same.json', second);

    // Case-only surfaces mask to byte-identical documents, so no hash can tell
    // which occurrence belongs to which download.
    expect(vault.files[0]?.maskedSha256).toBe(vault.files[1]?.maskedSha256);
    await expect(restoreJsonText('same.json', firstResult, vault)).rejects.toMatchObject({
      code: 'AMBIGUOUS_VAULT_FILE',
    });
    await expect(restoreJsonText('same.json', secondResult, vault)).rejects.toMatchObject({
      code: 'AMBIGUOUS_VAULT_FILE',
    });
  });

  it('fails closed when duplicate names have no masked bytes hash at all', async () => {
    const vault = createVault('');
    const source = '{"email":"ivan@example.ru"}';
    const result = await maskJson(vault, 'same.json', source);
    for (const record of vault.files) delete record.maskedSha256;

    const other = await maskJson(vault, 'same.json', '{"email":"other@example.ru"}');
    for (const record of vault.files) delete record.maskedSha256;

    await expect(restoreJsonText('same.json', result, vault)).rejects.toBeInstanceOf(
      AmbiguousVaultFileError,
    );
    await expect(restoreJsonText('same.json', other, vault)).rejects.toBeInstanceOf(
      AmbiguousVaultFileError,
    );
  });
});

interface IdentityFormat {
  label: string;
  ext: string;
  source: string;
  /** Differs from `source` only by case: both mask to identical bytes. */
  caseVariant: string;
  foreign(prefix: string): string;
  mask(vault: Vault, name: string): Promise<{ maskedBytes: Uint8Array }>;
  maskSource(vault: Vault, name: string, source: string): Promise<{ maskedBytes: Uint8Array }>;
  restore(name: string, bytes: Uint8Array, vault: Vault): Promise<{ bytes: Uint8Array }>;
}

const IDENTITY_FORMATS: readonly IdentityFormat[] = [
  {
    label: 'TXT',
    ext: 'txt',
    source: 'Почта ivan@example.ru',
    caseVariant: 'Почта IVAN@example.ru',
    foreign: (prefix) => `Ящик: [[${prefix}_EMAIL_1]]`,
    mask: (vault, name) =>
      anonymizeTxt(fileOf(name, 'text/plain', encoder.encode('Почта ivan@example.ru')), {
        vault,
        maxBytes: 1_000_000,
      }),
    maskSource: (vault, name, source) =>
      anonymizeTxt(fileOf(name, 'text/plain', encoder.encode(source)), {
        vault,
        maxBytes: 1_000_000,
      }),
    restore: (name, bytes, vault) => restoreTxt(fileOf(name, 'text/plain', bytes), vault),
  },
  {
    label: 'MD',
    ext: 'md',
    source: 'Почта ivan@example.ru',
    caseVariant: 'Почта IVAN@example.ru',
    foreign: (prefix) => `Ящик: [[${prefix}_EMAIL_1]]`,
    mask: (vault, name) =>
      anonymizeMd(fileOf(name, 'text/markdown', encoder.encode('Почта ivan@example.ru')), {
        vault,
        maxBytes: 1_000_000,
      }),
    maskSource: (vault, name, source) =>
      anonymizeMd(fileOf(name, 'text/markdown', encoder.encode(source)), {
        vault,
        maxBytes: 1_000_000,
      }),
    restore: (name, bytes, vault) => restoreMd(fileOf(name, 'text/markdown', bytes), vault),
  },
  {
    label: 'JSON',
    ext: 'json',
    source: '{"email":"ivan@example.ru"}',
    caseVariant: '{"email":"IVAN@example.ru"}',
    foreign: (prefix) => `{"email":"[[${prefix}_EMAIL_1]]","note":"x"}`,
    mask: (vault, name) =>
      anonymizeJson(
        fileOf(name, 'application/json', encoder.encode('{"email":"ivan@example.ru"}')),
        {
          vault,
          maxBytes: 1_000_000,
        },
      ),
    maskSource: (vault, name, source) =>
      anonymizeJson(fileOf(name, 'application/json', encoder.encode(source)), {
        vault,
        maxBytes: 1_000_000,
      }),
    restore: (name, bytes, vault) => restoreJson(fileOf(name, 'application/json', bytes), vault),
  },
  {
    label: 'XML',
    ext: 'xml',
    source: '<root><email>ivan@example.ru</email></root>',
    caseVariant: '<root><email>IVAN@example.ru</email></root>',
    foreign: (prefix) => `<root><email>[[${prefix}_EMAIL_1]]</email><n>1</n></root>`,
    mask: (vault, name) =>
      anonymizeXml(
        fileOf(
          name,
          'application/xml',
          encoder.encode('<root><email>ivan@example.ru</email></root>'),
        ),
        { vault, maxBytes: 1_000_000 },
      ),
    maskSource: (vault, name, source) =>
      anonymizeXml(fileOf(name, 'application/xml', encoder.encode(source)), {
        vault,
        maxBytes: 1_000_000,
      }),
    restore: (name, bytes, vault) => restoreXml(fileOf(name, 'application/xml', bytes), vault),
  },
];

describe('R17-RESTORE-HASH: masked bytes own the restore identity', () => {
  for (const format of IDENTITY_FORMATS) {
    describe(format.label, () => {
      it('fails closed for identical masked bytes under different names', async () => {
        const vault = createVault('');
        const first = await format.mask(vault, `first.${format.ext}`);
        await format.mask(vault, `second.${format.ext}`);

        expect(vault.files[0]?.maskedSha256).toBe(vault.files[1]?.maskedSha256);
        // Names differ, so name disambiguation used to pick the record whose
        // bytes were identical anyway: no test can tell which occurrence list
        // the download belongs to.
        await expect(
          format.restore(`first.${format.ext}`, first.maskedBytes, vault),
        ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
        await expect(
          format.restore(`renamed.${format.ext}`, first.maskedBytes, vault),
        ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
      });

      it('fails closed for modified bytes of a hashed record', async () => {
        const vault = createVault('');
        const result = await format.mask(vault, `same.${format.ext}`);
        const modified = new Uint8Array([...result.maskedBytes, 0x0a]);

        await expect(format.restore(`same.${format.ext}`, modified, vault)).rejects.toBeInstanceOf(
          IdentityMismatchVaultFileError,
        );
      });

      it('fails closed for foreign bytes under a vault record name', async () => {
        const vault = createVault('', { prefix: 'AAAAA' });
        const other = createVault('', { prefix: 'BBBBB' });
        await format.mask(vault, `same.${format.ext}`);
        const foreign = await format.mask(other, `same.${format.ext}`);

        await expect(
          format.restore(`same.${format.ext}`, foreign.maskedBytes, vault),
        ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
      });

      it('fails closed for unknown bytes without a name match in a single-file vault', async () => {
        const vault = createVault('', { prefix: 'AAAAA' });
        await format.mask(vault, `same.${format.ext}`);

        // Before the fix `record` stayed undefined and the single-file global
        // occurrence list replayed this record's PII into foreign bytes.
        await expect(
          format.restore(`other.${format.ext}`, encoder.encode(format.foreign('AAAAA')), vault),
        ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
      });

      it('fails closed for a foreign name on a single legacy record without a hash', async () => {
        const vault = createVault('', { prefix: 'AAAAA' });
        await format.mask(vault, `legacy.${format.ext}`);
        const record = vault.files[0];
        expect(record).toBeDefined();
        if (record) delete record.maskedSha256;

        // Before R18 the missing name match left the record undefined and the
        // single-file global occurrence list replayed vault PII here.
        await expect(
          format.restore(`other.${format.ext}`, encoder.encode(format.foreign('AAAAA')), vault),
        ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
      });

      it('fails closed for foreign-vault tags on a matching legacy name', async () => {
        const vault = createVault('', { prefix: 'AAAAA' });
        await format.mask(vault, `legacy.${format.ext}`);
        const record = vault.files[0];
        expect(record).toBeDefined();
        if (record) delete record.maskedSha256;

        await expect(
          format.restore(`legacy.${format.ext}`, encoder.encode(format.foreign('BBBBB')), vault),
        ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
      });

      it('keeps the global fallback for a matching legacy name without a hash', async () => {
        const vault = createVault('', { prefix: 'AAAAA' });
        await format.mask(vault, `legacy.${format.ext}`);
        const record = vault.files[0];
        expect(record).toBeDefined();
        if (record) delete record.maskedSha256;

        const restored = await format.restore(
          `legacy.${format.ext}`,
          encoder.encode(format.foreign('AAAAA')),
          vault,
        );
        expect(decoder.decode(restored.bytes)).toContain('ivan@example.ru');
      });
    });
  }
});

describe('R18-RESTORE-LEGACY-NEW: unhashed legacy records keep the bytes ambiguous', () => {
  for (const format of IDENTITY_FORMATS) {
    describe(format.label, () => {
      it("fails closed when a legacy record may own a new record's identical bytes", async () => {
        const vault = createVault('', { prefix: 'AAAAA' });
        const legacyMasked = await format.maskSource(vault, `same.${format.ext}`, format.source);
        const legacy = vault.files[0];
        expect(legacy).toBeDefined();
        if (legacy) delete legacy.maskedSha256;
        const fresh = await format.maskSource(vault, `same.${format.ext}`, format.caseVariant);

        expect(legacy?.maskedSha256).toBeUndefined();
        expect(fresh.maskedBytes).toEqual(legacyMasked.maskedBytes);

        // The hashed record is unique, but the legacy record's bytes could be
        // byte-identical while its occurrence scope maps the same tag to the
        // other surface. Both the shared name and a third name are ambiguous.
        await expect(
          format.restore(`same.${format.ext}`, fresh.maskedBytes, vault),
        ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
        await expect(
          format.restore(`third.${format.ext}`, fresh.maskedBytes, vault),
        ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
      });

      it('restores a valid hashed record when no legacy record remains', async () => {
        const vault = createVault('', { prefix: 'AAAAA' });
        const masked = await format.maskSource(vault, `same.${format.ext}`, format.source);

        const restored = await format.restore(`renamed.${format.ext}`, masked.maskedBytes, vault);
        expect(decoder.decode(restored.bytes)).toBe(format.source);
      });
    });
  }
});

describe('R21-FORMAT-CLASS: legacy ambiguity is scoped to the format class', () => {
  it('fails closed when a legacy DOCX may own the hashed DOCX bytes', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const legacy = await anonymizeDocx(
      fileOf('same.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    const record = vault.files[0];
    expect(record).toBeDefined();
    if (record) delete record.maskedSha256;
    const fresh = await anonymizeDocx(
      fileOf('same.docx', DOCX_MIME, minimalDocx(docxBody('ИВАНОВ ИВАН ИВАНОВИЧ'))),
      { vault, maxBytes: MAX_BYTES },
    );

    expect(fresh.maskedBytes).toEqual(legacy.maskedBytes);
    // Before the fix the hashed match was returned even though the legacy
    // DOCX record could own the same bytes and replay the other surface.
    await expect(
      restoreDocx(fileOf('same.docx', DOCX_MIME, fresh.maskedBytes), vault),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
  });

  it('fails closed when a legacy XLSX may own the hashed XLSX bytes', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const legacy = await anonymizeXlsx(
      fileOf('same.xlsx', XLSX_MIME, minimalXlsx('Иванов Иван Иванович')),
      { vault, maxBytes: MAX_BYTES },
    );
    const record = vault.files[0];
    expect(record).toBeDefined();
    if (record) delete record.maskedSha256;
    const fresh = await anonymizeXlsx(
      fileOf('same.xlsx', XLSX_MIME, minimalXlsx('ИВАНОВ ИВАН ИВАНОВИЧ')),
      { vault, maxBytes: MAX_BYTES },
    );

    expect(fresh.maskedBytes).toEqual(legacy.maskedBytes);
    await expect(
      restoreXlsx(fileOf('same.xlsx', XLSX_MIME, fresh.maskedBytes), vault),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
  });

  it('restores a hashed DOCX while an unrelated legacy TXT record remains', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    await anonymizeTxt(
      fileOf('legacy.txt', 'text/plain', encoder.encode('Почта ivan@example.ru')),
      { vault, maxBytes: MAX_BYTES },
    );
    const legacy = vault.files[0];
    expect(legacy).toBeDefined();
    if (legacy) delete legacy.maskedSha256;
    const fresh = await anonymizeDocx(
      fileOf('fresh.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );

    // Text masked bytes are UTF-8 text and can never equal an OOXML
    // container, so the legacy TXT record must not block the DOCX restore.
    const restored = await restoreDocx(fileOf('fresh.docx', DOCX_MIME, fresh.maskedBytes), vault);
    expect(partText(restored.bytes, 'word/document.xml')).toContain('Иванов Иван Иванович');
  });

  it('restores a hashed TXT while an unrelated legacy DOCX record remains', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    await anonymizeDocx(
      fileOf('legacy.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    const legacy = vault.files[0];
    expect(legacy).toBeDefined();
    if (legacy) delete legacy.maskedSha256;
    const source = 'Почта ivan@example.ru';
    const fresh = await anonymizeTxt(fileOf('fresh.txt', 'text/plain', encoder.encode(source)), {
      vault,
      maxBytes: MAX_BYTES,
    });

    const restored = await restoreTxt(fileOf('fresh.txt', 'text/plain', fresh.maskedBytes), vault);
    expect(decoder.decode(restored.bytes)).toBe(source);
  });
});

describe('R1/R3: DOCX/XLSX restore identity is the masked-byte hash', () => {
  it('restores two DOCX case variants from their own occurrence scopes', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const first = await anonymizeDocx(
      fileOf('same.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович', 'Первый'))),
      { vault, maxBytes: MAX_BYTES },
    );
    const second = await anonymizeDocx(
      fileOf('same.docx', DOCX_MIME, minimalDocx(docxBody('ИВАНОВ ИВАН ИВАНОВИЧ', 'Второй'))),
      { vault, maxBytes: MAX_BYTES },
    );

    expect(vault.files[0]?.maskedSha256).toBeDefined();
    expect(vault.files[1]?.maskedSha256).toBeDefined();
    expect(vault.files[0]?.maskedSha256).not.toBe(vault.files[1]?.maskedSha256);
    expect(vault.files[0]?.occurrenceCount).toBeGreaterThan(0);

    const restoredFirst = await restoreDocx(
      fileOf('same.docx', DOCX_MIME, first.maskedBytes),
      vault,
    );
    const restoredSecond = await restoreDocx(
      fileOf('same.docx', DOCX_MIME, second.maskedBytes),
      vault,
    );
    expect(partText(restoredFirst.bytes, 'word/document.xml')).toContain('Иванов Иван Иванович');
    expect(partText(restoredFirst.bytes, 'word/document.xml')).toContain('Первый');
    expect(partText(restoredSecond.bytes, 'word/document.xml')).toContain('ИВАНОВ ИВАН ИВАНОВИЧ');
    expect(partText(restoredSecond.bytes, 'word/document.xml')).toContain('Второй');

    // A renamed masked download is resolved by its masked-byte hash, not by
    // the file name.
    const renamed = await restoreDocx(fileOf('renamed.docx', DOCX_MIME, first.maskedBytes), vault);
    expect(partText(renamed.bytes, 'word/document.xml')).toContain('Иванов Иван Иванович');
    expect(renamed.fileName).toBe('same.docx');
  });

  it('restores two XLSX case variants from their own occurrence scopes', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const first = await anonymizeXlsx(
      fileOf('same.xlsx', XLSX_MIME, minimalXlsx('Иванов Иван Иванович Первый')),
      { vault, maxBytes: MAX_BYTES },
    );
    const second = await anonymizeXlsx(
      fileOf('same.xlsx', XLSX_MIME, minimalXlsx('ИВАНОВ ИВАН ИВАНОВИЧ Второй')),
      { vault, maxBytes: MAX_BYTES },
    );

    expect(vault.files[0]?.maskedSha256).not.toBe(vault.files[1]?.maskedSha256);
    expect(vault.files[0]?.occurrenceCount).toBeGreaterThan(0);

    const restoredFirst = await restoreXlsx(
      fileOf('same.xlsx', XLSX_MIME, first.maskedBytes),
      vault,
    );
    const restoredSecond = await restoreXlsx(
      fileOf('same.xlsx', XLSX_MIME, second.maskedBytes),
      vault,
    );
    expect(partText(restoredFirst.bytes, 'xl/worksheets/sheet1.xml')).toContain(
      'Иванов Иван Иванович',
    );
    expect(partText(restoredSecond.bytes, 'xl/worksheets/sheet1.xml')).toContain(
      'ИВАНОВ ИВАН ИВАНОВИЧ',
    );
  });

  it('rejects modified masked DOCX/XLSX bytes without changing them', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const docx = await anonymizeDocx(
      fileOf('clean.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    const xlsx = await anonymizeXlsx(fileOf('clean.xlsx', XLSX_MIME, minimalXlsx()), {
      vault,
      maxBytes: MAX_BYTES,
    });

    for (const [name, mime, bytes] of [
      ['clean.docx', DOCX_MIME, docx.maskedBytes],
      ['clean.xlsx', XLSX_MIME, xlsx.maskedBytes],
    ] as const) {
      const modified = new Uint8Array(bytes);
      modified[modified.length - 1] = (modified[modified.length - 1] ?? 0) ^ 0xff;
      const before = new Uint8Array(modified);
      const restore = name.endsWith('.docx') ? restoreDocx : restoreXlsx;
      await expect(restore(fileOf(name, mime, modified), vault)).rejects.toBeInstanceOf(
        IdentityMismatchVaultFileError,
      );
      expect(modified).toEqual(before);
    }
  });

  it('checks identity before any unzip (R23-DOC-1)', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const masked = await anonymizeDocx(
      fileOf('same.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    // Truncated bytes are not a ZIP at all: an unzip-first implementation would
    // fail with a ZIP error; identity must win and yield IdentityMismatch.
    const truncated = masked.maskedBytes.slice(0, 64);
    await expect(
      restoreDocx(fileOf('same.docx', DOCX_MIME, truncated), vault),
    ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
  });

  it('reaches the archive check only after a hash match (R23-DOC-1)', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const zip64 = withZip64EocdCounts(minimalDocx(docxBody('Иванов Иван Иванович')));
    const hash = await sha256Hex(zip64);
    vault.files.push({
      originalName: 'archive.docx',
      maskedName: 'archive.docx',
      format: 'docx',
      size: zip64.byteLength,
      sha256: hash,
      maskedSha256: hash,
      occurrenceStart: 0,
      occurrenceCount: 0,
    });

    // The hash matches, so restore proceeds to unzip and reports the archive
    // cause (the background maps `ZipError('zip64')` to UNSUPPORTED_ARCHIVE).
    await expect(
      restoreDocx(fileOf('archive.docx', DOCX_MIME, zip64), vault),
    ).rejects.toMatchObject({ name: 'ZipError', reason: 'zip64' });
  });

  it('rejects a foreign DOCX/XLSX that carries a known tag', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    await anonymizeDocx(
      fileOf('own.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    await anonymizeXlsx(fileOf('own.xlsx', XLSX_MIME, minimalXlsx()), {
      vault,
      maxBytes: MAX_BYTES,
    });
    expect(vault.entities.PERSON_1).toBeDefined();

    const foreignDocx = minimalDocx(docxBody('[[DM7F3_PERSON_1]]'));
    const foreignXlsx = minimalXlsx('[[DM7F3_PERSON_1]]');
    await expect(
      restoreDocx(fileOf('own.docx', DOCX_MIME, foreignDocx), vault),
    ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
    await expect(
      restoreDocx(fileOf('unknown.docx', DOCX_MIME, foreignDocx), vault),
    ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
    await expect(
      restoreXlsx(fileOf('own.xlsx', XLSX_MIME, foreignXlsx), vault),
    ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
    await expect(
      restoreXlsx(fileOf('unknown.xlsx', XLSX_MIME, foreignXlsx), vault),
    ).rejects.toBeInstanceOf(IdentityMismatchVaultFileError);
  });

  it('fails closed for a legacy DOCX/XLSX record without scope in a multi-file vault', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    await anonymizeDocx(
      fileOf('first.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    await anonymizeDocx(
      fileOf('second.docx', DOCX_MIME, minimalDocx(docxBody('Петров Пётр Петрович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    await anonymizeXlsx(fileOf('first.xlsx', XLSX_MIME, minimalXlsx('Иванов Иван Иванович')), {
      vault,
      maxBytes: MAX_BYTES,
    });
    await anonymizeXlsx(fileOf('second.xlsx', XLSX_MIME, minimalXlsx('Петров Пётр Петрович')), {
      vault,
      maxBytes: MAX_BYTES,
    });
    for (const record of vault.files) {
      delete record.maskedSha256;
      delete record.occurrenceStart;
      delete record.occurrenceCount;
    }

    await expect(
      restoreDocx(
        fileOf('second.docx', DOCX_MIME, minimalDocx(docxBody('[[DM7F3_PERSON_1]]'))),
        vault,
      ),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
    await expect(
      restoreXlsx(fileOf('second.xlsx', XLSX_MIME, minimalXlsx('[[DM7F3_PERSON_1]]')), vault),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
  });
});

describe('R25-CROSS-CLASS: a legacy record of another class never blocks a hashed restore', () => {
  const SOURCE = 'Письмо: ivan@example.ru';

  async function hashedTxt(vault: Vault): Promise<{ maskedBytes: Uint8Array }> {
    return anonymizeTxt(fileOf('same.txt', 'text/plain', encoder.encode(SOURCE)), {
      vault,
      maxBytes: MAX_BYTES,
    });
  }

  /** A real masked record of another class, renamed and stripped of its hash. */
  function makeLegacy(record: Vault['files'][number] | undefined): void {
    expect(record).toBeDefined();
    if (!record) return;
    delete record.maskedSha256;
    record.originalName = 'same.txt';
    record.maskedName = 'same.txt';
  }

  it('restores hashed TXT while legacy word, sheet and PDF records share its name', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const hashed = await hashedTxt(vault);

    await anonymizeDocx(
      fileOf('word.docx', DOCX_MIME, minimalDocx(docxBody('Петров Пётр Петрович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    makeLegacy(vault.files[1]);

    await anonymizeXlsx(fileOf('sheet.xlsx', XLSX_MIME, minimalXlsx('Петров Пётр Петрович')), {
      vault,
      maxBytes: MAX_BYTES,
    });
    makeLegacy(vault.files[2]);

    // PDF redaction is one-way: only a legacy record can exist here.
    vault.files.push({
      originalName: 'same.txt',
      maskedName: 'same.txt',
      format: 'pdf',
      size: 1,
      sha256: 'f'.repeat(64),
    });

    const restored = await restoreTxt(fileOf('same.txt', 'text/plain', hashed.maskedBytes), vault);
    expect(decoder.decode(restored.bytes)).toBe(SOURCE);
    // A wrong-scope replay would insert the foreign persons instead.
    expect(decoder.decode(restored.bytes)).not.toContain('Петров');
  });

  it('restores hashed DOCX while a legacy TXT record shares its name', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    await anonymizeTxt(fileOf('same.doc', 'text/plain', encoder.encode(SOURCE)), {
      vault,
      maxBytes: MAX_BYTES,
    });
    const legacy = vault.files[0];
    expect(legacy).toBeDefined();
    if (legacy) {
      delete legacy.maskedSha256;
      legacy.format = 'txt';
    }

    const fresh = await anonymizeDocx(
      fileOf('same.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );

    const restored = await restoreDocx(fileOf('same.docx', DOCX_MIME, fresh.maskedBytes), vault);
    expect(partText(restored.bytes, 'word/document.xml')).toContain('Иванов Иван Иванович');
  });

  it('still fails closed as Ambiguous for a legacy TXT record of the same class', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const hashed = await hashedTxt(vault);
    await anonymizeTxt(
      fileOf('legacy.txt', 'text/plain', encoder.encode('Другой: petr@example.ru')),
      {
        vault,
        maxBytes: MAX_BYTES,
      },
    );
    makeLegacy(vault.files[1]);

    await expect(
      restoreTxt(fileOf('same.txt', 'text/plain', hashed.maskedBytes), vault),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
  });
});

describe('R21-BINARY-CLASS-OVERBLOCK: word and sheet classes are independent', () => {
  it('restores a hashed XLSX while a legacy DOCX record remains', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    await anonymizeDocx(
      fileOf('legacy.docx', DOCX_MIME, minimalDocx(docxBody('Петров Пётр Петрович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    const legacy = vault.files[0];
    expect(legacy).toBeDefined();
    if (legacy) delete legacy.maskedSha256;

    const fresh = await anonymizeXlsx(
      fileOf('fresh.xlsx', XLSX_MIME, minimalXlsx('Иванов Иван Иванович')),
      { vault, maxBytes: MAX_BYTES },
    );

    // Before the fix the legacy DOCX record blocked the XLSX restore because
    // both formats shared the single `binary` class.
    const restored = await restoreXlsx(fileOf('fresh.xlsx', XLSX_MIME, fresh.maskedBytes), vault);
    const sheet = partText(restored.bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('Иванов Иван Иванович');
    // A wrong-scope replay would insert the DOCX record's person here.
    expect(sheet).not.toContain('Петров');
  });

  it('restores a hashed DOCX while a legacy XLSX record remains', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    await anonymizeXlsx(fileOf('legacy.xlsx', XLSX_MIME, minimalXlsx('Петров Пётр Петрович')), {
      vault,
      maxBytes: MAX_BYTES,
    });
    const legacy = vault.files[0];
    expect(legacy).toBeDefined();
    if (legacy) delete legacy.maskedSha256;

    const fresh = await anonymizeDocx(
      fileOf('fresh.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );

    const restored = await restoreDocx(fileOf('fresh.docx', DOCX_MIME, fresh.maskedBytes), vault);
    const body = partText(restored.bytes, 'word/document.xml');
    expect(body).toContain('Иванов Иван Иванович');
    expect(body).not.toContain('Петров');
  });

  it('fails closed when a legacy .doc record may own the hashed DOCX bytes', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const legacy = await anonymizeDocx(
      fileOf('same.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );
    const record = vault.files[0];
    expect(record).toBeDefined();
    if (record) {
      delete record.maskedSha256;
      // DOC records are stored as DOCX: the same word class.
      record.format = 'doc';
    }
    const fresh = await anonymizeDocx(
      fileOf('same.docx', DOCX_MIME, minimalDocx(docxBody('ИВАНОВ ИВАН ИВАНОВИЧ'))),
      { vault, maxBytes: MAX_BYTES },
    );

    expect(fresh.maskedBytes).toEqual(legacy.maskedBytes);
    await expect(
      restoreDocx(fileOf('same.docx', DOCX_MIME, fresh.maskedBytes), vault),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
  });

  it('fails closed when a legacy .xls record may own the hashed XLSX bytes', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const legacy = await anonymizeXlsx(
      fileOf('same.xlsx', XLSX_MIME, minimalXlsx('Иванов Иван Иванович')),
      { vault, maxBytes: MAX_BYTES },
    );
    const record = vault.files[0];
    expect(record).toBeDefined();
    if (record) {
      delete record.maskedSha256;
      // XLS records are stored as XLSX: the same sheet class.
      record.format = 'xls';
    }
    const fresh = await anonymizeXlsx(
      fileOf('same.xlsx', XLSX_MIME, minimalXlsx('ИВАНОВ ИВАН ИВАНОВИЧ')),
      { vault, maxBytes: MAX_BYTES },
    );

    expect(fresh.maskedBytes).toEqual(legacy.maskedBytes);
    await expect(
      restoreXlsx(fileOf('same.xlsx', XLSX_MIME, fresh.maskedBytes), vault),
    ).rejects.toBeInstanceOf(AmbiguousVaultFileError);
  });

  it('keeps the legacy PDF class apart from a word restore', async () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    vault.files.push({
      originalName: 'legacy.pdf',
      maskedName: 'legacy.pdf',
      format: 'pdf',
      size: 1,
      sha256: 'f'.repeat(64),
    });
    const fresh = await anonymizeDocx(
      fileOf('fresh.docx', DOCX_MIME, minimalDocx(docxBody('Иванов Иван Иванович'))),
      { vault, maxBytes: MAX_BYTES },
    );

    const restored = await restoreDocx(fileOf('fresh.docx', DOCX_MIME, fresh.maskedBytes), vault);
    expect(partText(restored.bytes, 'word/document.xml')).toContain('Иванов Иван Иванович');
  });
});
