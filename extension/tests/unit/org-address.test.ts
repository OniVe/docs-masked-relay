import { describe, expect, it } from 'vitest';
import { anonymizeText, detectAll, restoreText } from '../../src/core';

function spans(text: string): {
  label: string;
  text: string;
  priority: number;
  ruleId: string;
}[] {
  return detectAll(text).map(({ label, text: value, priority, ruleId }) => ({
    label,
    text: value,
    priority,
    ruleId,
  }));
}

describe('ORG', () => {
  it('masks a quoted short legal form, including lower case', () => {
    expect(spans('ООО «Ромашка»')).toEqual([
      { label: 'ORG', text: 'ООО «Ромашка»', priority: 78, ruleId: 'org.short' },
    ]);
    expect(spans('ооо «Ромашка»')).toEqual([
      { label: 'ORG', text: 'ооо «Ромашка»', priority: 78, ruleId: 'org.short' },
    ]);
  });

  it('masks the long legal-form phrase', () => {
    const text =
      'Федеральное государственное бюджетное образовательное учреждение высшего образования «Московский политехнический университет»';
    expect(spans(text)).toEqual([{ label: 'ORG', text, priority: 77, ruleId: 'org.long' }]);

    const withYo = 'Казённое учреждение «Солнышко»';
    expect(spans(withYo)).toEqual([
      { label: 'ORG', text: withYo, priority: 77, ruleId: 'org.long' },
    ]);

    const lowercase =
      'федеральное государственное автономное образовательное учреждение высшего образования «Северный политехнический институт»';
    expect(spans(lowercase)).toEqual([
      { label: 'ORG', text: lowercase, priority: 77, ruleId: 'org.long' },
    ]);
  });

  it('does not mask a legal form without quotation marks', () => {
    expect(detectAll('ООО Ромашка')).toEqual([]);
    expect(detectAll('ООО «Ромашка» и ООО Ромашка').map((span) => span.label)).toEqual(['ORG']);
  });
});

describe('ADDRESS', () => {
  const addresses = [
    '119991, г. Москва, ул. Ленина, д. 12, корп. 3, кв. 45',
    'г. Санкт-Петербург, 197101, Садовый проезд, д. 49, лит. А',
    '123308, г. Москва, ул. Полевая, д. 11, корп. 2, кв. 47',
    'г. Ростов-на-Дону, ул. Мира, д. 5, оф. 12',
    '127015, г. Москва, ул. Большая Новодмитровская, д. 36, стр. 2, офис 415',
  ];

  it('masks the five guide addresses as one full ADDRESS span', () => {
    for (const address of addresses) {
      expect(spans(address)).toEqual([
        { label: 'ADDRESS', text: address, priority: 84, ruleId: 'ru.address' },
      ]);
    }
  });

  it('masks the short index + geo + street form with priority 82', () => {
    const address = '127001, г. Москва, ул. Тверская';
    expect(spans(address)).toEqual([
      { label: 'ADDRESS', text: address, priority: 82, ruleId: 'ru.address' },
    ]);
  });

  it('requires a house for the full form and a street for the short one', () => {
    expect(detectAll('ул. Ленина')).toEqual([]);
    expect(detectAll('г. Москва')).toEqual([]);
    expect(detectAll('127001, г. Москва')).toEqual([]);
    expect(detectAll('127001, г. Москва, ул. Ленина, д. 5').map((span) => span.label)).toEqual([
      'ADDRESS',
    ]);
  });

  it('accepts a capitalised marker but keeps the docs_masked street-name rule', () => {
    expect(detectAll('Ул. Ленина, д. 5').map((span) => span.label)).toEqual(['ADDRESS']);
    // docs_masked requires capitalised settlement/street names.
    expect(detectAll('ул. ленина, д. 5')).toEqual([]);
    expect(detectAll('г. москва, ул. Тверская, д. 5').map((span) => span.text)).toEqual([
      'ул. Тверская, д. 5',
    ]);
  });

  it('does not break overlapping phone and INN detection', () => {
    const text =
      'ООО «Ромашка», ИНН 7707083893, г. Москва, ул. Ленина, д. 5, тел. +7 (916) 123-45-67';
    const result = anonymizeText(text);

    expect(result.entities.map((entity) => entity.label)).toEqual([
      'ORG',
      'INN',
      'ADDRESS',
      'PHONE',
    ]);
    expect(result.maskedText).toContain('_ORG_1');
    expect(result.maskedText).toContain('_INN_1');
    expect(result.maskedText).toContain('_ADDRESS_1');
    expect(result.maskedText).toContain('_PHONE_1');
    expect(restoreText(result.maskedText, result.vault).text).toBe(text);
  });
});
