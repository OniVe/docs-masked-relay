import { describe, expect, it } from 'vitest';
import {
  anonymizeText,
  createVault,
  createVaultIndex,
  findLeaks,
  LeakGuardError,
  restoreText,
} from '../../src/core';

const SAMPLE =
  'Почта ivan@example.ru, тел. +7 (916) 123-45-67, СНИЛС 112-233-445 95, карта 4111 1111 1111 1111.';

describe('overlap resolution through the masker', () => {
  it('prefers PASSPORT (91) over an overlapping PHONE candidate (88)', () => {
    const text = 'тел. 77 04 123456 78';
    const result = anonymizeText(text);
    expect(result.maskedText).toContain('_PASSPORT_1');
    expect(result.maskedText).not.toContain('_PHONE_');
    expect(result.maskedText).not.toContain('77 04 123456');
  });

  it('prefers CARD (93) over POLICY (90) for the same 16 digits', () => {
    const result = anonymizeText('полис 4111111111111111');
    expect(result.maskedText).toContain('_CARD_1');
    expect(result.maskedText).not.toContain('_POLICY_');
  });
});

describe('sequential round-trip', () => {
  it('restores the exact original text', () => {
    const result = anonymizeText(SAMPLE);
    expect(result.maskedText).not.toContain('ivan@example.ru');
    expect(result.maskedText).not.toContain('4111 1111');

    const restored = restoreText(result.maskedText, result.vault);
    expect(restored.text).toBe(SAMPLE);
    expect(restored.replacements).toBe(4);
    expect(restored.unknownTags).toEqual([]);
  });

  it('falls back to canonical after the occurrence queue is exhausted', () => {
    const result = anonymizeText('Почта ivan@example.ru');
    const tag = result.entities[0]?.tag;
    expect(tag).toBeDefined();

    const restored = restoreText(`${tag} и ещё раз ${tag}`, result.vault);
    expect(restored.text).toBe('ivan@example.ru и ещё раз ivan@example.ru');
  });
});

describe('canonical restore', () => {
  it('uses the longest observed form for case-only variants', () => {
    const text = 'Почта Ivan@Example.ru и ivan@example.ru';
    const result = anonymizeText(text);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ key: 'EMAIL_1', count: 2 });

    const sequential = restoreText(result.maskedText, result.vault);
    expect(sequential.text).toBe(text);

    const canonical = restoreText(result.maskedText, result.vault, {
      mode: 'canonical',
    });
    expect(canonical.text).toBe('Почта Ivan@Example.ru и Ivan@Example.ru');
  });
});

describe('tolerant tags', () => {
  it('restores bold-wrapped, escaped, spaced and lower-case tags', () => {
    const result = anonymizeText('Почта ivan@example.ru');
    const tag = result.entities[0]?.tag;
    expect(tag).toBeDefined();
    if (!tag) return;

    const prefix = result.vault.prefix;
    const variants = [
      `**${tag}**`,
      tag.replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('_', '\\_'),
      `[[ ${prefix} _ EMAIL _ 1 ]]`,
      `[[${prefix.toLowerCase()}_email_1]]`,
    ];

    for (const variant of variants) {
      const restored = restoreText(variant, result.vault);
      expect(restored.text).toContain('ivan@example.ru');
      expect(restored.unknownTags).toEqual([]);
    }
  });

  it('leaves unknown tags untouched and reports them', () => {
    const vault = createVault('', { prefix: 'DM7F3' });
    const text = 'Клиент [[ZZZZZ_EMAIL_1]], [[DM7F3_EMAIL_1]]';
    const restored = restoreText(text, vault);

    expect(restored.text).toBe(text);
    expect(restored.replacements).toBe(0);
    expect(restored.unknownTags).toEqual(['[[ZZZZZ_EMAIL_1]]', '[[DM7F3_EMAIL_1]]']);
  });
});

describe('LeakGuard', () => {
  it('throws when a disabled detector leaves an email in the output', () => {
    let error: unknown;
    try {
      anonymizeText('mail ivan@example.ru', { labels: new Set(['PHONE']) });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(LeakGuardError);
    const guard = error as LeakGuardError;
    expect(guard.count).toBeGreaterThan(0);
    expect(guard.values.length).toBeGreaterThan(0);
    expect(guard.values[0]).toBe('ivan@example.ru');
  });

  it('truncates reported values to 24 characters', () => {
    const longEmail = 'verylonglocalpart12345@example.ru';
    let error: unknown;
    try {
      anonymizeText(`mail ${longEmail}`, { labels: new Set(['PHONE']) });
    } catch (caught) {
      error = caught;
    }

    const guard = error as LeakGuardError;
    expect(guard.values[0]).toHaveLength(24);
    expect(guard.values[0]).not.toBe(longEmail);
  });

  it('returns findings instead of throwing when blockOnLeak is false', () => {
    const result = anonymizeText('mail ivan@example.ru', {
      labels: new Set(['PHONE']),
      blockOnLeak: false,
    });
    expect(result.maskedText).toBe('mail ivan@example.ru');
    expect(result.leakFindings.map((finding) => finding.kind)).toContain('paranoid:email');
  });

  it('adds paranoid digit and phone findings when detectors are disabled', () => {
    const digits = anonymizeText('код 1234567', {
      labels: new Set(['EMAIL']),
      blockOnLeak: false,
    });
    expect(digits.leakFindings).toContainEqual({
      kind: 'paranoid:digits',
      value: '1234567',
    });

    const phone = anonymizeText('звон +79161234567', {
      labels: new Set(['EMAIL']),
      blockOnLeak: false,
    });
    expect(phone.leakFindings.map((finding) => finding.kind)).toContain('paranoid:phone');
  });

  it('suppresses allowlisted emails in LeakGuard', () => {
    const text = 'почта ivan@example.ru';
    const config = { allowlist: [' IVAN@EXAMPLE.RU '] };

    const result = anonymizeText(text, config);
    expect(result.maskedText).toBe(text);
    expect(result.leakFindings).toEqual([]);
    expect(findLeaks(text, config)).toEqual([]);
  });

  it('suppresses allowlisted phones and long digit runs', () => {
    const phone = '+7 (916) 123-45-67';
    const phoneText = `звон ${phone}`;
    const phoneConfig = { allowlist: [phone] };

    const phoneResult = anonymizeText(phoneText, phoneConfig);
    expect(phoneResult.maskedText).toBe(phoneText);
    expect(phoneResult.leakFindings).toEqual([]);
    expect(findLeaks(phoneText, phoneConfig)).toEqual([]);

    const digitText = 'заказ 1234567';
    const digitConfig = { allowlist: ['1234567'] };

    const digitResult = anonymizeText(digitText, digitConfig);
    expect(digitResult.maskedText).toBe(digitText);
    expect(digitResult.leakFindings).toEqual([]);
    expect(findLeaks(digitText, digitConfig)).toEqual([]);
  });

  it('still reports a non-allowlisted email through paranoid patterns', () => {
    const text = 'почта ivan@example.ru';
    const config = {
      labels: new Set(['PHONE'] as const),
      allowlist: ['other@example.ru'],
    };

    expect(findLeaks(text, config)).toContainEqual({
      kind: 'paranoid:email',
      value: 'ivan@example.ru',
    });
    expect(() => anonymizeText(text, config)).toThrow(LeakGuardError);
  });

  it('does not mutate an existing vault when it blocks', () => {
    const first = anonymizeText('Почта ivan@example.ru');
    const occurrences = first.vault.occurrences.length;

    expect(() =>
      anonymizeText(
        'plain email leak@example.ru',
        {
          labels: new Set(['PHONE']),
        },
        first.vault,
      ),
    ).toThrow(LeakGuardError);

    expect(first.vault.occurrences).toHaveLength(occurrences);
    expect(first.vault.entities.EMAIL_1?.count).toBe(1);
  });

  it('inPlace with a reused index produces the same tags as the cloning path', () => {
    const firstText = 'Почта ivan@example.ru';
    const secondText = 'Повтор ivan@example.ru и ivan@example.ru';
    const expectedVault = createVault('', { prefix: 'TSTPX' });
    const expected = anonymizeText(`${firstText}\n${secondText}`, {}, expectedVault);

    const vault = createVault('', { prefix: 'TSTPX' });
    const index = createVaultIndex(vault);
    const first = anonymizeText(firstText, {}, vault, { inPlace: true, index });
    const second = anonymizeText(secondText, {}, vault, { inPlace: true, index });

    expect(`${first.maskedText}\n${second.maskedText}`).toBe(expected.maskedText);
    expect(vault.entities).toEqual(expected.vault.entities);
    expect(vault.occurrences).toEqual(expected.vault.occurrences);
  });

  it('inPlace and index require a caller-owned vault', () => {
    expect(() => anonymizeText('x', {}, undefined, { inPlace: true })).toThrow(/existing vault/u);
    expect(() =>
      anonymizeText('x', {}, undefined, { index: createVaultIndex(createVault('')) }),
    ).toThrow(/existing vault/u);
  });
});

describe('R2-M1: masking many distinct entities is linear', () => {
  function distinctEmailsText(count: number): string {
    return Array.from({ length: count }, (_, index) => `user${index}@example.com`).join('\n');
  }

  function maskDuration(count: number): number {
    const text = distinctEmailsText(count);
    const started = performance.now();
    const result = anonymizeText(text);
    const duration = performance.now() - started;
    expect(Object.keys(result.vault.entities)).toHaveLength(count);
    expect(result.maskedText).not.toContain('@example.com');
    return duration;
  }

  it('8k/16k distinct emails stay far below the old quadratic timings', { timeout: 60_000 }, () => {
    // Warm up detectors/JIT so the ratio measures masking, not first-call costs.
    maskDuration(1_000);
    const eightK = maskDuration(8_000);
    const sixteenK = maskDuration(16_000);

    // Before the fix: 8k ~8.4s, 16k ~38s (quadratic). Linear runs are ~1-2s
    // alone and slower under the full parallel suite; thresholds keep headroom.
    expect(eightK).toBeLessThan(6_000);
    expect(sixteenK).toBeLessThan(12_000);
    expect(sixteenK).toBeLessThan(Math.max(eightK, 100) * 8);
  });
});
