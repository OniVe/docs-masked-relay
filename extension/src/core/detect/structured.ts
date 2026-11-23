/**
 * Structured PII detectors ported from docs_masked (`pii_shield/detectors.py`).
 *
 * M1a implements every structured rule listed in the porting guide; M1b1 adds
 * PERSON from `pii_shield/names_ru.py`; M1b2 moves ORG (`./org`) and ADDRESS
 * (`./address`) out of stubs.
 *
 * Unicode rules: no `\b`/`\w` for Cyrillic. Boundaries are explicit
 * `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])` lookarounds with `/u`.
 */

import {
  digitsOnly,
  ibanValid,
  inn10Valid,
  inn12Valid,
  luhnCheck,
  ogrnValid,
  snilsValid,
} from '../checksums';
import type { DetectionConfig, EntityLabel } from '../types';
import { detectAddress } from './address';
import { hasContextBefore } from './context';
import { detectOrg } from './org';
import { detectPersonSpans, type PersonDetectContext } from './person';
import type { Span } from './span';
import {
  type CandidateRegion,
  getStructuredScanner,
  REGION_EMAIL,
  REGION_HANDLE,
  REGION_IBAN,
  REGION_LICENSE,
  REGION_NUMERIC,
  REGION_URL,
} from './wasm-scan';

function push(
  out: Span[],
  text: string,
  label: EntityLabel,
  start: number,
  end: number,
  priority: number,
  ruleId: string,
): void {
  if (start < 0 || end <= start || end > text.length) return;
  out.push({
    label,
    start,
    end,
    text: text.slice(start, end),
    priority,
    ruleId,
  });
}

function collect(
  text: string,
  re: RegExp,
  label: EntityLabel,
  priority: number,
  ruleId: string,
  accept?: (raw: string, start: number) => boolean,
): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const start = match.index ?? 0;
    if (accept && !accept(raw, start)) continue;
    push(out, text, label, start, start + raw.length, priority, ruleId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// EMAIL / URL / HANDLE
// ---------------------------------------------------------------------------

const EMAIL_RE =
  /(?<![\p{L}\p{N}_.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}(?![\p{L}\p{N}_])/gu;

const URL_HTTP_RE = /(?<![\p{L}\p{N}_])https?:\/\/[^\s<>"')\]]+/giu;
const URL_WWW_RE =
  /(?<![\p{L}\p{N}_])www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,12}[^\s<>"')\]]*/giu;

const HANDLE_RE = /(?<![\p{L}\p{N}@./_])@[A-Za-z][A-Za-z0-9_]{3,31}(?![\p{L}\p{N}_])/gu;

export function detectEmail(text: string): Span[] {
  return collect(text, EMAIL_RE, 'EMAIL', 95, 'email');
}

export function detectUrl(text: string): Span[] {
  return [
    ...collect(text, URL_HTTP_RE, 'URL', 40, 'url.http'),
    ...collect(text, URL_WWW_RE, 'URL', 40, 'url.www'),
  ];
}

export function detectHandle(text: string): Span[] {
  return collect(text, HANDLE_RE, 'HANDLE', 85, 'handle');
}

// ---------------------------------------------------------------------------
// PHONE
// ---------------------------------------------------------------------------

const PHONE_CANDIDATE_RE =
  /(?<![\p{L}\p{N}_])\+?\d[\d \t\-()\u2013\u2014.]{7,22}\d(?![\p{L}\p{N}_])/gu;

const PHONE_CONTEXT = [
  'тел',
  'phone',
  'моб',
  'факс',
  'whatsapp',
  'viber',
  'telegram',
  'звон',
  'call',
] as const;

export function detectPhone(text: string): Span[] {
  return collect(text, PHONE_CANDIDATE_RE, 'PHONE', 88, 'phone', (raw, start) => {
    const digits = digitsOnly(raw);
    if (digits.length < 10 || digits.length > 15) return false;

    const hasPlus = raw.trimStart().startsWith('+');
    const elevenWithRuPrefix =
      digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'));
    const formatted = /[ \t()\u2013\u2014-]/u.test(raw);
    const hasPhoneContext = hasContextBefore(text, start, 42, PHONE_CONTEXT);

    return hasPlus || elevenWithRuPrefix || formatted || hasPhoneContext;
  });
}

// ---------------------------------------------------------------------------
// SNILS
// ---------------------------------------------------------------------------

const SNILS_FORMATTED_RE = /(?<!\d)\d{3}[- ]\d{3}[- ]\d{3}[ -]\d{2}(?!\d)/gu;
const SNILS_PLAIN_RE = /(?<!\d)\d{11}(?!\d)/gu;

const SNILS_CONTEXT = ['снилс', 'страхов', 'пенсион'] as const;

export function detectSnils(text: string): Span[] {
  const out: Span[] = [];

  for (const match of text.matchAll(SNILS_FORMATTED_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const valid = snilsValid(raw);
    const context = hasContextBefore(text, start, 32, SNILS_CONTEXT);
    if (valid) {
      push(out, text, 'SNILS', start, start + raw.length, 94, 'ru.snils');
    } else if (context) {
      push(out, text, 'SNILS', start, start + raw.length, 92, 'ru.snils');
    }
  }

  for (const match of text.matchAll(SNILS_PLAIN_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const valid = snilsValid(raw);
    const context = hasContextBefore(text, start, 32, SNILS_CONTEXT);
    if (!context) continue;
    push(out, text, 'SNILS', start, start + raw.length, valid ? 94 : 92, 'ru.snils');
  }

  return out;
}

// ---------------------------------------------------------------------------
// INN / OGRN / KPP-BIK
// ---------------------------------------------------------------------------

const INN_RE = /(?<!\d)(?:\d{12}|\d{10})(?!\d)/gu;
const INN_CONTEXT = ['инн', 'inn', 'налогоплат'] as const;

export function detectInn(text: string): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(INN_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const digits = digitsOnly(raw);
    const context = hasContextBefore(text, start, 42, INN_CONTEXT);
    const valid = digits.length === 12 ? inn12Valid(digits) : inn10Valid(digits);

    if (context) {
      // docs_masked masks even a bad checksum when the label is present.
      push(out, text, 'INN', start, start + raw.length, valid ? 90 : 75, 'ru.inn');
    } else if (digits.length === 12 && valid) {
      // Without context only a checksum-valid 12-digit INN is trusted.
      push(out, text, 'INN', start, start + raw.length, 70, 'ru.inn');
    }
  }
  return out;
}

const OGRN_RE = /(?<!\d)(?:\d{15}|\d{13})(?!\d)/gu;
const OGRN_CONTEXT = ['огрн', 'ogrn'] as const;

export function detectOgrn(text: string): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(OGRN_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    if (ogrnValid(raw)) {
      push(out, text, 'OGRN', start, start + raw.length, 90, 'ru.ogrn');
    } else if (hasContextBefore(text, start, 32, OGRN_CONTEXT)) {
      push(out, text, 'OGRN', start, start + raw.length, 75, 'ru.ogrn');
    }
  }
  return out;
}

const KPP_BIK_RE = /(?<!\d)\d{9}(?!\d)/gu;
const KPP_CONTEXT = ['кпп'] as const;
const BIK_CONTEXT = ['бик'] as const;

export function detectKppBik(text: string): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(KPP_BIK_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    if (hasContextBefore(text, start, 32, KPP_CONTEXT)) {
      push(out, text, 'KPP', start, start + raw.length, 92, 'ru.kpp');
      continue;
    }
    if (hasContextBefore(text, start, 32, BIK_CONTEXT) || raw.startsWith('04')) {
      push(out, text, 'BIK', start, start + raw.length, 92, 'ru.bik');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ACCOUNT / CARD / IBAN
// ---------------------------------------------------------------------------

const ACCOUNT_RE = /(?<!\d)(?:(?:\d{4}[ -]){4}\d{4}|\d{20})(?!\d)/gu;
const CARD_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/gu;
const IBAN_RE =
  /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/gu;

export function detectAccount(text: string): Span[] {
  return collect(text, ACCOUNT_RE, 'ACCOUNT', 90, 'ru.account');
}

export function detectCard(text: string): Span[] {
  return collect(text, CARD_RE, 'CARD', 93, 'card', (raw) => luhnCheck(raw));
}

export function detectIban(text: string): Span[] {
  return collect(text, IBAN_RE, 'IBAN', 93, 'iban', (raw) => ibanValid(raw));
}

// ---------------------------------------------------------------------------
// PASSPORT / POLICY / LICENSE / PLATE
// ---------------------------------------------------------------------------

const PASSPORT_RE = /(?<!\d)(\d{2} ?\d{2}) ?(?:№ ?)?(\d{6})(?!\d)/gu;
const FOREIGN_PASSPORT_RE = /(?<!\d)\d{9}(?!\d)/gu;
const DEPARTMENT_CODE_RE = /(?<!\d)\d{3}[- ]?\d{3}(?!\d)/gu;

const PASSPORT_CONTEXT = [
  'паспорт',
  'серия',
  'серии',
  'passport',
  'удостоверя',
  'документ',
] as const;
const FOREIGN_PASSPORT_CONTEXT = ['загранпаспорт', 'заграничн'] as const;
const DEPARTMENT_CONTEXT = ['код подразделения', 'к/п'] as const;

export function detectPassport(text: string): Span[] {
  const out: Span[] = [];

  for (const match of text.matchAll(PASSPORT_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const spaced = raw.includes(' ');
    const context = hasContextBefore(text, start, 60, PASSPORT_CONTEXT);
    if (spaced || context) {
      push(out, text, 'PASSPORT', start, start + raw.length, 91, 'ru.passport');
    }
  }

  for (const match of text.matchAll(FOREIGN_PASSPORT_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    if (hasContextBefore(text, start, 60, FOREIGN_PASSPORT_CONTEXT)) {
      push(out, text, 'PASSPORT', start, start + raw.length, 91, 'ru.passport.foreign');
    }
  }

  // "код подразделения 770-093": only the six-digit group is masked.
  for (const match of text.matchAll(DEPARTMENT_CODE_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    if (hasContextBefore(text, start, 60, DEPARTMENT_CONTEXT)) {
      push(out, text, 'PASSPORT', start, start + raw.length, 92, 'ru.passport.department');
    }
  }

  return out;
}

const POLICY_RE = /(?<!\d)\d{16}(?!\d)/gu;
const POLICY_CONTEXT = ['полис', 'омс', 'дмс'] as const;

export function detectPolicy(text: string): Span[] {
  return collect(text, POLICY_RE, 'POLICY', 90, 'ru.policy', (_raw, start) =>
    hasContextBefore(text, start, 42, POLICY_CONTEXT),
  );
}

const LICENSE_RE = /(?<![\p{L}\p{N}_])\d{2} ?[А-ЯЁ0-9]{2} ?\d{6}(?![\p{L}\p{N}_])/gu;
const LICENSE_CONTEXT = ['вод', 'прав', 'удостоверен', 'в/у', 'license'] as const;

export function detectLicense(text: string): Span[] {
  return collect(text, LICENSE_RE, 'LICENSE', 89, 'ru.license', (_raw, start) =>
    hasContextBefore(text, start, 50, LICENSE_CONTEXT),
  );
}

const PLATE_RE =
  /(?<![\p{L}\p{N}_])[АВЕКМНОРСТУХ] ?\d{3} ?[АВЕКМНОРСТУХ]{2} ?\d{2,3}(?![\p{L}\p{N}_])/gu;

export function detectPlate(text: string): Span[] {
  return collect(text, PLATE_RE, 'PLATE', 87, 'ru.plate');
}

// ---------------------------------------------------------------------------
// IP
// ---------------------------------------------------------------------------

const IP_RE =
  /(?<![\p{L}\p{N}_.])(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?![\p{L}\p{N}_]|\.\d)/gu;

export function detectIp(text: string): Span[] {
  return collect(text, IP_RE, 'IP', 80, 'ip');
}

// ---------------------------------------------------------------------------
// DATE / BIRTHDATE / DOCDATE
// ---------------------------------------------------------------------------

const DATE_NUMERIC_RE = /(?<!\d)\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}(?!\d)/gu;
const DATE_ISO_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gu;
const DATE_TEXT_RE =
  /(?<![\p{L}\p{N}])\d{1,2}\s+(?:января|февраля|марта|апреля|мая|мае|июня|июля|августа|сентября|октября|ноября|декабря)\s+\d{4}(?!\d)/giu;

const BIRTH_CONTEXT = [
  'рожден',
  'рождения',
  'д.р.',
  'др.',
  'г.р.',
  'birth',
  'dob',
  'родил',
  'date of birth',
] as const;

const DOCDATE_CONTEXT = [
  'выдан',
  'выдано',
  'дата выдачи',
  'issued',
  'действителен до',
  'срок действия',
  'зарегистрирован',
] as const;

const RIGHT_BIRTH_RE = /г\.\s*р\.|года\s+рожд|рожд/iu;

interface DateDecision {
  label: EntityLabel;
  priority: number;
}

function classifyDate(
  text: string,
  start: number,
  end: number,
  config: DetectionConfig,
): DateDecision | undefined {
  const leftBirth = hasContextBefore(text, start, 45, BIRTH_CONTEXT);
  const right = text.slice(end, Math.min(text.length, end + 22));
  if (leftBirth || RIGHT_BIRTH_RE.test(right)) {
    return { label: 'BIRTHDATE', priority: 86 };
  }

  if (hasContextBefore(text, start, 90, DOCDATE_CONTEXT)) {
    return { label: 'DOCDATE', priority: 84 };
  }

  if (config.enableDate) {
    return { label: 'DATE', priority: 20 };
  }

  return undefined;
}

export function detectDate(text: string, config: DetectionConfig = {}): Span[] {
  const out: Span[] = [];

  for (const match of text.matchAll(DATE_ISO_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const decision = classifyDate(text, start, start + raw.length, config);
    if (decision) {
      push(out, text, decision.label, start, start + raw.length, decision.priority, 'date.iso');
    }
  }

  for (const match of text.matchAll(DATE_NUMERIC_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const decision = classifyDate(text, start, start + raw.length, config);
    if (decision) {
      push(out, text, decision.label, start, start + raw.length, decision.priority, 'date.numeric');
    }
  }

  for (const match of text.matchAll(DATE_TEXT_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const decision = classifyDate(text, start, start + raw.length, config);
    if (decision) {
      push(out, text, decision.label, start, start + raw.length, decision.priority, 'date.text');
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// DOCNUM (registry / document numbers)
// ---------------------------------------------------------------------------

const DOCNUM_PREFIX_RE =
  /(?<![\p{L}\p{N}_])(?:ОКТМО|ОКПО|ОКАТО|ОКОГУ|ОКФС|ОКОПФ|ОКВЭД|ОКУД|КБК|УИН|УИП|л\.\s*с\.|лицевой\s+счёт|рег\.\s*№|регистрационный\s+номер)\s*[:№#]?\s*/giu;

const DOCNUM_VALUE_RE = /^\d[\d .-]{3,28}\d/u;

export function detectDocNum(text: string): Span[] {
  const out: Span[] = [];

  for (const match of text.matchAll(DOCNUM_PREFIX_RE)) {
    const prefixEnd = (match.index ?? 0) + match[0].length;
    const valueMatch = DOCNUM_VALUE_RE.exec(text.slice(prefixEnd));
    if (!valueMatch) continue;

    const raw = valueMatch[0];
    const start = prefixEnd;
    const end = start + raw.length;
    // Reject a value longer than the 30-character cap (regex would leave
    // the remaining digits behind and leak them).
    if (text[end] !== undefined && /\d/u.test(text[end])) continue;

    push(out, text, 'DOCNUM', start, end, 92, 'docnum');
  }

  return out;
}

// ---------------------------------------------------------------------------
// PERSON / composite entry point
// ---------------------------------------------------------------------------
export function detectPerson(
  text: string,
  config: DetectionConfig = {},
  context: PersonDetectContext = {},
): Span[] {
  return detectPersonSpans(text, config, context);
}

/**
 * Over-inclusive prefilter for every structured detector except DATE / ORG /
 * ADDRESS / DOCNUM / PERSON (which run their own cheap hints). A structured
 * match needs one of: `@`; an http/www URL; five digits separated by at most
 * three separator characters; a dotted IPv4; an IBAN country+check pair; or a
 * digit next to a Cyrillic capital (license/plate). If none is present the
 * whole-text regex family cannot match and is skipped. This is a pure
 * early-out: the hint is a superset of every rule's first characters.
 */
const STRUCTURED_HINT_RE =
  /@|[hH][tT][tT][pP]s?:\/\/|[wW][wW][wW]\.|\d(?:[ \t.\-/()\u2013\u2014]{0,22}\d){4}|\d\.\d\.\d\.\d|[A-Za-z]{2}\d{2}|\d[ \t-]?[А-ЯЁа-яё]|[А-ЯЁа-яё][ \t-]?\d/u;

/** Whole-document wasm gate; the test hook avoids 1 MB fixtures per case. */
let structuredWasmMinChars = 1024 * 1024;

/** @internal Test-only override for the wasm size gate. */
export function setStructuredWasmMinCharsForTests(value: number): void {
  structuredWasmMinChars = value;
}

/** Runs every structured detector in docs_masked order. */
export function detectStructured(
  text: string,
  config: DetectionConfig = {},
  personContext: PersonDetectContext = {},
): Span[] {
  if (text.length === 0) return [];

  if (!STRUCTURED_HINT_RE.test(text)) {
    return [
      ...detectDate(text, config),
      ...detectOrg(text),
      ...detectAddress(text),
      ...detectDocNum(text),
      ...detectPerson(text, config, personContext),
    ];
  }

  // Large whole-document scans (TXT, PDF text, very large XML/JSON values)
  // take the wasm path; the per-node adapters feed small strings where JS
  // regex is already cheap. The scanner returns candidate regions, not
  // matches: the unchanged JS detector regex still decides every span.
  const scanner = text.length >= structuredWasmMinChars ? getStructuredScanner() : null;
  if (scanner) {
    const regions = scanner.regions(text);
    if (regions) return detectStructuredRegions(text, config, personContext, regions);
  }

  return detectStructuredWholeText(text, config, personContext);
}

function detectStructuredWholeText(
  text: string,
  config: DetectionConfig,
  personContext: PersonDetectContext,
): Span[] {
  return [
    ...detectEmail(text),
    ...(config.enableUrl ? detectUrl(text) : []),
    ...detectHandle(text),
    ...detectPhone(text),
    ...detectSnils(text),
    ...detectInn(text),
    ...detectOgrn(text),
    ...detectKppBik(text),
    ...detectAccount(text),
    ...detectCard(text),
    ...detectIban(text),
    ...detectPassport(text),
    ...detectPolicy(text),
    ...detectLicense(text),
    ...detectPlate(text),
    ...detectIp(text),
    ...detectDate(text, config),
    ...detectOrg(text),
    ...detectAddress(text),
    ...detectDocNum(text),
    ...detectPerson(text, config, personContext),
  ];
}

/**
 * Context detectors (`phone`, `snils`, `passport`, ...) inspect up to 60
 * characters to the left. The region itself is maximal for the candidate
 * character class; add a wide window for context, then keep only spans that
 * start inside the region (a slice edge must not invent a boundary).
 */
const REGION_CONTEXT_CHARS = 80;

interface PreparedRegion {
  region: CandidateRegion;
  slice: string;
  offset: number;
}

function prepareRegions(text: string, regions: readonly CandidateRegion[]): PreparedRegion[] {
  const prepared: PreparedRegion[] = [];
  for (const region of regions) {
    let from = Math.max(0, region.start - REGION_CONTEXT_CHARS);
    if (from > 0) {
      const code = text.charCodeAt(from);
      // Do not split a surrogate pair: the left context is only heuristic.
      if (code >= 0xdc00 && code <= 0xdfff) from -= 1;
    }
    prepared.push({ region, slice: text.slice(from, region.end), offset: from });
  }
  return prepared;
}

function collectRegionSpans(
  text: string,
  prepared: readonly PreparedRegion[] | undefined,
  detect: (value: string) => Span[],
): Span[] {
  if (prepared === undefined || prepared.length === 0) return [];
  const out: Span[] = [];
  const seen = new Set<string>();

  for (const { region, slice, offset } of prepared) {
    for (const span of detect(slice)) {
      const start = offset + span.start;
      const end = offset + span.end;
      if (start < region.start || end > region.end || end <= start) continue;
      const key = `${span.label}\u0000${span.ruleId}\u0000${start}\u0000${end}\u0000${span.priority}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...span, start, end, text: text.slice(start, end) });
    }
  }

  out.sort((left, right) => left.start - right.start);
  return out;
}

function groupRegions(regions: readonly CandidateRegion[]): Map<number, CandidateRegion[]> {
  const grouped = new Map<number, CandidateRegion[]>();
  for (const region of regions) {
    const list = grouped.get(region.kind);
    if (list === undefined) grouped.set(region.kind, [region]);
    else list.push(region);
  }
  return grouped;
}

function detectStructuredRegions(
  text: string,
  config: DetectionConfig,
  personContext: PersonDetectContext,
  regions: readonly CandidateRegion[],
): Span[] {
  const grouped = groupRegions(regions);
  const prepare = (kind: number): PreparedRegion[] | undefined => {
    const list = grouped.get(kind);
    return list === undefined ? undefined : prepareRegions(text, list);
  };
  const email = prepare(REGION_EMAIL);
  const url = prepare(REGION_URL);
  const handle = prepare(REGION_HANDLE);
  const numeric = prepare(REGION_NUMERIC);
  const license = prepare(REGION_LICENSE);
  const iban = prepare(REGION_IBAN);
  const run = (prepared: PreparedRegion[] | undefined, detect: (value: string) => Span[]): Span[] =>
    collectRegionSpans(text, prepared, detect);

  return [
    ...run(email, detectEmail),
    ...(config.enableUrl ? run(url, detectUrl) : []),
    ...run(handle, detectHandle),
    ...run(numeric, detectPhone),
    ...run(numeric, detectSnils),
    ...run(numeric, detectInn),
    ...run(numeric, detectOgrn),
    ...run(numeric, detectKppBik),
    ...run(numeric, detectAccount),
    ...run(numeric, detectCard),
    ...run(iban, detectIban),
    ...run(numeric, detectPassport),
    ...run(numeric, detectPolicy),
    // The wasm license family requires a Cyrillic capital, so an all-digit
    // license (`12 34 567890`, `7712123456`) never gets a LICENSE region.
    // Re-run the unchanged JS detector over numeric regions too; its regex
    // and context check still decide, so this only widens candidates.
    ...run(numeric, detectLicense),
    ...run(license, detectLicense),
    ...run(license, detectPlate),
    ...run(numeric, detectIp),
    ...detectDate(text, config),
    ...detectOrg(text),
    ...detectAddress(text),
    ...detectDocNum(text),
    ...detectPerson(text, config, personContext),
  ];
}
