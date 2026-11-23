import { describe, expect, it } from 'vitest';
import {
  anonymizeText,
  assertPersonDensity,
  buildPersonIndex,
  canonicalOf,
  DENSITY_LIMIT_MESSAGE,
  DensityLimitError,
  detectAll,
  findLeaks,
  MAX_PERSON_TOKENS,
  restoreText,
  type Span,
} from '../../src/core';

function personSpans(text: string, aggressive = false): Span[] {
  return detectAll(text, { aggressive }).filter((span) => span.label === 'PERSON');
}

function personKeys(vault: ReturnType<typeof anonymizeText>['vault']): string[] {
  return Object.keys(vault.entities).filter((key) => key.startsWith('PERSON_'));
}

describe('PERSON morphology and clustering', () => {
  it('merges full name, oblique surname and initials into one entity', () => {
    const text = 'Иванов Иван Иванович пришёл. Иванову выдан пропуск. Иванов И.И. подписал.';
    const result = anonymizeText(text);

    expect(personKeys(result.vault)).toEqual(['PERSON_1']);
    const tag = result.entities[0]?.tag;
    expect(tag).toBeDefined();
    expect(tag === undefined ? 0 : result.maskedText.split(tag).length - 1).toBe(3);
    expect(result.vault.entities.PERSON_1).toMatchObject({
      count: 3,
      canonical: 'Иванов Иван Иванович',
      nominative: 'Иванов Иван Иванович',
    });
  });

  it('does not merge homonyms with different initials', () => {
    const result = anonymizeText(
      'Петров Алексей Иванович и Петрова Мария Сергеевна — разные люди.',
    );

    expect(personKeys(result.vault)).toEqual(['PERSON_1', 'PERSON_2']);
    expect(result.vault.entities.PERSON_1?.canonical).toBe('Петров Алексей Иванович');
    expect(result.vault.entities.PERSON_2?.canonical).toBe('Петрова Мария Сергеевна');
  });

  it('keeps Иван Петрович and Игорь Павлович apart', () => {
    const result = anonymizeText('Иван Петрович и Игорь Павлович');
    expect(personKeys(result.vault)).toHaveLength(2);
  });

  it('builds a document index across units (name + initials)', () => {
    const index = buildPersonIndex(['Кузнецову выдан пропуск', 'Сотрудник Кузнецов Иван Петрович']);

    expect(index.stems.get('кузнецов')).toEqual(['кузнецов', 'и', 'п']);
  });

  it('exposes entityKey, nominative and canonical score on spans', () => {
    const span = personSpans('Кузнецову Ивану Петровичу')[0];
    expect(span).toMatchObject({
      label: 'PERSON',
      priority: 86,
      ruleId: 'person',
      nominative: 'Кузнецов Иван Петрович',
      canonical: 'Кузнецову Ивану Петровичу',
      personConfidence: 1,
    });
    expect(span?.entityKey).toContain('кузнецов');
    expect(span?.canonicalScore).toBeGreaterThan(0);
  });
});

describe('PERSON across calls sharing one vault', () => {
  it('reuses the entity when the full name was seen first', () => {
    const first = anonymizeText('Сотрудник Кузнецов Иван Петрович');
    const second = anonymizeText('Кузнецову выдан пропуск', {}, first.vault);

    expect(personKeys(second.vault)).toEqual(['PERSON_1']);
    const tag = first.entities[0]?.tag;
    expect(tag).toBeDefined();
    expect(second.maskedText).toContain(tag);
  });

  it('merges an aggressively detected lone surname with a later full name', () => {
    // A lone surname without a trigger is not PERSON by default in
    // docs_masked; aggressive mode is what creates the first entity here.
    const first = anonymizeText('Кузнецову выдан пропуск', { aggressive: true });
    const second = anonymizeText('Сотрудник Кузнецов Иван Петрович', {}, first.vault);

    expect(personKeys(second.vault)).toEqual(['PERSON_1']);
    const tag = first.entities[0]?.tag;
    expect(tag).toBeDefined();
    expect(second.maskedText).toContain(tag);
    expect(second.vault.entities.PERSON_1?.canonical).toBe('Кузнецов Иван Петрович');
  });
});

describe('nominative reconstruction', () => {
  const cases: readonly [string, string][] = [
    ['Кузнецову Ивану Петровичу', 'Кузнецов Иван Петрович'],
    ['Петровой Марии Сергеевны', 'Петрова Мария Сергеевна'],
    ['Достоевского Фёдора Михайловича', 'Достоевский Фёдор Михайлович'],
    ['Ковалевской Софьи Васильевны', 'Ковалевская Софья Васильевна'],
  ];

  for (const [oblique, nominative] of cases) {
    it(`restores ${nominative} from ${oblique}`, () => {
      const text = `Направлено ${oblique} по адресу.`;
      const result = anonymizeText(text);
      const entity = result.vault.entities.PERSON_1;

      expect(entity).toBeDefined();
      expect(entity === undefined ? '' : canonicalOf(entity)).toBe(nominative);

      const restored = restoreText(result.maskedText, result.vault, {
        mode: 'canonical',
      });
      expect(restored.text).toBe(`Направлено ${nominative} по адресу.`);

      const sequential = restoreText(result.maskedText, result.vault);
      expect(sequential.text).toBe(text);
    });
  }
});

describe('PERSON false positives and Latin names', () => {
  it('never treats a city after a geo prefix as a person', () => {
    expect(personSpans('Совещание прошло в г. Москва и в г. Казань.')).toEqual([]);
  });

  it('does not detect PERSON in clean business text', () => {
    const text = 'Настоящий Договор заключён в городе Москве. Итого 100 рублей.';
    expect(detectAll(text).filter((span) => span.label === 'PERSON')).toEqual([]);
  });

  it('detects a titled Latin person and a Slavic-tail name', () => {
    expect(personSpans('Mr John Smith')).toMatchObject([
      { label: 'PERSON', text: 'Mr John Smith', priority: 80 },
    ]);
    expect(personSpans('Ivanov Ivan Ivanovich')).toMatchObject([
      { label: 'PERSON', text: 'Ivanov Ivan Ivanovich', priority: 78 },
    ]);
  });

  it('does not detect an untitled non-Slavic Latin name', () => {
    expect(personSpans('John Smith')).toEqual([]);
  });

  it('does not join tokens across tabs or line breaks', () => {
    expect(personSpans('Иванов\nИван\nИванович')).toEqual([]);
    expect(personSpans('Иванов\tИван Иванович')).not.toContainEqual(
      expect.objectContaining({ start: 0 }),
    );
  });

  it('accepts one/two ordinary or NBSP spaces inside a full name', () => {
    expect(personSpans('Иванов  Иван Иванович')).toHaveLength(1);
    expect(personSpans('Иванов\u00A0Иван Иванович')).toHaveLength(1);
  });
});

describe('aggressive surname mode', () => {
  it('is off by default and does not mask a lone surname', () => {
    expect(personSpans('Кузнецову выдан пропуск')).toEqual([]);
  });

  it('detects a lone surname after a trigger even without aggressive', () => {
    expect(personSpans('Сотрудник Кузнецов пришёл')).toMatchObject([
      { label: 'PERSON', text: 'Кузнецов', priority: 55 },
    ]);
  });

  it('detects a lone surname anywhere with aggressive: true', () => {
    expect(personSpans('Кузнецову выдан пропуск', true)).toMatchObject([
      { label: 'PERSON', text: 'Кузнецову', priority: 55 },
    ]);
  });
});

describe('PERSON: city-name homonym in the first-name role', () => {
  it('masks a full name whose first name is also a city stopword and restores it exactly', () => {
    for (const full of [
      'Иванов Владимир Иванович',
      'Петров Владимир Сергеевич',
      'Владимир Иванович Петров',
    ]) {
      const result = anonymizeText(full);

      expect(personSpans(full)).toMatchObject([{ label: 'PERSON', text: full }]);
      expect(result.maskedText).not.toContain('Владимир');
      expect(restoreText(result.maskedText, result.vault).text).toBe(full);
    }
  });

  it('masks two-word forms where the homonym is the first name', () => {
    for (const name of ['Иванов Владимир', 'Владимир Иванович', 'Владимир Иванов']) {
      expect(personSpans(name)).toMatchObject([{ label: 'PERSON', text: name }]);
    }
  });

  it('keeps the city after a geo prefix unmasked, even next to person repeats', () => {
    expect(personSpans('г. Владимир')).toEqual([]);
    expect(personSpans('Владимир — город')).toEqual([]);
    expect(personSpans('Совещание прошло в г. Владимир.')).toEqual([]);

    const text = 'Владимир Иванович приехал в г. Владимир.';
    expect(personSpans(text).map((span) => span.text)).toEqual(['Владимир Иванович']);
  });

  it('applies the geo guard before patterns 1-3, case-aware for г./Г.', () => {
    // Lowercase `г.` marks a city: the first ИВАНОВ is not a person, while the
    // following surname with initials still is (M16-N2).
    expect(personSpans('г. Иванов / Иванов И.И.').map((span) => span.text)).toEqual([
      'Иванов И.И.',
    ]);
    // Uppercase `Г.` is an initial, not a city prefix.
    expect(personSpans('Г. Иванов').map((span) => span.text)).toEqual(['Г. Иванов']);
    // The ordinary full name is unaffected by the guard.
    expect(personSpans('Иванов Иван Иванович').map((span) => span.text)).toEqual([
      'Иванов Иван Иванович',
    ]);
  });

  it('does not treat `2020 г.` as a city prefix (PII leak R22-GEO-1)', () => {
    const dated = 'В 2020 г. Иванов И.И. пришёл.';
    expect(personSpans(dated).map((span) => span.text)).toEqual(['Иванов И.И.']);
    const result = anonymizeText(dated);
    expect(result.maskedText).not.toContain('Иванов');
    expect(findLeaks(result.maskedText)).toEqual([]);

    const fullDate = '01.01.2020 г. Иванов Иван Иванович';
    expect(personSpans(fullDate).map((span) => span.text)).toEqual(['Иванов Иван Иванович']);
    expect(findLeaks(anonymizeText(fullDate).maskedText)).toEqual([]);

    // A lone geo candidate without a year keeps its old semantics (city),
    // while a multi-token person pattern after `г.` is masked (R22-GEO-1
    // residual).
    expect(personSpans('г. Иванов')).toEqual([]);
    expect(anonymizeText('г. Иванов').maskedText).toBe('г. Иванов');
    expect(personSpans('г. Владимир')).toEqual([]);
    const slash = 'г. Иванов / Иванов И.И.';
    expect(personSpans(slash).map((span) => span.text)).toEqual(['Иванов И.И.']);
    const slashMasked = anonymizeText(slash).maskedText;
    expect(slashMasked).toContain('г. Иванов');
    expect(slashMasked).not.toContain('Иванов И.И.');
  });

  it('masks initials and full names after lowercase `г.` (R22-GEO-1 residual)', () => {
    const initials = 'г. Иванов И.И. приехал.';
    expect(personSpans(initials).map((span) => span.text)).toEqual(['Иванов И.И.']);
    const initialsMasked = anonymizeText(initials).maskedText;
    expect(initialsMasked).toContain('г. ');
    expect(initialsMasked).not.toContain('Иванов');
    expect(findLeaks(initialsMasked)).toEqual([]);

    const full = 'г. Иванов Иван Иванович';
    expect(personSpans(full).map((span) => span.text)).toEqual(['Иванов Иван Иванович']);
    expect(findLeaks(anonymizeText(full).maskedText)).toEqual([]);

    // The year guard still covers both multi-token forms.
    expect(personSpans('В 2020 г. Иванов И.И.').map((span) => span.text)).toEqual(['Иванов И.И.']);
    expect(personSpans('01.01.2020 г. Иванов Иван Иванович').map((span) => span.text)).toEqual([
      'Иванов Иван Иванович',
    ]);
  });

  it('does not turn a geo-prefixed exact repeat into a person', () => {
    expect(personSpans('Иванов И.И. приехал в г. Иванов.').map((span) => span.text)).toEqual([
      'Иванов И.И.',
    ]);
  });
});

describe('R23-GEO-4: date-first geo prefixes and two-token persons after г.', () => {
  it('masks two-token person candidates after lowercase г.', () => {
    for (const [source, name] of [
      ['г. Иванов Иван', 'Иванов Иван'],
      ['г. Иван Иванович', 'Иван Иванович'],
      ['г. ИВАНОВ ИВАН', 'ИВАНОВ ИВАН'],
    ] as const) {
      expect(personSpans(source).map((span) => span.text)).toEqual([name]);
      const result = anonymizeText(source);
      expect(result.maskedText).toContain('г. ');
      for (const part of name.split(' ')) {
        expect(result.maskedText).not.toContain(part);
      }
      expect(findLeaks(result.maskedText)).toEqual([]);
      expect(restoreText(result.maskedText, result.vault).text).toBe(source);
    }
  });

  it('masks a person after a date or year used as г. (год)', () => {
    const cases = [
      '2020-01-01 г. Иванов Иван',
      '2020.01.01 г. Иванов Иван',
      '2020/01/01 г. Иванов Иван',
      '2020-01-01г. Иванов Иван',
      '01.01.2020 г. Иванов Иван',
      '2020 г. Иванов Иван',
      '2020г. Иванов Иван',
    ] as const;
    for (const source of cases) {
      expect(personSpans(source).map((span) => span.text)).toEqual(['Иванов Иван']);
      const result = anonymizeText(source);
      expect(result.maskedText).not.toContain('Иванов');
      expect(result.maskedText).not.toContain('Иван');
      expect(findLeaks(result.maskedText)).toEqual([]);
      expect(restoreText(result.maskedText, result.vault).text).toBe(source);
    }

    const initials = '2020-01-01 г. Иванов И.И. пришёл.';
    expect(personSpans(initials).map((span) => span.text)).toEqual(['Иванов И.И.']);
    expect(findLeaks(anonymizeText(initials).maskedText)).toEqual([]);
  });

  it('masks a lone surname after a date fail-safe but keeps a lone city', () => {
    for (const source of ['2020 г. Иванов', '2020-01-01 г. Иванов', '01.01.2020 г. Иванов']) {
      expect(personSpans(source).map((span) => span.text)).toEqual(['Иванов']);
      expect(findLeaks(anonymizeText(source).maskedText)).toEqual([]);
    }

    expect(personSpans('г. Иванов')).toEqual([]);
    expect(anonymizeText('г. Иванов').maskedText).toBe('г. Иванов');
    expect(personSpans('г. Владимир')).toEqual([]);
    expect(anonymizeText('г. Владимир').maskedText).toBe('г. Владимир');
  });

  it('keeps city repeats suppressed but maps date-first repeats', () => {
    expect(personSpans('Иванов И.И. приехал в г. Иванов.').map((span) => span.text)).toEqual([
      'Иванов И.И.',
    ]);
    for (const source of [
      'Иванов И.И. приехал в 2020 г. Иванов.',
      'Иванов И.И. приехал в 2020-01-01 г. Иванов.',
    ]) {
      expect(personSpans(source).map((span) => span.text)).toEqual(['Иванов И.И.', 'Иванов']);
      expect(findLeaks(anonymizeText(source).maskedText)).toEqual([]);
    }
  });

  it('keeps the case-aware г./Г. and all-caps behaviour', () => {
    expect(personSpans('Г. ИВАНОВ').map((span) => span.text)).toEqual(['Г. ИВАНОВ']);
    expect(personSpans('г. ИВАНОВ / ИВАНОВ И.И.').map((span) => span.text)).toEqual([
      'ИВАНОВ И.И.',
    ]);
    expect(anonymizeText('г. ИВАНОВ / ИВАНОВ И.И.').maskedText).toContain('г. ИВАНОВ');
  });

  it('documents the cap-only detector limitation for lowercase surnames', () => {
    // The PERSON detector is capitalized-only (see docs-masked-porting.md §3);
    // a lowercase surname after a year is not a candidate by design.
    const source = '2020 г.иванов';
    expect(anonymizeText(source).maskedText).toBe(source);
  });
});

describe('R25-DENSITY: name-dense documents fail closed before PERSON work', () => {
  it('throws a typed DensityLimitError above the uppercase-token cap', () => {
    const dense = 'ИВАН '.repeat(60); // 60 uppercase tokens, limit 50
    expect(() => detectAll(dense, { maxPersonTokens: 50 })).toThrow(DensityLimitError);

    try {
      detectAll(dense, { maxPersonTokens: 50 });
    } catch (error) {
      expect(error).toBeInstanceOf(DensityLimitError);
      expect((error as DensityLimitError).code).toBe('TOO_MANY_ENTITIES');
      expect((error as Error).message).toBe(DENSITY_LIMIT_MESSAGE);
    }
  });

  it('keeps the exact boundary inclusive and the default cap above 8k names', () => {
    const atLimit = 'ИВАН '.repeat(50);
    expect(() => detectAll(atLimit, { maxPersonTokens: 50 })).not.toThrow();
    expect(() => detectAll(`${atLimit}ИВАН `, { maxPersonTokens: 50 })).toThrow(DensityLimitError);

    // The existing 8k name-dense perf corpus: 8 000 x 3 tokens = 24 000,
    // still well below the production cap.
    const names8k = 'Иванов Иван Иванович\n'.repeat(8_000);
    expect(MAX_PERSON_TOKENS).toBe(50_000);
    expect(() => assertPersonDensity(names8k)).not.toThrow();
    expect(() => assertPersonDensity(names8k, 23_999)).toThrow(DensityLimitError);
  });

  it('guards the public buildPersonIndex entry, not only detectAll', () => {
    // core/index.ts exports buildPersonIndex; it must not bypass the cap.
    expect(() => buildPersonIndex('ИВАН '.repeat(60), { maxPersonTokens: 50 })).toThrow(
      DensityLimitError,
    );
  });

  it('counts apostrophes, hyphenated names and combining marks exactly', () => {
    const tokens = "O' O’ O'Brien O’Neil Жан-Поль И\u0301";
    expect(() => assertPersonDensity(tokens, 6)).not.toThrow();
    expect(() => assertPersonDensity(tokens, 5)).toThrow(DensityLimitError);
  });

  it('counts lone initials (`И.И.`, `I.`) as density tokens', () => {
    const initials = 'И.И. '.repeat(30); // 60 tokens
    expect(() => assertPersonDensity(initials, 60)).not.toThrow();
    expect(() => assertPersonDensity(initials, 59)).toThrow(DensityLimitError);
    expect(() => assertPersonDensity('I. '.repeat(3), 3)).not.toThrow();
    expect(() => assertPersonDensity('I. '.repeat(3), 2)).toThrow(DensityLimitError);

    // Redteam case: a document made only of initials must not return 0 spans.
    expect(() => detectAll('И.И. '.repeat(50_001), { maxPersonTokens: 50 })).toThrow(
      DensityLimitError,
    );
  });

  it('counts the density cap across all units, not per unit', () => {
    // Redteam bypass: two 30k-token units under a 50k cap returned because
    // the guard looked at each unit separately.
    expect(() =>
      buildPersonIndex(['ИВАН '.repeat(30_000), 'ИВАН '.repeat(30_000)], {
        maxPersonTokens: 50_000,
      }),
    ).toThrow(DensityLimitError);
    expect(() =>
      buildPersonIndex(['ИВАН '.repeat(10_000), 'ИВАН '.repeat(10_000)], {
        maxPersonTokens: 50_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertPersonDensity(['ИВАН '.repeat(30_000), 'ИВАН '.repeat(30_000)], 50_000),
    ).toThrow(DensityLimitError);
  });

  it('ignores a malformed override instead of disabling the guard', () => {
    const dense = 'ИВАН '.repeat(100);
    expect(() => assertPersonDensity(dense, 0)).not.toThrow();
    expect(() => assertPersonDensity(dense, Number.NaN)).not.toThrow();
  });
});

describe('PERSON round-trip', () => {
  it('restores a mixed PERSON + EMAIL + PHONE text exactly', () => {
    const text = 'Иванов Иван Иванович, ivan@example.ru, тел. +7 (916) 123-45-67.';
    const result = anonymizeText(text);

    expect(result.maskedText).not.toContain('Иванов');
    expect(result.maskedText).not.toContain('ivan@example.ru');
    expect(result.maskedText).toContain('_PERSON_1');
    expect(result.maskedText).toContain('_EMAIL_1');
    expect(result.maskedText).toContain('_PHONE_1');

    const restored = restoreText(result.maskedText, result.vault);
    expect(restored.text).toBe(text);
    expect(restored.replacements).toBe(3);
  });
});
