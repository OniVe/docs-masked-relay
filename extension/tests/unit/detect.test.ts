import { describe, expect, it } from 'vitest';
import { detectAll } from '../../src/core';

function labels(text: string): string[] {
  return detectAll(text).map((span) => span.label);
}

function textOf(text: string, label: string): string | undefined {
  return detectAll(text).find((span) => span.label === label)?.text;
}

describe('structured detector matrix', () => {
  it('detects the docs_masked fixture set', () => {
    expect(labels('Почта: ivan@example.ru')).toEqual(['EMAIL']);
    expect(labels('тел. +7 (916) 123-45-67')).toEqual(['PHONE']);
    expect(labels('СНИЛС 112-233-445 95')).toEqual(['SNILS']);
    expect(labels('ОГРН 1027700132195')).toEqual(['OGRN']);
    expect(labels('карта 4111 1111 1111 1111')).toEqual(['CARD']);
    expect(labels('паспорт 45 12 345678')).toEqual(['PASSPORT']);
    expect(labels('IBAN DE89370400440532013000')).toEqual(['IBAN']);
    expect(labels('госномер Х123УК799')).toEqual(['PLATE']);
    expect(labels('12.03.1985 г.р.')).toEqual(['BIRTHDATE']);
    expect(labels('ОКТМО 45000000')).toEqual(['DOCNUM']);
  });

  it('detects Russian requisites with context', () => {
    expect(labels('ИНН 7707083893')).toEqual(['INN']);
    expect(labels('КПП 770701001')).toEqual(['KPP']);
    expect(labels('БИК 044525000')).toEqual(['BIK']);
    expect(labels('р/с 40702810900000000001')).toEqual(['ACCOUNT']);
    expect(labels('полис ОМС 4111 1111 1111 1111')).toEqual(['CARD']);
    expect(labels('к/с 40702810900000000001, БИК 044525000, ОКТМО 45000000')).toEqual([
      'ACCOUNT',
      'BIK',
      'DOCNUM',
    ]);
  });

  it('detects handles and IP addresses', () => {
    expect(labels('пишите @ivan_01')).toEqual(['HANDLE']);
    expect(labels('версия 1.2.3.4')).toEqual(['IP']);
  });

  it('detects POLICY, LICENSE and a foreign passport', () => {
    expect(
      detectAll('полис 4111111111111111', {
        labels: new Set(['POLICY']),
      }).map((span) => span.label),
    ).toEqual(['POLICY']);
    expect(labels('вод. удостоверение 45 АВ 123456')).toEqual(['LICENSE']);
    expect(labels('загранпаспорт 123456789')).toEqual(['PASSPORT']);
  });

  it('masks the document date and department code in a passport block', () => {
    const text = 'паспорт 45 12 345678, выдан ОВД района 24.06.2013, код подразделения 770-093';
    const spans = detectAll(text);
    expect(spans.map((span) => `${span.label}:${span.text}`)).toEqual([
      'PASSPORT:45 12 345678',
      'DOCDATE:24.06.2013',
      'PASSPORT:770-093',
    ]);
  });

  it('keeps docs_masked priorities', () => {
    const snils = detectAll('СНИЛС 112-233-445 95')[0];
    expect(snils).toMatchObject({ priority: 94, ruleId: 'ru.snils' });

    const email = detectAll('ivan@example.ru')[0];
    expect(email).toMatchObject({ priority: 95, ruleId: 'email' });

    const passport = detectAll('паспорт 45 12 345678')[0];
    expect(passport).toMatchObject({ priority: 91, ruleId: 'ru.passport' });
  });
});

describe('clean text and DATE gating', () => {
  it('does not change plain business text', () => {
    const text = 'Настоящий Договор заключён в городе Москве. Итого 100 рублей.';
    expect(detectAll(text)).toEqual([]);
  });

  it('leaves unqualified dates alone by default', () => {
    expect(detectAll('Дата 12.03.2025')).toEqual([]);
  });

  it('detects plain dates when enableDate is on', () => {
    const spans = detectAll('Дата 12.03.2025', { enableDate: true });
    expect(spans).toMatchObject([{ label: 'DATE', text: '12.03.2025', priority: 20 }]);
  });

  it('keeps BIRTHDATE and DOCDATE enabled by default', () => {
    expect(textOf('12.03.1985 г.р.', 'BIRTHDATE')).toBe('12.03.1985');
    expect(textOf('12 марта 1985 г.р.', 'BIRTHDATE')).toBe('12 марта 1985');
    expect(textOf('выдан 24.06.2013', 'DOCDATE')).toBe('24.06.2013');
  });
});

describe('configuration', () => {
  it('filters labels after detection', () => {
    const text = 'Почта ivan@example.ru, тел. +7 (916) 123-45-67';
    const spans = detectAll(text, { labels: new Set(['EMAIL']) });
    expect(spans.map((span) => span.label)).toEqual(['EMAIL']);
  });

  it('supports URL only when enabled', () => {
    const text = 'сайт https://example.com/a?b=1';
    expect(detectAll(text)).toEqual([]);
    expect(detectAll(text, { enableUrl: true })).toMatchObject([
      { label: 'URL', text: 'https://example.com/a?b=1', priority: 40 },
    ]);
  });

  it('respects an exact case-insensitive allowlist', () => {
    const text = 'Почта ivan@example.ru';
    expect(detectAll(text, { allowlist: [' IVAN@EXAMPLE.RU '] })).toEqual([]);
    // Substring allowlist entries do not match (exact comparison).
    expect(detectAll(text, { allowlist: ['ivan@example'] })).toHaveLength(1);
  });

  it('detects custom literal terms as substrings, case-insensitively', () => {
    const text = 'ООО «Ромашка» и снова ромашка';
    const spans = detectAll(text, { customTerms: ['Ромашка'] });
    expect(spans).toMatchObject([
      { label: 'CUSTOM', text: 'Ромашка', priority: 99 },
      { label: 'CUSTOM', text: 'ромашка', priority: 99 },
    ]);
  });

  it('does not detect inside existing tags, but still scans around them', () => {
    expect(detectAll('[[DM7F3_EMAIL_1]]')).toEqual([]);
    const spans = detectAll('[[DM7F3_EMAIL_1]] ivan@example.ru');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.text).toBe('ivan@example.ru');
  });
});

describe('Unicode boundaries', () => {
  it('does not start an email inside a Cyrillic word', () => {
    expect(detectAll('почтаivan@example.ru')).toEqual([]);
    expect(detectAll('Почта: ivan@example.ru')).toHaveLength(1);
  });

  it('handles Cyrillic labels and values without ASCII word boundaries', () => {
    expect(textOf('ИНН 7707083893', 'INN')).toBe('7707083893');
    expect(textOf('снилс 112-233-445 95', 'SNILS')).toBe('112-233-445 95');
  });

  it('detects ORG, PERSON and ADDRESS in one Cyrillic line', () => {
    expect(labels('ООО «Ромашка», Иванов Иван Иванович, ул. Ленина, д. 5')).toEqual([
      'ORG',
      'PERSON',
      'ADDRESS',
    ]);
  });
});
