import { describe, expect, it } from 'vitest';
import type { FileInput, Vault } from '../../src/core';
import { anonymizeJson, anonymizeXml, createVault, restoreJson, restoreXml } from '../../src/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fileOf(name: string, mimeType: string, bytes: Uint8Array): FileInput {
  return { name, mimeType, bytes };
}

async function restoreJsonText(name: string, result: { maskedBytes: Uint8Array }, vault: Vault) {
  const restored = await restoreJson(fileOf(name, 'application/json', result.maskedBytes), vault);
  return decoder.decode(restored.bytes);
}

async function restoreXmlText(name: string, result: { maskedBytes: Uint8Array }, vault: Vault) {
  const restored = await restoreXml(fileOf(name, 'application/xml', result.maskedBytes), vault);
  return decoder.decode(restored.bytes);
}

describe('R15-RESTORE: occurrence scope and sequential restore order', () => {
  it('JSON restores repeated tag case variants node by node', async () => {
    const source = '{"a":"ivan@example.ru","b":"IVAN@example.ru"}';
    const vault = createVault(source);
    const result = await anonymizeJson(
      fileOf('case.json', 'application/json', encoder.encode(source)),
      {
        vault,
        maxBytes: 1_000_000,
      },
    );
    const masked = decoder.decode(result.maskedBytes);

    // Both nodes share one tag; before R15-RESTORE the second node replayed
    // the first occurrence (lowercase) because queues were rebuilt per node.
    const tag = masked.match(/\[\[[A-Z0-9]{5}_EMAIL_1\]\]/u)?.[0];
    expect(tag).toBeDefined();
    expect(masked.split(tag as string)).toHaveLength(3);
    expect(await restoreJsonText('case.json', result, vault)).toBe(source);
  });

  it('XML restores person oblique forms node by node', async () => {
    const source = '<root><a>Иванов Иван Иванович</a><b>Иванову Ивану Ивановичу</b></root>';
    const vault = createVault(source);
    const result = await anonymizeXml(
      fileOf('person.xml', 'application/xml', encoder.encode(source)),
      {
        vault,
        maxBytes: 1_000_000,
      },
    );
    const masked = decoder.decode(result.maskedBytes);

    const tag = masked.match(/\[\[[A-Z0-9]{5}_PERSON_1\]\]/u)?.[0];
    expect(tag).toBeDefined();
    expect(masked.split(tag as string)).toHaveLength(3);
    expect(await restoreXmlText('person.xml', result, vault)).toBe(source);
  });

  it('restores two files in one vault from their own occurrence ranges', async () => {
    const vault = createVault('');
    const first = '{"email":"ivan@example.ru","n":1}';
    const second = '{"email":"IVAN@example.ru","n":2}';

    const firstResult = await anonymizeJson(
      fileOf('first.json', 'application/json', encoder.encode(first)),
      { vault, maxBytes: 1_000_000 },
    );
    const secondResult = await anonymizeJson(
      fileOf('second.json', 'application/json', encoder.encode(second)),
      { vault, maxBytes: 1_000_000 },
    );

    expect(vault.files[0]?.occurrenceStart).toBe(0);
    expect(vault.files[0]?.occurrenceCount).toBe(1);
    expect(vault.files[1]?.occurrenceStart).toBe(1);
    expect(vault.files[1]?.occurrenceCount).toBe(1);

    // Same tag in both files: without a file scope the second file replayed
    // the first file's lowercase surface.
    expect(decoder.decode(firstResult.maskedBytes)).toContain('_EMAIL_1');
    expect(decoder.decode(secondResult.maskedBytes)).toContain('_EMAIL_1');
    expect(await restoreJsonText('first.json', firstResult, vault)).toBe(first);
    expect(await restoreJsonText('second.json', secondResult, vault)).toBe(second);
  });

  it('XML restores text and attribute values in source order', async () => {
    const source = '<root contact="IVAN@example.ru">ivan@example.ru</root>';
    const vault = createVault(source);
    const result = await anonymizeXml(
      fileOf('order.xml', 'application/xml', encoder.encode(source)),
      {
        vault,
        maxBytes: 1_000_000,
      },
    );
    const masked = decoder.decode(result.maskedBytes);

    // The attribute carries the first surface in source order, but masking
    // visits text nodes first; positions must reorder the shared queue.
    expect(masked).toMatch(
      /^<root contact="\[\[[A-Z0-9]{5}_EMAIL_1\]\]">\[\[[A-Z0-9]{5}_EMAIL_1\]\]<\/root>$/u,
    );
    expect(await restoreXmlText('order.xml', result, vault)).toBe(source);
  });

  it('falls back to the global occurrence list for legacy file records', async () => {
    const source = '{"a":"ivan@example.ru","b":"IVAN@example.ru"}';
    const vault = createVault(source);
    const result = await anonymizeJson(
      fileOf('legacy.json', 'application/json', encoder.encode(source)),
      {
        vault,
        maxBytes: 1_000_000,
      },
    );

    const record = vault.files[0];
    expect(record).toBeDefined();
    if (record) {
      delete record.occurrenceStart;
      delete record.occurrenceCount;
    }

    expect(await restoreJsonText('legacy.json', result, vault)).toBe(source);
  });
});
