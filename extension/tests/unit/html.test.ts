import { describe, expect, it } from 'vitest';
import type { AnonymizeResult, FileInput, Vault } from '../../src/core';
import {
  anonymizeHtml,
  createVault,
  decodeTextBytes,
  encodeTextBytes,
  htmlFormatAdapter,
  restoreHtml,
} from '../../src/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const PERSON = 'Иван Петров';
const EMAIL = 'ivan@example.ru';
const PHONE = '+7 916 123-45-67';

function fileOf(name: string, bytes: Uint8Array, mimeType = 'text/html'): FileInput {
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
  options: { mimeType?: string } = {},
): Promise<RoundTrip> {
  const sourceBytes = encoder.encode(source);
  const vault = createVault(source);
  const file = fileOf(name, sourceBytes, options.mimeType);

  const result = await anonymizeHtml(file, { vault, maxBytes: 1_000_000 });
  const masked = decoder.decode(result.maskedBytes);
  const restored = await restoreHtml(fileOf(name, result.maskedBytes, options.mimeType), vault);

  return {
    result,
    masked,
    restored: decoder.decode(restored.bytes),
    restoredBytes: restored.bytes,
    sourceBytes,
    vault,
  };
}

describe('HTML adapter', () => {
  it('masks text, attributes, comments, CDATA and raw-text elements while keeping markup', async () => {
    const source = [
      '<!DOCTYPE html>',
      '<html lang="ru">',
      '<head>',
      `  <title>${PERSON}</title>`,
      `  <style>/* ${PERSON} */ body { color: red; }</style>`,
      `  <script>const owner = "${EMAIL}"; const cmp = 1 < 2;</script>`,
      '</head>',
      `<body data-owner="${PERSON}" data-email=${EMAIL}>`,
      `  <!-- ${PERSON} ${EMAIL} -->`,
      `  <p title='${PERSON}'>Телефон: ${PHONE}</p>`,
      `  <textarea>${PERSON}</textarea>`,
      `  <![CDATA[${PERSON}]]>`,
      '</body>',
      '</html>',
      '',
    ].join('\n');

    const { masked, restored, result } = await roundTrip('page.html', source);

    for (const value of [PERSON, EMAIL, PHONE]) {
      expect(masked).not.toContain(value);
    }
    expect(masked).toContain('<!DOCTYPE html>');
    expect(masked).toContain('<html lang="ru">');
    expect(masked).toContain(`<title>[[`);
    expect(masked).toContain('<style>/* [[');
    expect(masked).toMatch(/<script>const owner = "\[\[[A-Z0-9]{5}_EMAIL_1\]\]"/u);
    expect(masked).toContain('const cmp = 1 < 2;');
    expect(masked).toContain('data-owner="[[');
    expect(masked).toContain('data-email=[[');
    expect(masked).toContain('<!-- [[');
    expect(masked).toContain("<p title='[[");
    expect(masked).toContain('<textarea>[[');
    expect(masked).toContain('<![CDATA[[[');
    expect(result.format).toBe('html');
    expect(result.entities.map((entity) => entity.label)).toEqual(
      expect.arrayContaining(['PERSON', 'EMAIL', 'PHONE']),
    );
    expect(restored).toBe(source);
  });

  it('leaves a no-PII document byte-identical (mixed content, < in text and attributes)', async () => {
    const source = [
      '<!DOCTYPE html>',
      '<html><head><meta charset="utf-8"><title>Notes</title></head>',
      '<body class="page" data-note="a<b">',
      '  <p>1 < 2 and 2 > 1; AT&T &amp; friends.</p>',
      '  <script>if (1 < 2) { console.log("ok"); }</script>',
      '</body></html>',
      '',
    ].join('\r\n');

    const { masked, maskedBytes, restoredBytes, sourceBytes, result } = await (async () => {
      const sourceBytes = encoder.encode(source);
      const vault = createVault(source);
      const result = await anonymizeHtml(fileOf('clean.html', sourceBytes), {
        vault,
        maxBytes: 1_000_000,
      });
      const masked = decoder.decode(result.maskedBytes);
      return {
        masked,
        maskedBytes: result.maskedBytes,
        restoredBytes: (await restoreHtml(fileOf('clean.html', result.maskedBytes), vault)).bytes,
        sourceBytes,
        result,
      };
    })();

    expect(masked).toBe(source);
    expect(maskedBytes).toEqual(sourceBytes);
    expect(restoredBytes).toEqual(sourceBytes);
    expect(result.entities).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('restores the original windows-1251 bytes and keeps <meta charset> untouched', async () => {
    const source = [
      '<html><head><meta charset="windows-1251"></head>',
      `<body title="${PERSON}">${EMAIL}</body></html>`,
    ].join('');
    const sourceBytes = encodeTextBytes(source, 'windows-1251', false);
    const vault = createVault(source);

    const result = await anonymizeHtml(fileOf('win1251.html', sourceBytes), {
      vault,
      maxBytes: 1_000_000,
    });
    const masked = decodeTextBytes(result.maskedBytes, 'windows-1251', false);
    expect(masked).toContain('<meta charset="windows-1251">');
    expect(masked).not.toContain(PERSON);
    expect(masked).not.toContain(EMAIL);
    expect(result.maskedMime).toBe('text/html');

    const restored = await restoreHtml(fileOf('win1251.html', result.maskedBytes), vault);
    expect(restored.bytes).toEqual(sourceBytes);
  });

  it('round-trips UTF-16LE with BOM', async () => {
    const source = `<html><body title="${PERSON}">${EMAIL}</body></html>`;
    const sourceBytes = encodeTextBytes(source, 'utf-16le', true);
    const vault = createVault(source);

    const result = await anonymizeHtml(fileOf('utf16.html', sourceBytes), {
      vault,
      maxBytes: 1_000_000,
    });
    const masked = decodeTextBytes(result.maskedBytes, 'utf-16le', true);
    expect(masked).not.toContain(PERSON);
    expect(masked).not.toContain(EMAIL);

    const restored = await restoreHtml(fileOf('utf16.html', result.maskedBytes), vault);
    expect(restored.bytes).toEqual(sourceBytes);
  });

  it('fails closed on unclosed comments, quotes, CDATA and raw-text blocks', async () => {
    const cases = [
      '<html><body><!-- Иван Петров',
      `<html><body title="${PERSON}>text</body></html>`,
      `<html><body><![CDATA[${PERSON}`,
      `<html><body><script>const owner = "${PERSON}";`,
      `<html><body><style>/* ${PERSON}`,
    ] as const;

    for (const source of cases) {
      const vault = createVault(source);
      await expect(
        anonymizeHtml(fileOf('broken.html', encoder.encode(source)), {
          vault,
          maxBytes: 1_000_000,
        }),
      ).rejects.toThrow(/HTML:.*(?:unclosed|quoted)/iu);
      expect(vault.occurrences).toHaveLength(0);
      expect(vault.files).toHaveLength(0);
    }
  });

  it('skips data: URI attribute values with a warning', async () => {
    const source = [
      `<img src="data:image/png;base64,AAAA" href='data:text/plain,hello' alt="${PERSON}">`,
      `<a href="data:text/plain,${EMAIL}">link</a>`,
    ].join('\n');

    const { masked, restored, result } = await roundTrip('data-uri.html', source);

    expect(masked).toContain('src="data:image/png;base64,AAAA"');
    expect(masked).toContain("href='data:text/plain,hello'");
    expect(masked).toContain(`href="data:text/plain,${EMAIL}"`);
    expect(masked).not.toContain(PERSON);
    expect(masked).toContain('alt="[[');
    expect(result.warnings.some((warning) => /data: URI/u.test(warning))).toBe(true);
    expect(restored).toBe(source);
  });

  it('exposes .html/.htm extensions and the html format', () => {
    expect(htmlFormatAdapter.format).toBe('html');
    expect(htmlFormatAdapter.extensions).toEqual(['.html', '.htm']);
    expect(htmlFormatAdapter.canHandle({ name: 'page.htm', mimeType: 'text/plain' })).toBe(true);
    expect(
      htmlFormatAdapter.canHandle({ name: 'page.html', mimeType: 'application/xhtml+xml' }),
    ).toBe(true);
  });
});
