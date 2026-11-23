/**
 * Pure checksum validators ported from docs_masked (`pii_shield/validators`).
 *
 * All functions accept formatted input and ignore non-digit characters, so a
 * caller can pass the exact regex match (`112-233-445 95`, `4111 1111 ...`).
 * They never throw and never log the value.
 */

/** Keeps ASCII digits only. */
export function digitsOnly(value: string): string {
  return value.replace(/\D+/gu, '');
}

/**
 * Luhn check for payment card numbers.
 * Returns false for anything shorter than two digits.
 */
export function luhnCheck(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length < 2) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * SNILS checksum (docs_masked `snils_ok`):
 * sum(d[i] * (9 - i)) for the first nine digits; <100 is the checksum,
 * 100/101 become 0, otherwise `%101` with 100/101 mapped to 0.
 * Numbers whose first nine digits are identical are rejected.
 */
export function snilsValid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length !== 11) return false;

  const body = digits.slice(0, 9);
  if (/^(\d)\1{8}$/u.test(body)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += (body.charCodeAt(i) - 48) * (9 - i);
  }

  let check: number;
  if (sum < 100) {
    check = sum;
  } else if (sum === 100 || sum === 101) {
    check = 0;
  } else {
    check = sum % 101;
    if (check === 100 || check === 101) check = 0;
  }

  return check === Number(digits.slice(9));
}

const INN10_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN12_FIRST_WEIGHTS = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN12_SECOND_WEIGHTS = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;

function weightedControlDigit(digits: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) {
    sum += (digits.charCodeAt(i) - 48) * (weights[i] ?? 0);
  }
  return (sum % 11) % 10;
}

/** 10-digit INN: one control digit. */
export function inn10Valid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length !== 10) return false;
  return weightedControlDigit(digits, INN10_WEIGHTS) === Number(digits[9]);
}

/** 12-digit INN: two control digits. */
export function inn12Valid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length !== 12) return false;

  const first = weightedControlDigit(digits, INN12_FIRST_WEIGHTS);
  const second = weightedControlDigit(digits, INN12_SECOND_WEIGHTS);
  return first === Number(digits[10]) && second === Number(digits[11]);
}

/** Accepts either a 10- or 12-digit INN. */
export function innValid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length === 10) return inn10Valid(digits);
  if (digits.length === 12) return inn12Valid(digits);
  return false;
}

/**
 * OGRN: 13 digits use `first12 % 11 % 10`, 15 digits use
 * `first14 % 13 % 10`. Both prefixes are below Number.MAX_SAFE_INTEGER.
 */
export function ogrnValid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length === 13) {
    return (Number(digits.slice(0, 12)) % 11) % 10 === Number(digits[12]);
  }
  if (digits.length === 15) {
    return (Number(digits.slice(0, 14)) % 13) % 10 === Number(digits[14]);
  }
  return false;
}

/**
 * IBAN mod-97. Spaces are ignored, letters use A=10..Z=35, the first four
 * characters move to the end. Structural length check: 15..34 characters.
 */
export function ibanValid(value: string): boolean {
  const compact = value.replace(/\s+/gu, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(compact)) return false;

  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else {
      remainder = (remainder * 100 + (code - 55)) % 97;
    }
  }
  return remainder === 1;
}
