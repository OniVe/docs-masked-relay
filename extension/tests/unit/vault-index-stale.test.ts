import { describe, expect, it } from 'vitest';
import {
  assignDetection,
  createVault,
  createVaultIndex,
  encodePersonKey,
  refreshVaultIndex,
  type Span,
} from '../../src/core';

function emailSpan(text: string): Span {
  return { label: 'EMAIL', start: 0, end: text.length, text, priority: 95, ruleId: 'email' };
}

function personSpan(text: string, surname: string): Span {
  return {
    label: 'PERSON',
    start: 0,
    end: text.length,
    text,
    priority: 95,
    ruleId: 'person',
    entityKey: encodePersonKey([surname, '', '']),
    canonical: text,
  };
}

describe('M15-M1: stale VaultIndex is rebuilt before indexed assignment', () => {
  it('keeps key serial and does not overwrite entities written without the index', () => {
    const vault = createVault('', { prefix: 'TSTPX' });
    const index = createVaultIndex(vault);

    // External writer: no index involved.
    const first = assignDetection(vault, emailSpan('first@example.com'));
    const second = assignDetection(vault, emailSpan('second@example.com'));
    expect(first.key).toBe('EMAIL_1');
    expect(second.key).toBe('EMAIL_2');

    // Indexed writer sees a stale index (counter 0, no surfaces).
    const third = assignDetection(vault, emailSpan('third@example.com'), { index });
    const repeat = assignDetection(vault, emailSpan('first@example.com'), { index });

    expect(third.key).toBe('EMAIL_3');
    expect(repeat.key).toBe('EMAIL_1');
    expect(Object.keys(vault.entities).sort()).toEqual(['EMAIL_1', 'EMAIL_2', 'EMAIL_3']);
    expect(vault.entities.EMAIL_1?.canonical).toBe('first@example.com');
    expect(vault.entities.EMAIL_2?.canonical).toBe('second@example.com');
    expect(vault.entities.EMAIL_3?.canonical).toBe('third@example.com');
  });

  it('finds a structured variant added outside the index', () => {
    const vault = createVault('', { prefix: 'TSTPX' });
    const index = createVaultIndex(vault);
    assignDetection(vault, emailSpan('first@example.com'));

    const repeat = assignDetection(vault, emailSpan('FIRST@example.com'), { index });
    expect(repeat.key).toBe('EMAIL_1');
    expect(vault.entities.EMAIL_1?.canonical).toBe('first@example.com');
    expect(Object.keys(vault.entities)).toEqual(['EMAIL_1']);
  });

  it('does not overwrite a key inserted directly without an occurrence', () => {
    const vault = createVault('', { prefix: 'TSTPX' });
    const index = createVaultIndex(vault);
    vault.entities.EMAIL_1 = {
      label: 'EMAIL',
      canonical: 'external@example.com',
      variants: [],
      count: 1,
    };

    const assigned = assignDetection(vault, emailSpan('new@example.com'), { index });
    expect(assigned.key).toBe('EMAIL_2');
    expect(vault.entities.EMAIL_1?.canonical).toBe('external@example.com');
    expect(vault.entities.EMAIL_2?.canonical).toBe('new@example.com');
  });

  it('reuses the surface after an entity-only insert once the index is refreshed (R16-N1)', () => {
    const vault = createVault('', { prefix: 'TSTPX' });
    const index = createVaultIndex(vault);
    // Entity-only insert: no occurrence, so `occurrenceCount` cannot notice it.
    vault.entities.EMAIL_1 = {
      label: 'EMAIL',
      canonical: 'external@example.com',
      variants: [],
      count: 1,
    };
    // The documented requirement: callers that write entities directly must
    // rebuild the index before reusing it.
    refreshVaultIndex(vault, index);

    const repeat = assignDetection(vault, emailSpan('external@example.com'), { index });
    expect(repeat.key).toBe('EMAIL_1');
    expect(Object.keys(vault.entities)).toEqual(['EMAIL_1']);
    expect(vault.entities.EMAIL_1?.count).toBe(2);
  });

  it('finds a PERSON by surname stem after an external assignment', () => {
    const vault = createVault('', { prefix: 'TSTPX' });
    const index = createVaultIndex(vault);

    // External writer stores the person without the semantic entityKey map.
    const external = personSpan('Петров Иван', 'петров');
    delete external.entityKey;
    const full = assignDetection(vault, external);
    expect(full.key).toBe('PERSON_1');

    const lone = assignDetection(vault, personSpan('Петров', 'петров'), { index });
    expect(lone.key).toBe('PERSON_1');
    expect(vault.entities.PERSON_1?.canonical).toBe('Петров Иван');
    expect(vault.occurrences[0]?.original).toBe('Петров Иван');
    expect(Object.keys(vault.entities)).toEqual(['PERSON_1']);
  });
});
