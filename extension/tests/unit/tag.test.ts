import { describe, expect, it } from 'vitest';
import {
  makePrefix,
  makeTag,
  parseTags,
  TAG_PREFIX_ALPHABET,
  TAG_PREFIX_LENGTH,
} from '../../src/core/tag';

describe('makeTag', () => {
  it('builds the canonical tag format', () => {
    expect(makeTag('DM7F3', 'PERSON', 1)).toBe('[[DM7F3_PERSON_1]]');
    expect(makeTag('AB123', 'EMAIL', 42)).toBe('[[AB123_EMAIL_42]]');
  });

  it('normalizes prefix and label to upper case', () => {
    expect(makeTag('dm7f3', 'person', 3)).toBe('[[DM7F3_PERSON_3]]');
  });

  it('rejects invalid prefixes', () => {
    expect(() => makeTag('DM7F', 'PERSON', 1)).toThrow(/prefix/);
    expect(() => makeTag('DM7F33', 'PERSON', 1)).toThrow(/prefix/);
    expect(() => makeTag('DM-7F', 'PERSON', 1)).toThrow(/prefix/);
    expect(() => makeTag('ЖМ7F3', 'PERSON', 1)).toThrow(/prefix/);
  });

  it('rejects invalid labels', () => {
    expect(() => makeTag('DM7F3', 'PERSON NAME', 1)).toThrow(/label/);
    expect(() => makeTag('DM7F3', '1PERSON', 1)).toThrow(/label/);
    expect(() => makeTag('DM7F3', 'PERSON_1', 1)).toThrow(/label/);
  });

  it('rejects invalid counters', () => {
    expect(() => makeTag('DM7F3', 'PERSON', 0)).toThrow(/counter/);
    expect(() => makeTag('DM7F3', 'PERSON', -1)).toThrow(/counter/);
    expect(() => makeTag('DM7F3', 'PERSON', 1.5)).toThrow(/counter/);
    expect(() => makeTag('DM7F3', 'PERSON', Number.NaN)).toThrow(/counter/);
  });
});

describe('parseTags', () => {
  it('returns an empty array when there are no tags', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('Иванов Иван, договор № 42')).toEqual([]);
  });

  it('finds all canonical tags with offsets', () => {
    const text = 'Клиент [[DM7F3_PERSON_1]], почта [[DM7F3_EMAIL_2]].';
    const tags = parseTags(text);

    expect(tags).toHaveLength(2);
    expect(tags[0]).toMatchObject({
      raw: '[[DM7F3_PERSON_1]]',
      prefix: 'DM7F3',
      label: 'PERSON',
      n: 1,
      index: text.indexOf('[[DM7F3_PERSON_1]]'),
    });
    expect(tags[1]).toMatchObject({
      raw: '[[DM7F3_EMAIL_2]]',
      prefix: 'DM7F3',
      label: 'EMAIL',
      n: 2,
    });
  });

  it('tolerates case changes from chat/markdown processing', () => {
    expect(parseTags('[[dm7f3_person_1]]')).toMatchObject([
      { prefix: 'DM7F3', label: 'PERSON', n: 1 },
    ]);
  });

  it('tolerates markdown escaping', () => {
    const escaped = String.raw`\[\[DM7F3\_PERSON\_1\]\]`;
    expect(parseTags(escaped)).toMatchObject([{ prefix: 'DM7F3', label: 'PERSON', n: 1 }]);
  });

  it('tolerates spaces around separators', () => {
    expect(parseTags('[[ DM7F3 _ PERSON _ 12 ]]')).toMatchObject([
      { prefix: 'DM7F3', label: 'PERSON', n: 12 },
    ]);
  });

  it('finds tags wrapped in bold markers', () => {
    expect(parseTags('**[[DM7F3_PERSON_1]]**')).toMatchObject([
      { prefix: 'DM7F3', label: 'PERSON', n: 1 },
    ]);
  });

  it('ignores malformed tags and invalid counters', () => {
    const text = [
      '[[DM7F_PERSON_1]]', // prefix too short
      '[[DM7F3_PERSON_0]]', // counter starts at 1
      '[[DM7F3_PERSON_01]]', // leading zero
      '[[DM7F3 PERSON 1]]', // wrong separators
      '[[DM7F3-PERSON-1]]', // wrong separators
    ].join(' ');
    expect(parseTags(text)).toEqual([]);
  });

  it('round-trips every generated tag', () => {
    const tags = Array.from({ length: 25 }, (_, i) => makeTag('DM7F3', 'CUSTOM', i + 1));
    const parsed = parseTags(tags.join(' '));

    expect(parsed).toHaveLength(tags.length);
    expect(parsed.map((tag) => tag.raw)).toEqual(tags);
    expect(parsed.map((tag) => tag.n)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
});

describe('makePrefix', () => {
  it('returns five characters from the documented alphabet', () => {
    for (let i = 0; i < 100; i += 1) {
      const prefix = makePrefix();
      expect(prefix).toHaveLength(TAG_PREFIX_LENGTH);
      for (const char of prefix) {
        expect(TAG_PREFIX_ALPHABET).toContain(char);
      }
    }
  });

  it('is random enough for vault collision avoidance', () => {
    const prefixes = new Set(Array.from({ length: 500 }, () => makePrefix()));
    // 36^5 space; collisions in 500 samples are improbable but theoretically
    // possible, so require a wide margin rather than uniqueness.
    expect(prefixes.size).toBeGreaterThan(490);
  });

  it('produces tags accepted by makeTag and parseTags', () => {
    const prefix = makePrefix();
    const tag = makeTag(prefix, 'PERSON', 1);
    expect(parseTags(tag)).toMatchObject([{ prefix, label: 'PERSON', n: 1 }]);
  });
});
