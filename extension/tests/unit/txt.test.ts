import { describe, expect, it } from 'vitest';
import type { FileInput } from '../../src/core';
import {
  anonymizeTxt,
  createVault,
  detectEncoding,
  detectEol,
  restoreTxt,
  sha256Hex,
  txtFormatAdapter,
} from '../../src/core';

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf16Bytes(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = littleEndian ? 0xff : 0xfe;
  out[1] = littleEndian ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const offset = 2 + i * 2;
    if (littleEndian) {
      out[offset] = code & 0xff;
      out[offset + 1] = code >> 8;
    } else {
      out[offset] = code >> 8;
      out[offset + 1] = code & 0xff;
    }
  }
  return out;
}

function utf16NoBomBytes(text: string, littleEndian: boolean): Uint8Array {
  return utf16Bytes(text, littleEndian).subarray(2);
}

function fileOf(name: string, bytes: Uint8Array): FileInput {
  return { name, mimeType: 'text/plain', bytes };
}

function contextFor(text: string) {
  return { vault: createVault(text), maxBytes: 1_000_000 };
}

describe('detectEncoding', () => {
  it('sniffs UTF-8/UTF-16 BOMs', () => {
    expect(detectEncoding(concat(Uint8Array.of(0xef, 0xbb, 0xbf), encoder.encode('тест')))).toEqual(
      { encoding: 'utf-8', bom: true },
    );
    expect(detectEncoding(utf16Bytes('тест', true))).toEqual({
      encoding: 'utf-16le',
      bom: true,
    });
    expect(detectEncoding(utf16Bytes('тест', false))).toEqual({
      encoding: 'utf-16be',
      bom: true,
    });
  });

  it('detects plain UTF-8 and falls back to windows-1251', () => {
    expect(detectEncoding(encoder.encode('Привет'))).toEqual({
      encoding: 'utf-8',
      bom: false,
    });

    // "Привет" in CP1251 followed by ASCII.
    const cp1251 = Uint8Array.from([
      0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0x74, 0x65, 0x73, 0x74,
    ]);
    expect(detectEncoding(cp1251)).toEqual({
      encoding: 'windows-1251',
      bom: false,
    });
  });
});

describe('EMP-R2: BOM-less UTF-16 with non-Latin/symbol text', () => {
  const samples = ['Цена €5', 'Итог 😀 готов', '漢字 и Greek: Ελληνικά'];
  it.each(samples)('detects and round-trips %s without BOM', async (sample) => {
    for (const littleEndian of [true, false]) {
      const bytes = utf16NoBomBytes(sample, littleEndian);
      const expected = littleEndian ? 'utf-16le' : 'utf-16be';
      expect(detectEncoding(bytes)).toEqual({ encoding: expected, bom: false });

      const ctx = contextFor(sample);
      const result = await anonymizeTxt(fileOf('unicode.txt', bytes), ctx);
      expect(new TextDecoder('utf-8').decode(result.maskedBytes)).toBe(sample);
      expect(result.maskedBytes).toEqual(encoder.encode(sample));
      expect(result.warnings.some((warning) => /without BOM/u.test(warning))).toBe(true);
    }
  });
});

describe('EMP-R2: BOM-less UTF-16 endianness tie (no ASCII NUL signal)', () => {
  const tieSamples = ['Договор😀', 'Αθήνα', 'שלום', 'Договор 😀'];
  it.each(tieSamples)('detects the real endianness of %s', async (sample) => {
    for (const littleEndian of [true, false]) {
      const bytes = utf16NoBomBytes(sample, littleEndian);
      expect(detectEncoding(bytes)).toEqual({
        encoding: littleEndian ? 'utf-16le' : 'utf-16be',
        bom: false,
      });

      const result = await anonymizeTxt(fileOf('tie.txt', bytes), contextFor(sample));
      expect(new TextDecoder('utf-8').decode(result.maskedBytes)).toBe(sample);
    }
  });

  it('keeps CJK-only text LE-first when both decodes are plausible', () => {
    expect(detectEncoding(utf16NoBomBytes('中文', true))).toEqual({
      encoding: 'utf-16le',
      bom: false,
    });
  });
});

describe('EMP-R2/R4-N2: CJK-only and emoji-only BOM-less UTF-16', () => {
  it.each([
    ['中文', true],
    ['中文', false],
  ] as const)('detects %s (%s) instead of the wrong endianness', async (sample, littleEndian) => {
    const bytes = utf16NoBomBytes(sample, littleEndian);
    const expected = littleEndian ? 'utf-16le' : 'utf-16be';
    expect(detectEncoding(bytes)).toMatchObject({ encoding: expected, bom: false });

    const result = await anonymizeTxt(fileOf('cjk.txt', bytes), contextFor(sample));
    expect(new TextDecoder('utf-8').decode(result.maskedBytes)).toBe(sample);
    expect(result.warnings.some((warning) => /without BOM/u.test(warning))).toBe(true);
  });

  // EMP-R2-v2: these UTF-16 bytes are also printable ASCII, so UTF-8-first
  // reads them as text instead of guessing CJK. Accepted NIT; documented.
  it.each([true, false] as const)('keeps 漢字漢字 BOM-less UTF-16 bytes as UTF-8 (%s)', (le) => {
    const bytes = utf16NoBomBytes('漢字漢字', le);
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-8', bom: false });
  });

  it.each([
    ['😀', true],
    ['😀', false],
    ['😀😀', true],
    ['😀😀', false],
  ] as const)(
    'detects emoji-only %s (%s) by surrogate-pair consistency',
    async (sample, littleEndian) => {
      const bytes = utf16NoBomBytes(sample, littleEndian);
      const expected = littleEndian ? 'utf-16le' : 'utf-16be';
      expect(detectEncoding(bytes)).toMatchObject({ encoding: expected, bom: false });

      const result = await anonymizeTxt(fileOf('emoji.txt', bytes), contextFor(sample));
      expect(new TextDecoder('utf-8').decode(result.maskedBytes)).toBe(sample);
    },
  );

  it('reads a short CJK sample that is valid ASCII as UTF-8 without noise (条款)', async () => {
    const bytes = utf16NoBomBytes('条款', true);
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-8', bom: false });

    const result = await anonymizeTxt(fileOf('short-cjk.txt', bytes), contextFor('条款'));
    expect(result.warnings.some((warning) => /ambiguous/u.test(warning))).toBe(false);
  });

  it('warns instead of silently picking LE on an exact symbol-only tie (€€)', async () => {
    const bytes = utf16NoBomBytes('€€', false);
    expect(detectEncoding(bytes)).toMatchObject({ ambiguous: true });

    const result = await anonymizeTxt(fileOf('symbols.txt', bytes), contextFor('€€'));
    expect(result.warnings.some((warning) => /ambiguous/u.test(warning))).toBe(true);
  });
});

describe('EMP-R2-v2/R5-N2: UTF-8-first for valid printable text', () => {
  const utf8Samples = [
    'ivan@example.ru!',
    'https://example.ru/a',
    'foo.bar!',
    'a[i]+=1;',
    '😀😀!?',
  ];

  it.each(utf8Samples)('keeps %s as UTF-8 and round-trips', async (sample) => {
    const bytes = encoder.encode(sample);
    expect(detectEncoding(bytes)).toMatchObject({ encoding: 'utf-8', bom: false });

    const ctx = contextFor(sample);
    const result = await anonymizeTxt(fileOf('utf8.txt', bytes), ctx);
    expect(ctx.vault.files[0]?.encoding).toBe('utf-8');
    expect(new TextDecoder('utf-8', { fatal: true }).decode(result.maskedBytes)).not.toMatch(
      /[\u3000-\u9fff]/u,
    );

    const restored = await restoreTxt(fileOf('utf8.txt', result.maskedBytes), ctx.vault);
    expect([...restored.bytes]).toEqual([...bytes]);
  });

  it('does not warn on a short ASCII buffer with punctuation (a>bc)', async () => {
    const bytes = encoder.encode('a>bc');
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-8', bom: false });

    const result = await anonymizeTxt(fileOf('short.txt', bytes), contextFor('a>bc'));
    expect(result.warnings.some((warning) => /ambiguous/u.test(warning))).toBe(false);
  });
});

describe('detectEol', () => {
  it('picks the dominant line ending', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('crlf');
    expect(detectEol('a\nb\nc\r\n')).toBe('lf');
    expect(detectEol('a\rb\rc\r\n')).toBe('cr');
    expect(detectEol('no newlines')).toBe('lf');
  });
});

describe('TXT round-trip', () => {
  it('keeps UTF-8 BOM, CRLF and restores exact bytes', async () => {
    const text = 'Привет, почта ivan@example.ru!\r\nВторая строка.\r\n';
    const bytes = concat(Uint8Array.of(0xef, 0xbb, 0xbf), encoder.encode(text));
    const ctx = contextFor(text);
    const result = await anonymizeTxt(fileOf('letter.txt', bytes), ctx);

    expect(result.maskedBytes[0]).not.toBe(0xef);
    const masked = new TextDecoder().decode(result.maskedBytes);
    expect(masked).toContain('_EMAIL_1');
    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).toContain('\r\n');
    expect(result.entities.map((entity) => entity.label)).toEqual(['EMAIL']);

    expect(ctx.vault.files).toHaveLength(1);
    expect(ctx.vault.files[0]).toMatchObject({
      originalName: 'letter.txt',
      maskedName: 'letter.txt',
      format: 'txt',
      encoding: 'utf-8',
      bom: true,
      eol: 'crlf',
      size: bytes.length,
    });
    expect(ctx.vault.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);

    const restored = await restoreTxt(fileOf('letter.txt', result.maskedBytes), ctx.vault);
    expect([...restored.bytes]).toEqual([...bytes]);
    expect(restored.fileName).toBe('letter.txt');
  });

  it('restores UTF-16LE BOM files byte-for-byte', async () => {
    const text = 'Иван: test@example.ru\r\nСтрока 2\r\n';
    const bytes = utf16Bytes(text, true);
    const ctx = contextFor(text);

    const result = await anonymizeTxt(fileOf('utf16.txt', bytes), ctx);
    const restored = await restoreTxt(fileOf('utf16.txt', result.maskedBytes), ctx.vault);

    expect([...restored.bytes]).toEqual([...bytes]);
    expect(ctx.vault.files[0]).toMatchObject({
      encoding: 'utf-16le',
      bom: true,
      eol: 'crlf',
    });
    expect(restored.replacements).toBe(1);
  });

  it('restores windows-1251 bytes and keeps LF', async () => {
    // "Привет ivan@example.ru\n" in CP1251, byte sequence is deliberate.
    const text = 'Привет ivan@example.ru\n';
    const bytes = Uint8Array.from([
      0xcf,
      0xf0,
      0xe8,
      0xe2,
      0xe5,
      0xf2,
      0x20, // "Привет "
      ...encoder.encode('ivan@example.ru\n'),
    ]);
    const ctx = contextFor(text);

    expect(detectEncoding(bytes)).toEqual({
      encoding: 'windows-1251',
      bom: false,
    });

    const result = await anonymizeTxt(fileOf('cp1251.txt', bytes), ctx);
    const masked = new TextDecoder('utf-8', { fatal: true }).decode(result.maskedBytes);
    expect(masked).toContain('_EMAIL_1');
    expect(masked).toContain('\n');
    expect(masked).not.toContain('\r\n');

    const restored = await restoreTxt(fileOf('cp1251.txt', result.maskedBytes), ctx.vault);
    expect([...restored.bytes]).toEqual([...bytes]);
    expect(ctx.vault.files[0]).toMatchObject({
      encoding: 'windows-1251',
      bom: false,
      eol: 'lf',
    });
  });

  it('restores mixed EOL byte-exactly (M8-M1-TXT)', async () => {
    const text = 'Почта ivan@example.ru\r\nСтрока\nТретья\r\n';
    const bytes = encoder.encode(text);
    const ctx = contextFor(text);

    const result = await anonymizeTxt(fileOf('mixed.txt', bytes), ctx);
    expect(new TextDecoder().decode(result.maskedBytes)).toContain('\r\n');
    expect(new TextDecoder().decode(result.maskedBytes)).toContain('\n');

    const restored = await restoreTxt(fileOf('mixed.txt', result.maskedBytes), ctx.vault);
    expect([...restored.bytes]).toEqual([...bytes]);
  });

  it('keeps LF when the source uses LF', async () => {
    const text = 'Почта ivan@example.ru\nСтрока\n';
    const bytes = encoder.encode(text);
    const ctx = contextFor(text);

    const result = await anonymizeTxt(fileOf('lf.txt', bytes), ctx);
    expect(new TextDecoder().decode(result.maskedBytes)).not.toContain('\r');

    const restored = await restoreTxt(fileOf('lf.txt', result.maskedBytes), ctx.vault);
    expect([...restored.bytes]).toEqual([...bytes]);
  });

  it('rejects files above the byte limit before decoding', async () => {
    const ctx = { vault: createVault(''), maxBytes: 4 };
    await expect(
      anonymizeTxt(fileOf('big.txt', encoder.encode('0123456789')), ctx),
    ).rejects.toThrow(/limit/u);
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 of "abc"', async () => {
    await expect(sha256Hex(encoder.encode('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('txtFormatAdapter', () => {
  it('recognizes .txt by extension and MIME type', () => {
    expect(
      txtFormatAdapter.canHandle({ name: 'A.TXT', mimeType: 'application/octet-stream' }),
    ).toBe(true);
    expect(txtFormatAdapter.canHandle({ name: 'notes', mimeType: 'text/plain' })).toBe(true);
    expect(txtFormatAdapter.canHandle({ name: 'doc.docx', mimeType: 'text/plain' })).toBe(true);
    expect(txtFormatAdapter.canHandle({ name: 'doc.docx', mimeType: 'application/xml' })).toBe(
      false,
    );
  });
});
