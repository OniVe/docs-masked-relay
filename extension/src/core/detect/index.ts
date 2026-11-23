/**
 * Detection entry point: collect candidates, filter by config, protect
 * existing tags, resolve overlaps. Optional second pass mirrors docs_masked
 * `find_spans` (blank accepted spans, rescan, re-resolve).
 */

import { parseTags } from '../tag';
import { ALL_LABELS, type DetectionConfig, type EntityLabel } from '../types';
import { detectCustom } from './custom';
import { blankSpans, resolveOverlaps, type Span, spansOverlap } from './span';
import { detectStructured } from './structured';

export type { DetectionConfig } from '../types';
export { ALL_LABELS } from '../types';
export type { Span } from './span';

/** docs_masked enables everything except DATE/URL/GEO by default. */
const DEFAULT_DISABLED: ReadonlySet<EntityLabel> = new Set<EntityLabel>(['DATE', 'URL']);

export const DEFAULT_LABELS: ReadonlySet<EntityLabel> = new Set(
  ALL_LABELS.filter((label) => !DEFAULT_DISABLED.has(label)),
);

export interface DetectOptions {
  /**
   * Second pass: blank out accepted spans, rerun detectors, keep only new
   * non-overlapping finds. Off by default: it can create spans through the
   * "holes" left by a long match (a known docs_masked trade-off).
   */
  secondPass?: boolean;
  /**
   * PERSON semantic-key map from an existing vault. Enables repeat mentions
   * of people seen in an earlier call.
   */
  personKeys?: Record<string, string>;
}

function normalizedSurface(value: string): string {
  return value.trim().toLowerCase();
}

function isInsideTag(span: Span, tags: ReturnType<typeof parseTags>): boolean {
  return tags.some((tag) => span.start < tag.index + tag.raw.length && tag.index < span.end);
}

interface ContainingCandidate {
  span: Span;
  length: number;
  /** Position in the original candidate array: tie-break, first wins. */
  order: number;
}

/** Longest length wins; on a tie the candidate seen first wins (R21 semantics). */
function isBetterCandidate(
  candidate: ContainingCandidate,
  current: ContainingCandidate | undefined,
): boolean {
  if (current === undefined) return true;
  if (candidate.length !== current.length) return candidate.length > current.length;
  return candidate.order < current.order;
}

/** Number of sorted `values` that are <= `limit` (prefix length). */
function countAtMost(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const value = values[middle];
    if (value !== undefined && value <= limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * A custom term can be a prefix of a longer detected person name, for example
 * `Иванов Иван` inside `Иванов Иван Иванович`. The custom span wins every
 * overlap by priority 99 and would mask only its own prefix, leaving the
 * patronymic in plaintext where no detector and no leak pattern sees it.
 * Expand such a custom span to the boundaries of the longest PERSON span that
 * contains it, keeping the custom tag label, so the whole name is masked and
 * restored as one entity. Other overlapping detectors (ORG, ADDRESS, …) keep
 * the documented custom-substring behavior; non-overlapping custom terms are
 * untouched.
 *
 * Interval index instead of CUSTOM×PERSON scans (R21-N4): PERSON spans are
 * swept by `end` descending into a prefix-max Fenwick tree keyed by `start`.
 * Each CUSTOM query then asks for the longest inserted span with
 * `start <= custom.start`; every inserted span also has `end >= custom.end`,
 * so the answer is exactly the longest containing PERSON span. O((P+C) log P)
 * time and O(P) memory, with the same longest/first tie-break as before.
 *
 * @internal Exported for the interval-index unit tests in `custom-label.test.ts`.
 */
export function expandContainedCustomSpans(text: string, candidates: readonly Span[]): Span[] {
  const persons: ContainingCandidate[] = [];
  const customs: { span: Span; candidateIndex: number }[] = [];
  candidates.forEach((span, candidateIndex) => {
    if (span.label === 'PERSON') {
      persons.push({ span, length: span.end - span.start, order: persons.length });
    } else if (span.label === 'CUSTOM') {
      customs.push({ span, candidateIndex });
    }
  });
  if (persons.length === 0 || customs.length === 0) return [...candidates];

  const starts = [...new Set(persons.map((person) => person.span.start))].sort(
    (left, right) => left - right,
  );
  const coordinateByStart = new Map<number, number>();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start !== undefined) coordinateByStart.set(start, index + 1);
  }

  // Max Fenwick tree over start coordinates; inserts are monotonic because
  // both lists are swept by `end` descending.
  const tree: (ContainingCandidate | undefined)[] = new Array(starts.length + 1).fill(undefined);
  const insert = (candidate: ContainingCandidate): void => {
    const coordinate = coordinateByStart.get(candidate.span.start);
    if (coordinate === undefined) return;
    for (let node = coordinate; node < tree.length; node += node & -node) {
      if (isBetterCandidate(candidate, tree[node])) tree[node] = candidate;
    }
  };
  const prefixBest = (count: number): ContainingCandidate | undefined => {
    let best: ContainingCandidate | undefined;
    for (let node = count; node > 0; node -= node & -node) {
      const candidate = tree[node];
      if (candidate !== undefined && isBetterCandidate(candidate, best)) best = candidate;
    }
    return best;
  };

  const orderedPersons = [...persons].sort(
    (left, right) => right.span.end - left.span.end || left.order - right.order,
  );
  const orderedCustoms = [...customs].sort(
    (left, right) => right.span.end - left.span.end || left.candidateIndex - right.candidateIndex,
  );

  const result = [...candidates];
  let cursor = 0;
  for (const custom of orderedCustoms) {
    while (cursor < orderedPersons.length) {
      const person = orderedPersons[cursor];
      if (person === undefined || person.span.end < custom.span.end) break;
      insert(person);
      cursor += 1;
    }

    const best = prefixBest(countAtMost(starts, custom.span.start));
    if (best === undefined) continue;
    if (best.length <= custom.span.end - custom.span.start) continue;
    result[custom.candidateIndex] = {
      ...custom.span,
      start: best.span.start,
      end: best.span.end,
      text: text.slice(best.span.start, best.span.end),
    };
  }
  return result;
}

function collectCandidates(
  text: string,
  config: DetectionConfig,
  options: DetectOptions = {},
): Span[] {
  let allowed = config.labels ?? DEFAULT_LABELS;
  if (config.labels === undefined && (config.enableDate || config.enableUrl)) {
    const expanded = new Set<EntityLabel>(DEFAULT_LABELS);
    if (config.enableDate) expanded.add('DATE');
    if (config.enableUrl) expanded.add('URL');
    allowed = expanded;
  }
  const allowlist = new Set((config.allowlist ?? []).map((value) => normalizedSurface(value)));
  const tags = parseTags(text);
  const structured = detectStructured(text, config, { personKeys: options.personKeys });
  // An allowlisted custom term is the user's explicit opt-out: it must not be
  // expanded either (the allowlist wins over the custom rule).
  const custom = detectCustom(text, config.customTerms ?? [], config.customLabel).filter(
    (span) => !allowlist.has(normalizedSurface(span.text)),
  );

  // Expand before applying labels/allowlist to the expanded span: with
  // `labels: {CUSTOM}` the PERSON candidate is not allowed, but it still has
  // to define the full-name boundary, otherwise the patronymic leaks
  // (R21-CUSTOM-EXPAND). `structured` is intentionally unfiltered here; the
  // expanded span is re-checked against the allowlist below.
  return expandContainedCustomSpans(text, [...structured, ...custom]).filter((span) => {
    if (span.end <= span.start || span.end > text.length) return false;
    if (!allowed.has(span.label)) return false;
    if (allowlist.has(normalizedSurface(span.text))) return false;
    // Never detect inside an existing tag; a partial overlap would corrupt
    // the tag during replacement.
    if (isInsideTag(span, tags)) return false;
    return true;
  });
}

/**
 * Returns non-overlapping spans ordered by document position.
 * `config.labels` is applied after every detector has run and after a CUSTOM
 * term is expanded over a containing PERSON span (docs_masked semantics); the
 * allowlist is exact lower-cased equality, not a substring.
 */
export function detectAll(
  text: string,
  config: DetectionConfig = {},
  options: DetectOptions = {},
): Span[] {
  if (text.length === 0) return [];

  const resolved = resolveOverlaps(collectCandidates(text, config, options));
  if (!options.secondPass || resolved.length === 0) return resolved;

  const blanked = blankSpans(text, resolved);
  const extras = collectCandidates(blanked, config, options)
    .filter((span) => !resolved.some((existing) => spansOverlap(existing, span)))
    .map((span) => ({ ...span, text: text.slice(span.start, span.end) }));

  if (extras.length === 0) return resolved;
  return resolveOverlaps([...resolved, ...extras]);
}
