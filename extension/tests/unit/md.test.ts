import { describe, expect, it } from 'vitest';
import type { AnonymizeResult, FileInput, Vault } from '../../src/core';
import { anonymizeMd, createVault, mdFormatAdapter, restoreMd } from '../../src/core';

const encoder = new TextEncoder();

function fileOf(name: string, bytes: Uint8Array): FileInput {
  return { name, mimeType: 'text/markdown', bytes };
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
  md: string,
  options: { skipCode?: boolean; bom?: boolean } = {},
): Promise<RoundTrip> {
  const body = encoder.encode(md);
  const sourceBytes = options.bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body;
  const ctx = { vault: createVault(md), maxBytes: 1_000_000, skipCode: options.skipCode };
  const result = await anonymizeMd(fileOf('doc.md', sourceBytes), ctx);
  const masked = new TextDecoder('utf-8', { fatal: true }).decode(result.maskedBytes);
  const restored = await restoreMd(fileOf('doc.md', result.maskedBytes), ctx.vault);

  return {
    result,
    masked,
    restored: new TextDecoder('utf-8', { fatal: true }).decode(restored.bytes),
    restoredBytes: restored.bytes,
    sourceBytes,
    vault: ctx.vault,
  };
}

describe('Markdown adapter', () => {
  it('keeps headings, bold, lists and table markup while masking PII', async () => {
    const md = [
      '# Отчёт Ивана Петрова',
      '',
      '**Иван Петров** — клиент, почта ivan@example.ru.',
      '',
      '- тел. +7 (916) 123-45-67',
      '- второй пункт',
      '',
      '| Имя | Почта |',
      '| --- | --- |',
      '| Иван Петров | test@example.ru |',
      '',
    ].join('\n');

    const { masked, restored, result } = await roundTrip(md);

    expect(masked).toContain('# Отчёт ');
    expect(masked).toContain('**');
    expect(masked).toContain('- ');
    expect(masked).toContain('| --- | --- |');
    expect(masked).not.toContain('Иван Петров');
    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).not.toContain('test@example.ru');
    expect(result.entities.map((entity) => entity.label)).toContain('PERSON');
    expect(result.entities.map((entity) => entity.label)).toContain('EMAIL');
    expect(result.entities.map((entity) => entity.label)).toContain('PHONE');
    expect(restored).toBe(md);
  });

  it('masks a link label and its destination, then restores both', async () => {
    const md = '[Иван](https://example.ru/u/ivan)';
    const { masked, restored, result } = await roundTrip(md);
    const prefix = result.vaultPrefix;

    expect(masked).toBe(`[[[${prefix}_PERSON_1]]]([[${prefix}_URL_1]])`);
    expect(result.entities.map((entity) => entity.label)).toEqual(['PERSON', 'URL']);
    expect(restored).toBe(md);
  });

  it('masks image alt text and definition URLs', async () => {
    const md =
      '![Иван Петров](https://example.ru/i/ivan.png)\n\n![Иван Петров][ref]\n\n[ref]: https://example.ru/u/ivan "Иван"\n';
    const { masked, restored, result } = await roundTrip(md);
    const prefix = result.vaultPrefix;

    expect(masked).toContain(`![[[${prefix}_PERSON_1]]]([[${prefix}_URL_1]])`);
    expect(masked).toContain(`![[[${prefix}_PERSON_1]]][ref]`);
    expect(masked).toContain(`[ref]: [[${prefix}_URL_2]] "Иван"`);
    expect(restored).toBe(md);
  });

  it('masks a lone first name in reference labels and image alt', async () => {
    const md = '[Иван][ref]\n\n![Иван][ref]\n\n[ref]: https://example.ru/u/ivan\n';
    const { masked, restored, result } = await roundTrip(md);
    const prefix = result.vaultPrefix;

    expect(masked).toContain(`[[[${prefix}_PERSON_1]]][ref]`);
    expect(masked).toContain(`![[[${prefix}_PERSON_1]]][ref]`);
    expect(masked).toContain(`[ref]: [[${prefix}_URL_1]]`);
    expect(restored).toBe(md);
  });

  it('masks YAML frontmatter values but keeps keys and delimiters', async () => {
    const md = [
      '---',
      'title: Отчёт Ивана Петрова',
      'email: ivan@example.ru',
      'tags:',
      '  - клиент Иван Петров',
      '---',
      '',
      'Текст.',
      '',
    ].join('\n');

    const { masked, restored, result } = await roundTrip(md);

    expect(masked.startsWith('---\ntitle: Отчёт ')).toBe(true);
    expect(masked).toContain('\nemail: ');
    expect(masked).toContain('\ntags:\n  - клиент ');
    expect(masked).not.toContain('Ивана Петрова');
    expect(masked).not.toContain('ivan@example.ru');
    expect(result.entities.map((entity) => entity.label)).toContain('PERSON');
    expect(result.entities.map((entity) => entity.label)).toContain('EMAIL');
    expect(restored).toBe(md);
  });

  it('masks code blocks and inline code by default', async () => {
    const md = [
      'Текст ivan@example.ru',
      '',
      '```js',
      'const mail = "code@example.ru";',
      '```',
      '',
      '`inline@example.ru`',
      '',
    ].join('\n');

    const { masked, restored } = await roundTrip(md);
    expect(masked).not.toContain('code@example.ru');
    expect(masked).not.toContain('inline@example.ru');
    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).toContain('```js');
    expect(restored).toBe(md);
  });

  it('respects skipCode: true for fences and inline code', async () => {
    const md = [
      'Текст ivan@example.ru',
      '',
      '```js',
      'const mail = "code@example.ru";',
      '```',
      '',
      '`inline@example.ru`',
      '',
    ].join('\n');

    const { masked, restored } = await roundTrip(md, { skipCode: true });
    expect(masked).toContain('code@example.ru');
    expect(masked).toContain('inline@example.ru');
    expect(masked).not.toContain('ivan@example.ru');
    expect(restored).toBe(md);
  });

  it('masks HTML blocks and reports a warning', async () => {
    const md = '<div>\n  html@example.ru\n</div>\n';
    const { masked, restored, result } = await roundTrip(md);

    expect(masked).not.toContain('html@example.ru');
    expect(masked).toContain('<div>');
    expect(result.warnings.some((warning) => /HTML/u.test(warning))).toBe(true);
    expect(restored).toBe(md);
  });

  it('preserves UTF-8 BOM, CRLF and vault file metadata', async () => {
    const md = '---\r\nemail: ivan@example.ru\r\n---\r\n\r\n# Текст\r\n';
    const { masked, restoredBytes, sourceBytes, vault, restored } = await roundTrip(md, {
      bom: true,
    });

    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).toContain('\r\n');
    expect([...restoredBytes]).toEqual([...sourceBytes]);
    expect(restored).toBe(md);
    expect(vault.files).toHaveLength(1);
    expect(vault.files[0]).toMatchObject({
      originalName: 'doc.md',
      maskedName: 'doc.md',
      format: 'md',
      encoding: 'utf-8',
      bom: true,
      eol: 'crlf',
      size: sourceBytes.length,
    });
    expect(vault.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('reports unknown tags on restore', async () => {
    const file = fileOf('doc.md', encoder.encode('Текст [[ZZZZZ_EMAIL_1]]'));
    const restored = await restoreMd(file, createVault(''));
    expect(restored.unknownTags).toEqual(['[[ZZZZZ_EMAIL_1]]']);
    expect(restored.warnings).toHaveLength(1);
  });
});

describe('mdFormatAdapter', () => {
  it('recognizes .md/.markdown and text/markdown', () => {
    expect(
      mdFormatAdapter.canHandle({ name: 'NOTES.MD', mimeType: 'application/octet-stream' }),
    ).toBe(true);
    expect(mdFormatAdapter.canHandle({ name: 'notes.markdown', mimeType: '' })).toBe(true);
    expect(mdFormatAdapter.canHandle({ name: 'notes', mimeType: 'text/markdown' })).toBe(true);
    expect(mdFormatAdapter.canHandle({ name: 'doc.docx', mimeType: 'text/plain' })).toBe(false);
  });
});
