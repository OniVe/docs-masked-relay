import { describe, expect, it } from 'vitest';
import type { Span } from '../../src/core';
import { detectAll, resolveOverlaps } from '../../src/core';

function span(
  label: Span['label'],
  start: number,
  end: number,
  priority: number,
  ruleId = 'test',
): Span {
  return {
    label,
    start,
    end,
    text: 'x'.repeat(end - start),
    priority,
    ruleId,
  };
}

describe('resolveOverlaps', () => {
  it('prefers priority, then length, then the left start', () => {
    expect(
      resolveOverlaps([span('EMAIL', 0, 4, 90), span('PHONE', 0, 8, 91)]).map((item) => item.label),
    ).toEqual(['PHONE']);

    expect(
      resolveOverlaps([span('EMAIL', 0, 5, 90), span('PHONE', 0, 8, 90)]).map((item) => item.label),
    ).toEqual(['PHONE']);

    expect(
      resolveOverlaps([span('EMAIL', 0, 5, 90), span('PHONE', 3, 8, 90)]).map((item) => item.label),
    ).toEqual(['EMAIL']);
  });

  it('keeps detector order only as the final stable tie-break', () => {
    const first = span('EMAIL', 0, 5, 90, 'first');
    const second = span('PHONE', 0, 5, 90, 'second');
    expect(resolveOverlaps([first, second]).map((item) => item.ruleId)).toEqual(['first']);
    expect(resolveOverlaps([second, first]).map((item) => item.ruleId)).toEqual(['second']);
  });

  it('returns kept spans in document order', () => {
    const resolved = resolveOverlaps([span('PHONE', 10, 15, 90), span('EMAIL', 0, 5, 90)]);
    expect(resolved.map((item) => item.start)).toEqual([0, 10]);
  });
});

describe('second pass', () => {
  it('does not duplicate an already accepted span', () => {
    const spans = detectAll('Почта ivan@example.ru', {}, { secondPass: true });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      label: 'EMAIL',
      start: 6,
      end: 21,
      text: 'ivan@example.ru',
    });
  });
});
