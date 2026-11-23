import { describe, expect, it } from 'vitest';
import type { FileInput } from '../../src/core';
import {
  anonymizeJson,
  anonymizeText,
  anonymizeTxt,
  anonymizeXml,
  assertClean,
  createVault,
  detectAll,
  findLeaks,
  restoreJson,
  restoreText,
  restoreTxt,
  restoreXml,
} from '../../src/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const FULL_NAME = 'ИВАНОВ ВЛАДИМИР ИВАНОВИЧ';

function fileOf(name: string, mimeType: string, bytes: Uint8Array): FileInput {
  return { name, mimeType, bytes };
}

function personSpans(text: string): string[] {
  return detectAll(text)
    .filter((span) => span.label === 'PERSON')
    .map((span) => span.text);
}

describe('M16-N2: ALL-CAPS Cyrillic person fallback', () => {
  it('detects a full ALL-CAPS name and LeakGuard sees it before masking', () => {
    expect(personSpans(FULL_NAME)).toEqual([FULL_NAME]);
    expect(findLeaks(FULL_NAME).map((finding) => finding.kind)).toContain('detector:person');
    expect(() => assertClean(FULL_NAME)).toThrow(/LeakGuard/u);
  });

  it('masks and restores the exact ALL-CAPS surface', () => {
    const result = anonymizeText(FULL_NAME);
    expect(result.maskedText).not.toContain('ИВАНОВ');
    expect(result.maskedText).not.toContain('ВЛАДИМИР');
    expect(findLeaks(result.maskedText)).toEqual([]);
    expect(restoreText(result.maskedText, result.vault).text).toBe(FULL_NAME);
  });

  it('detects surname + first name in either order', () => {
    expect(personSpans('ИВАНОВ ИВАН')).toEqual(['ИВАНОВ ИВАН']);
    expect(personSpans('ИВАНОВ ВЛАДИМИР')).toEqual(['ИВАНОВ ВЛАДИМИР']);
  });

  it('does not mask an ALL-CAPS organization without a person signal', () => {
    expect(personSpans('ООО РОМАШКА')).toEqual([]);
    expect(anonymizeText('ООО РОМАШКА').maskedText).toBe('ООО РОМАШКА');
  });

  it('keeps city and geo-prefixed contexts untouched', () => {
    expect(personSpans('МОСКВА')).toEqual([]);
    expect(personSpans('РОСТОВ-НА-ДОНУ')).toEqual([]);
    expect(personSpans('г. ИВАНОВ')).toEqual([]);
    expect(anonymizeText('г. ИВАНОВ').maskedText).toBe('г. ИВАНОВ');
  });

  it('treats lowercase г. as a city marker but uppercase Г. as an initial', () => {
    // M16-N2: only the lowercase abbreviation is a geo prefix. The first
    // ИВАНОВ is a city; the second is a person.
    expect(personSpans('г. ИВАНОВ / ИВАНОВ И.И.')).toEqual(['ИВАНОВ И.И.']);
    // `Г.` is an initial plus a surname, so it must not be suppressed.
    expect(personSpans('Г. ИВАНОВ')).toEqual(['Г. ИВАНОВ']);
  });

  it('masks `Г. ИВАНОВ` and ALL-CAPS names after a year (R22-GEO-1)', () => {
    const initial = 'Г. ИВАНОВ пришёл.';
    const initialMasked = anonymizeText(initial).maskedText;
    expect(initialMasked).not.toContain('ИВАНОВ');
    expect(findLeaks(initialMasked)).toEqual([]);

    const dated = 'В 2020 г. ИВАНОВ И.И. пришёл.';
    expect(personSpans(dated)).toEqual(['ИВАНОВ И.И.']);
    expect(findLeaks(anonymizeText(dated).maskedText)).toEqual([]);

    // Lowercase `г.` before a multi-token ALL-CAPS person is masked too; the
    // lone geo form above stays plaintext.
    const lower = 'г. ИВАНОВ И.И.';
    expect(personSpans(lower)).toEqual(['ИВАНОВ И.И.']);
    expect(findLeaks(anonymizeText(lower).maskedText)).toEqual([]);
  });

  it('does not revive a geo-prefixed repeat of a known person', () => {
    expect(personSpans('ИВАНОВ И.И. подписал … г. ИВАНОВ')).toEqual(['ИВАНОВ И.И.']);
  });

  it('masks only the person inside a mixed ALL-CAPS sentence', () => {
    const source = 'ООО РОМАШКА ИВАНОВ ВЛАДИМИР ИВАНОВИЧ';
    const result = anonymizeText(source);
    expect(result.maskedText).toContain('ООО РОМАШКА');
    expect(result.maskedText).not.toContain('ИВАНОВ');
    expect(restoreText(result.maskedText, result.vault).text).toBe(source);
  });

  it('masks an ALL-CAPS surname after a person trigger', () => {
    const source = 'Директор ИВАНОВ';
    const result = anonymizeText(source);
    expect(result.maskedText).not.toContain('ИВАНОВ');
    expect(restoreText(result.maskedText, result.vault).text).toBe(source);
  });

  it('masks ALL-CAPS names in TXT documents and restores them exactly', async () => {
    const source = `Договор\n${FULL_NAME}\n`;
    const vault = createVault('');
    const masked = await anonymizeTxt(fileOf('allcaps.txt', 'text/plain', encoder.encode(source)), {
      vault,
      maxBytes: 1_000_000,
    });
    const maskedText = decoder.decode(masked.maskedBytes);
    expect(maskedText).not.toContain('ИВАНОВ');
    expect(findLeaks(maskedText)).toEqual([]);

    const restored = await restoreTxt(
      fileOf('allcaps.txt', 'text/plain', masked.maskedBytes),
      vault,
    );
    expect(decoder.decode(restored.bytes)).toBe(source);
  });

  it('masks ALL-CAPS names in JSON text values and split name fields', async () => {
    const source = JSON.stringify({
      text: FULL_NAME,
      first: 'ИВАН',
      age: 42,
      last: 'ПЕТРОВ',
      surname: 'ИВАНОВ',
      name: 'ВЛАДИМИР',
      patronymic: 'ИВАНОВИЧ',
    });
    const vault = createVault('');
    const masked = await anonymizeJson(
      fileOf('allcaps.json', 'application/json', encoder.encode(source)),
      { vault, maxBytes: 1_000_000 },
    );
    const maskedText = decoder.decode(masked.maskedBytes);
    expect(maskedText).not.toContain('ИВАНОВ');
    expect(maskedText).not.toContain('ПЕТРОВ');
    expect(maskedText).not.toContain('ВЛАДИМИР');
    expect(findLeaks(maskedText)).toEqual([]);

    const restored = await restoreJson(
      fileOf('allcaps.json', 'application/json', masked.maskedBytes),
      vault,
    );
    expect(decoder.decode(restored.bytes)).toBe(source);
  });

  it('masks ALL-CAPS names in XML text and attributes and restores them exactly', async () => {
    const source = `<root><first>ИВАН</first><last>ПЕТРОВ</last><fio attr="${FULL_NAME}">${FULL_NAME}</fio></root>`;
    const vault = createVault('');
    const masked = await anonymizeXml(
      fileOf('allcaps.xml', 'application/xml', encoder.encode(source)),
      { vault, maxBytes: 1_000_000 },
    );
    const maskedText = decoder.decode(masked.maskedBytes);
    expect(maskedText).not.toContain('ИВАНОВ');
    expect(maskedText).not.toContain('ПЕТРОВ');
    expect(findLeaks(maskedText)).toEqual([]);

    const restored = await restoreXml(
      fileOf('allcaps.xml', 'application/xml', masked.maskedBytes),
      vault,
    );
    expect(decoder.decode(restored.bytes)).toBe(source);
  });
});
