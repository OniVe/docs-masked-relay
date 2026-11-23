import { describe, expect, it } from 'vitest';
import {
  ibanValid,
  inn10Valid,
  inn12Valid,
  innValid,
  luhnCheck,
  ogrnValid,
  snilsValid,
} from '../../src/core';

describe('luhnCheck', () => {
  it('accepts a valid card and rejects a wrong check digit', () => {
    expect(luhnCheck('4111 1111 1111 1111')).toBe(true);
    expect(luhnCheck('4111111111111111')).toBe(true);
    expect(luhnCheck('4111 1111 1111 1112')).toBe(false);
  });

  it('rejects values with fewer than two digits', () => {
    expect(luhnCheck('')).toBe(false);
    expect(luhnCheck('7')).toBe(false);
    expect(luhnCheck('abc')).toBe(false);
  });
});

describe('snilsValid', () => {
  it('accepts the docs_masked fixture and rejects a wrong checksum', () => {
    expect(snilsValid('112-233-445 95')).toBe(true);
    expect(snilsValid('112-233-445 96')).toBe(false);
  });

  it('rejects the all-identical body', () => {
    expect(snilsValid('111-111-111 00')).toBe(false);
  });

  it('requires exactly 11 digits', () => {
    expect(snilsValid('112-233-445')).toBe(false);
    expect(snilsValid('112-233-445 951')).toBe(false);
  });
});

describe('ogrnValid', () => {
  it('accepts the 13-digit fixture and rejects a wrong check digit', () => {
    expect(ogrnValid('1027700132195')).toBe(true);
    expect(ogrnValid('1027700132196')).toBe(false);
  });

  it('validates the 15-digit branch', () => {
    // OGRNIP 304500116000157 is a published example.
    expect(ogrnValid('304500116000157')).toBe(true);
    expect(ogrnValid('304500116000158')).toBe(false);
  });
});

describe('INN validators', () => {
  it('validates 10- and 12-digit INNs', () => {
    expect(inn10Valid('7707083893')).toBe(true);
    expect(inn10Valid('7707083894')).toBe(false);
    expect(inn12Valid('500100732259')).toBe(true);
    expect(inn12Valid('500100732258')).toBe(false);
    expect(innValid('7707083893')).toBe(true);
    expect(innValid('500100732259')).toBe(true);
  });

  it('rejects unsupported lengths', () => {
    expect(innValid('770708389')).toBe(false);
    expect(innValid('77070838931')).toBe(false);
  });
});

describe('ibanValid', () => {
  it('validates a German IBAN with and without spaces', () => {
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanValid('DE89370400440532013001')).toBe(false);
  });

  it('rejects malformed structure and an unsupported checksum', () => {
    expect(ibanValid('DE89')).toBe(false);
    expect(ibanValid('1DE89370400440532013000')).toBe(false);
  });
});
