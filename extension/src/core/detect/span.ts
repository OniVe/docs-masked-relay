/**
 * Span resolution: detectors return overlapping candidates; the masker keeps
 * the most valuable one using docs_masked ordering:
 *   priority desc -> length desc -> start asc -> detector order (stable).
 */

import type { EntityLabel } from '../types';

export interface Span {
  label: EntityLabel;
  /** Inclusive UTF-16 code-unit offset. */
  start: number;
  /** Exclusive UTF-16 code-unit offset. */
  end: number;
  /** Matched source text. Never log this value. */
  text: string;
  /** Higher wins overlaps. See docs-masked-porting.md §1. */
  priority: number;
  /** Stable rule identifier, e.g. `ru.snils`. */
  ruleId: string;
  /**
   * PERSON semantic key (docs_masked mention key encoded as JSON, or a Latin
   * name key). The vault maps it to a concrete `PERSON_N` entity key.
   */
  entityKey?: string;
  /** PERSON nominative-case hint for canonical restore. */
  nominative?: string;
  /** Preferred canonical surface candidate; defaults to `text`. */
  canonical?: string;
  /** PERSON canonical score: word count, then shorter surface. */
  canonicalScore?: number;
  /** Detector confidence in [0, 1] (PERSON only for now). */
  personConfidence?: number;
  /**
   * CUSTOM only: tag label override (`CLIENT` -> `[[PREFIX_CLIENT_1]]`).
   * `label` stays `CUSTOM`, so the vault keeps one custom entity per surface +
   * label and restore can address the tag by its visible label.
   */
  tagLabel?: string;
}

export function spanLength(span: Span): number {
  return span.end - span.start;
}

export function spansOverlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Stable comparator used before greedy selection. Returning 0 for equal
 * priority/length/start is intentional: Array#sort is stable, so detector
 * order breaks the tie exactly like the Python `sorted` does.
 */
export function compareSpans(a: Span, b: Span): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const lengthDelta = spanLength(b) - spanLength(a);
  if (lengthDelta !== 0) return lengthDelta;
  return a.start - b.start;
}

/**
 * Greedy non-overlapping selection. Invalid (empty or negative) spans are
 * dropped. Result is ordered by document position.
 */
export function resolveOverlaps(spans: readonly Span[]): Span[] {
  const ordered = [...spans].sort(compareSpans);
  const kept: Span[] = [];

  for (const candidate of ordered) {
    if (candidate.start < 0 || candidate.end <= candidate.start) continue;
    if (kept.some((existing) => spansOverlap(existing, candidate))) continue;
    kept.push(candidate);
  }

  return kept.sort((a, b) => a.start - b.start || spanLength(b) - spanLength(a));
}

/**
 * Replaces span ranges with spaces while preserving length and offsets.
 * Used by the optional second detector pass.
 */
export function blankSpans(text: string, spans: readonly Span[]): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;

  for (const span of ordered) {
    if (span.start < cursor || span.end > text.length) continue;
    if (span.start > cursor) parts.push(text.slice(cursor, span.start));
    parts.push(' '.repeat(span.end - span.start));
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
