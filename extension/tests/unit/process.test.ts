import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../src/background/db';
import {
  isPdfRoute,
  MAX_FILE_BYTES,
  processAnonymize,
  processRestore,
  processRestoreName,
  selectFormatAdapter,
} from '../../src/background/process';
import {
  closeVaultStore,
  getVault,
  initVaultStore,
  listVaults,
} from '../../src/background/vault-store';
import { decodeXml, unzipPackage } from '../../src/core';
import { minimalDocx } from '../fixtures/docx';
import { minimalXlsx } from '../fixtures/xlsx';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const PHONE = '+7 916 123-45-67';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function partText(bytes: Uint8Array, part: string): string {
  const parts = unzipPackage(bytes);
  const data = parts.get(part);
  if (!data) throw new Error(`Missing fixture part ${part}`);
  return decodeXml(data).text;
}

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
});

afterEach(async () => {
  await closeVaultStore();
});

describe('processAnonymize / processRestore', () => {
  it('round-trips TXT and persists the vault', async () => {
    const text = `Договор\n${PERSON}\n${EMAIL}\n${PHONE}\n`;
    const masked = await processAnonymize({
      bytes: encoder.encode(text),
      name: 'letter.txt',
      mime: 'text/plain',
      chatId: 'chat-txt',
    });

    const maskedText = decoder.decode(masked.maskedBytes);
    expect(maskedText).not.toContain(PERSON);
    expect(maskedText).not.toContain(EMAIL);
    expect(maskedText).not.toContain(PHONE);
    expect(maskedText).toContain(`[[${masked.vaultPrefix}_`);
    expect(masked.format).toBe('txt');
    expect(masked.vaultPrefix).toMatch(/^[A-Z0-9]{5}$/u);

    const labels = masked.entities.map((entity) => entity.label);
    expect(labels).toContain('PERSON');
    expect(labels).toContain('EMAIL');
    expect(labels).toContain('PHONE');
    expect(masked.entities.every((entity) => !('canonical' in entity))).toBe(true);

    const stored = await getVault(masked.vaultId);
    expect(stored?.files).toHaveLength(1);
    expect(stored?.files[0]?.originalName).toBe('letter.txt');

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: 'text/plain',
      chatId: 'chat-txt',
    });
    expect(decoder.decode(restored.bytes)).toBe(text);
    expect(restored.replacements).toBeGreaterThanOrEqual(3);
    expect(restored.unknownTags).toEqual([]);
    expect(restored.fileName).toBe('letter.txt');
  });

  it('fails closed when masked bytes do not match the vault record', async () => {
    const text = `${PERSON}\n${EMAIL}\n`;
    const masked = await processAnonymize({
      bytes: encoder.encode(text),
      name: 'tampered.txt',
      mime: 'text/plain',
      chatId: 'chat-tampered',
    });
    const modified = new Uint8Array([...masked.maskedBytes, 0x0a]);

    await expect(
      processRestore({
        bytes: modified,
        name: masked.maskedName,
        mime: 'text/plain',
        chatId: 'chat-tampered',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('round-trips JSON and XML through the process adapter routing', async () => {
    const jsonSource = '{"name":"Иван Петров","email":"ivan@example.ru","count":7}';
    const maskedJson = await processAnonymize({
      bytes: encoder.encode(jsonSource),
      name: 'data.json',
      mime: 'application/json',
      chatId: 'chat-json',
    });

    expect(maskedJson.format).toBe('json');
    expect(maskedJson.maskedMime).toBe('application/json');
    expect(decoder.decode(maskedJson.maskedBytes)).not.toContain('Иван Петров');
    expect(decoder.decode(maskedJson.maskedBytes)).toContain('"count":7');

    const restoredJson = await processRestore({
      bytes: maskedJson.maskedBytes,
      name: maskedJson.maskedName,
      mime: 'application/json',
      chatId: 'chat-json',
    });
    expect(decoder.decode(restoredJson.bytes)).toBe(jsonSource);

    const xmlSource = '<root><name>Иван Петров</name><email>ivan@example.ru</email></root>';
    const maskedXml = await processAnonymize({
      bytes: encoder.encode(xmlSource),
      name: 'data.xml',
      mime: 'text/xml',
      chatId: 'chat-xml',
    });

    expect(maskedXml.format).toBe('xml');
    expect(maskedXml.maskedMime).toBe('text/xml');
    expect(decoder.decode(maskedXml.maskedBytes)).not.toContain('Иван Петров');

    const restoredXml = await processRestore({
      bytes: maskedXml.maskedBytes,
      name: maskedXml.maskedName,
      mime: 'text/xml',
      chatId: 'chat-xml',
    });
    expect(decoder.decode(restoredXml.bytes)).toBe(xmlSource);

    const maskedXmlOctet = await processAnonymize({
      bytes: encoder.encode('<root>ok</root>'),
      name: 'bare.xml',
      mime: 'application/octet-stream',
      chatId: 'chat-xml-octet',
    });
    expect(maskedXmlOctet.maskedMime).toBe('application/xml');
  });

  it('rejects numeric JSON card data without saving a vault', async () => {
    await expect(
      processAnonymize({
        bytes: encoder.encode('{"card":4111111111111111}'),
        name: 'card.json',
        mime: 'application/json',
        chatId: 'chat-json-card',
      }),
    ).rejects.toThrow(/CARD/u);
    expect(await listVaults()).toHaveLength(0);
  });

  it('rejects a name-dense file as TOO_MANY_ENTITIES without saving a vault', async () => {
    const dense = Array.from({ length: 60 }, (_, index) => `Иванов Иван Иванович ${index}`).join(
      '\n',
    );

    await expect(
      processAnonymize({
        bytes: encoder.encode(dense),
        name: 'dense.txt',
        mime: 'text/plain',
        chatId: 'chat-dense',
        config: { maxPersonTokens: 50 },
      }),
    ).rejects.toMatchObject({
      name: 'RelayError',
      code: 'TOO_MANY_ENTITIES',
      message:
        'Файл содержит слишком много имён или сущностей для обработки. Разбейте его на части.',
    });
    expect(await listVaults()).toHaveLength(0);
  });

  it('restores by vault prefix and by a prefix embedded in the file name', async () => {
    const text = `${PERSON}\n${EMAIL}\n`;
    const masked = await processAnonymize({
      bytes: encoder.encode(text),
      name: 'prefix.txt',
      mime: 'text/plain',
      chatId: 'chat-prefix',
    });

    const byPrefix = await processRestore({
      bytes: masked.maskedBytes,
      name: 'renamed.txt',
      mime: 'text/plain',
      prefix: masked.vaultPrefix,
    });
    expect(decoder.decode(byPrefix.bytes)).toBe(text);

    const taggedName = `[[${masked.vaultPrefix}_PERSON_1]]_renamed.txt`;
    const byName = await processRestore({
      bytes: masked.maskedBytes,
      name: taggedName,
      mime: 'text/plain',
    });
    expect(decoder.decode(byName.bytes)).toBe(text);
  });

  it('restores a clean-named masked file by bytes when no prefix or chat is available', async () => {
    const text = `${PERSON}\n${EMAIL}\n`;
    const masked = await processAnonymize({
      bytes: encoder.encode(text),
      name: 'smoke.txt',
      mime: 'text/plain',
      chatId: 'chat-manual',
    });
    // No PII in the name, so manual mode gets neither a tag prefix nor a chat id.
    expect(masked.maskedName).toBe('smoke.txt');

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: 'smoke.txt',
      mime: 'text/plain',
    });
    expect(decoder.decode(restored.bytes)).toBe(text);
    expect(restored.fileName).toBe('smoke.txt');
    expect(restored.replacements).toBeGreaterThanOrEqual(2);
    expect(restored.unknownTags).toEqual([]);
  });

  it('fails closed when masked bytes match several vaults', async () => {
    // No PII means the masked bytes carry no vault prefix, so both vaults
    // store exactly the same masked content.
    const source = 'no personal data here\n';
    const first = await processAnonymize({
      bytes: encoder.encode(source),
      name: 'first.txt',
      mime: 'text/plain',
      chatId: 'chat-ambiguous-a',
    });
    const second = await processAnonymize({
      bytes: encoder.encode(source),
      name: 'second.txt',
      mime: 'text/plain',
      chatId: 'chat-ambiguous-b',
    });
    expect(first.vaultId).not.toBe(second.vaultId);
    expect([...first.maskedBytes]).toEqual([...second.maskedBytes]);

    await expect(
      processRestore({
        bytes: first.maskedBytes,
        name: 'first.txt',
        mime: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'NO_VAULT' });
  });

  it('rejects masked bytes that match no vault record', async () => {
    await processAnonymize({
      bytes: encoder.encode(`${PERSON}\n`),
      name: 'present.txt',
      mime: 'text/plain',
      chatId: 'chat-no-match',
    });

    await expect(
      processRestore({
        bytes: encoder.encode('unrelated bytes that were never masked here\n'),
        name: 'smoke.txt',
        mime: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'NO_VAULT' });
  });

  it('prefers chat and prefix resolution over the masked-bytes scan', async () => {
    const source = 'no personal data here\n';
    const first = await processAnonymize({
      bytes: encoder.encode(source),
      name: 'first.txt',
      mime: 'text/plain',
      chatId: 'chat-priority-a',
    });
    const second = await processAnonymize({
      bytes: encoder.encode(source),
      name: 'second.txt',
      mime: 'text/plain',
      chatId: 'chat-priority-b',
    });
    expect([...first.maskedBytes]).toEqual([...second.maskedBytes]);

    // The identity scan alone would see two vaults and fail closed.
    await expect(
      processRestore({ bytes: first.maskedBytes, name: 'first.txt', mime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'NO_VAULT' });

    const byChat = await processRestore({
      bytes: first.maskedBytes,
      name: 'first.txt',
      mime: 'text/plain',
      chatId: 'chat-priority-b',
    });
    expect(decoder.decode(byChat.bytes)).toBe(source);

    const byPrefix = await processRestore({
      bytes: first.maskedBytes,
      name: 'first.txt',
      mime: 'text/plain',
      prefix: second.vaultPrefix,
    });
    expect(decoder.decode(byPrefix.bytes)).toBe(source);
  });

  it('masks the file name with the chat vault prefix', async () => {
    const masked = await processAnonymize({
      bytes: encoder.encode(`${PERSON}\n${EMAIL}\n`),
      name: `${PERSON} договор.txt`,
      mime: 'text/plain',
      chatId: 'chat-name',
    });

    expect(masked.maskedName).toContain(`[[${masked.vaultPrefix}_PERSON_1]]`);
    expect(masked.maskedName).not.toContain(PERSON);
    expect(masked.maskedName.endsWith('.txt')).toBe(true);

    const stored = await getVault(masked.vaultId);
    expect(stored?.files[0]?.maskedName).toBe(masked.maskedName);
    expect(stored?.filenameMap).toContainEqual({
      original: `${PERSON} договор.txt`,
      masked: masked.maskedName,
    });

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: 'text/plain',
      chatId: 'chat-name',
    });
    expect(restored.fileName).toBe(`${PERSON} договор.txt`);
  });

  it('round-trips DOCX and reuses the chat vault', async () => {
    const body = `<w:p><w:r><w:t>${PERSON}</w:t></w:r></w:p><w:p><w:r><w:t>${EMAIL}</w:t></w:r></w:p>`;
    const masked = await processAnonymize({
      bytes: minimalDocx(body),
      name: 'letter.docx',
      mime: DOCX_MIME,
      chatId: 'chat-docx',
    });

    const maskedDoc = partText(masked.maskedBytes, 'word/document.xml');
    expect(maskedDoc).not.toContain(PERSON);
    expect(maskedDoc).not.toContain(EMAIL);
    expect(maskedDoc).toContain(`[[${masked.vaultPrefix}_`);

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: DOCX_MIME,
      chatId: 'chat-docx',
    });
    const restoredDoc = partText(restored.bytes, 'word/document.xml');
    expect(restoredDoc).toContain(PERSON);
    expect(restoredDoc).toContain(EMAIL);
    expect(restored.replacements).toBeGreaterThan(0);

    const second = await processAnonymize({
      bytes: minimalDocx(`<w:p><w:r><w:t>${EMAIL}</w:t></w:r></w:p>`),
      name: 'second.docx',
      mime: DOCX_MIME,
      chatId: 'chat-docx',
    });
    expect(second.vaultId).toBe(masked.vaultId);
    expect(second.vaultPrefix).toBe(masked.vaultPrefix);
  });

  it('round-trips XLSX inline strings', async () => {
    const masked = await processAnonymize({
      bytes: minimalXlsx(PERSON),
      name: 'sheet.xlsx',
      mime: XLSX_MIME,
      chatId: 'chat-xlsx',
    });

    const maskedSheet = partText(masked.maskedBytes, 'xl/worksheets/sheet1.xml');
    expect(maskedSheet).not.toContain(PERSON);
    expect(maskedSheet).toContain(`[[${masked.vaultPrefix}_`);

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: XLSX_MIME,
      chatId: 'chat-xlsx',
    });
    const restoredSheet = partText(restored.bytes, 'xl/worksheets/sheet1.xml');
    expect(restoredSheet).toContain(PERSON);
    expect(restored.replacements).toBeGreaterThan(0);
  });

  it('restores clean-named DOCX and XLSX by masked bytes without a chat or prefix', async () => {
    const docx = await processAnonymize({
      bytes: minimalDocx(`<w:p><w:r><w:t>${PERSON}</w:t></w:r></w:p>`),
      name: 'clean.docx',
      mime: DOCX_MIME,
      chatId: 'chat-clean-docx',
    });
    expect(docx.maskedName).toBe('clean.docx');
    const docxVault = await getVault(docx.vaultId);
    expect(docxVault?.files[0]?.maskedSha256).toBeDefined();
    expect(docxVault?.files[0]?.format).toBe('docx');

    const docxRestored = await processRestore({
      bytes: docx.maskedBytes,
      name: 'clean.docx',
      mime: DOCX_MIME,
    });
    expect(partText(docxRestored.bytes, 'word/document.xml')).toContain(PERSON);

    const xlsx = await processAnonymize({
      bytes: minimalXlsx(PERSON),
      name: 'clean.xlsx',
      mime: XLSX_MIME,
      chatId: 'chat-clean-xlsx',
    });
    expect(xlsx.maskedName).toBe('clean.xlsx');
    const xlsxVault = await getVault(xlsx.vaultId);
    expect(xlsxVault?.files[0]?.maskedSha256).toBeDefined();
    expect(xlsxVault?.files[0]?.format).toBe('xlsx');

    const xlsxRestored = await processRestore({
      bytes: xlsx.maskedBytes,
      name: 'clean.xlsx',
      mime: XLSX_MIME,
    });
    expect(partText(xlsxRestored.bytes, 'xl/worksheets/sheet1.xml')).toContain(PERSON);
  });

  it('keeps one vault for all formats in the same chat', async () => {
    const txt = await processAnonymize({
      bytes: encoder.encode(PERSON),
      name: 'a.txt',
      mime: 'text/plain',
      chatId: 'chat-shared',
    });
    const docx = await processAnonymize({
      bytes: minimalDocx(`<w:p><w:r><w:t>${PERSON}</w:t></w:r></w:p>`),
      name: 'b.docx',
      mime: DOCX_MIME,
      chatId: 'chat-shared',
    });
    const xlsx = await processAnonymize({
      bytes: minimalXlsx(PERSON),
      name: 'c.xlsx',
      mime: XLSX_MIME,
      chatId: 'chat-shared',
    });

    expect(new Set([txt.vaultId, docx.vaultId, xlsx.vaultId]).size).toBe(1);
    expect(await listVaults()).toHaveLength(1);
  });
});

describe('processRestoreName', () => {
  it('restores a tagged file name by prefix or chat id', async () => {
    const masked = await processAnonymize({
      bytes: encoder.encode(`${PERSON}\n${EMAIL}\n`),
      name: `${PERSON} договор.txt`,
      mime: 'text/plain',
      chatId: 'chat-restore-name',
    });
    expect(masked.maskedName).toMatch(/\[\[[A-Z0-9]{5}_PERSON_1\]\]/u);
    expect(masked.maskedName).not.toContain(PERSON);

    const byName = await processRestoreName({ name: masked.maskedName });
    expect(byName.fileName).not.toContain('[[');
    expect(byName.fileName).toContain(PERSON);
    expect(byName.replacements).toBe(1);
    expect(byName.unknownTags).toEqual([]);
    expect(byName.warnings).toEqual([]);

    const byPrefix = await processRestoreName({
      name: masked.maskedName,
      prefix: masked.vaultPrefix,
    });
    expect(byPrefix.fileName).toBe(byName.fileName);

    const byChat = await processRestoreName({
      name: masked.maskedName,
      chatId: 'chat-restore-name',
    });
    expect(byChat.fileName).toBe(byName.fileName);
  });

  it('keeps unknown tags and reports them without touching the name', async () => {
    const masked = await processAnonymize({
      bytes: encoder.encode(PERSON),
      name: `${PERSON}.txt`,
      mime: 'text/plain',
      chatId: 'chat-restore-unknown',
    });

    const tagged = `[[${masked.vaultPrefix}_UNKNOWN_9]]_note.txt`;
    const result = await processRestoreName({ name: tagged, chatId: 'chat-restore-unknown' });
    expect(result.fileName).toBe(tagged);
    expect(result.replacements).toBe(0);
    expect(result.unknownTags).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(PERSON);
  });

  it('rejects names without a resolvable vault', async () => {
    await expect(processRestoreName({ name: '[[ZZZZZ_PERSON_1]]_x.txt' })).rejects.toMatchObject({
      code: 'NO_VAULT',
    });
    await expect(processRestoreName({ name: 'plain.txt' })).rejects.toMatchObject({
      code: 'NO_VAULT',
    });
  });

  it('restores a renamed masked file name when no VaultFile record matches', async () => {
    const text = `${PERSON}\n${EMAIL}\n`;
    const masked = await processAnonymize({
      bytes: encoder.encode(text),
      name: 'letter.txt',
      mime: 'text/plain',
      chatId: 'chat-restore-copy',
    });

    const renamed = `[[${masked.vaultPrefix}_PERSON_1]]_copy.txt`;
    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: renamed,
      mime: 'text/plain',
      prefix: masked.vaultPrefix,
    });
    expect(decoder.decode(restored.bytes)).toBe(text);
    expect(restored.fileName).not.toContain('[[');
    expect(restored.fileName).toContain(PERSON);
  });
});

describe('M8: extension-first routing and masked MIME', () => {
  it('selects the adapter by extension before MIME (M8-R1)', () => {
    expect(selectFormatAdapter('data.xml', 'application/json')?.format).toBe('xml');
    expect(selectFormatAdapter('data.json', 'text/markdown')?.format).toBe('json');
    expect(selectFormatAdapter('data.jsonl', 'text/markdown')?.format).toBe('json');
    expect(selectFormatAdapter('data.xml', 'text/markdown')?.format).toBe('xml');
    expect(selectFormatAdapter('data.xml', 'text/plain')?.format).toBe('xml');
    expect(selectFormatAdapter('notes.md', 'text/plain')?.format).toBe('md');
    expect(selectFormatAdapter('page.html', 'text/html')?.format).toBe('html');
    expect(selectFormatAdapter('page.htm', 'application/xhtml+xml')?.format).toBe('html');
    expect(selectFormatAdapter('page.html', 'application/json')?.format).toBe('html');
    expect(selectFormatAdapter('a.data', 'application/json')?.format).toBe('json');
  });

  it('routes .xml sent as application/json to XML and restores it', async () => {
    const source = '<root><name>Иван Петров</name></root>';
    const masked = await processAnonymize({
      bytes: encoder.encode(source),
      name: 'data.xml',
      mime: 'application/json',
      chatId: 'chat-xml-json-mime',
    });

    expect(masked.format).toBe('xml');
    expect(masked.maskedMime).toBe('application/xml');
    expect(decoder.decode(masked.maskedBytes)).not.toContain('Иван Петров');

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: 'application/json',
      chatId: 'chat-xml-json-mime',
    });
    expect(decoder.decode(restored.bytes)).toBe(source);
  });

  it('routes PDF only by .pdf or unknown extension + PDF MIME (M8-R1)', async () => {
    expect(isPdfRoute('report.pdf', 'text/plain')).toBe(true);
    expect(isPdfRoute('report.bin', 'application/pdf')).toBe(true);
    expect(isPdfRoute('data.json', 'application/pdf')).toBe(false);
    expect(isPdfRoute('notes.txt', 'application/pdf')).toBe(false);
    expect(isPdfRoute('data.xml', 'application/pdf')).toBe(false);

    const source = '{"name":"Иван Петров"}';
    const masked = await processAnonymize({
      bytes: encoder.encode(source),
      name: 'data.json',
      mime: 'application/pdf',
      chatId: 'chat-json-pdf-mime',
    });

    expect(masked.format).toBe('json');
    expect(decoder.decode(masked.maskedBytes)).not.toContain('Иван Петров');
  });

  it('routes .json sent as text/markdown to JSON, not Markdown (M8-R1)', async () => {
    const source = '{"name":"Иван Петров"}';
    const masked = await processAnonymize({
      bytes: encoder.encode(source),
      name: 'data.json',
      mime: 'text/markdown',
      chatId: 'chat-json-md-mime',
    });

    expect(masked.format).toBe('json');
    expect(masked.maskedMime).toBe('application/json');
    expect(decoder.decode(masked.maskedBytes)).not.toContain('Иван Петров');
  });

  it('returns application/xml for .xml sent as text/plain (M8-R2)', async () => {
    const masked = await processAnonymize({
      bytes: encoder.encode('<root>ok</root>'),
      name: 'plain.xml',
      mime: 'text/plain',
      chatId: 'chat-xml-plain-mime',
    });

    expect(masked.format).toBe('xml');
    expect(masked.maskedMime).toBe('application/xml');
  });
});

describe('process errors', () => {
  it('rejects unsupported formats and oversized files', async () => {
    expect(selectFormatAdapter('a.pdf', 'application/pdf')).toBeUndefined();
    expect(selectFormatAdapter('a.txt', 'text/plain')?.format).toBe('txt');
    expect(selectFormatAdapter('notes.md', 'text/plain')?.format).toBe('md');
    expect(selectFormatAdapter('data.json', 'application/octet-stream')?.format).toBe('json');
    expect(selectFormatAdapter('data.jsonl', 'application/x-ndjson')?.format).toBe('json');
    expect(selectFormatAdapter('data.xml', 'text/xml')?.format).toBe('xml');
    expect(selectFormatAdapter('report.docx', 'application/octet-stream')?.format).toBe('docx');

    await expect(
      processAnonymize({ bytes: Uint8Array.of(1), name: 'a.pdf', mime: 'application/pdf' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });

    const oversized = new Uint8Array(MAX_FILE_BYTES + 1);
    await expect(
      processAnonymize({ bytes: oversized, name: 'big.txt', mime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'LIMIT' });

    expect(await listVaults()).toEqual([]);
  });

  it('rejects restore without a matching vault', async () => {
    const base = { bytes: encoder.encode('masked'), name: 'x.txt', mime: 'text/plain' };

    await expect(processRestore({ ...base, prefix: 'ZZZZZ' })).rejects.toMatchObject({
      code: 'NO_VAULT',
    });
    await expect(processRestore({ ...base, chatId: 'unknown-chat' })).rejects.toMatchObject({
      code: 'NO_VAULT',
    });
    await expect(processRestore(base)).rejects.toMatchObject({ code: 'NO_VAULT' });
  });
});
