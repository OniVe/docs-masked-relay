/**
 * Text-level anonymization and restore.
 *
 * Ordering contract (docs_masked): spans are resolved by priority, tags are
 * assigned left-to-right, replacements are applied right-to-left so offsets
 * stay valid. A failed LeakGuard leaves an existing vault untouched.
 */

import { detectAll } from './detect';
import { resolveOverlaps, type Span } from './detect/span';
import { AmbiguousVaultFileError } from './restore-identity';
import { parseTags } from './tag';
import type { DetectionConfig, MaskedEntity, Occurrence, Vault, VaultFile } from './types';
import {
  type AssignedEntity,
  assignDetection,
  canonicalOf,
  createVault,
  createVaultIndex,
  type VaultIndex,
} from './vault';

export interface LeakFinding {
  /** `detector:<ruleId>`, `paranoid:email`, `paranoid:digits`, ... */
  kind: string;
  value: string;
}

export interface AnonymizeTextResult {
  maskedText: string;
  vault: Vault;
  /** Unique entities touched by this call, in first-occurrence order. */
  entities: MaskedEntity[];
  /** Replacements in the input text, left-to-right (offsets are UTF-16). */
  replacements: MaskedReplacement[];
  warnings: string[];
  leakFindings: LeakFinding[];
}

export interface MaskedReplacement {
  start: number;
  end: number;
  tag: string;
}

/**
 * Shared sequential-restore cursor for one file/document. Build it once from
 * the file's occurrence records; every node/attribute of the document passes
 * the same object, so the queues are not rebuilt per value (R15-RESTORE).
 */
export interface RestoreSession {
  /** Per-tag FIFO of original surfaces, consumed in restore order. */
  readonly queues: Map<string, string[]>;
  /**
   * Set when the file record has no occurrence scope and the vault holds more
   * than one file. The global queues cannot belong to this document alone, so
   * `restoreText` fails closed on the first known tag instead of replaying
   * another file's surfaces (R16-RESTORE-IDENTITY).
   */
  readonly ambiguous?: boolean;
}

export interface RestoreTextOptions {
  /** `sequential` replays occurrence order, `canonical` always uses canonical. */
  mode?: 'sequential' | 'canonical';
  /**
   * Cursor shared across the nodes of one file/document. When omitted,
   * sequential mode rebuilds the queues from all vault occurrences, which
   * keeps single-string callers unchanged.
   */
  session?: RestoreSession;
}

export interface RestoreTextResult {
  text: string;
  replacements: number;
  /** Raw tag text left untouched (unknown prefix or entity). */
  unknownTags: string[];
}

export interface AnonymizeTextOptions {
  /**
   * Mutate `existingVault` directly instead of cloning it.
   *
   * Rollback contract (R15-N2): a throw may leave `existingVault` partially
   * mutated (`entities`, `occurrences`, `personKeys`). The caller MUST restore
   * a snapshot before reusing the vault; standard adapters (JSON/XML) snapshot
   * once per document and commit on success only. Requires `existingVault`.
   */
  inPlace?: boolean;
  /**
   * Incremental index for `existingVault`, reused across calls within one
   * document. `assignDetection` updates it on every tag allocation. Requires
   * `existingVault`; when omitted the index is rebuilt for this call.
   *
   * Index contract (R15-N2): the index is a snapshot, not a source of truth.
   * A caller that mutates the vault outside `assignDetection` (or rolls it
   * back after a failed in-place call) MUST rebuild the index; a stale index
   * can miss an existing surface and allocate a duplicate tag. There is no
   * silent linear fallback because a miss is the normal path for a new entity.
   */
  index?: VaultIndex;
}

const TRUNCATE_AT = 24;
const MAX_REPORTED_VALUES = 6;

const EMAIL_LIKE_RE =
  /(?<![\p{L}\p{N}_.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}(?![\p{L}\p{N}_])/gu;
const LONG_DIGITS_RE = /(?<!\d)\d{7,}(?!\d)/gu;
const PHONE_LIKE_RE = /(?<!\d)\+\d[\d\s\-()]{7,}\d(?!\d)/gu;

/**
 * LeakGuard scans large documents in chunks so detector allocations are
 * bounded (M15-M2). The overlap supplies full left/right context for matches
 * that start near a chunk edge; only spans starting inside the chunk's core
 * are kept, so every document offset is reported exactly once.
 */
const LEAK_CHUNK_CHARS = 2 * 1024 * 1024;
const LEAK_CHUNK_OVERLAP = 64 * 1024;

export function detectAllChunked(
  text: string,
  config: DetectionConfig,
  chunkChars: number = LEAK_CHUNK_CHARS,
  overlap: number = LEAK_CHUNK_OVERLAP,
): Span[] {
  if (chunkChars <= 0 || overlap < 0 || text.length <= chunkChars * 2) {
    return detectAll(text, config);
  }

  const spans: Span[] = [];
  for (let coreStart = 0; coreStart < text.length; coreStart += chunkChars) {
    const coreEnd = Math.min(coreStart + chunkChars, text.length);
    const contentStart = Math.max(0, coreStart - overlap);
    const contentEnd = Math.min(text.length, coreEnd + overlap);
    const chunk = text.slice(contentStart, contentEnd);
    for (const span of detectAll(chunk, config)) {
      const start = span.start + contentStart;
      if (start < coreStart || start >= coreEnd) continue;
      const end = span.end + contentStart;
      spans.push({ ...span, start, end, text: text.slice(start, end) });
    }
  }
  return spans;
}

function truncate(value: string): string {
  return value.length > TRUNCATE_AT ? value.slice(0, TRUNCATE_AT) : value;
}

/**
 * Replaces tag text with spaces so paranoid patterns do not flag digits that
 * belong to the tag format itself (docs_masked strips tags before paranoid).
 */
function blankTags(text: string): string {
  const tags = parseTags(text);
  if (tags.length === 0) return text;

  // One pass over the tag list: rebuild the string once instead of slicing
  // the whole document per tag (O(n + k) instead of O(n * k), R15 M15-M2).
  const parts: string[] = [];
  let cursor = 0;
  for (const tag of tags) {
    if (tag.index < cursor) continue;
    parts.push(text.slice(cursor, tag.index), ' '.repeat(tag.raw.length));
    cursor = tag.index + tag.raw.length;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * Thrown when residual PII survives anonymization. The message contains only
 * the finding count and up to six truncated values (spec §6.3, §10).
 */
export class LeakGuardError extends Error {
  readonly count: number;
  readonly values: string[];
  readonly findings: LeakFinding[];

  constructor(findings: readonly LeakFinding[]) {
    const values = findings.slice(0, MAX_REPORTED_VALUES).map((finding) => truncate(finding.value));
    const sample =
      values.length > 0 ? `: ${values.map((value) => JSON.stringify(value)).join(', ')}` : '';
    super(`LeakGuard: ${findings.length} residual finding(s) after masking${sample}`);
    this.name = 'LeakGuardError';
    this.count = findings.length;
    this.values = values;
    this.findings = [...findings];
  }
}

/**
 * Re-runs the detectors with the same config and adds docs_masked paranoid
 * patterns. Findings are deduplicated by `(kind, value)`.
 */
export function findLeaks(maskedText: string, config: DetectionConfig = {}): LeakFinding[] {
  const findings: LeakFinding[] = [];
  const seen = new Set<string>();
  const allowlist = new Set((config.allowlist ?? []).map((value) => value.trim().toLowerCase()));

  const add = (kind: string, value: string): void => {
    // An allowlisted value is intentionally left in the text; it must not
    // resurface through either a detector or a paranoid pattern.
    if (allowlist.has(value.trim().toLowerCase())) return;
    const dedupKey = `${kind}\u0000${value}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    findings.push({ kind, value });
  };

  for (const span of detectAllChunked(maskedText, config)) {
    add(`detector:${span.ruleId}`, span.text);
  }

  const paranoidText = blankTags(maskedText);
  for (const match of paranoidText.matchAll(EMAIL_LIKE_RE)) {
    add('paranoid:email', match[0]);
  }
  for (const match of paranoidText.matchAll(LONG_DIGITS_RE)) {
    add('paranoid:digits', match[0]);
  }
  for (const match of paranoidText.matchAll(PHONE_LIKE_RE)) {
    add('paranoid:phone', match[0]);
  }

  return findings;
}

/** Throws `LeakGuardError` unless `config.blockOnLeak === false`. */
export function assertClean(maskedText: string, config: DetectionConfig = {}): LeakFinding[] {
  const findings = findLeaks(maskedText, config);
  if (findings.length > 0 && config.blockOnLeak !== false) {
    throw new LeakGuardError(findings);
  }
  return findings;
}

/**
 * Single pass over ascending, non-overlapping replacements: O(n + k) instead
 * of rebuilding the whole string on every tag. Spans come from
 * `resolveOverlaps`, so they are sorted and disjoint.
 */
function applyReplacements(
  text: string,
  replacements: readonly { start: number; end: number; value: string }[],
): string {
  if (replacements.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < cursor) continue;
    parts.push(text.slice(cursor, replacement.start), replacement.value);
    cursor = replacement.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function commitVault(target: Vault, draft: Vault): void {
  target.schema = draft.schema;
  target.id = draft.id;
  target.prefix = draft.prefix;
  target.createdAt = draft.createdAt;
  target.chatIds = draft.chatIds;
  target.files = draft.files;
  target.entities = draft.entities;
  target.personKeys = draft.personKeys;
  target.occurrences = draft.occurrences;
  target.filenameMap = draft.filenameMap;
}

/**
 * Detect -> resolve -> assign -> replace. Existing vaults are edited through
 * a draft: on LeakGuardError the caller's vault is unchanged. `inPlace` skips
 * the draft for multi-string adapters that already hold a document snapshot;
 * such callers are responsible for the rollback.
 */
export function anonymizeText(
  text: string,
  config: DetectionConfig = {},
  existingVault?: Vault,
  options: AnonymizeTextOptions = {},
): AnonymizeTextResult {
  const { inPlace = false, index: providedIndex } = options;
  // The flags only make sense against a caller-owned vault; fail loudly rather
  // than silently producing a draft that cannot be reused or rolled back.
  if (inPlace && !existingVault) {
    throw new Error('anonymizeText: inPlace requires an existing vault');
  }
  if (providedIndex !== undefined && !existingVault) {
    throw new Error('anonymizeText: an index requires an existing vault');
  }

  const draft = existingVault
    ? inPlace
      ? existingVault
      : structuredClone(existingVault)
    : createVault(text);

  const spans: Span[] = resolveOverlaps(detectAll(text, config, { personKeys: draft.personKeys }));
  const replacements: { start: number; end: number; tag: string; value: string }[] = [];
  const entities = new Map<string, MaskedEntity>();

  // One index per call: entity lookup/counter allocation stays O(1) per span
  // instead of scanning all entities (R2-M1). Multi-string adapters reuse the
  // document index across calls (R15 perf).
  const index = providedIndex ?? createVaultIndex(draft);

  // Tags are assigned in document order (first occurrence gets _1).
  for (const span of spans) {
    const assigned: AssignedEntity = assignDetection(draft, span, { index });
    replacements.push({
      start: span.start,
      end: span.end,
      tag: assigned.tag,
      value: assigned.tag,
    });
    entities.set(assigned.key, {
      key: assigned.key,
      tag: assigned.tag,
      label: assigned.label,
      canonical: assigned.canonical,
      count: assigned.count,
    });
  }

  const maskedText = applyReplacements(text, replacements);
  const leakFindings = assertClean(maskedText, config);

  if (existingVault && !inPlace) commitVault(existingVault, draft);
  const vault = existingVault ?? draft;

  return {
    maskedText,
    vault,
    entities: [...entities.values()],
    replacements,
    warnings: [],
    leakFindings,
  };
}

function tagQueueKey(tag: { prefix: string; label: string; n: number }): string {
  return `${tag.prefix}_${tag.label}_${tag.n}`;
}

function occurrencesByTag(occurrences: readonly Occurrence[]): Map<string, string[]> {
  const queues = new Map<string, string[]>();

  for (const occurrence of occurrences) {
    const parsed = parseTags(occurrence.tag)[0];
    if (!parsed) continue;
    const key = tagQueueKey(parsed);
    const queue = queues.get(key);
    if (queue) queue.push(occurrence.original);
    else queues.set(key, [occurrence.original]);
  }

  return queues;
}

/** Sequential-restore cursor built from an explicit occurrence list. */
export function createRestoreSession(occurrences: readonly Occurrence[]): RestoreSession {
  return { queues: occurrencesByTag(occurrences) };
}

/**
 * Session scoped to one vault file. Records written by the scoped adapters
 * carry `occurrenceStart`/`occurrenceCount`; a legacy record in a single-file
 * vault falls back to the whole vault (the pre-R15 behavior). A legacy or
 * unknown record in a multi-file vault cannot own the global occurrence list,
 * so the session is marked ambiguous and restore fails closed on the first
 * known tag instead of consuming another file's surfaces.
 */
export function createFileRestoreSession(
  vault: Vault,
  record: VaultFile | undefined,
): RestoreSession {
  if (record?.occurrenceStart !== undefined) {
    const start = record.occurrenceStart;
    let count = record.occurrenceCount;
    if (count === undefined) {
      // A start without a count is a half-migrated legacy record. The next
      // scoped file's start bounds this range exactly; the last file owns the
      // rest. A middle record with no bound cannot be scoped safely.
      let nextStart = Number.POSITIVE_INFINITY;
      for (const other of vault.files) {
        if (other === record) continue;
        const candidate = other.occurrenceStart;
        if (candidate !== undefined && candidate > start && candidate < nextStart) {
          nextStart = candidate;
        }
      }
      if (nextStart !== Number.POSITIVE_INFINITY) {
        count = nextStart - start;
      } else if (vault.files[vault.files.length - 1] === record) {
        count = Math.max(0, vault.occurrences.length - start);
      } else {
        return { queues: occurrencesByTag(vault.occurrences), ambiguous: true };
      }
    }
    return createRestoreSession(vault.occurrences.slice(start, start + count));
  }
  if (vault.files.length > 1) {
    return { queues: occurrencesByTag(vault.occurrences), ambiguous: true };
  }
  return createRestoreSession(vault.occurrences);
}

/**
 * Orders this file's freshly appended occurrences (`start`..end) by their
 * absolute source offset. Masking pre-passes (JSON name contexts, XML name/URI
 * and attribute analysis) can assign tags in a different order than the source
 * text; sequential restore traverses the document in source order, so per-tag
 * FIFOs must be in source order too (R15-RESTORE). `positions[i]` belongs to
 * `vault.occurrences[start + i]`; a length mismatch leaves call order intact
 * rather than silently dropping entries (adapter bookkeeping bug).
 */
export function orderOccurrencesByPosition(
  vault: Vault,
  start: number,
  positions: readonly number[],
): void {
  const count = vault.occurrences.length - start;
  if (count <= 1) return;
  if (positions.length !== count) return;

  const slice = vault.occurrences.slice(start);
  const order = Array.from({ length: count }, (_, index) => index);
  order.sort((left, right) => {
    const byPosition = (positions[left] as number) - (positions[right] as number);
    return byPosition !== 0 ? byPosition : left - right;
  });
  const ordered = order
    .map((index) => slice[index])
    .filter((occurrence): occurrence is Occurrence => occurrence !== undefined);

  vault.occurrences.splice(start, count, ...ordered);
}

/**
 * Replaces tags in `text`. Tolerant parsing handles markdown escapes, case
 * changes, spaces and `**` wrappers. Unknown tags stay untouched and are
 * reported raw.
 */
export function restoreText(
  text: string,
  vault: Vault,
  options: RestoreTextOptions = {},
): RestoreTextResult {
  const mode = options.mode ?? 'sequential';
  const tags = parseTags(text);
  if (tags.length === 0) {
    return { text, replacements: 0, unknownTags: [] };
  }

  const queues =
    mode === 'sequential'
      ? (options.session?.queues ?? occurrencesByTag(vault.occurrences))
      : undefined;
  const replacements: { start: number; end: number; value: string }[] = [];
  const unknownTags: string[] = [];
  const seenUnknown = new Set<string>();

  for (const tag of tags) {
    const unknown = (): void => {
      if (seenUnknown.has(tag.raw)) return;
      seenUnknown.add(tag.raw);
      unknownTags.push(tag.raw);
    };

    if (tag.prefix !== vault.prefix) {
      unknown();
      continue;
    }

    const entity = vault.entities[`${tag.label}_${tag.n}`];
    if (!entity) {
      unknown();
      continue;
    }

    if (mode === 'sequential' && options.session?.ambiguous === true) {
      throw new AmbiguousVaultFileError(
        'this vault file has no occurrence scope while the vault contains several files',
      );
    }

    let value: string;
    if (mode === 'canonical') {
      value = canonicalOf(entity);
    } else {
      const queue = queues?.get(`${tag.prefix}_${tag.label}_${tag.n}`);
      value = queue && queue.length > 0 ? (queue.shift() as string) : canonicalOf(entity);
    }

    replacements.push({
      start: tag.index,
      end: tag.index + tag.raw.length,
      value,
    });
  }

  const restored = applyReplacements(text, replacements);

  return {
    text: restored,
    replacements: replacements.length,
    unknownTags,
  };
}
