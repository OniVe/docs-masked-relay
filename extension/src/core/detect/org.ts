/**
 * ORG detector ported from docs_masked `d_org` (`pii_shield/detectors.py:377`).
 *
 * Two shapes are accepted:
 * - short legal form + quoted name (priority 78);
 * - long legal phrase (adjective) + quoted name (priority 77).
 *
 * Parity notes:
 * - docs_masked compiles the short form without IGNORECASE, so `ооо «Ромашка»`
 *   is missed there. Here both rules are case-insensitive; Unicode lookarounds
 *   replace Python `\b`, which is dead before Cyrillic in JavaScript.
 * - Quotation marks are mandatory (docs_masked rule). `ООО Ромашка` without
 *   quotes is intentionally not an ORG: masking a bare legal form plus one
 *   capitalised word produced too many false positives in the source project.
 * - The name may not cross a line break and is capped at 70/80 characters.
 */

import type { Span } from './span';

/** Legal forms from docs_masked `dictionaries.LEGAL_FORMS`, longest first. */
const LEGAL_FORMS = [
  'ФГБОУ',
  'ФГБУ',
  'ФГУП',
  'ООО',
  'ОАО',
  'ЗАО',
  'ПАО',
  'НАО',
  'АНО',
  'ГУП',
  'МУП',
  'ГБУ',
  'МБУ',
  'МКУ',
  'ТСЖ',
  'СНТ',
  'ГСК',
  'КФХ',
  'НКО',
  'ИП',
  'АО',
  'ПК',
  'GMBH',
  'CORP',
  'LLC',
  'LTD',
  'INC',
  'PLC',
] as const;

/** Long-form stems from docs_masked `ORG_LONG_RE` (`казённ` and `казенн`). */
const LONG_FORM_STEMS = [
  'федеральн',
  'государственн',
  'муниципальн',
  'автономн',
  'бюджетн',
  'казённ',
  'казенн',
  'обществ',
  'акционерн',
  'некоммерческ',
  'публичн',
] as const;

const LEGAL_FORMS_GROUP = [...LEGAL_FORMS].sort((a, b) => b.length - a.length).join('|');
const LONG_FORM_STEMS_GROUP = [...LONG_FORM_STEMS].sort((a, b) => b.length - a.length).join('|');

/**
 * `\b` in JavaScript is ASCII-only, so Cyrillic needs an explicit Unicode
 * lookbehind. The closing quote is already a boundary; a trailing lookahead
 * would reject `ООО «Ромашка»X` and leak the name instead of masking it.
 */
const ORG_SHORT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:${LEGAL_FORMS_GROUP})\.?[ \u00A0]*[«"'][^»"'\r\n]{1,70}[»"']`,
  'giu',
);

const ORG_LONG_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:${LONG_FORM_STEMS_GROUP})[\p{L}]*[^«»\r\n]{0,90}«[^»\r\n]{1,80}»`,
  'giu',
);

/** Both ORG shapes require a quoted name. */
const ORG_HINT_RE = /[«"']/u;

function collect(text: string, re: RegExp, priority: number, ruleId: string): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (raw.length === 0) continue;
    out.push({
      label: 'ORG',
      start,
      end: start + raw.length,
      text: raw,
      priority,
      ruleId,
    });
  }
  return out;
}

export function detectOrg(text: string): Span[] {
  // Both rules require a quoted name; without any quote character there is
  // nothing to match. ASCII/lowercase prose skips two whole-text regexes.
  if (!ORG_HINT_RE.test(text)) return [];
  return [
    ...collect(text, ORG_SHORT_RE, 78, 'org.short'),
    ...collect(text, ORG_LONG_RE, 77, 'org.long'),
  ];
}
