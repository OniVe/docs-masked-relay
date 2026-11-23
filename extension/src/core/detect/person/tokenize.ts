/**
 * Tokenizer for Russian person mentions.
 *
 * Ported from docs_masked `pii_shield/names_ru.py` (`_TOK_RE`, `tokenize`,
 * `_adjacent`) — MIT, © 2026 Kirill Pshinnik,
 * commit 905f92362d574351c1f9b22f56685facffa42c54.
 *
 * Only Cyrillic-capitalised words, initials, lowercase words, Latin words and
 * numbers are tokens. A Cyrillic ALL-CAPS word is tokenised as a capitalised
 * word whose `text` is title-cased for the grammar, while `start`/`end` still
 * point at the original surface (M16-N2). A lone capital letter without a dot
 * is intentionally not tokenised (docs_masked behaviour).
 */

export type TokenKind = 'init' | 'cap' | 'low' | 'lat' | 'num';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Inclusive UTF-16 offset. */
  start: number;
  /** Exclusive UTF-16 offset. */
  end: number;
}

const TOKEN_RE =
  /(?<init>[А-ЯЁ]\.)|(?<cap>[А-ЯЁ][а-яё]+(?:-[А-ЯЁа-яё][а-яё]+)?)|(?<caps>[А-ЯЁ]{2,}(?:-[А-ЯЁ]{2,})*)|(?<low>[а-яё]+(?:-[а-яё]+)?\.?)|(?<lat>[A-Za-z][A-Za-z'’-]*)|(?<num>[0-9]+)/g;

/** `ИВАНОВ-ПЕТРОВ` -> `Иванов-Петров`; offsets and length stay unchanged. */
function titleCaseCaps(value: string): string {
  return value
    .split('-')
    .map((part) => {
      const first = part.charAt(0);
      return first.length === 0 ? part : `${first}${part.slice(1).toLowerCase()}`;
    })
    .join('-');
}

const ADJACENT_RE = /^[ \u00A0]{1,2}$/u;

/** A single Cyrillic/Latin letter followed by a dot, e.g. `И.`. */
export const INITIAL_ONLY_RE = /^[А-ЯЁA-Z]\.$/u;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  for (;;) {
    const match = TOKEN_RE.exec(text);
    if (match === null) break;
    const groups = match.groups;
    const kind: TokenKind = groups?.init
      ? 'init'
      : groups?.cap || groups?.caps
        ? 'cap'
        : groups?.low
          ? 'low'
          : groups?.lat
            ? 'lat'
            : 'num';
    const start = match.index;
    const tokenText = groups?.caps ? titleCaseCaps(match[0]) : match[0];
    out.push({ kind, text: tokenText, start, end: start + match[0].length });
  }
  return out;
}

/**
 * Tokens are adjacent when the gap is empty or one/two ordinary or NBSP
 * spaces. Tabs and line breaks deliberately break a full name.
 */
export function adjacent(text: string, a: Token, b: Token): boolean {
  const gap = text.slice(a.end, b.start);
  return gap === '' || ADJACENT_RE.test(gap);
}

/** Token lookahead window used by the mention grammar (1-4 tokens). */
export function windowFrom(
  text: string,
  tokens: readonly Token[],
  index: number,
): { tokens: Token[]; adjacent: boolean[] } {
  const next = tokens.slice(index, Math.min(index + 4, tokens.length));
  const adjacentFlags = [true];
  for (let i = 1; i < next.length; i += 1) {
    const previous = next[i - 1];
    const current = next[i];
    adjacentFlags.push(
      previous !== undefined && current !== undefined && adjacent(text, previous, current),
    );
  }
  return { tokens: next, adjacent: adjacentFlags };
}

/** Returns the first `count` token kinds only when all of them are adjacent. */
export function kindsOf(
  window: { tokens: readonly Token[]; adjacent: readonly boolean[] },
  count: number,
): TokenKind[] {
  if (window.tokens.length < count) return [];
  if (!window.adjacent.slice(0, count).every(Boolean)) return [];
  return window.tokens.slice(0, count).map((token) => token.kind);
}
