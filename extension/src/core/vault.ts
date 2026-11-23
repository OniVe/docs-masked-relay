/**
 * Vault assignment for detected entities.
 *
 * Structured labels use `(label, surface.trim().toLowerCase())`, which merges
 * case-only variants (emails) and keeps formatting variants apart (phones).
 * PERSON uses the semantic key carried by the span (`span.entityKey`) and the
 * `Vault.personKeys` map, so case forms/initials of one person share a tag.
 *
 * PERSON canonical/nominative scoring is ported from docs_masked `vault.py`
 * (MIT, © 2026 Kirill Pshinnik,
 * commit 905f92362d574351c1f9b22f56685facffa42c54).
 */

import { normalizeCustomLabel } from './detect/custom';
import { decodePersonKey, personCanonicalScore } from './detect/person';
import { hintScoreGreater } from './detect/person/nominative';
import { stem } from './detect/person/stem';
import type { Span } from './detect/span';
import { makePrefix, makeTag } from './tag';
import type { EntityLabel, EntityRecord, Occurrence, Vault } from './types';
import { VAULT_SCHEMA } from './types';

export interface CreateVaultOptions {
  /** Deterministic prefix for tests; ignored if invalid or present in text. */
  prefix?: string;
  /** Deterministic id for tests. */
  id?: string;
  /** Deterministic timestamp for tests. */
  now?: string | Date;
}

const PREFIX_RE = /^[A-Z0-9]{5}$/u;
const ENTITY_KEY_RE = /^([A-Z][A-Z0-9]*)_([1-9][0-9]*)$/u;

function normalizedSurface(value: string): string {
  return value.trim().toLowerCase();
}

function containsPrefix(text: string, prefix: string): boolean {
  return text.toLowerCase().includes(prefix.toLowerCase());
}

function choosePrefix(text: string, requested?: string): string {
  if (requested !== undefined) {
    const candidate = requested.toUpperCase();
    if (PREFIX_RE.test(candidate) && !containsPrefix(text, candidate)) {
      return candidate;
    }
  }

  // Collision with source text would make restore ambiguous; retry.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = makePrefix();
    if (!containsPrefix(text, candidate)) return candidate;
  }
  throw new Error('Could not generate a collision-free vault prefix');
}

function timestamp(now?: string | Date): string {
  if (now === undefined) return new Date().toISOString();
  if (typeof now === 'string') return now;
  return now.toISOString();
}

export function createVault(text: string, options: CreateVaultOptions = {}): Vault {
  return {
    schema: VAULT_SCHEMA,
    id: options.id ?? crypto.randomUUID(),
    prefix: choosePrefix(text, options.prefix),
    createdAt: timestamp(options.now),
    chatIds: [],
    files: [],
    entities: {},
    personKeys: {},
    occurrences: [],
    filenameMap: [],
  };
}

/**
 * Extension seam for callers that need custom entity key resolution. PERSON
 * uses `Span.entityKey` + `Vault.personKeys` by default.
 */
export type EntityKeyResolver = (vault: Vault, span: Span) => string | undefined;

export interface AssignOptions {
  /** Overrides the default structured key resolution. */
  resolveKey?: EntityKeyResolver;
  /** Per-call index built by `createVaultIndex`; keeps assignment linear. */
  index?: VaultIndex;
}

export interface AssignedEntity {
  /** Key inside `Vault.entities`, e.g. `EMAIL_1`. */
  key: string;
  tag: string;
  label: EntityLabel;
  /** `canonicalOf` value at call time. */
  canonical: string;
  count: number;
  isNew: boolean;
}

/**
 * Per-call lookup index for `Vault.entities`: one pass over the vault instead
 * of scanning every entity for every detected span (R2-M1). Callers build it
 * once and pass it through `AssignOptions.index`; plain `assignDetection`
 * calls fall back to the linear scan.
 */
export interface VaultIndex {
  /**
   * `${label}|${customTagLabel}|${normalizedSurface}` -> entity key (canonical
   * and variants). `customTagLabel` is empty for non-CUSTOM labels.
   */
  structured: Map<string, string>;
  /** Highest `_N` counter per label. */
  counters: Map<EntityLabel, number>;
  /** Highest `_N` counter per custom tag label (`CLIENT`, `PROJECT`, ...). */
  customCounters: Map<string, number>;
  /** Surname stem -> PERSON keys, for the lone-surname cluster fallback. */
  personStems: Map<string, string[]>;
  /**
   * `Vault.occurrences.length` when the index was built or last refreshed.
   * Every assignment appends exactly one occurrence, so a mismatch means the
   * vault changed outside this index and the index must be rebuilt (M15-M1).
   *
   * Entity-only inserts (`vault.entities[key] = ...`, e.g. filename masking
   * merging a draft) do not move this counter (R16-N1). A caller that writes
   * entities directly MUST call `refreshVaultIndex` (or rebuild the index)
   * before reusing it; otherwise a later surface may allocate a duplicate tag.
   */
  occurrenceCount: number;
}

function structuredIndexKey(label: EntityLabel, surface: string, customTagLabel?: string): string {
  return `${label}|${customTagLabel ?? ''}|${normalizedSurface(surface)}`;
}

/** CUSTOM spans carry a visible tag label; every other label uses `label`. */
function customLabelOfSpan(span: Span): string | undefined {
  if (span.label !== 'CUSTOM') return undefined;
  return normalizeCustomLabel(span.tagLabel);
}

/**
 * CUSTOM entity keys are `<TAG_LABEL>_<N>` (`CLIENT_1`), while
 * `EntityRecord.label` stays `CUSTOM`. The key prefix is therefore the tag
 * label that `buildTag` and restore need; legacy vaults with `CUSTOM_N`
 * entities keep working unchanged.
 */
function customLabelOfKey(key: string): string | undefined {
  const match = ENTITY_KEY_RE.exec(key);
  return match?.[1];
}

/** First word of a person canonical, normalized exactly like detector keys. */
function personStem(canonical: string): string {
  return stem(canonical.trim().split(/\s+/u)[0] ?? '');
}

function indexPersonStem(
  personStems: Map<string, string[]>,
  key: string,
  entity: EntityRecord,
): void {
  if (entity.label !== 'PERSON') return;
  const indexKey = personStem(entity.canonical);
  if (indexKey.length === 0) return;
  const keys = personStems.get(indexKey);
  if (keys === undefined) personStems.set(indexKey, [key]);
  else if (!keys.includes(key)) keys.push(key);
}

export function createVaultIndex(vault: Vault): VaultIndex {
  const structured = new Map<string, string>();
  const counters = new Map<EntityLabel, number>();
  const customCounters = new Map<string, number>();
  const personStems = new Map<string, string[]>();
  for (const [key, entity] of Object.entries(vault.entities)) {
    indexEntity(structured, key, entity);
    indexPersonStem(personStems, key, entity);
    const prefix = `${entity.label}_`;
    if (key.startsWith(prefix)) {
      const n = Number(key.slice(prefix.length));
      if (Number.isInteger(n) && n > (counters.get(entity.label) ?? 0)) {
        counters.set(entity.label, n);
      }
    }
    if (entity.label !== 'CUSTOM') continue;
    const tagLabel = customLabelOfKey(key);
    if (tagLabel === undefined) continue;
    const keyPrefix = `${tagLabel}_`;
    if (!key.startsWith(keyPrefix)) continue;
    const n = Number(key.slice(keyPrefix.length));
    if (Number.isInteger(n) && n > (customCounters.get(tagLabel) ?? 0)) {
      customCounters.set(tagLabel, n);
    }
  }
  return {
    structured,
    counters,
    customCounters,
    personStems,
    occurrenceCount: vault.occurrences.length,
  };
}

/**
 * Rebuilds `index` in place from the current vault. Used when an occurrence
 * count mismatch proves the index is stale (M15-M1): another assignment path
 * wrote to the vault after the index was built.
 */
export function refreshVaultIndex(vault: Vault, index: VaultIndex): void {
  const fresh = createVaultIndex(vault);
  index.structured = fresh.structured;
  index.counters = fresh.counters;
  index.customCounters = fresh.customCounters;
  index.personStems = fresh.personStems;
  index.occurrenceCount = fresh.occurrenceCount;
}

function ensureIndexFresh(vault: Vault, index: VaultIndex): void {
  if (index.occurrenceCount !== vault.occurrences.length) {
    refreshVaultIndex(vault, index);
  }
}

function pushOccurrence(vault: Vault, tag: string, original: string, index?: VaultIndex): void {
  vault.occurrences.push({ tag, original });
  if (index) index.occurrenceCount += 1;
}

function indexEntity(structured: Map<string, string>, key: string, entity: EntityRecord): void {
  const customTagLabel = entity.label === 'CUSTOM' ? customLabelOfKey(key) : undefined;
  for (const surface of [entity.canonical, ...entity.variants]) {
    const indexKey = structuredIndexKey(entity.label, surface, customTagLabel);
    if (!structured.has(indexKey)) structured.set(indexKey, key);
  }
}

function findIndexedKey(
  vault: Vault,
  index: VaultIndex,
  label: EntityLabel,
  surface: string,
  customTagLabel?: string,
): string | undefined {
  // A stale index (another assignment path wrote to the vault) may miss a
  // canonical or variant; rebuild once before trusting the lookup.
  ensureIndexFresh(vault, index);
  const key = index.structured.get(structuredIndexKey(label, surface, customTagLabel));
  if (key === undefined) return undefined;
  const entity = vault.entities[key];
  if (entity?.label !== label) return undefined;
  // Same surface under another custom label is a different tag: `CLIENT_1`
  // must never be reused for a term now configured as `PROJECT`.
  if (label === 'CUSTOM' && customLabelOfKey(key) !== customTagLabel) return undefined;
  // A long-lived incremental index may still hold a surface the entity no
  // longer exposes after a canonical change. Recheck against the entity's
  // current canonical/variants, exactly like the linear-scan path.
  const wanted = normalizedSurface(surface);
  if (normalizedSurface(entity.canonical) === wanted) return key;
  if (entity.variants.some((variant) => normalizedSurface(variant) === wanted)) return key;
  return undefined;
}

/** Finds an entity whose canonical/variant equals the surface (case-insensitive). */
export function findStructuredEntityKey(
  vault: Vault,
  span: Span,
  index?: VaultIndex,
): string | undefined {
  const customTagLabel = customLabelOfSpan(span);
  if (index) return findIndexedKey(vault, index, span.label, span.text, customTagLabel);

  const surface = normalizedSurface(span.text);

  for (const [key, entity] of Object.entries(vault.entities)) {
    if (entity.label !== span.label) continue;
    if (customTagLabel !== undefined && customLabelOfKey(key) !== customTagLabel) continue;
    if (normalizedSurface(entity.canonical) === surface) return key;
    if (entity.variants.some((variant) => normalizedSurface(variant) === surface)) {
      return key;
    }
  }
  return undefined;
}

function nextCounter(vault: Vault, label: EntityLabel, index?: VaultIndex): number {
  if (index) {
    ensureIndexFresh(vault, index);
    // A stale counter must never overwrite an existing key: walk forward to
    // the first free `${label}_N` and sync the index (M15-M1).
    let next = (index.counters.get(label) ?? 0) + 1;
    while (vault.entities[`${label}_${next}`] !== undefined) next += 1;
    index.counters.set(label, next);
    return next;
  }

  let max = 0;
  const prefix = `${label}_`;
  for (const key of Object.keys(vault.entities)) {
    if (!key.startsWith(prefix)) continue;
    const n = Number(key.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Next `_N` for one custom tag label. Counters are per visible label, so
 * `CLIENT_1` and `PROJECT_1` can coexist. The keys are still `<LABEL>_<N>` and
 * therefore directly addressable by restore.
 */
function nextCustomCounter(vault: Vault, tagLabel: string, index?: VaultIndex): number {
  if (index) {
    ensureIndexFresh(vault, index);
    let next = (index.customCounters.get(tagLabel) ?? 0) + 1;
    while (vault.entities[`${tagLabel}_${next}`] !== undefined) next += 1;
    index.customCounters.set(tagLabel, next);
    return next;
  }

  let max = 0;
  const prefix = `${tagLabel}_`;
  for (const [key, entity] of Object.entries(vault.entities)) {
    if (entity.label !== 'CUSTOM' || !key.startsWith(prefix)) continue;
    const n = Number(key.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

function observe(entity: EntityRecord, surface: string): void {
  entity.count += 1;
  if (surface === entity.canonical) return;

  if (surface.length > entity.canonical.length) {
    const previous = entity.canonical;
    entity.canonical = surface;
    entity.variants = entity.variants.filter((variant) => variant !== surface);
    if (previous.length > 0 && !entity.variants.includes(previous)) {
      entity.variants.push(previous);
    }
    return;
  }

  if (!entity.variants.includes(surface)) entity.variants.push(surface);
}

/**
 * PERSON observation (docs_masked `Entity.observe`): canonical by word count
 * then shorter surface, variants unique, nominative hint only on a strictly
 * better score.
 */
function observePerson(entity: EntityRecord, span: Span): void {
  entity.count += 1;

  const surface = span.text;
  if (!entity.variants.includes(surface)) entity.variants.push(surface);

  if (span.nominative && hintScoreGreater(span.nominative, entity.nominative)) {
    entity.nominative = span.nominative;
  }

  const candidate = span.canonical ?? surface;
  const candidateScore = span.canonicalScore ?? personCanonicalScore(candidate);
  const currentScore = personCanonicalScore(entity.canonical);
  if (candidateScore > currentScore) {
    entity.canonical = candidate;
  }
}

/**
 * Resolves a PERSON span: semantic-key map first, then exact canonical or
 * variant equality (case-insensitive).
 */
function findPersonEntityKey(vault: Vault, span: Span, index?: VaultIndex): string | undefined {
  if (index) ensureIndexFresh(vault, index);
  if (span.entityKey !== undefined) {
    const mapped = vault.personKeys?.[span.entityKey];
    if (mapped !== undefined && vault.entities[mapped]?.label === 'PERSON') {
      return mapped;
    }
  }

  const surfaces = [span.canonical, span.text]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => normalizedSurface(value));

  if (index) {
    for (const surface of surfaces) {
      const key = findIndexedKey(vault, index, 'PERSON', surface);
      if (key !== undefined) return key;
    }
  } else {
    for (const [key, entity] of Object.entries(vault.entities)) {
      if (entity.label !== 'PERSON') continue;
      if (surfaces.includes(normalizedSurface(entity.canonical))) return key;
      if (entity.variants.some((variant) => surfaces.includes(normalizedSurface(variant)))) {
        return key;
      }
    }
  }

  // Cluster a lone surname with the only known person of that surname. A full
  // mention may only absorb a previously-created one-word entity; two full
  // homonyms (Петров Алексей / Петрова Мария) must never merge here.
  const personKey = decodePersonKey(span.entityKey ?? '');
  if (personKey?.[0]) {
    const loneSurname = personKey[1].length === 0 && personKey[2].length === 0;
    const candidates: string[] = [];
    const consider = (key: string, entity: EntityRecord | undefined): void => {
      if (entity?.label !== 'PERSON') return;
      // Recheck the stem: the canonical may have changed after indexing.
      if (personStem(entity.canonical) !== personKey[0]) return;
      const wordCount = entity.canonical.trim().split(/\s+/u).filter(Boolean).length;
      if (!loneSurname && wordCount > 1) return;
      candidates.push(key);
    };
    if (index) {
      for (const key of index.personStems.get(personKey[0]) ?? []) {
        consider(key, vault.entities[key]);
      }
    } else {
      for (const [key, entity] of Object.entries(vault.entities)) {
        consider(key, entity);
      }
    }
    if (candidates.length === 1) return candidates[0];
  }

  return undefined;
}

/**
 * Adds one detection occurrence to the vault and returns its tag.
 * `vault.occurrences` is appended in call order (the masker calls this
 * left-to-right), which is what sequential restore replays.
 */
export function assignDetection(
  vault: Vault,
  span: Span,
  options: AssignOptions = {},
): AssignedEntity {
  if (options.index) ensureIndexFresh(vault, options.index);
  if (span.label === 'PERSON') {
    return assignPerson(vault, span, options);
  }

  const resolver =
    options.resolveKey ??
    ((target: Vault, value: Span) => findStructuredEntityKey(target, value, options.index));
  const resolvedKey = resolver(vault, span);
  const existing =
    resolvedKey !== undefined && vault.entities[resolvedKey]?.label === span.label
      ? { key: resolvedKey, entity: vault.entities[resolvedKey] }
      : undefined;

  if (existing) {
    observe(existing.entity, span.text);
    if (options.index) indexEntity(options.index.structured, existing.key, existing.entity);
    const tag = buildTag(vault, existing.key);
    pushOccurrence(vault, tag, span.text, options.index);
    return {
      key: existing.key,
      tag,
      label: existing.entity.label,
      canonical: canonicalOf(existing.entity),
      count: existing.entity.count,
      isNew: false,
    };
  }

  const customTagLabel = customLabelOfSpan(span);
  const key =
    customTagLabel === undefined
      ? `${span.label}_${nextCounter(vault, span.label, options.index)}`
      : `${customTagLabel}_${nextCustomCounter(vault, customTagLabel, options.index)}`;
  const entity: EntityRecord = {
    label: span.label,
    canonical: span.canonical ?? span.text,
    variants: [],
    count: 1,
  };
  vault.entities[key] = entity;
  if (options.index) indexEntity(options.index.structured, key, entity);

  const tag = buildTag(vault, key);
  pushOccurrence(vault, tag, span.text, options.index);
  return {
    key,
    tag,
    label: entity.label,
    canonical: canonicalOf(entity),
    count: entity.count,
    isNew: true,
  };
}

function assignPerson(vault: Vault, span: Span, options: AssignOptions = {}): AssignedEntity {
  vault.personKeys ??= {};

  const resolvedKey =
    options.resolveKey !== undefined
      ? options.resolveKey(vault, span)
      : findPersonEntityKey(vault, span, options.index);
  const existing =
    resolvedKey !== undefined && vault.entities[resolvedKey]?.label === 'PERSON'
      ? { key: resolvedKey, entity: vault.entities[resolvedKey] }
      : undefined;

  if (existing) {
    observePerson(existing.entity, span);
    if (options.index) {
      indexEntity(options.index.structured, existing.key, existing.entity);
      indexPersonStem(options.index.personStems, existing.key, existing.entity);
    }
    if (span.entityKey !== undefined) {
      vault.personKeys[span.entityKey] = existing.key;
    }
    const tag = buildTag(vault, existing.key);
    pushOccurrence(vault, tag, span.text, options.index);
    return {
      key: existing.key,
      tag,
      label: 'PERSON',
      canonical: canonicalOf(existing.entity),
      count: existing.entity.count,
      isNew: false,
    };
  }

  const key = `PERSON_${nextCounter(vault, 'PERSON', options.index)}`;
  const entity: EntityRecord = {
    label: 'PERSON',
    canonical: span.canonical ?? span.text,
    variants: [],
    count: 0,
  };
  vault.entities[key] = entity;
  observePerson(entity, span);
  if (options.index) {
    indexEntity(options.index.structured, key, entity);
    indexPersonStem(options.index.personStems, key, entity);
  }
  if (span.entityKey !== undefined) {
    vault.personKeys[span.entityKey] = key;
  }

  const tag = buildTag(vault, key);
  pushOccurrence(vault, tag, span.text, options.index);
  return {
    key,
    tag,
    label: 'PERSON',
    canonical: canonicalOf(entity),
    count: entity.count,
    isNew: true,
  };
}

/** Restore fallback: nominative hint when present, otherwise canonical. */
export function canonicalOf(entity: EntityRecord): string {
  return entity.nominative || entity.canonical;
}

/** `PERSON_1` -> `[[DM7F3_PERSON_1]]`. */
export function buildTag(vault: Vault, key: string): string {
  const match = ENTITY_KEY_RE.exec(key);
  if (!match) {
    throw new Error('Invalid entity key: expected <LABEL>_<N>');
  }
  const [, label = '', counter = '0'] = match;
  return makeTag(vault.prefix, label, Number(counter));
}

/** Utility for future format adapters: an occurrence list slice. */
export function occurrencesSince(vault: Vault, fromIndex: number): Occurrence[] {
  return vault.occurrences.slice(fromIndex);
}
