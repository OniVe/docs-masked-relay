/**
 * ADDRESS detector ported from docs_masked `d_address`
 * (`pii_shield/detectors.py:345-374`).
 *
 * Grammar: `_LEAD` (0-4 index/geo tokens) + `_STREET` (marker before the
 * name, or the name before the marker) + mandatory `_HOUSE` + `_EXTRA`
 * (apartment/office/building blocks). A short form (6-digit index + 1-3 geo
 * tokens + street, no house) is accepted at priority 82 unless it starts
 * inside a full address.
 *
 * Parity/limitations (kept from docs_masked on purpose):
 * - Street and settlement names must start with a capital Cyrillic letter:
 *   `ул. ленина` and `г. москва` are not addresses. Marker/house/unit words
 *   tolerate a capital first letter so `Ул. Ленина, д. 5` works at sentence
 *   start; all-caps `УЛ.` is still out of scope.
 * - The short form requires a comma after the index (`127001, г. Москва, ...`);
 *   `127001 г. Москва ул. ...` is a known docs_masked gap.
 * - Whitespace inside an address is `[ \u00A0]`, never `\s`: a match does not
 *   cross a line break, so an address split over lines stays un-masked rather
 *   than swallowing unrelated text.
 */

import type { Span } from './span';

/** Makes the first Cyrillic letter accept upper and lower case. */
function firstLetterFold(word: string): string {
  const first = word[0];
  if (first === undefined) return word;
  if (/[А-ЯЁа-яё]/u.test(first)) {
    const upper = first.toUpperCase();
    const lower = first.toLowerCase();
    return upper === lower ? word : `[${upper}${lower}]${word.slice(1)}`;
  }
  return word;
}

function alternatives(words: readonly string[]): string {
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map(firstLetterFold)
    .join('|');
}

/** docs_masked `_GEO` prefixes; longest first avoids partial-prefix retries. */
const GEO_PREFIXES = [
  'город',
  'район',
  'респ',
  'село',
  'деревня',
  'посёлок',
  'поселок',
  'станица',
  'область',
  'микрорайон',
  'гор',
  'пгт',
  'обл',
  'край',
  'р-н',
  'мкр',
  'дер',
  'пос',
  'ст',
  'с',
  'г',
  'д',
] as const;

/** docs_masked `_MARK` street markers. */
const STREET_MARKERS = [
  'улица',
  'проспект',
  'переулок',
  'бульвар',
  'набережная',
  'площадь',
  'проезд',
  'тупик',
  'линия',
  'аллея',
  'шоссе',
  'пр-кт',
  'пр-т',
  'просп',
  'наб',
  'пер',
  'пл',
  'ул',
  'пр',
  'ш',
  'б-р',
] as const;

/** docs_masked `_UNITS` plus the abbreviated forms from the porting guide. */
const UNIT_WORDS = [
  'квартира',
  'корпус',
  'строение',
  'помещение',
  'литера',
  'этаж',
  'офис',
  'строен',
  'помещ',
  'корп',
  'стр',
  'лит',
  'кв',
  'оф',
  'пом',
  'эт',
  'к',
] as const;

const GEO_GROUP = alternatives(GEO_PREFIXES);
const MARK_GROUP = alternatives(STREET_MARKERS);
const UNIT_GROUP = alternatives(UNIT_WORDS);

const GEO = String.raw`(?<![\p{L}\p{N}_])(?:(?:${GEO_GROUP})\.?[ \u00A0]*[А-ЯЁ][а-яё]+(?:-[А-ЯЁа-яё][а-яё]+)*)`;
const INDEX = String.raw`(?<!\d)\d{6}(?!\d)`;

const LEAD = String.raw`(?:(?:${INDEX}|${GEO}),?[ \u00A0]*){0,4}`;

/**
 * Marker-first branch: `ул. Ленина`. The name is lazy so the following house
 * part can take `д. 5`; it stops at a comma, semicolon or line break.
 * Name-first branch: `Садовый проезд`.
 */
const STREET = String.raw`(?:(?<![\p{L}\p{N}_])(?:${MARK_GROUP})\.?[ \u00A0]*[А-ЯЁ0-9][^,;\r\n]{0,45}?|(?<![\p{L}\p{N}_])[А-ЯЁ][А-Яа-яёЁ0-9\- ]{1,40}?[ \u00A0]+(?:${MARK_GROUP})\.?)`;

const HOUSE = String.raw`(?:(?:${alternatives(['дом', 'влд', 'вл', 'д'])}))\.?[ \u00A0]*\d+[а-яА-ЯёЁ]?(?:[/\-]\d+[а-яА-ЯёЁ]?)?`;

/** `, кв. 10`, `, корп. 2`, `, стр. 1, офис 5` (repeating, optional commas). */
const EXTRA = String.raw`(?:,?[ \u00A0]*(?:${UNIT_GROUP})\.?[ \u00A0]*(?:\d+[а-яА-ЯёЁ]?|[А-ЯЁа-яё](?![а-яё])))*`;

const ADDRESS_RE = new RegExp(
  `${LEAD}${STREET},?[ \\u00A0]*${HOUSE}${EXTRA}(?![\\p{L}\\p{N}_])`,
  'gu',
);

/** Every address branch requires a capital Cyrillic settlement/street letter. */
const ADDRESS_HINT_RE = /[А-ЯЁ]/u;

const ADDRESS_SHORT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${INDEX},[ \u00A0]*(?:(?:${GEO}),?[ \u00A0]*){1,3}${STREET}(?![\p{L}\p{N}_])`,
  'gu',
);

function push(out: Span[], text: string, start: number, end: number, priority: number): void {
  if (start < 0 || end <= start || end > text.length) return;
  out.push({
    label: 'ADDRESS',
    start,
    end,
    text: text.slice(start, end),
    priority,
    ruleId: 'ru.address',
  });
}

export function detectAddress(text: string): Span[] {
  // Every branch of the grammar contains at least one capital Cyrillic
  // letter (a settlement or street name). Lowercase/ASCII filler can skip the
  // expensive whole-text regex; this is a pure early-out, not a rule change.
  if (!ADDRESS_HINT_RE.test(text)) return [];
  const out: Span[] = [];
  const full: { start: number; end: number }[] = [];

  for (const match of text.matchAll(ADDRESS_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    full.push({ start, end });
    push(out, text, start, end, 84);
  }

  for (const match of text.matchAll(ADDRESS_SHORT_RE)) {
    const start = match.index ?? 0;
    // A short address that begins inside an already matched full address is
    // redundant; docs_masked keeps only the full span.
    if (full.some((span) => start >= span.start && start < span.end)) continue;
    push(out, text, start, start + match[0].length, 82);
  }

  return out;
}
