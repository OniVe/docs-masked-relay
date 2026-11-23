/**
 * Tag format: `[[<PREFIX>_<LABEL>_<N>]]`, for example `[[DM7F3_PERSON_1]]`.
 *
 * `parseTags` is deliberately more tolerant than `makeTag`: restore has to
 * survive markdown escaping, case changes and spaces injected by editors or
 * ChatGPT's markdown rendering (spec §6.1).
 */

export const TAG_PREFIX_LENGTH = 5;
export const TAG_PREFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const PREFIX_RE = /^[A-Z0-9]{5}$/;
const LABEL_RE = /^[A-Z][A-Z0-9]*$/;

/**
 * Canonical format, strict. Throws on invalid input instead of silently
 * producing a tag that restore could not find.
 */
export function makeTag(prefix: string, label: string, n: number): string {
  const normalizedPrefix = prefix.toUpperCase();
  const normalizedLabel = label.toUpperCase();

  if (!PREFIX_RE.test(normalizedPrefix)) {
    throw new Error(`Invalid tag prefix: expected ${TAG_PREFIX_LENGTH} chars [A-Z0-9]`);
  }
  if (!LABEL_RE.test(normalizedLabel)) {
    throw new Error('Invalid tag label: expected [A-Z][A-Z0-9]*');
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('Invalid tag counter: expected an integer >= 1');
  }

  return `[[${normalizedPrefix}_${normalizedLabel}_${n}]]`;
}

export interface ParsedTag {
  /** Exact matched text, including escapes/spaces. */
  raw: string;
  prefix: string;
  label: string;
  n: number;
  /** Start offset of `raw` in the source text. */
  index: number;
}

/**
 * Tolerant tag scanner. Accepts:
 * - canonical tags;
 * - different case (`[[dm7f3_person_1]]`);
 * - markdown escaping (`\[\[DM7F3\_PERSON\_1\]\]`);
 * - whitespace around separators (`[[DM7F3 _ PERSON _ 1]]`).
 *
 * Invalid counters (0, leading zero) are ignored rather than parsed.
 */
export function parseTags(text: string): ParsedTag[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  // Fresh instance per call: /g regexes keep state in `lastIndex`.
  const re =
    /\\?\[\\?\[\s*([A-Z0-9]{5})\s*\\?_\s*([A-Z][A-Z0-9]*)\s*\\?_\s*([1-9][0-9]*)\s*\\?\]\\?\]/gi;
  const tags: ParsedTag[] = [];

  for (const match of text.matchAll(re)) {
    const [raw, prefix = '', label = '', counter = '0'] = match;
    tags.push({
      raw,
      prefix: prefix.toUpperCase(),
      label: label.toUpperCase(),
      n: Number(counter),
      index: match.index ?? 0,
    });
  }

  return tags;
}

/**
 * Random 5-char vault prefix. Uses rejection sampling so every character in
 * `A-Z0-9` is equally likely (256 % 36 bias avoided).
 */
export function makePrefix(): string {
  const limit = 256 - (256 % TAG_PREFIX_ALPHABET.length); // 252
  let prefix = '';

  while (prefix.length < TAG_PREFIX_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(TAG_PREFIX_LENGTH - prefix.length));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      prefix += TAG_PREFIX_ALPHABET[byte % TAG_PREFIX_ALPHABET.length];
      if (prefix.length === TAG_PREFIX_LENGTH) break;
    }
  }

  return prefix;
}
