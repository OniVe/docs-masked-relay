/**
 * Left-context helpers. JS `\b`/`\w` are ASCII-only even with `/u`, so all
 * "is this a word" checks here use Unicode property escapes instead.
 */

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

export function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR_RE.test(char);
}

/** Raw left window, capped at `maxChars` (negative values clamp to 0). */
export function leftContext(text: string, start: number, maxChars: number): string {
  const from = Math.max(0, start - Math.max(0, maxChars));
  return text.slice(from, Math.max(0, start));
}

/**
 * Last Unicode word immediately to the left, lower-cased.
 * `«СНИЛС: 112...»` -> `снилс`; `телефон+7...` -> `телефон`.
 */
export function lastWordBefore(text: string, start: number, maxChars: number): string {
  const window = leftContext(text, start, maxChars);
  let end = window.length;
  while (end > 0 && !isWordChar(window[end - 1])) end -= 1;
  let begin = end;
  while (begin > 0 && isWordChar(window[begin - 1])) begin -= 1;
  return window.slice(begin, end).toLowerCase();
}

/** Exact whole-word match of the nearest left word. */
export function hasWordBefore(
  text: string,
  start: number,
  maxChars: number,
  words: Iterable<string>,
): boolean {
  const word = lastWordBefore(text, start, maxChars);
  if (word.length === 0) return false;

  for (const candidate of words) {
    if (candidate.toLowerCase() === word) return true;
  }
  return false;
}

/**
 * Substring match inside the left window. docs_masked `_has_context` uses
 * this for multi-word triggers such as `код подразделения` and
 * `дата выдачи`; callers that need a single word use `hasWordBefore`.
 */
export function hasContextBefore(
  text: string,
  start: number,
  maxChars: number,
  phrases: readonly string[],
): boolean {
  if (phrases.length === 0) return false;
  const window = leftContext(text, start, maxChars).toLowerCase();
  return phrases.some((phrase) => window.includes(phrase.toLowerCase()));
}
