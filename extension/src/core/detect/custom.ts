/**
 * User-defined literal terms. docs_masked matches them as substrings
 * (no word boundaries), case-insensitively, with priority 99.
 *
 * A term line may override the tag label:
 *   Иванов Иван => CLIENT
 *   Проект «Альфа» -> PROJECT
 *   договор № 42 => DOC
 *   секрет
 *
 * Plain lines use the global `customLabel` (default `CUSTOM`). The label is
 * only the middle part of the tag (`[[<PREFIX>_<LABEL>_<N>]]`), never arbitrary
 * replacement text: restore maps the whole tag back through the vault.
 */

import { ALL_LABELS } from '../types';
import type { Span } from './span';

export const DEFAULT_CUSTOM_LABEL = 'CUSTOM';

/** Total length 1..32: first letter, then letters/digits. */
export const CUSTOM_LABEL_RE = /^[A-Z][A-Z0-9]{0,31}$/u;

/**
 * Built-in labels cannot be used as a custom tag label: `CLIENT` is safe, but
 * `PERSON` would collide with a real `PERSON_N` entity on restore.
 */
const RESERVED_LABELS: ReadonlySet<string> = new Set(
  ALL_LABELS.filter((label) => label !== DEFAULT_CUSTOM_LABEL),
);

/** True for a valid, non-reserved custom tag label. */
export function isCustomTagLabel(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_LABEL_RE.test(value) && !RESERVED_LABELS.has(value);
}

/** Valid label or `CUSTOM`; trims, but never silently upper-cases. */
export function normalizeCustomLabel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CUSTOM_LABEL;
  const trimmed = value.trim();
  return isCustomTagLabel(trimmed) ? trimmed : DEFAULT_CUSTOM_LABEL;
}

export interface CustomTermRule {
  /** Literal substring to mask. */
  term: string;
  /** Effective tag label. */
  tagLabel: string;
  /** Explicit label text that failed validation, for UI explanations. */
  invalidLabel?: string;
}

/** Matches the first `=>` or `->` separator anywhere in the line. */
const SEPARATOR_RE = /\s*(?:=>|->)\s*/u;

/**
 * Parses one configured line. Returns `undefined` for an empty line or an
 * empty term. An invalid per-line label falls back to `CUSTOM` (not to the
 * global label) and is reported through `invalidLabel`.
 */
export function parseCustomTermLine(
  raw: string,
  defaultLabel: unknown = DEFAULT_CUSTOM_LABEL,
): CustomTermRule | undefined {
  const line = raw.trim();
  if (line.length === 0) return undefined;

  const match = SEPARATOR_RE.exec(line);
  if (!match) {
    const term = line;
    return { term, tagLabel: normalizeCustomLabel(defaultLabel) };
  }

  const term = line.slice(0, match.index).trim();
  if (term.length === 0) return undefined;

  const rawLabel = line.slice(match.index + match[0].length).trim();
  if (isCustomTagLabel(rawLabel)) return { term, tagLabel: rawLabel };
  return { term, tagLabel: DEFAULT_CUSTOM_LABEL, invalidLabel: rawLabel };
}

/**
 * Parses and deduplicates configured lines. Terms are unique
 * case-insensitively; the first line wins. Used by the detector and by the
 * options UI to explain invalid per-line labels.
 */
export function parseCustomTermLines(
  terms: readonly string[],
  defaultLabel: unknown = DEFAULT_CUSTOM_LABEL,
): CustomTermRule[] {
  const seen = new Set<string>();
  const rules: CustomTermRule[] = [];
  for (const raw of terms) {
    if (typeof raw !== 'string') continue;
    const rule = parseCustomTermLine(raw, defaultLabel);
    if (!rule) continue;
    const key = rule.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }
  return rules;
}

function escapeRegExp(value: string): string {
  // Hyphen is not special outside a character class; escaping it under /u
  // would be a syntax error.
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function detectCustom(
  text: string,
  terms: readonly string[] = [],
  defaultLabel: unknown = DEFAULT_CUSTOM_LABEL,
): Span[] {
  const rules = parseCustomTermLines(terms, defaultLabel);
  if (text.length === 0 || rules.length === 0) return [];

  // Stable longest-first ordering makes the leftmost-longest alternative win
  // when one configured term is a prefix of another.
  const ordered = [...rules].sort((a, b) => b.term.length - a.term.length);
  const labelByTerm = new Map<string, string>();
  for (const rule of ordered) {
    const key = rule.term.toLowerCase();
    if (!labelByTerm.has(key)) labelByTerm.set(key, rule.tagLabel);
  }

  const re = new RegExp(ordered.map((rule) => escapeRegExp(rule.term)).join('|'), 'giu');
  const spans: Span[] = [];
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const matched = match[0];
    const tagLabel = labelByTerm.get(matched.toLowerCase()) ?? DEFAULT_CUSTOM_LABEL;
    spans.push({
      label: 'CUSTOM',
      start,
      end: start + matched.length,
      text: matched,
      priority: 99,
      ruleId: 'custom',
      tagLabel,
    });
  }
  return spans;
}
