import { describe, expect, it } from 'vitest';
import type { FileInput, Vault } from '../../src/core';
import {
  anonymizeJson,
  anonymizeText,
  anonymizeTxt,
  anonymizeXml,
  createVault,
  detectAll,
  detectCustom,
  findLeaks,
  parseCustomTermLine,
  restoreJson,
  restoreText,
  restoreTxt,
  restoreXml,
} from '../../src/core';
import { expandContainedCustomSpans, type Span } from '../../src/core/detect';
import type { EntityLabel } from '../../src/core/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PREFIX = 'DM7F3';

function txtFile(name: string, bytes: Uint8Array): FileInput {
  return { name, mimeType: 'text/plain', bytes };
}

function deterministicVault(text: string): Vault {
  return createVault(text, { prefix: PREFIX });
}

describe('CUSTOM term labels: parsing', () => {
  it('uses the global label for plain lines and per-line overrides for both arrows', () => {
    expect(parseCustomTermLine('секрет', 'CLIENT')).toEqual({
      term: 'секрет',
      tagLabel: 'CLIENT',
    });
    expect(parseCustomTermLine('  Иванов Иван => CLIENT  ', 'CUSTOM')).toEqual({
      term: 'Иванов Иван',
      tagLabel: 'CLIENT',
    });
    expect(parseCustomTermLine('Проект «Альфа» -> PROJECT', 'CUSTOM')).toEqual({
      term: 'Проект «Альфа»',
      tagLabel: 'PROJECT',
    });
  });

  it('falls back to CUSTOM for an invalid or reserved per-line label', () => {
    expect(parseCustomTermLine('секрет => client', 'CLIENT')).toMatchObject({
      term: 'секрет',
      tagLabel: 'CUSTOM',
      invalidLabel: 'client',
    });
    expect(parseCustomTermLine('секрет => PERSON', 'CLIENT')).toMatchObject({
      term: 'секрет',
      tagLabel: 'CUSTOM',
      invalidLabel: 'PERSON',
    });
    expect(parseCustomTermLine('секрет => CLIENT_', 'CLIENT')).toMatchObject({
      tagLabel: 'CUSTOM',
      invalidLabel: 'CLIENT_',
    });
  });

  it('falls back to CUSTOM for an invalid or reserved global label', () => {
    expect(parseCustomTermLine('секрет', 'person')).toEqual({
      term: 'секрет',
      tagLabel: 'CUSTOM',
    });
    expect(parseCustomTermLine('секрет', 'PERSON')).toEqual({
      term: 'секрет',
      tagLabel: 'CUSTOM',
    });
    expect(parseCustomTermLine('секрет', 'X'.repeat(33))).toEqual({
      term: 'секрет',
      tagLabel: 'CUSTOM',
    });
  });

  it('detects longest-first and keeps the label of the matched line', () => {
    const spans = detectCustom(
      'ООО «Ромашка» и просто Ромашка',
      ['Ромашка => CLIENT', 'ООО «Ромашка» => ORGX'],
      'CUSTOM',
    );
    expect(spans.map((span) => [span.text, span.tagLabel])).toEqual([
      ['ООО «Ромашка»', 'ORGX'],
      ['Ромашка', 'CLIENT'],
    ]);
  });

  it('passes the global label through detectAll', () => {
    const spans = detectAll('Проект Феникс', {
      customTerms: ['Феникс'],
      customLabel: 'CLIENT',
    });
    expect(spans).toMatchObject([{ label: 'CUSTOM', tagLabel: 'CLIENT' }]);
  });
});

describe('CUSTOM term labels: mask/restore', () => {
  it('keeps per-label counters and restores the exact text', () => {
    const source = [
      'Иванов Иван подготовил проект «Альфа».',
      'Петров Пётр, Иванов Иван, проект «Альфа», договор № 42, секрет.',
    ].join('\n');
    const config = {
      customLabel: 'GLOBAL',
      customTerms: [
        'Иванов Иван => CLIENT',
        'Петров Пётр => CLIENT',
        'Проект «Альфа» => PROJECT',
        'договор № 42 => DOC',
        'секрет',
      ],
    };
    const vault = deterministicVault(source);
    const result = detectAll(source, config);
    expect(result.map((span) => span.tagLabel)).toEqual([
      'CLIENT',
      'PROJECT',
      'CLIENT',
      'CLIENT',
      'PROJECT',
      'DOC',
      'GLOBAL',
    ]);

    const masked = anonymizeText(source, config, vault);
    expect(masked.maskedText).toContain('[[DM7F3_CLIENT_1]]');
    expect(masked.maskedText).toContain('[[DM7F3_CLIENT_2]]');
    expect(masked.maskedText).toContain('[[DM7F3_PROJECT_1]]');
    expect(masked.maskedText).toContain('[[DM7F3_DOC_1]]');
    expect(masked.maskedText).toContain('[[DM7F3_GLOBAL_1]]');
    expect(masked.maskedText).not.toContain('Иванов Иван');

    // Two distinct CLIENT terms get CLIENT_1/CLIENT_2; a repeated surface
    // reuses its tag, so restore stays a direct tag -> entity lookup.
    expect(masked.maskedText.match(/\[\[DM7F3_CLIENT_1\]\]/gu)).toHaveLength(2);

    const restored = restoreText(masked.maskedText, vault);
    expect(restored.text).toBe(source);
    expect(restored.replacements).toBe(7);
  });

  it('falls back to CUSTOM for an invalid global label and still restores', () => {
    const source = 'секрет и ещё раз секрет';
    const vault = deterministicVault(source);
    const masked = anonymizeText(source, { customTerms: ['секрет'], customLabel: 'client' }, vault);
    expect(masked.maskedText).toContain('[[DM7F3_CUSTOM_1]]');
    expect(restoreText(masked.maskedText, vault).text).toBe(source);
  });

  it('does not reuse a tag when the same term gets another label', () => {
    const source = 'секрет';
    const vault = deterministicVault(source);

    const first = anonymizeText(source, { customTerms: ['секрет => CLIENT'] }, vault);
    const second = anonymizeText(source, { customTerms: ['секрет => PROJECT'] }, vault);
    expect(first.maskedText).toContain('[[DM7F3_CLIENT_1]]');
    expect(second.maskedText).toContain('[[DM7F3_PROJECT_1]]');
    expect(Object.keys(vault.entities).sort()).toEqual(['CLIENT_1', 'PROJECT_1']);
    expect(restoreText(first.maskedText, vault).text).toBe(source);
    expect(restoreText(second.maskedText, vault).text).toBe(source);
  });

  it('keeps legacy CUSTOM_N tags restorable', () => {
    const vault = deterministicVault('x');
    vault.entities.CUSTOM_1 = {
      label: 'CUSTOM',
      canonical: 'старый термин',
      variants: [],
      count: 1,
    };
    vault.occurrences.push({
      tag: '[[DM7F3_CUSTOM_1]]',
      original: 'старый термин',
    });
    expect(restoreText('[[DM7F3_CUSTOM_1]]', vault).text).toBe('старый термин');
  });
});

describe('CUSTOM term labels: custom prefix inside a longer PERSON', () => {
  const source = 'Иванов Иван Иванович';
  const config = { customTerms: ['Иванов Иван => CLIENT'] };

  it('expands the custom span to the full person and keeps its label', () => {
    const spans = detectAll(source, config);
    expect(spans).toMatchObject([
      {
        label: 'CUSTOM',
        tagLabel: 'CLIENT',
        start: 0,
        end: source.length,
        text: source,
        priority: 99,
      },
    ]);
  });

  it('executes the CUSTOM expansion before the label filter', () => {
    const customOnly = { ...config, labels: new Set<EntityLabel>(['CUSTOM']) };
    // Before the fix `labels: {CUSTOM}` removed the PERSON candidate first, so
    // the custom prefix was not expanded and `Иванович` stayed in plaintext.
    const spans = detectAll(source, customOnly);
    expect(spans).toMatchObject([
      { label: 'CUSTOM', tagLabel: 'CLIENT', start: 0, end: source.length, text: source },
    ]);

    const vault = deterministicVault(source);
    const masked = anonymizeText(source, customOnly, vault);
    expect(masked.maskedText).toBe('[[DM7F3_CLIENT_1]]');
    expect(masked.maskedText).not.toContain('Иванович');
    expect(findLeaks(masked.maskedText, customOnly)).toEqual([]);
    expect(restoreText(masked.maskedText, vault).text).toBe(source);
  });

  it('lets the allowlist win over the custom rule and its expansion', () => {
    const customOnly = { ...config, labels: new Set<EntityLabel>(['CUSTOM']) };
    // Either allowlisting the configured term or the expanded full name is the
    // user's explicit opt-out; no partial custom mask is produced.
    expect(detectAll(source, { ...customOnly, allowlist: ['Иванов Иван'] })).toEqual([]);
    expect(detectAll(source, { ...customOnly, allowlist: [source] })).toEqual([]);

    const vault = deterministicVault(source);
    const masked = anonymizeText(source, { ...customOnly, allowlist: [source] }, vault);
    expect(masked.maskedText).toBe(source);
  });

  it('masks the entire name and the leak guard sees no patronymic', () => {
    const vault = deterministicVault(source);
    const masked = anonymizeText(source, config, vault);
    expect(masked.maskedText).toBe('[[DM7F3_CLIENT_1]]');
    expect(masked.maskedText).not.toContain('Иванович');
    expect(findLeaks(masked.maskedText, config)).toEqual([]);
    expect(restoreText(masked.maskedText, vault).text).toBe(source);
  });

  it('TXT, JSON and XML mask the full name as CLIENT_1 and restore exactly', async () => {
    const vault = deterministicVault(source);
    const txt = await anonymizeTxt(txtFile('full.txt', encoder.encode(source)), {
      vault,
      maxBytes: 1_000_000,
      config,
    });
    const txtMasked = decoder.decode(txt.maskedBytes);
    expect(txtMasked).toBe('[[DM7F3_CLIENT_1]]');
    expect(findLeaks(txtMasked, config)).toEqual([]);
    const txtRestored = await restoreTxt(txtFile('full.txt', txt.maskedBytes), vault);
    expect(decoder.decode(txtRestored.bytes)).toBe(source);

    const json = JSON.stringify({ name: source }, null, 2);
    const jsonResult = await anonymizeJson(
      { name: 'person.json', mimeType: 'application/json', bytes: encoder.encode(json) },
      { vault, maxBytes: 1_000_000, config },
    );
    const jsonMasked = decoder.decode(jsonResult.maskedBytes);
    expect(jsonMasked).toContain('[[DM7F3_CLIENT_1]]');
    expect(jsonMasked).not.toContain('Иванович');
    expect(findLeaks(jsonMasked, config)).toEqual([]);
    const jsonRestored = await restoreJson(
      { name: 'person.json', mimeType: 'application/json', bytes: jsonResult.maskedBytes },
      vault,
    );
    expect(decoder.decode(jsonRestored.bytes)).toBe(json);

    const xml = `<root><name>${source}</name></root>`;
    const xmlResult = await anonymizeXml(
      { name: 'person.xml', mimeType: 'application/xml', bytes: encoder.encode(xml) },
      { vault, maxBytes: 1_000_000, config },
    );
    const xmlMasked = decoder.decode(xmlResult.maskedBytes);
    expect(xmlMasked).toContain('[[DM7F3_CLIENT_1]]');
    expect(xmlMasked).not.toContain('Иванович');
    expect(findLeaks(xmlMasked, config)).toEqual([]);
    const xmlRestored = await restoreXml(
      { name: 'person.xml', mimeType: 'application/xml', bytes: xmlResult.maskedBytes },
      vault,
    );
    expect(decoder.decode(xmlRestored.bytes)).toBe(xml);
  });
});

describe('CUSTOM expansion: interval index', () => {
  const text = '0123456789abcdefghijklmnopqrstuvwxyz';

  function syntheticSpan(label: EntityLabel, start: number, end: number): Span {
    return {
      label,
      start,
      end,
      text: text.slice(start, end),
      priority: label === 'CUSTOM' ? 99 : 80,
      ruleId: 'test',
    };
  }

  it('picks the longest containing PERSON and ignores partial overlaps', () => {
    const custom = syntheticSpan('CUSTOM', 5, 10);
    const spans = expandContainedCustomSpans(text, [
      syntheticSpan('PERSON', 0, 7), // ends before the custom span ends
      syntheticSpan('PERSON', 6, 20), // starts inside the custom span
      syntheticSpan('PERSON', 0, 12), // contains, length 12
      syntheticSpan('PERSON', 1, 14), // contains, length 13: wins
      custom,
      syntheticSpan('PERSON', 5, 10), // same length: not an expansion
    ]);

    expect(spans[4]).toMatchObject({
      label: 'CUSTOM',
      start: 1,
      end: 14,
      text: text.slice(1, 14),
      priority: 99,
    });
  });

  it('keeps the first PERSON on an equal-length tie', () => {
    const custom = syntheticSpan('CUSTOM', 5, 10);
    const spans = expandContainedCustomSpans(text, [
      syntheticSpan('PERSON', 0, 15),
      syntheticSpan('PERSON', 1, 16),
      custom,
    ]);

    expect(spans[2]).toMatchObject({ label: 'CUSTOM', start: 0, end: 15 });
  });

  it('handles nested PERSON spans and leaves non-containing terms alone', () => {
    const nested = syntheticSpan('CUSTOM', 6, 12);
    const outside = syntheticSpan('CUSTOM', 31, 35);
    const spans = expandContainedCustomSpans(text, [
      syntheticSpan('PERSON', 0, 30),
      syntheticSpan('PERSON', 2, 26),
      syntheticSpan('PERSON', 4, 20),
      nested,
      outside,
    ]);

    expect(spans[3]).toMatchObject({ start: 0, end: 30, text: text.slice(0, 30) });
    expect(spans[4]).toEqual(outside);
  });

  it('returns the candidates unchanged when there is no PERSON or no CUSTOM', () => {
    const custom = syntheticSpan('CUSTOM', 5, 10);
    expect(expandContainedCustomSpans(text, [custom])).toEqual([custom]);

    const person = syntheticSpan('PERSON', 0, 15);
    expect(expandContainedCustomSpans(text, [person])).toEqual([person]);
  });

  it('expands several custom terms under labels={CUSTOM} and keeps counters/restore', () => {
    const source = 'Иванов Иван Иванович, Петров Пётр Петрович и снова Иванов Иван.';
    const customOnly = {
      customTerms: ['Иванов Иван => CLIENT', 'Петров Пётр => PROJECT'],
      labels: new Set<EntityLabel>(['CUSTOM']),
    };

    const spans = detectAll(source, customOnly);
    expect(spans.map((span) => [span.tagLabel, span.text])).toEqual([
      ['CLIENT', 'Иванов Иван Иванович'],
      ['PROJECT', 'Петров Пётр Петрович'],
      ['CLIENT', 'Иванов Иван'],
    ]);

    const vault = deterministicVault(source);
    const masked = anonymizeText(source, customOnly, vault);
    expect(masked.maskedText).toBe(
      '[[DM7F3_CLIENT_1]], [[DM7F3_PROJECT_1]] и снова [[DM7F3_CLIENT_2]].',
    );
    expect(Object.keys(vault.entities).sort()).toEqual(['CLIENT_1', 'CLIENT_2', 'PROJECT_1']);
    expect(vault.entities.CLIENT_1).toMatchObject({ label: 'CUSTOM', count: 1 });
    expect(vault.entities.CLIENT_2).toMatchObject({ label: 'CUSTOM', count: 1 });
    expect(vault.entities.PROJECT_1).toMatchObject({ label: 'CUSTOM', count: 1 });
    expect(restoreText(masked.maskedText, vault).text).toBe(source);
  });
});

describe('CUSTOM term labels: format adapters', () => {
  const source = 'Иванов Иван, проект «Альфа», договор № 42, секрет';
  const config = {
    customLabel: 'GLOBAL',
    customTerms: [
      'Иванов Иван => CLIENT',
      'Проект «Альфа» => PROJECT',
      'договор № 42 => DOC',
      'секрет',
    ],
  };

  it('TXT mask/restore is byte-exact', async () => {
    const vault = deterministicVault(source);
    const result = await anonymizeTxt(txtFile('note.txt', encoder.encode(source)), {
      vault,
      maxBytes: 1_000_000,
      config,
    });
    const masked = decoder.decode(result.maskedBytes);
    expect(masked).toContain('[[DM7F3_CLIENT_1]]');
    expect(masked).toContain('[[DM7F3_PROJECT_1]]');
    expect(masked).toContain('[[DM7F3_DOC_1]]');
    expect(masked).toContain('[[DM7F3_GLOBAL_1]]');

    const restored = await restoreTxt(txtFile('note.txt', result.maskedBytes), vault);
    expect(decoder.decode(restored.bytes)).toBe(source);
  });

  it('JSON mask/restore is byte-exact', async () => {
    const json = JSON.stringify(
      {
        client: 'Иванов Иван',
        project: 'Проект «Альфа»',
        document: 'договор № 42',
        note: 'секрет',
      },
      null,
      2,
    );
    const vault = deterministicVault(json);
    const result = await anonymizeJson(
      { name: 'data.json', mimeType: 'application/json', bytes: encoder.encode(json) },
      { vault, maxBytes: 1_000_000, config },
    );
    const masked = decoder.decode(result.maskedBytes);
    expect(masked).toContain('[[DM7F3_CLIENT_1]]');
    expect(masked).toContain('[[DM7F3_PROJECT_1]]');
    expect(() => JSON.parse(masked)).not.toThrow();

    const restored = await restoreJson(
      { name: 'data.json', mimeType: 'application/json', bytes: result.maskedBytes },
      vault,
    );
    expect(decoder.decode(restored.bytes)).toBe(json);
  });

  it('XML mask/restore is byte-exact in text and attributes', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<root client="Иванов Иван" project="Проект «Альфа»">',
      '  <document>договор № 42</document>',
      '  <note>секрет</note>',
      '</root>',
    ].join('\n');
    const vault = deterministicVault(xml);
    const result = await anonymizeXml(
      { name: 'data.xml', mimeType: 'application/xml', bytes: encoder.encode(xml) },
      { vault, maxBytes: 1_000_000, config },
    );
    const masked = decoder.decode(result.maskedBytes);
    expect(masked).toContain('[[DM7F3_CLIENT_1]]');
    expect(masked).toContain('[[DM7F3_PROJECT_1]]');

    const restored = await restoreXml(
      { name: 'data.xml', mimeType: 'application/xml', bytes: result.maskedBytes },
      vault,
    );
    expect(decoder.decode(restored.bytes)).toBe(xml);
  });
});
