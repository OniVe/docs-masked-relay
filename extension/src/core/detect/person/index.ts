/**
 * PERSON detection and document-level person index.
 *
 * Ported from docs_masked `pii_shield/names_ru.py` and the PERSON parts of
 * `pii_shield/masker.py` (`_person_spans`, `_cluster_persons`,
 * `build_person_index`, `_latin_repeat_spans`) — MIT, © 2026 Kirill Pshinnik,
 * commit 905f92362d574351c1f9b22f56685facffa42c54.
 *
 * The detector is intentionally stateless: every span carries a semantic
 * `entityKey`, `nominative`, `canonical` and `canonicalScore`, so the vault
 * can merge mentions without a caller-provided resolver. `personKeys` from an
 * existing vault can be passed as context to recognise repeats across units.
 */

import type { DetectionConfig } from '../../types';
import type { Span } from '../span';
import {
  findPersonMentions,
  findRepeatMentions,
  mentionNominative,
  type PersonKey,
  type PersonMention,
  personKey,
} from './mentions';
import { toNominative } from './nominative';
import { stem } from './stem';

export type { PersonKey } from './mentions';
export { findPersonMentions, personKey } from './mentions';

// ---------------------------------------------------------------------------
// Semantic keys exchanged with the vault
// ---------------------------------------------------------------------------

const KEY_TAG = 'person';
const LATIN_KEY_TAG = 'latin';

/**
 * Person mentions need a Cyrillic capitalised word (including all-caps) or a
 * Latin Title-case word. ASCII all-caps tags (`[[EMAIL_1]]`) intentionally do
 * not count: the Latin grammar only recognises `[A-Z][a-z]+`.
 */
const PERSON_UPPER_HINT_RE = /[А-ЯЁ]|[A-Z][a-z]/u;

// ---------------------------------------------------------------------------
// Density guard (25 MB name-dense fail-closed)
// ---------------------------------------------------------------------------

/**
 * A whole-document PERSON pass is superlinear; a 25 MB name-dense document is
 * not a useful workload, it is a denial-of-service shape. The guard counts
 * uppercase tokens before any tokenizer/index work and fails closed above
 * this cap.
 *
 * Derivation: the existing 8k name-dense perf corpus has 3 uppercase tokens
 * per full name (24 000) and must keep passing, so the cap sits above it with
 * >2x headroom. A 25 MB Cyrillic name-dense text averages ~39 UTF-8 bytes per
 * `Фамилия Имя Отчество` line, i.e. ~670 000 names and ~2.0M tokens — ~40x the
 * cap. The normal 25 MB JSON/XML/email-dense perf corpus carries ~0-1.3k
 * uppercase tokens (XML `CDATA` markers), so it stays far below the cap.
 */
export const MAX_PERSON_TOKENS = 50_000;

export const DENSITY_LIMIT_MESSAGE =
  'Файл содержит слишком много имён или сущностей для обработки. Разбейте его на части.';

/** Typed fail-closed rejection for documents with too many candidate names. */
export class DensityLimitError extends Error {
  readonly code = 'TOO_MANY_ENTITIES' as const;

  constructor(message: string = DENSITY_LIMIT_MESSAGE) {
    super(message);
    this.name = 'DensityLimitError';
  }
}

/** One uppercase letter followed by letters/marks/apostrophes/hyphen, or a lone initial (`И.`, `I.`). */
const UPPER_TOKEN_RE = /[\p{Lu}](?:[\p{L}\p{M}'’-]+|\.)/gu;

/**
 * Throws `DensityLimitError` once the uppercase-token total across all `units`
 * exceeds `maxTokens`. The count is aggregate (a string is one unit): two
 * individually small units must not bypass the cap. Every match is at least
 * two UTF-16 units, so a total shorter than `2 * limit` cannot exceed the cap
 * and skips the scan. Non-positive/non-integer overrides fall back to the
 * default: the guard must not be disabled by a malformed setting.
 */
export function assertPersonDensity(
  units: string | readonly string[],
  maxTokens: number = MAX_PERSON_TOKENS,
): void {
  const limit = Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : MAX_PERSON_TOKENS;
  const list = typeof units === 'string' ? [units] : units;

  let totalLength = 0;
  for (const unit of list) totalLength += unit.length;
  if (totalLength < limit * 2) return;

  let count = 0;
  for (const unit of list) {
    for (const _match of unit.matchAll(UPPER_TOKEN_RE)) {
      count += 1;
      if (count > limit) throw new DensityLimitError();
    }
  }
}

export function encodePersonKey(key: PersonKey): string {
  return JSON.stringify([KEY_TAG, key[0], key[1], key[2]]);
}

export function decodePersonKey(semantic: string): PersonKey | undefined {
  try {
    const parsed: unknown = JSON.parse(semantic);
    if (!Array.isArray(parsed) || parsed[0] !== KEY_TAG) return undefined;
    if (parsed.length !== 4) return undefined;
    const [, surname, first, patronymic] = parsed;
    if (
      typeof surname !== 'string' ||
      typeof first !== 'string' ||
      typeof patronymic !== 'string'
    ) {
      return undefined;
    }
    return [surname, first, patronymic];
  } catch {
    return undefined;
  }
}

export function encodeLatinKey(key: string): string {
  return JSON.stringify([LATIN_KEY_TAG, key]);
}

export function decodeLatinKey(semantic: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(semantic);
    if (!Array.isArray(parsed) || parsed[0] !== LATIN_KEY_TAG) return undefined;
    if (parsed.length !== 2 || typeof parsed[1] !== 'string') return undefined;
    return parsed[1];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Canonical score and hints
// ---------------------------------------------------------------------------

/** docs_masked PERSON score: word count first, then shorter surface wins. */
export function personCanonicalScore(surface: string): number {
  const words = surface.trim().split(/\s+/u).filter(Boolean).length;
  return words * 1_000_000 - surface.length;
}

export function personSpanNominative(
  surname: string,
  first = '',
  patronymic = '',
  initials: readonly string[] = [],
): string {
  return toNominative(surname, first, patronymic, initials);
}

// ---------------------------------------------------------------------------
// Latin names
// ---------------------------------------------------------------------------

const TITLE = String.raw`(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sir)\.?`;
const SLAVIC_TAIL = `(?:ovich|evich|ovna|evna|ich|ov|ova|ev|eva|yov|yova|in|ina|yn|yna|sky|skiy|skaya|tsky|tskaya|enko|chuk|uk|yuk|yan|dze|shvili|adze)`;
const TAIL_END_RE = new RegExp(`${SLAVIC_TAIL}$`, 'i');
const TAIL_FULL_RE = new RegExp(`^${SLAVIC_TAIL}$`, 'i');
const TITLED_RE = new RegExp(
  String.raw`\b${TITLE}\s+[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,2}\b`,
  'g',
);
const TITLE_PREFIX_RE = new RegExp(String.raw`^${TITLE}\s+`);
const LATIN_NAME_RUN_RE = /\b[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,2}\b/g;
const LATIN_WORD_RE = /\b[A-Z][a-z]{2,20}\b/g;

const LATIN_STOP = new Set([
  'The',
  'This',
  'That',
  'And',
  'For',
  'With',
  'From',
  'Company',
  'Ltd',
  'Inc',
  'Corp',
  'Group',
  'Bank',
  'Street',
  'Avenue',
  'Road',
  'City',
  'Region',
  'State',
  'Russia',
  'Moscow',
  'Saint',
  'Petersburg',
  'Kazan',
  'Minsk',
  'Kiev',
  'Kyiv',
  'Almaty',
  'Astana',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'Total',
  'Subject',
  'Date',
  'Number',
  'Address',
  'Phone',
  'Email',
  'Contract',
  'Agreement',
  'Attachment',
  'Note',
  'Page',
  'Section',
  'Article',
  'Chapter',
  'General',
  'Director',
  'Manager',
  'Chief',
  'Head',
  'Senior',
  'Junior',
  'Lead',
]);

function latinKey(words: readonly string[]): string {
  for (const word of words) {
    if (TAIL_END_RE.test(word) && !TAIL_FULL_RE.test(word)) {
      return word.toLowerCase();
    }
  }
  return words.map((word) => word.toLowerCase()).join(' ');
}

function latinWords(value: string): string[] {
  return [...value.matchAll(/[A-Z][a-z]+/g)].map((match) => match[0]);
}

interface Intervals {
  start: number;
  end: number;
}

function isCovered(intervals: readonly Intervals[], start: number): boolean {
  return intervals.some((interval) => interval.start <= start && start < interval.end);
}

interface LatinBase {
  spans: Span[];
  intervals: Intervals[];
}

function detectLatinBaseSpans(text: string): LatinBase {
  const spans: Span[] = [];
  const intervals: Intervals[] = [];

  for (const match of text.matchAll(TITLED_RE)) {
    const surface = match[0];
    const start = match.index ?? 0;
    const withoutTitle = surface.replace(TITLE_PREFIX_RE, '');
    const key = latinKey(withoutTitle.split(/\s+/u).filter(Boolean));
    spans.push({
      label: 'PERSON',
      start,
      end: start + surface.length,
      text: surface,
      priority: 80,
      ruleId: 'latin.person.title',
      entityKey: encodeLatinKey(key),
      canonical: surface,
      canonicalScore: personCanonicalScore(surface),
      personConfidence: 1,
    });
    intervals.push({ start, end: start + surface.length });
  }

  for (const match of text.matchAll(LATIN_NAME_RUN_RE)) {
    const start = match.index ?? 0;
    if (isCovered(intervals, start)) continue;
    const surface = match[0];
    const words = surface.split(/\s+/u).filter(Boolean);
    if (words.some((word) => LATIN_STOP.has(word))) continue;
    if (!words.some((word) => TAIL_END_RE.test(word))) continue;

    spans.push({
      label: 'PERSON',
      start,
      end: start + surface.length,
      text: surface,
      priority: 78,
      ruleId: 'latin.person.tail',
      entityKey: encodeLatinKey(latinKey(words)),
      canonical: surface,
      canonicalScore: personCanonicalScore(surface),
      personConfidence: 1,
    });
    intervals.push({ start, end: start + surface.length });
  }

  return { spans, intervals };
}

// ---------------------------------------------------------------------------
// Document index
// ---------------------------------------------------------------------------

export interface PersonIndex {
  /** stem -> person key; `null` marks an ambiguous stem. */
  stems: Map<string, PersonKey | null>;
  /** lower-cased Latin word -> Latin key; `null` marks ambiguity. */
  latin: Map<string, string | null>;
}

interface DetailedIndex {
  bySurname: Map<string, Map<string, PersonKey>>;
}

function keysEqual(a: PersonKey, b: PersonKey): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function addDetailed(target: DetailedIndex, key: PersonKey): void {
  if (!key[0] || (!key[1] && !key[2])) return;
  let bucket = target.bySurname.get(key[0]);
  if (bucket === undefined) {
    bucket = new Map();
    target.bySurname.set(key[0], bucket);
  }
  bucket.set(encodePersonKey(key), key);
}

function detailedFromIndex(index: PersonIndex): DetailedIndex {
  const detailed: DetailedIndex = { bySurname: new Map() };
  for (const key of index.stems.values()) {
    if (key !== null) addDetailed(detailed, key);
  }
  return detailed;
}

function setStem(index: PersonIndex, stemValue: string, key: PersonKey): void {
  if (stemValue.length === 0) return;
  const existing = index.stems.get(stemValue);
  if (existing === null) return;
  if (existing !== undefined) {
    if (!keysEqual(existing, key)) index.stems.set(stemValue, null);
    return;
  }
  index.stems.set(stemValue, key);
}

function setLatin(index: PersonIndex, word: string, key: string): void {
  if (word.length === 0) return;
  const existing = index.latin.get(word);
  if (existing === null) return;
  if (existing !== undefined) {
    if (existing !== key) index.latin.set(word, null);
    return;
  }
  index.latin.set(word, key);
}

function addLatinWords(index: PersonIndex, key: string): void {
  for (const word of key.split(/\s+/u).filter(Boolean)) {
    if (TAIL_END_RE.test(word)) setLatin(index, word.toLowerCase(), key);
  }
}

/** Cluster incomplete mentions against full keys (surname + initials). */
function clusterMentions(mentions: readonly PersonMention[], detailed: DetailedIndex): PersonKey[] {
  for (const mention of mentions) {
    addDetailed(detailed, personKey(mention));
  }

  return mentions.map((mention) => {
    const key = personKey(mention);
    if (!key[0]) return key;
    const bucket = detailed.bySurname.get(key[0]);
    if (bucket === undefined) return key;

    const candidates = [...bucket.values()].filter(
      (candidate) => (!key[1] || key[1] === candidate[1]) && (!key[2] || key[2] === candidate[2]),
    );
    return candidates.length === 1 ? (candidates[0] as PersonKey) : key;
  });
}

function seedFromKnownKeys(index: PersonIndex, known: Record<string, string> | undefined): void {
  if (known === undefined) return;
  for (const semantic of Object.keys(known)) {
    const person = decodePersonKey(semantic);
    if (person !== undefined) {
      if (person[0] && (person[1] || person[2])) {
        setStem(index, person[0], person);
      }
      continue;
    }
    const latin = decodeLatinKey(semantic);
    if (latin !== undefined) addLatinWords(index, latin);
  }
}

/**
 * First pass over one text or all document units: `stem -> person key`, plus
 * a Latin-word index. Conflicting stems become `null` (masked separately).
 * `knownKeys` is `Vault.personKeys` from a previous call.
 */
export function buildPersonIndex(
  units: string | readonly string[],
  config: DetectionConfig = {},
  knownKeys?: Record<string, string>,
): PersonIndex {
  const index: PersonIndex = { stems: new Map(), latin: new Map() };
  seedFromKnownKeys(index, knownKeys);

  const list = typeof units === 'string' ? [units] : units;
  // The guard lives here, not only in `detectPersonSpans`: `buildPersonIndex`
  // is public core API and must not be a bypass around the density cap. The
  // count is aggregate over all units, so many small units cannot slip under
  // a per-unit check.
  assertPersonDensity(list, config.maxPersonTokens ?? MAX_PERSON_TOKENS);
  const detailed = detailedFromIndex(index);

  for (const unit of list) {
    if (unit.length === 0 || unit.trim().length === 0) continue;

    for (const latinSpan of detectLatinBaseSpans(unit).spans) {
      const key = decodeLatinKey(latinSpan.entityKey ?? '');
      if (key !== undefined) addLatinWords(index, key);
    }

    const mentions = findPersonMentions(unit, config.aggressive === true);
    const clustered = clusterMentions(mentions, detailed);
    for (let i = 0; i < mentions.length; i += 1) {
      const mention = mentions[i];
      const key = clustered[i];
      if (mention === undefined || key === undefined) continue;
      if (!key[0] || (!key[1] && !key[2])) continue;
      if (mention.surname) setStem(index, stem(mention.surname), key);
      if (mention.first) setStem(index, stem(mention.first), key);
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface PersonDetectContext {
  /** `Vault.personKeys`: semantic key -> entity key. */
  personKeys?: Record<string, string>;
}

function personSpan(
  text: string,
  start: number,
  end: number,
  priority: number,
  ruleId: string,
  key: PersonKey,
  nominative: string,
  confidence: number,
): Span {
  const surface = text.slice(start, end);
  return {
    label: 'PERSON',
    start,
    end,
    text: surface,
    priority,
    ruleId,
    entityKey: encodePersonKey(key),
    nominative,
    canonical: surface,
    canonicalScore: personCanonicalScore(surface),
    personConfidence: confidence,
  };
}

export function detectPersonSpans(
  text: string,
  config: DetectionConfig = {},
  context: PersonDetectContext = {},
): Span[] {
  if (text.length === 0) return [];

  // Every mention shape requires an uppercase Latin/Cyrillic letter. Without
  // one (and without repeat keys from an earlier document) the whole index,
  // tokenizer and repeat scan cannot produce a span. This is a pure early-out:
  // a non-empty personKeys map always takes the full path.
  const knownKeys = context.personKeys;
  const hasKnownKeys = knownKeys !== undefined && Object.keys(knownKeys).length > 0;
  if (!hasKnownKeys && !PERSON_UPPER_HINT_RE.test(text)) return [];

  const index = buildPersonIndex(text, config, context.personKeys);
  const mentions = findPersonMentions(
    text,
    config.aggressive === true,
    config.loneFirstNames === true,
  );
  const detailed = detailedFromIndex(index);
  const clustered = clusterMentions(mentions, detailed);

  const spans: Span[] = [];
  const covered: Intervals[] = [];

  for (let i = 0; i < mentions.length; i += 1) {
    const mention = mentions[i];
    const key = clustered[i];
    if (mention === undefined || key === undefined) continue;
    spans.push(
      personSpan(
        text,
        mention.start,
        mention.end,
        Math.trunc(76 * mention.confidence) + 10,
        mention.confidence < 1 ? 'person.aggressive' : 'person',
        key,
        mentionNominative(mention),
        mention.confidence,
      ),
    );
    covered.push({ start: mention.start, end: mention.end });
  }

  // stem -> clustered key for repeat mentions, with ambiguity tracking.
  const knownStems = new Map<string, PersonKey>();
  const ambiguous = new Set<string>();

  const remember = (stemValue: string, key: PersonKey): void => {
    if (stemValue.length === 0) return;
    const existing = knownStems.get(stemValue);
    if (existing !== undefined && !keysEqual(existing, key)) {
      ambiguous.add(stemValue);
    } else if (existing === undefined) {
      knownStems.set(stemValue, key);
    }
  };

  for (let i = 0; i < mentions.length; i += 1) {
    const mention = mentions[i];
    const key = clustered[i];
    if (mention === undefined || key === undefined) continue;
    if (mention.surname) remember(stem(mention.surname), key);
    if (mention.first) remember(stem(mention.first), key);
  }

  for (const [stemValue, key] of index.stems) {
    if (key === null) {
      ambiguous.add(stemValue);
      if (!knownStems.has(stemValue)) {
        knownStems.set(stemValue, [stemValue, '', '']);
      }
    } else {
      const existing = knownStems.get(stemValue);
      if (existing !== undefined && !keysEqual(existing, key)) {
        ambiguous.add(stemValue);
      } else {
        knownStems.set(stemValue, key);
      }
    }
  }

  // Ambiguous surnames are still masked, but under a stem-bound tag.
  for (const stemValue of ambiguous) {
    knownStems.set(stemValue, [stemValue, '', '']);
  }

  for (const hit of findRepeatMentions(
    text,
    knownStems,
    covered.map((interval) => [interval.start, interval.end] as const),
  )) {
    spans.push(
      personSpan(
        text,
        hit.start,
        hit.end,
        74,
        'person.repeat',
        hit.key,
        toNominative(hit.surface),
        0.75,
      ),
    );
  }

  // Latin titled/tail persons and single-word repeats of known Latin people.
  const latin = detectLatinBaseSpans(text);
  spans.push(...latin.spans);
  const coveredLatin: Intervals[] = [...covered, ...latin.intervals];

  const latinIndex = new Map<string, string>();
  for (const [word, key] of index.latin) {
    if (key !== null) latinIndex.set(word, key);
  }
  for (const span of latin.spans) {
    const key = decodeLatinKey(span.entityKey ?? '');
    if (key === undefined) continue;
    for (const word of latinWords(span.text)) {
      if (TAIL_END_RE.test(word) && !latinIndex.has(word.toLowerCase())) {
        latinIndex.set(word.toLowerCase(), key);
      }
    }
  }

  for (const match of text.matchAll(LATIN_WORD_RE)) {
    const word = match[0];
    if (LATIN_STOP.has(word)) continue;
    const start = match.index ?? 0;
    if (isCovered(coveredLatin, start)) continue;
    const key = latinIndex.get(word.toLowerCase());
    if (key === undefined) continue;
    const surface = word;
    spans.push({
      label: 'PERSON',
      start,
      end: start + surface.length,
      text: surface,
      priority: 73,
      ruleId: 'latin.repeat',
      entityKey: encodeLatinKey(key),
      canonical: surface,
      canonicalScore: personCanonicalScore(surface),
      personConfidence: 0.75,
    });
  }

  return spans.sort((a, b) => a.start - b.start || b.priority - a.priority);
}
