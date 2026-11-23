import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymizeText, createVault, detectAll, detectStructured, findLeaks } from '../../src/core';
import { setStructuredWasmMinCharsForTests } from '../../src/core/detect/structured';
import {
  getStructuredScanner,
  initStructuredScanner,
  resetStructuredScanner,
} from '../../src/core/detect/wasm-scan';
import type { DetectionConfig, EntityLabel } from '../../src/core/types';

const WASM = readFileSync(new URL('../../src/core/detect/pii-scan.wasm', import.meta.url));

const PAD = `\n${'Фоновый текст без персональных данных. '.repeat(12)}`;

interface Comparable {
  label: string;
  start: number;
  end: number;
  text: string;
  priority: number;
  ruleId: string;
  entityKey?: string;
  nominative?: string;
}

function comparable(spans: readonly Comparable[]): Comparable[] {
  return [...spans]
    .map((span) => ({
      label: span.label,
      start: span.start,
      end: span.end,
      text: span.text,
      priority: span.priority,
      ruleId: span.ruleId,
      entityKey: span.entityKey,
      nominative: span.nominative,
    }))
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.label.localeCompare(right.label) ||
        left.ruleId.localeCompare(right.ruleId),
    );
}

const CASES: Array<{ name: string; text: string; config?: DetectionConfig }> = [
  {
    name: 'email boundaries and case',
    text: 'Почта: ivan.petrov+tag@example.ru; x@y.co, a@b.c, bad@x, @nope.ru',
  },
  {
    name: 'email cyrillic/emoji neighbours',
    text: 'почтаivan@example.ru и ivan@example.ruтекст, 😀 petrov@example.com — ок',
  },
  {
    name: 'urls',
    text: 'Ссылки https://example.com/a?b=1#c и HTTP://Example.ORG/x, www.example.ru/path?q=1, WWW.EXAMPLE.RU/Up, ftp://no',
  },
  {
    name: 'handles',
    text: 'Аккаунты @durov, @navalny_team, почта user1@example.ru, @ab',
  },
  {
    name: 'phones',
    text: 'Тел. +7 (999) 123-45-67, 8 800 555 35 35, 495 123 45 67; номер 12345 и +1 202 555 0147.',
  },
  {
    name: 'phone with wide separators and masked tags',
    text: 'Тел. +7    999 123 45 67; [[EMAIL_1]] [[PHONE_2]]',
  },
  {
    name: 'snils and inn',
    text: 'СНИЛС 112-233-445 95; ИНН 7707083893, 500100732259; без контекста 500100732259.',
  },
  {
    name: 'ogrn kpp bik',
    text: 'ОГРН 1027700132195, ОГРН 304500116000157; КПП 770701001; БИК 044525225.',
  },
  {
    name: 'accounts cards iban',
    text: 'Счёт 4081 7810 3770 0000 0000; карта 4111 1111 1111 1111; IBAN DE89 3704 0044 0532 0130 00 и GB82WEST12345698765432.',
  },
  {
    name: 'passport policy license plate',
    text: 'Паспорт 45 06 123456, загранпаспорт 123456789, код подразделения 770-093; полис ОМС 1234567890123456; вод. удостоверение 77 АВ 123456; машина А123ВС77.',
  },
  {
    name: 'all-digit licenses',
    text: 'вод. удостоверение 12 34 567890; водительское удостоверение 7712123456; права 98 76 543210.',
  },
  {
    name: 'ip dates docnum',
    text: 'IP 192.168.1.1 и 10.0.0.255, не 999.1.1.1; дата 12.03.2024 и 2024-03-12; ОКТМО 45382000, рег. № 123-45.',
    config: { enableDate: true },
  },
  {
    name: 'tags protected by detectAll only',
    text: '[[PERSON_1]] Иван Петров, ivan@example.ru, +7 999 123-45-67, [[EMAIL_1]]',
  },
  {
    name: 'dashes and unicode spaces',
    text: 'Телефон +7\u2013999\u2013123-45-67; 8\u2014800\u2013555-35-35; ivan@example.ru\u00a0конец',
  },
  {
    name: 'repeated digits and id-like values',
    text: 'id 1234, id 12345, 12345678901234567890, 4111-1111-1111-1111, 4111111111111111.',
  },
];

async function withScanner<T>(run: () => T): Promise<T> {
  await initStructuredScanner(WASM);
  try {
    return run();
  } finally {
    resetStructuredScanner();
  }
}

beforeAll(async () => {
  setStructuredWasmMinCharsForTests(0);
  await initStructuredScanner(WASM);
  expect(getStructuredScanner()).not.toBeNull();
  resetStructuredScanner();
});

afterAll(() => {
  setStructuredWasmMinCharsForTests(1024 * 1024);
  resetStructuredScanner();
});

describe('wasm structured scanner differential', () => {
  for (const testCase of CASES) {
    it(`matches the JS path: ${testCase.name}`, async () => {
      const text = testCase.text + PAD;
      const config = testCase.config ?? {};
      resetStructuredScanner();
      const js = comparable(detectStructured(text, config));
      const jsAll = comparable(detectAll(text, config));

      await withScanner(() => {
        const wasm = comparable(detectStructured(text, config));
        expect(wasm).toEqual(js);
        expect(comparable(detectAll(text, config))).toEqual(jsAll);
      });
    });
  }

  it('keeps UTF-16 offsets across Cyrillic and astral characters', async () => {
    const text = `😀😀 ivan@example.ru, 😀 +7 999 123-45-67, 😀 А123ВС77 ${PAD}`;
    resetStructuredScanner();
    const js = comparable(detectStructured(text));
    await withScanner(() => {
      const wasm = comparable(detectStructured(text));
      expect(wasm).toEqual(js);
      for (const span of wasm) {
        expect(text.slice(span.start, span.end)).toBe(span.text);
      }
    });
  });

  it('detects and masks an all-digit LICENSE on a ~1 MiB wasm scan', async () => {
    // The wasm license family only emits regions with a Cyrillic capital;
    // numeric regions must also feed the unchanged JS license detector.
    const bigPad = 'Фоновый текст без персональных данных. '.repeat(32_000);
    const licenseOnly = { labels: new Set<EntityLabel>(['LICENSE']) };
    for (const license of ['12 34 567890', '7712123456']) {
      const text = `${bigPad}Водительское удостоверение ${license}.`;
      expect(text.length).toBeGreaterThan(1024 * 1024);

      resetStructuredScanner();
      const js = comparable(detectAll(text, licenseOnly));
      expect(js.map((span) => span.text)).toEqual([license]);

      await initStructuredScanner(WASM);
      try {
        const wasm = comparable(detectAll(text, licenseOnly));
        expect(wasm).toEqual(js);
        expect(wasm.map((span) => span.label)).toEqual(['LICENSE']);

        const vault = createVault(text, { prefix: 'R20AA' });
        const masked = anonymizeText(text, licenseOnly, vault);
        expect(masked.maskedText).toContain('[[R20AA_LICENSE_1]]');
        expect(masked.maskedText).not.toContain(license);
        expect(findLeaks(masked.maskedText, licenseOnly)).toEqual([]);
      } finally {
        resetStructuredScanner();
      }
    }
  }, 30_000);

  it('does not regress letter licenses, plates, or numeric ids on the wasm path', async () => {
    const bigPad = 'Фоновый текст без персональных данных. '.repeat(32_000);
    const text =
      `${bigPad}вод. удостоверение 77 АВ 123456; машина А123ВС77; ` +
      'ИНН 7707083893; СНИЛС 112-233-445 95; тел. +7 916 123-45-67.';
    resetStructuredScanner();
    const js = comparable(detectAll(text));
    await initStructuredScanner(WASM);
    try {
      const wasm = comparable(detectAll(text));
      expect(wasm).toEqual(js);
      const labels = new Set(wasm.map((span) => span.label));
      expect(labels).toEqual(new Set(['LICENSE', 'PLATE', 'INN', 'SNILS', 'PHONE']));
    } finally {
      resetStructuredScanner();
    }
  });

  it('falls back to the JS path when the scanner is not loaded', () => {
    resetStructuredScanner();
    expect(getStructuredScanner()).toBeNull();
    const text = 'ivan@example.ru +7 999 123-45-67';
    expect(detectStructured(text).length).toBeGreaterThan(0);
  });
});
