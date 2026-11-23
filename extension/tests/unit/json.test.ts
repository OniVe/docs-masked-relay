import { describe, expect, it } from 'vitest';
import type { AnonymizeResult, FileInput, Vault } from '../../src/core';
import {
  anonymizeJson,
  createVault,
  decodeTextBytes,
  encodeTextBytes,
  jsonFormatAdapter,
  LeakGuardError,
  restoreJson,
} from '../../src/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fileOf(name: string, bytes: Uint8Array, mimeType = 'application/json'): FileInput {
  return { name, mimeType, bytes };
}

interface RoundTrip {
  result: AnonymizeResult;
  masked: string;
  restored: string;
  restoredBytes: Uint8Array;
  sourceBytes: Uint8Array;
  vault: Vault;
}

async function roundTrip(
  name: string,
  source: string,
  options: { bom?: boolean; mimeType?: string } = {},
): Promise<RoundTrip> {
  const body = encoder.encode(source);
  const sourceBytes = options.bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body;
  const vault = createVault(source);
  const file = fileOf(name, sourceBytes, options.mimeType);

  const result = await anonymizeJson(file, { vault, maxBytes: 1_000_000 });
  const masked = decoder.decode(result.maskedBytes);
  const restored = await restoreJson(fileOf(name, result.maskedBytes, options.mimeType), vault);

  return {
    result,
    masked,
    restored: decoder.decode(restored.bytes),
    restoredBytes: restored.bytes,
    sourceBytes,
    vault,
  };
}

describe('JSON adapter', () => {
  it('masks nested values and keys while leaving literals and numbers intact', async () => {
    const source = JSON.stringify(
      {
        'ivan@example.ru': 'Иван Петров',
        nested: { phone: '+7 916 123-45-67', active: true, count: 42, none: null },
        items: ['test@example.ru', 7, false],
      },
      null,
      2,
    );

    const { masked, restored, result } = await roundTrip('data.json', source);

    expect(masked).not.toContain('Иван Петров');
    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).not.toContain('test@example.ru');
    expect(masked).not.toContain('+7 916 123-45-67');
    expect(masked).toContain('"active": true');
    expect(masked).toContain('"count": 42');
    expect(masked).toContain('"none": null');
    expect(masked).toContain('"items"');
    expect(() => JSON.parse(masked)).not.toThrow();
    expect(result.format).toBe('json');
    expect(result.maskedMime).toBe('application/json');
    expect(result.entities.map((entity) => entity.label)).toEqual(
      expect.arrayContaining(['PERSON', 'EMAIL', 'PHONE']),
    );
    expect(restored).toBe(source);
  });

  it('masks a property key and restores it exactly', async () => {
    const source = '{"ivan@example.ru":1,"ok":2}';
    const { masked, restored, result } = await roundTrip('key.json', source);

    expect(masked).toBe(`{"[[${result.vaultPrefix}_EMAIL_1]]":1,"ok":2}`);
    expect(restored).toBe(source);
  });

  it('masks a full name with a city-homonym first name and split name fields', async () => {
    const source = JSON.stringify(
      {
        name: 'Иванов Владимир Иванович',
        person: { first: 'Владимир', last: 'Иванов', middle: 'Иванович' },
      },
      null,
      2,
    );

    const { masked, restored, result } = await roundTrip('city-name.json', source);

    expect(masked).not.toContain('Владимир');
    expect(masked).not.toContain('Иванов');
    expect(result.entities.filter((entity) => entity.label === 'PERSON')).not.toHaveLength(0);
    expect(restored).toBe(source);
  });

  it('keeps indentation and escapes outside replaced strings, and normalizes only masked values', async () => {
    const source =
      '{\n  "name": "\\u0418\\u0432\\u0430\\u043d \\u041f\\u0435\\u0442\\u0440\\u043e\\u0432",\n  "note": "a\\nb",\n  "unchanged": "ok"\n}';

    const { masked, restored } = await roundTrip('escapes.json', source);

    expect(masked).toContain('\n  "note": "a\\nb",\n');
    expect(masked).toContain('\n  "unchanged": "ok"\n');
    expect(masked).not.toContain('\\u0418');
    expect(JSON.parse(restored)).toEqual(JSON.parse(source));
    expect(restored).toContain('"note": "a\\nb"');
  });

  it('rejects invalid strict JSON without mutating the vault', async () => {
    for (const source of ['{a:1}', '// comment\n{"a":1}', '{"a":1,}', '{"a":1} trailing', '']) {
      const vault = createVault(source);
      await expect(
        anonymizeJson(fileOf('bad.json', encoder.encode(source)), { vault, maxBytes: 1_000_000 }),
      ).rejects.toThrow(/JSON/u);
      expect(vault.occurrences).toHaveLength(0);
      expect(vault.files).toHaveLength(0);
    }
  });

  it('rolls the in-place vault back when a later string trips LeakGuard', async () => {
    const source = '{"phone":"+79161234567","email":"ivan@example.ru"}';
    const vault = createVault(source);
    await expect(
      anonymizeJson(fileOf('partial.json', encoder.encode(source)), {
        vault,
        maxBytes: 1_000_000,
        config: { labels: new Set(['PHONE'] as const) },
      }),
    ).rejects.toThrow(LeakGuardError);
    expect(vault.occurrences).toHaveLength(0);
    expect(vault.entities).toEqual({});
    expect(vault.files).toHaveLength(0);
  });

  it('parses every non-empty JSONL line, never masks numbers and preserves CRLF', async () => {
    const source =
      '{"name":"Иван Петров"}\r\n\r\n{"email":"ivan@example.ru"}\r\n{"count":7,"ok":false}\r\n';

    const { masked, restored, result } = await roundTrip('events.jsonl', source, {
      mimeType: 'application/x-ndjson',
    });

    expect(masked).not.toContain('Иван Петров');
    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).toContain('\r\n\r\n');
    expect(masked).toContain('{"count":7,"ok":false}');
    for (const line of masked.split(/\r\n/u)) {
      if (line.length > 0) expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(result.maskedMime).toBe('application/x-ndjson');
    expect(restored).toBe(source);
  });

  it('rejects a JSONL file when any line is invalid', async () => {
    const source = '{"a":1}\n{bad}\n';
    const vault = createVault(source);

    await expect(
      anonymizeJson(fileOf('bad.jsonl', encoder.encode(source)), {
        vault,
        maxBytes: 1_000_000,
      }),
    ).rejects.toThrow(/line 2|strict JSON/u);
    expect(vault.occurrences).toHaveLength(0);
  });

  it('preserves UTF-8 BOM and CRLF on restore', async () => {
    const source = '{\r\n  "name": "Иван Петров"\r\n}\r\n';
    const { result, masked, restoredBytes, sourceBytes } = await roundTrip('bom.json', source, {
      bom: true,
    });

    expect(result.maskedBytes[0]).not.toBe(0xef);
    expect(masked).not.toContain('\uFEFF');
    expect(masked).toContain('\r\n');
    expect(restoredBytes).toEqual(sourceBytes);
  });

  it('round-trips UTF-16LE input back to UTF-16LE with BOM', async () => {
    const source = '{"name":"Иван Петров","n":7}';
    const sourceBytes = encodeTextBytes(source, 'utf-16le', true);
    const vault = createVault(source);

    const masked = await anonymizeJson(fileOf('utf16.json', sourceBytes), {
      vault,
      maxBytes: 1_000_000,
    });
    const maskedText = decoder.decode(masked.maskedBytes);
    expect(maskedText).not.toContain('Иван Петров');

    const restored = await restoreJson(fileOf('utf16.json', masked.maskedBytes), vault);
    expect(restored.bytes).toEqual(sourceBytes);
    expect(decodeTextBytes(restored.bytes, 'utf-16le', true)).toBe(source);
  });

  it('fails closed on numeric PII and leaves the vault untouched', async () => {
    const cases = [
      ['{"card":4111111111111111}', /CARD/u],
      ['{"card":4.111111111111111E+15}', /CARD/u],
      ['{"phone":79001234567}', /PHONE/u],
      ['{"inn":7707083893}', /INN/u],
      ['{"snils":11223344595}', /SNILS/u],
    ] as const;

    for (const [source, label] of cases) {
      const vault = createVault(source);
      await expect(
        anonymizeJson(fileOf('number.json', encoder.encode(source)), {
          vault,
          maxBytes: 1_000_000,
        }),
      ).rejects.toThrow(label);
      expect(vault.occurrences).toHaveLength(0);
      expect(vault.entities).toEqual({});
      expect(vault.files).toHaveLength(0);
    }
  });

  it('masks a numeric identifier stored as a JSON string', async () => {
    const source = '{"card":"4111111111111111"}';
    const { masked, restored } = await roundTrip('card-string.json', source);

    expect(masked).not.toContain('4111111111111111');
    expect(restored).toBe(source);
  });

  it('leaves unknown tags untouched and reports them', async () => {
    const source = '{"name":"[[ZZZZZ_PERSON_1]]"}';
    const vault = createVault('');
    const restored = await restoreJson(fileOf('unknown.json', encoder.encode(source)), vault);

    expect(decoder.decode(restored.bytes)).toBe(source);
    expect(restored.unknownTags).toEqual(['[[ZZZZZ_PERSON_1]]']);
    expect(restored.warnings[0]).toMatch(/unknown tag/u);
  });

  it('enforces the nesting limit', async () => {
    const allowed = `${'['.repeat(200)}0${']'.repeat(200)}`;
    const allowedVault = createVault(allowed);
    await expect(
      anonymizeJson(fileOf('deep-ok.json', encoder.encode(allowed)), {
        vault: allowedVault,
        maxBytes: 1_000_000,
      }),
    ).resolves.toMatchObject({ format: 'json' });

    const deep = `${'['.repeat(201)}0${']'.repeat(201)}`;
    const vault = createVault(deep);
    await expect(
      anonymizeJson(fileOf('deep.json', encoder.encode(deep)), {
        vault,
        maxBytes: 1_000_000,
      }),
    ).rejects.toThrow(/nesting limit/u);
  });

  it('enforces the configured byte limit', async () => {
    const source = '{"name":"Иван Петров"}';
    const vault = createVault(source);
    await expect(
      anonymizeJson(fileOf('big.json', encoder.encode(source)), { vault, maxBytes: 4 }),
    ).rejects.toThrow(/limit/u);
  });

  it('restores mixed line endings byte-exactly when nothing was masked (M8-M1)', async () => {
    const source = '{\r\n  "a": 1,\n  "b": 2\r\n}\r\n';
    const { result, restoredBytes, sourceBytes } = await roundTrip('mixed-eol.json', source);

    expect(result.maskedMime).toBe('application/json');
    expect(restoredBytes).toEqual(sourceBytes);
  });

  it('masks split first/last object values as person parts (M8-2)', async () => {
    const source = '{"first":"Иван","last":"Петров"}';
    const { masked, restored } = await roundTrip('person-split.json', source);

    expect(masked).not.toContain('Иван');
    expect(masked).not.toContain('Петров');
    expect(() => JSON.parse(masked)).not.toThrow();
    expect(Object.keys(JSON.parse(masked) as Record<string, unknown>)).toEqual(['first', 'last']);
    expect(restored).toBe(source);
  });

  it('masks split name parts in nested records and restores them exactly', async () => {
    const source =
      '{"people":[{"first_name":"Иван","last_name":"Петров"},{"first":"Анна","last":"Сидорова"}]}';
    const { masked, restored } = await roundTrip('people-split.json', source);

    expect(masked).not.toContain('Иван');
    expect(masked).not.toContain('Петров');
    expect(masked).not.toContain('Анна');
    expect(masked).not.toContain('Сидорова');
    expect(restored).toBe(source);
  });

  it('masks lone/interleaved name-context values but not unrelated ones (M8R2-N2)', async () => {
    const lone = '{"name":"Иван"}';
    const loneResult = await roundTrip('lone.json', lone);
    expect(loneResult.masked).not.toContain('"Иван"');
    expect(loneResult.restored).toBe(lone);

    const interleaved = '{"first":"Иван","age":30,"last":"Петров"}';
    const interleavedResult = await roundTrip('interleaved.json', interleaved);
    expect(interleavedResult.masked).not.toContain('Иван');
    expect(interleavedResult.masked).not.toContain('Петров');
    expect(interleavedResult.restored).toBe(interleaved);

    const unrelated = '{"first":"Север","last":"Юг"}';
    const unrelatedResult = await roundTrip('not-person.json', unrelated);
    expect(unrelatedResult.masked).toContain('"Север"');
    expect(unrelatedResult.masked).toContain('"Юг"');

    const notNameContext = '{"nick":"Иван"}';
    const nickResult = await roundTrip('nick.json', notNameContext);
    expect(nickResult.masked).toContain('"Иван"');
  });

  it('masks role-aware names across levels, arrays and any order (M8-2)', async () => {
    const source = [
      '{"middle":"Сергеевич","first":"Иван","last":"Петров",',
      ' "age":30,"meta":{"lastName":"Петров","note":"ok"},',
      ' "people":[{"first":"Иван"},{"last":"Петров"}],',
      ' "name":"Иван Петров",',
      ' "firstName":"Ivan","lastName":"Petrov",',
      ' "city":"New York","org":"Open AI","count":7,"flag":true,"nick":"Иван"}',
    ].join('\n');
    const { masked, restored } = await roundTrip('role-aware.json', source);

    for (const pair of [
      '"first":"Иван"',
      '"last":"Петров"',
      '"middle":"Сергеевич"',
      '"lastName":"Петров"',
      '"firstName":"Ivan"',
      '"lastName":"Petrov"',
    ]) {
      expect(masked).not.toContain(pair);
    }
    expect(masked).not.toContain('"Иван Петров"');
    expect(masked).toContain('"city":"New York"');
    expect(masked).toContain('"org":"Open AI"');
    expect(masked).toContain('"count":7');
    expect(masked).toContain('"flag":true');
    expect(masked).toContain('"nick":"Иван"');
    expect(restored).toBe(source);
  });

  it('rejects long digit strings with a LeakGuard error (fail-closed, M8-3)', async () => {
    const vault = createVault('');
    await expect(
      anonymizeJson(fileOf('digits.json', encoder.encode('{"id":"123456789"}')), {
        vault,
        maxBytes: 1_000_000,
      }),
    ).rejects.toThrow(/LeakGuard/u);
    expect(vault.occurrences).toHaveLength(0);

    // Numeric JSON values are not converted; ordinary timestamps stay valid.
    const numeric = await anonymizeJson(
      fileOf('timestamp.json', encoder.encode('{"ts":1700000000}')),
      { vault: createVault(''), maxBytes: 1_000_000 },
    );
    expect(decoder.decode(numeric.maskedBytes)).toBe('{"ts":1700000000}');
  });

  it('documents semantic escape exactness on restore (M8-5)', async () => {
    const source =
      '{"name":"\\u0418\\u0432\\u0430\\u043d \\u041f\\u0435\\u0442\\u0440\\u043e\\u0432","note":"a\\nb"}';
    const { restored } = await roundTrip('escapes-exact.json', source);

    expect(restored).toContain('"name":"Иван Петров"');
    expect(restored).toContain('"note":"a\\nb"');
    expect(JSON.parse(restored)).toEqual(JSON.parse(source));
  });

  it('routes JSON and JSONL shapes', () => {
    expect(jsonFormatAdapter.format).toBe('json');
    expect(
      jsonFormatAdapter.canHandle({ name: 'a.json', mimeType: 'application/octet-stream' }),
    ).toBe(true);
    expect(jsonFormatAdapter.canHandle({ name: 'a.jsonl', mimeType: 'text/plain' })).toBe(true);
    expect(jsonFormatAdapter.canHandle({ name: 'a.ndjson', mimeType: 'text/plain' })).toBe(true);
    expect(jsonFormatAdapter.canHandle({ name: 'a.data', mimeType: 'application/x-ndjson' })).toBe(
      true,
    );
    expect(jsonFormatAdapter.canHandle({ name: 'a.txt', mimeType: 'text/plain' })).toBe(false);
  });
});
