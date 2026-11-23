import { describe, expect, it } from 'vitest';
import { findLeaks } from '../../src/core';
import { detectAll } from '../../src/core/detect';
import { detectAllChunked } from '../../src/core/masker';

function signature(spans: readonly { ruleId: string; start: number; end: number; text: string }[]) {
  return spans
    .map((span) => `${span.ruleId}:${span.start}:${span.end}:${span.text}`)
    .sort((left, right) => left.localeCompare(right));
}

describe('M15-M2: chunked LeakGuard detection keeps detector semantics', () => {
  it('finds the same structured spans with chunk boundaries inside values', () => {
    const text = [
      'x'.repeat(79),
      ' ivan@example.ru ',
      'y'.repeat(84),
      ' +7 916 123-45-67 ',
      'z'.repeat(49),
      ' petrova@example.ru ',
      'w'.repeat(59),
      ' +7 916 765-43-21 ',
    ].join('');

    const whole = detectAll(text, {});
    const chunked = detectAllChunked(text, {}, 100, 40);

    // Every kept span starts in exactly one core, so the set must be equal.
    expect(signature(chunked)).toEqual(signature(whole));
    expect(chunked.some((span) => span.text === 'ivan@example.ru')).toBe(true);
    expect(chunked.some((span) => span.text === 'petrova@example.ru')).toBe(true);
  });

  it('blanks tag bodies before paranoid patterns (single-pass, no tag digits)', () => {
    const text = '[[ABCDE_EMAIL_1234567]] text [[ABCDE_PHONE_7654321]]';
    expect(findLeaks(text, { labels: new Set() })).toEqual([]);
  });

  it('keeps left context for a match starting exactly at the core boundary', () => {
    const email = 'ivan@example.ru';
    const text = `${'x'.repeat(99)} ${email} ${'y'.repeat(150)}`;
    const chunked = detectAllChunked(text, {}, 100, 40);
    const found = chunked.find((span) => span.text === email);
    expect(found?.start).toBe(100);
    expect(found?.ruleId).toBe('email');
  });
});
