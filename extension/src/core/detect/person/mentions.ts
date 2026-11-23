/**
 * Russian person mention grammar.
 *
 * Ported from docs_masked `pii_shield/names_ru.py` (`is_first_name`,
 * `is_patronymic`, `looks_like_surname`, `is_stopword`, `PersonMention`,
 * `find_person_mentions`, `find_repeat_mentions`) — MIT, © 2026 Kirill
 * Pshinnik, commit 905f92362d574351c1f9b22f56685facffa42c54.
 *
 * Patterns (guide §3):
 *   1. three capitalised words, the third a patronymic;
 *   2. `Фамилия И.И.` / `Фамилия И.`;
 *   3. `И.И. Фамилия` / `И. Фамилия`;
 *   4. `Имя Отчество`, `Имя Фамилия`, `Фамилия Имя`;
 *   5. a lone surname after a job/address trigger (always) or at all when
 *      `aggressive` is on.
 */

import {
  CAPITALIZED_STOPWORDS,
  GEO_PREFIXES,
  PATRONYMIC_SUFFIXES,
  PERSON_TRIGGERS,
  RU_FIRST_NAMES,
  SURNAME_SUFFIXES,
} from './dictionaries';
import { toNominative } from './nominative';
import { norm, stem } from './stem';
import { adjacent, kindsOf, type Token, tokenize, windowFrom } from './tokenize';

const NAME_STEMS = new Set(RU_FIRST_NAMES.map((name) => stem(name)));
const STOPWORD_SET = new Set(CAPITALIZED_STOPWORDS);
const STOP_STEMS = new Set(CAPITALIZED_STOPWORDS.map((word) => stem(word)));
const TRIGGER_SET = new Set(PERSON_TRIGGERS);

const PATRONYMIC_M_RE = /^(.*?(?:ович|евич|ьевич|иевич|ич))(?:[аеуойм]{1,3})?$/u;
const PATRONYMIC_F_RE = /^(.*?(?:овн|евн|ьевн|иевн|иничн|ичн))(?:[аыеуойю]{1,3})?$/u;
const SURNAME_OV_RE = /^(.*(?:ов|ев|ёв|ин|ын))(?:а|у|ым|е|ой|ою|ы|ых|ыми|ому|ого)?$/u;
const SURNAME_SK_RE = /^(.*(?:ск|цк))(?:ий|ый|ая|ого|ому|им|ом|ой|ою|ую|ие|ых|их|ими)?$/u;

export type PersonKey = readonly [surname: string, first: string, patronymic: string];

export interface PersonMention {
  start: number;
  end: number;
  surface: string;
  surname: string;
  first: string;
  patronymic: string;
  initials: readonly string[];
  confidence: number;
}

function endsWithAny(value: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => value.endsWith(suffix));
}

export function isFirstName(word: string): boolean {
  return NAME_STEMS.has(stem(word));
}

/** A patronymic in any case, e.g. `Иванович`, `Ивановны`, `Ильичу`. */
export function isPatronymic(word: string): boolean {
  const value = norm(word);
  if (value.length < 6) return false;
  if (endsWithAny(value, PATRONYMIC_SUFFIXES)) return true;
  return PATRONYMIC_M_RE.test(value) || PATRONYMIC_F_RE.test(value);
}

/** A surname in any case, judged by productive suffixes. */
export function looksLikeSurname(word: string): boolean {
  const value = norm(word);
  if (value.length < 4) return false;
  if (STOP_STEMS.has(value) || STOP_STEMS.has(stem(word))) return false;
  if (isPatronymic(word)) return false;
  if (endsWithAny(value, SURNAME_SUFFIXES)) return true;
  return SURNAME_OV_RE.test(value) || SURNAME_SK_RE.test(value);
}

export function isStopword(word: string): boolean {
  return STOPWORD_SET.has(word) || STOP_STEMS.has(stem(word));
}

function precededBy(text: string, token: Token, words: ReadonlySet<string>): boolean {
  const left = text
    .slice(Math.max(0, token.start - 24), token.start)
    .toLowerCase()
    .trim();
  if (left.length === 0) return false;
  const parts = left.split(/[\s,;(]+/u);
  const tail = parts.at(-1) ?? '';
  return tail.length > 0 && words.has(tail);
}

/**
 * Geo abbreviations that are also valid initials. For these the case of the
 * source text decides: `г. Иванов` is an address, while `Г. Иванов` is an
 * initial plus a surname. Lowercasing the left context before the suffix
 * check would suppress the person in the second form (M16-N2). The guard is
 * applied only to lone geo candidates (patterns 4-6, repeats); a multi-token
 * person pattern after `г.` is `господин`/a person and is masked
 * (R22-GEO-1 residual).
 */
const CASE_SENSITIVE_GEO_PREFIXES: ReadonlySet<string> = new Set(['г.']);

/**
 * `2020 г.`, `2020-01-01 г.` and `01.01.2020 г.` use `г.` as "год", not
 * "город". Without this guard the geo suppression hides a person right after
 * a date (PII leak: `В 2020 г. Иванов И.И.` was left unmasked; R22-GEO-1,
 * R23-GEO-4). The year/date tail must be preceded by a non-digit, so a longer
 * digit run is not mistaken for a date.
 */
const DATE_BEFORE_GEO_G =
  /(?:^|\D)(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4}|(?:1[89]|20)\d{2})\s*$/u;

/** Enough left context for an ISO date plus `г.` (R23-GEO-4: 12 was short). */
const GEO_CONTEXT_CHARS = 32;

function afterDateGeoPrefix(text: string, token: Token): boolean {
  const left = text.slice(Math.max(0, token.start - GEO_CONTEXT_CHARS), token.start).trimEnd();
  if (!left.toLowerCase().endsWith('г.')) return false;
  const beforeSuffix = left.slice(0, left.length - 2).trimEnd();
  return DATE_BEFORE_GEO_G.test(beforeSuffix);
}

function afterGeoPrefix(text: string, token: Token): boolean {
  const left = text.slice(Math.max(0, token.start - GEO_CONTEXT_CHARS), token.start);
  const trimmed = left.trimEnd();
  const lowered = trimmed.toLowerCase();
  return GEO_PREFIXES.some((prefix) => {
    if (!lowered.endsWith(prefix)) return false;
    if (!CASE_SENSITIVE_GEO_PREFIXES.has(prefix)) return true;
    if (!trimmed.endsWith(prefix)) return false;
    return !afterDateGeoPrefix(text, token);
  });
}

function makeMention(
  text: string,
  from: Token,
  to: Token,
  fields: Omit<PersonMention, 'start' | 'end' | 'surface' | 'confidence'> & {
    confidence?: number;
  },
): PersonMention {
  return {
    start: from.start,
    end: to.end,
    surface: text.slice(from.start, to.end),
    surname: fields.surname,
    first: fields.first,
    patronymic: fields.patronymic,
    initials: fields.initials,
    confidence: fields.confidence ?? 1,
  };
}

export function findPersonMentions(
  text: string,
  aggressive = false,
  loneFirstNames = false,
): PersonMention[] {
  const tokens = tokenize(text);
  const out: PersonMention[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || (token.kind !== 'cap' && token.kind !== 'init')) {
      index += 1;
      continue;
    }

    const window = windowFrom(text, tokens, index);
    const at = (position: number): Token => window.tokens[position] as Token;
    let matched: PersonMention | undefined;

    // 1. Three capitalised words with a patronymic:
    //    Фамилия Имя Отчество / Имя Отчество Фамилия.
    if (kindsOf(window, 3).join(',') === 'cap,cap,cap') {
      const a = at(0).text;
      const b = at(1).text;
      const c = at(2).text;
      const aStop = isStopword(a);
      const bStop = isStopword(b);
      const cStop = isStopword(c);
      if (!aStop && !bStop && !cStop) {
        if (isPatronymic(c) && (isFirstName(b) || looksLikeSurname(a))) {
          matched = makeMention(text, at(0), at(2), {
            surname: a,
            first: b,
            patronymic: c,
            initials: [],
          });
        } else if (isPatronymic(b)) {
          matched = makeMention(text, at(0), at(2), {
            surname: c,
            first: a,
            patronymic: b,
            initials: [],
          });
        }
      } else if (!aStop && bStop && isFirstName(b) && isPatronymic(c) && looksLikeSurname(a)) {
        // A city-name homonym (`Владимир`) is a valid first name when the
        // window also carries a surname and a patronymic: Фамилия Имя Отчество.
        matched = makeMention(text, at(0), at(2), {
          surname: a,
          first: b,
          patronymic: c,
          initials: [],
        });
      } else if (
        aStop &&
        !bStop &&
        !cStop &&
        isFirstName(a) &&
        isPatronymic(b) &&
        looksLikeSurname(c)
      ) {
        // The same exception in the Имя Отчество Фамилия order. A stopword is
        // still rejected in the surname/patronymic roles.
        matched = makeMention(text, at(0), at(2), {
          surname: c,
          first: a,
          patronymic: b,
          initials: [],
        });
      }
    }

    // 2. Фамилия И.И. / Фамилия И.
    if (matched === undefined && kindsOf(window, 3).join(',') === 'cap,init,init') {
      const a = at(0).text;
      if (!isStopword(a) && (looksLikeSurname(a) || precededBy(text, at(0), TRIGGER_SET))) {
        matched = makeMention(text, at(0), at(2), {
          surname: a,
          first: '',
          patronymic: '',
          initials: [at(1).text.charAt(0), at(2).text.charAt(0)],
        });
      }
    }
    if (matched === undefined && kindsOf(window, 2).join(',') === 'cap,init') {
      const a = at(0).text;
      if (!isStopword(a) && looksLikeSurname(a)) {
        matched = makeMention(text, at(0), at(1), {
          surname: a,
          first: '',
          patronymic: '',
          initials: [at(1).text.charAt(0)],
        });
      }
    }

    // 3. И.И. Фамилия / И. Фамилия.
    if (matched === undefined && kindsOf(window, 3).join(',') === 'init,init,cap') {
      const c = at(2).text;
      if (!isStopword(c) && (looksLikeSurname(c) || precededBy(text, at(0), TRIGGER_SET))) {
        matched = makeMention(text, at(0), at(2), {
          surname: c,
          first: '',
          patronymic: '',
          initials: [at(0).text.charAt(0), at(1).text.charAt(0)],
        });
      }
    }
    if (matched === undefined && kindsOf(window, 2).join(',') === 'init,cap') {
      const c = at(1).text;
      if (!isStopword(c) && looksLikeSurname(c)) {
        matched = makeMention(text, at(0), at(1), {
          surname: c,
          first: '',
          patronymic: '',
          initials: [at(0).text.charAt(0)],
        });
      }
    }

    // 4. Имя Фамилия / Фамилия Имя / Имя Отчество.
    //
    // No geo guard here: a two-token person candidate after `г.` is a person
    // (`г. Иванов Иван`, `г. Иван Иванович`), while a lone city after `г.`
    // stays plaintext through patterns 5-6 and repeats (R23-GEO-4).
    if (matched === undefined && kindsOf(window, 2).join(',') === 'cap,cap') {
      const a = at(0).text;
      const b = at(1).text;
      const aStop = isStopword(a);
      const bStop = isStopword(b);
      if (!aStop && !bStop) {
        if (isFirstName(a) && isPatronymic(b)) {
          matched = makeMention(text, at(0), at(1), {
            surname: '',
            first: a,
            patronymic: b,
            initials: [],
          });
        } else if (isFirstName(a) && looksLikeSurname(b)) {
          matched = makeMention(text, at(0), at(1), {
            surname: b,
            first: a,
            patronymic: '',
            initials: [],
          });
        } else if (looksLikeSurname(a) && isFirstName(b)) {
          matched = makeMention(text, at(0), at(1), {
            surname: a,
            first: b,
            patronymic: '',
            initials: [],
          });
        }
      } else if (aStop && !bStop && isFirstName(a) && isPatronymic(b)) {
        // `Владимир Иванович`: the stopword is the first name here.
        matched = makeMention(text, at(0), at(1), {
          surname: '',
          first: a,
          patronymic: b,
          initials: [],
        });
      } else if (aStop && !bStop && isFirstName(a) && looksLikeSurname(b)) {
        // `Владимир Иванов`: first name + surname.
        matched = makeMention(text, at(0), at(1), {
          surname: b,
          first: a,
          patronymic: '',
          initials: [],
        });
      } else if (!aStop && bStop && looksLikeSurname(a) && isFirstName(b)) {
        // `Иванов Владимир`: surname + first name.
        matched = makeMention(text, at(0), at(1), {
          surname: a,
          first: b,
          patronymic: '',
          initials: [],
        });
      }
    }

    // 5. Lone surname after a trigger, after a date's `г.`, or anywhere in
    // aggressive mode. A lone surname after `2020 г.` is fail-safe masked:
    // over-masking beats leaking a person (R23-GEO-4), while `г. Иванов`
    // without a date keeps the city semantics.
    if (
      matched === undefined &&
      token.kind === 'cap' &&
      !isStopword(token.text) &&
      looksLikeSurname(token.text) &&
      !afterGeoPrefix(text, token) &&
      (afterDateGeoPrefix(text, token) || precededBy(text, token, TRIGGER_SET) || aggressive)
    ) {
      matched = makeMention(text, token, token, {
        surname: token.text,
        first: '',
        patronymic: '',
        initials: [],
        confidence: 0.6,
      });
    }

    // 6. Lone known first name. Opt-in for narrow contexts (Markdown link
    // labels): a bare "Иван" is not enough evidence on its own.
    if (
      matched === undefined &&
      loneFirstNames &&
      token.kind === 'cap' &&
      !isStopword(token.text) &&
      isFirstName(token.text) &&
      !afterGeoPrefix(text, token)
    ) {
      matched = makeMention(text, token, token, {
        surname: '',
        first: token.text,
        patronymic: '',
        initials: [],
        confidence: 0.6,
      });
    }

    if (matched !== undefined) {
      out.push(matched);
      while (index < tokens.length) {
        const current = tokens[index];
        if (current === undefined || current.start >= matched.end) break;
        index += 1;
      }
    } else {
      index += 1;
    }
  }

  return out;
}

/** docs_masked `PersonMention.key`: surname stem + initials, or name stems. */
export function personKey(mention: PersonMention): PersonKey {
  if (mention.surname) {
    const first = mention.first
      ? norm(mention.first).slice(0, 1)
      : mention.initials.length > 0
        ? (mention.initials[0] ?? '').toLowerCase()
        : '';
    const patronymic = mention.patronymic
      ? norm(mention.patronymic).slice(0, 1)
      : mention.initials.length > 1
        ? (mention.initials[1] ?? '').toLowerCase()
        : '';
    return [stem(mention.surname), first.replaceAll('ё', 'е'), patronymic.replaceAll('ё', 'е')];
  }

  return [
    '',
    mention.first ? stem(mention.first) : '',
    mention.patronymic ? stem(mention.patronymic) : '',
  ];
}

export function mentionNominative(mention: PersonMention): string {
  return toNominative(mention.surname, mention.first, mention.patronymic, mention.initials);
}

/**
 * Second pass: lone case forms of already-known people.
 * `knownStems` maps stem -> person key; `covered` holds first-pass intervals.
 */
export function findRepeatMentions(
  text: string,
  knownStems: ReadonlyMap<string, PersonKey>,
  covered: readonly (readonly [number, number])[],
): { start: number; end: number; surface: string; key: PersonKey }[] {
  const hits: { start: number; end: number; surface: string; key: PersonKey }[] = [];
  for (const token of tokenize(text)) {
    if (token.kind !== 'cap') continue;
    if (covered.some(([start, end]) => start <= token.start && token.start < end)) {
      continue;
    }
    // A token after a geo prefix stays a place name: `г. ИВАНОВ` is a city, and
    // a repeated surname of a known person must not turn it into one. The
    // prefix check is case-aware, so `Г. ИВАНОВ` is still initial + surname.
    // After a date's `г.` (`2020 г.`, `2020-01-01 г.`) the token is a person
    // repeat, not a city (R23-GEO-4).
    if (afterGeoPrefix(text, token) && !afterDateGeoPrefix(text, token)) continue;
    const key = knownStems.get(stem(token.text));
    if (key === undefined) continue;
    hits.push({
      start: token.start,
      end: token.end,
      surface: text.slice(token.start, token.end),
      key,
    });
  }
  return hits;
}

/** Whether two tokens are directly adjacent (exported for tests). */
export function tokensAdjacent(text: string, a: Token, b: Token): boolean {
  return adjacent(text, a, b);
}
