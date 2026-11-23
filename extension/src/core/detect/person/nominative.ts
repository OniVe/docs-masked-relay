/**
 * Reconstruction of the nominative case for Russian names.
 *
 * Ported from docs_masked `pii_shield/names_ru.py` (`guess_gender`,
 * `_patronymic_nominative`, `_surname_nominative`, `_first_nominative`,
 * `to_nominative`, `_build_name_index`) — MIT, © 2026 Kirill Pshinnik,
 * commit 905f92362d574351c1f9b22f56685facffa42c54.
 *
 * Gender is derived from the patronymic first, then from the surname ending,
 * then from a known first name. When gender is unknown the surname is left
 * untouched: `Петрова` alone can be either feminine or genitive masculine.
 */

import { RU_FIRST_NAMES } from './dictionaries';
import { norm, stem } from './stem';
import { INITIAL_ONLY_RE } from './tokenize';

const MALE_A_NAMES = new Set([
  'никита',
  'илья',
  'кузьма',
  'фома',
  'лука',
  'савва',
  'данила',
  'гаврила',
  'мина',
  'сила',
  'фока',
]);

const PATRONYMIC_M_RE = /^(.*?(?:ович|евич|ьевич|иевич|ич))(?:[аеуойм]{1,3})?$/u;
const PATRONYMIC_F_RE = /^(.*?(?:овн|евн|ьевн|иевн|иничн|ичн))(?:[аыеуойю]{1,3})?$/u;
const SURNAME_OV_RE = /^(.*(?:ов|ев|ёв|ин|ын))(?:а|у|ым|е|ой|ою|ы|ых|ыми|ому|ого)?$/u;
const SURNAME_SK_RE = /^(.*(?:ск|цк))(?:ий|ый|ая|ого|ому|им|ом|ой|ою|ую|ие|ых|их|ими)?$/u;

type Gender = 'm' | 'f' | '';

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function isFemaleName(name: string): boolean {
  return (name.endsWith('а') || name.endsWith('я')) && !MALE_A_NAMES.has(name);
}

interface NameIndex {
  male: Map<string, string[]>;
  female: Map<string, string[]>;
  any: Map<string, string[]>;
}

function buildNameIndex(): NameIndex {
  const male = new Map<string, string[]>();
  const female = new Map<string, string[]>();
  const any = new Map<string, string[]>();

  const push = (table: Map<string, string[]>, key: string, name: string): void => {
    const existing = table.get(key);
    if (existing) existing.push(name);
    else table.set(key, [name]);
  };

  for (const name of [...RU_FIRST_NAMES].sort()) {
    const key = stem(name);
    const target = isFemaleName(name) ? female : male;
    push(target, key, capitalize(name));
    push(any, key, capitalize(name));
  }

  return { male, female, any };
}

const NAME_INDEX = buildNameIndex();

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let matched = 0;
  while (matched < limit && a.charAt(matched) === b.charAt(matched)) {
    matched += 1;
  }
  return matched;
}

function patronymicNominative(word: string): { value: string; gender: Gender } {
  const lower = word.toLowerCase();
  const male = PATRONYMIC_M_RE.exec(lower);
  if (male) return { value: capitalize(male[1] ?? ''), gender: 'm' };

  const female = PATRONYMIC_F_RE.exec(lower);
  if (female) return { value: capitalize(`${female[1] ?? ''}а`), gender: 'f' };

  return { value: word, gender: '' };
}

function surnameNominative(word: string, gender: Gender): string {
  if (!gender) {
    return /^[А-ЯЁA-Z]/u.test(word) ? word : capitalize(word);
  }

  const lower = word.toLowerCase();
  const regular = SURNAME_OV_RE.exec(lower);
  if (regular) {
    return capitalize(`${regular[1] ?? ''}${gender === 'f' ? 'а' : ''}`);
  }

  const sk = SURNAME_SK_RE.exec(lower);
  if (sk) {
    return capitalize(`${sk[1] ?? ''}${gender === 'f' ? 'ая' : 'ий'}`);
  }

  return /^[А-ЯЁA-Z]/u.test(word) ? word : capitalize(word);
}

function firstNominative(word: string, gender: Gender = ''): string {
  const key = stem(word);
  const table = gender === 'm' ? NAME_INDEX.male : gender === 'f' ? NAME_INDEX.female : undefined;
  const candidates = table?.get(key) ?? NAME_INDEX.any.get(key);
  if (candidates === undefined || candidates.length === 0) {
    return capitalize(word);
  }
  if (candidates.length === 1) {
    return candidates[0] ?? capitalize(word);
  }

  const lower = word.toLowerCase();
  let best = candidates[0] ?? capitalize(word);
  let bestScore = commonPrefix(lower, best.toLowerCase());
  for (const candidate of candidates.slice(1)) {
    const score = commonPrefix(lower, candidate.toLowerCase());
    // Same tie-break as docs_masked: more shared prefix, then shorter name.
    if (score > bestScore || (score === bestScore && candidate.length < best.length)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function guessGender(surname = '', first = '', patronymic = ''): Gender {
  if (patronymic) {
    const guessed = patronymicNominative(patronymic).gender;
    if (guessed) return guessed;
  }

  const lowSurname = norm(surname);
  if (
    lowSurname.endsWith('ой') ||
    lowSurname.endsWith('ою') ||
    lowSurname.endsWith('ая') ||
    lowSurname.endsWith('ей')
  ) {
    return 'f';
  }

  if (first) {
    const key = stem(first);
    const inMale = NAME_INDEX.male.has(key);
    const inFemale = NAME_INDEX.female.has(key);
    if (inFemale && !inMale) return 'f';
    if (inMale && !inFemale) return 'm';
    if (isFemaleName(norm(first))) return 'f';
  }

  return '';
}

/** Builds the nominative form from any oblique mention of one person. */
export function toNominative(
  surname = '',
  first = '',
  patronymic = '',
  initials: readonly string[] = [],
): string {
  const gender = guessGender(surname, first, patronymic);
  const parts: string[] = [];

  if (surname) {
    parts.push(surnameNominative(surname, gender));
  }
  if (first) {
    parts.push(firstNominative(first, gender));
  } else if (initials.length > 0) {
    parts.push(initials.map((initial) => `${initial.toUpperCase()}.`).join(' '));
  }
  if (patronymic) {
    parts.push(patronymicNominative(patronymic).value);
  }

  return parts.join(' ');
}

export interface HintScore {
  fullWords: number;
  totalWords: number;
}

/**
 * Quality of a nominative hint: full words first, then word count. Equal
 * scores never replace the current hint (docs_masked `_hint_score`).
 */
export function hintScore(hint: string | undefined): HintScore {
  if (!hint) return { fullWords: 0, totalWords: 0 };
  const tokens = hint.split(/\s+/u).filter(Boolean);
  let fullWords = 0;
  for (const token of tokens) {
    if (!INITIAL_ONLY_RE.test(token)) fullWords += 1;
  }
  return { fullWords, totalWords: tokens.length };
}

export function hintScoreGreater(a: string | undefined, b: string | undefined): boolean {
  const left = hintScore(a);
  const right = hintScore(b);
  if (left.fullWords !== right.fullWords) return left.fullWords > right.fullWords;
  return left.totalWords > right.totalWords;
}
