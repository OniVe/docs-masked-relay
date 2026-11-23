/**
 * JSON / JSONL adapter (M8).
 *
 * Edits are source-range splices over the original decoded text: string
 * values and property keys are replaced with `JSON.stringify(tag)`, so
 * indentation, key order, escapes and untouched number lexemes stay
 * byte-identical. Numbers are never converted: a numeric value that passes a
 * high-confidence PII checksum rejects the file (fail-closed). Only strict
 * JSON is accepted (no comments, no trailing commas); JSONL parses every
 * non-empty line independently. Encoding/BOM/EOL follow the TXT adapter.
 */

import { type Node as JsonNode, type ParseError, parseTree } from 'jsonc-parser';
import { inn10Valid, inn12Valid, luhnCheck, ogrnValid, snilsValid } from '../checksums';
import { detectAll, type Span } from '../detect';
import { isFirstName, isPatronymic, looksLikeSurname } from '../detect/person/mentions';
import { ensureStructuredScanner } from '../detect/wasm-scan';
import {
  anonymizeText,
  createFileRestoreSession,
  orderOccurrencesByPosition,
  type RestoreSession,
  restoreText,
} from '../masker';
import type {
  AnonymizeContext,
  AnonymizeResult,
  DetectionConfig,
  FileInput,
  FormatAdapter,
  MaskedEntity,
  RestoreResult,
  Vault,
} from '../types';
import { assignDetection, createVaultIndex, type VaultIndex } from '../vault';
import {
  decodeTextBytes,
  detectEncoding,
  detectEol,
  encodeTextBytes,
  parseTxtEncoding,
  resolveVaultFile,
  sha256Hex,
} from './txt';

const MAX_DEPTH = 200;
const MAX_NODES = 1_000_000;

/** Object keys in these name contexts are person-part fields (M8-2). */
const NAME_CONTEXT_KEYS = new Set([
  'first',
  'last',
  'middle',
  'surname',
  'given',
  'family',
  'patronymic',
  'name',
  'names',
  'fullname',
  'firstname',
  'lastname',
  'middlename',
  'givenname',
  'familyname',
  'patronymicname',
  'фио',
  'имя',
  'фамилия',
  'отчество',
]);

function isNameContextName(key: string): boolean {
  return NAME_CONTEXT_KEYS.has(key.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
}

/**
 * Latin transliterations of common RU first names/surnames (same dictionary as
 * the XML guard). A `first: "Ivan"` value is a person part too; generic
 * technical words (`user`, `path`, `value`) stay untouched.
 */
const LATIN_FIRST_NAMES = new Set(
  (
    'alexander alexandra alexey alexei anastasia anatoly andrei andrey anna anton ' +
    'arkady artem artur boris dmitry dmitri ekaterina elena fedor georgy gleb ' +
    'gregory igor ilya ivan kirill konstantin leonid marina maria maxim mikhail ' +
    'natalia natalya nikita nikolai nikolay oleg olga pavel petr peter roman ' +
    'sergey sergei sofia svetlana tatiana valentin valentina valery vasily viktor ' +
    'viktoria vladimir vladislav yakov yuri yury'
  ).split(' '),
);

const LATIN_SURNAMES = new Set(
  (
    'afanasev alekseev andreev antonov belov borisov dmitriev egorov fedorov ' +
    'frolov gusev ivanov kiselev kozlov kuznetsov lebedev makarov mikhailov ' +
    'morozov nikolaev novikov orlov pavlov petrov popov romanov semenov sergeev ' +
    'smirnov sokolov solovyov stepanov vasiliev volkov vorobiev yakovlev zaitsev ' +
    'zakharov'
  ).split(' '),
);

function isLatinPersonWord(word: string): boolean {
  if (!/^[A-Za-z]+$/u.test(word)) return false;
  const lower = word.toLowerCase();
  return LATIN_FIRST_NAMES.has(lower) || LATIN_SURNAMES.has(lower);
}

function personLabelsEnabled(config: DetectionConfig): boolean {
  return config.labels === undefined || config.labels.has('PERSON');
}

/**
 * Role-aware name value: a PERSON detector hit (including a partial span of a
 * three-part ФИО), or a one-word first name / surname / patronymic. Multi-word
 * non-PERSON values (`New York`, `Open AI`) never match.
 */
function isPersonFieldValue(value: string, config: DetectionConfig): boolean {
  const text = value.trim();
  if (text.length === 0) return false;
  if (detectAll(text, config).some((span) => span.label === 'PERSON')) return true;
  if (!personLabelsEnabled(config)) return false;
  const words = wordsOf(text);
  if (words.length !== 1) return false;
  const word = words[0] as string;
  return (
    isFirstName(word) || looksLikeSurname(word) || isPatronymic(word) || isLatinPersonWord(word)
  );
}

/** `.json` is one document; `.jsonl`/`.ndjson` is one JSON value per line. */
export type JsonMode = 'json' | 'jsonl';

/** Strict JSON number lexeme (RFC 8259). */
const NUMBER_LEXEME_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * Expands a decimal/exponent number lexeme to the integer it denotes without
 * float rounding. Returns undefined for fractional, negative or malformed
 * values: only non-negative whole numbers can be identifiers.
 */
function canonicalIntegerLexeme(value: string): string | undefined {
  const text = value.trim();
  if (!NUMBER_LEXEME_RE.test(text)) return undefined;

  const match = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (!match) return undefined;
  const [, sign = '', intPart = '', fraction = '', exponentText] = match;
  const digits = `${intPart}${fraction}`;

  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return undefined;

  const point = intPart.length + exponent;
  let integerPart: string;
  let fractionalPart: string;
  if (point <= 0) {
    integerPart = '0';
    fractionalPart = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    integerPart = digits + '0'.repeat(point - digits.length);
    fractionalPart = '';
  } else {
    integerPart = digits.slice(0, point);
    fractionalPart = digits.slice(point);
  }
  if (/[1-9]/u.test(fractionalPart)) return undefined;

  const canonical = integerPart.replace(/^0+(?=\d)/u, '');
  if (sign === '-' && canonical !== '0') return undefined;
  return canonical;
}

/**
 * High-confidence numeric identifiers, same rules as XLSX cells: INN, SNILS,
 * OGRN, Luhn CARD, 20-digit ACCOUNT and RU PHONE.
 */
function numericPiiLabel(value: string): string | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const length = value.length;

  if (length === 10 && inn10Valid(value)) return 'INN';
  if (length === 12 && inn12Valid(value)) return 'INN';
  if (length === 11 && snilsValid(value)) return 'SNILS';
  if ((length === 13 || length === 15) && ogrnValid(value)) return 'OGRN';
  if (length >= 13 && length <= 19 && luhnCheck(value)) return 'CARD';
  if (length === 20) return 'ACCOUNT';
  if (length === 11 && /^[78]\d{10}$/u.test(value)) return 'PHONE';
  return undefined;
}

/** Numeric JSON values cannot be converted without changing the type. */
function assertNumericSafe(raw: string, where: string): void {
  const canonical = canonicalIntegerLexeme(raw);
  if (canonical === undefined) return;
  const label = numericPiiLabel(canonical);
  if (label) {
    throw new Error(
      `JSON: numeric ${label} in ${where}; store the identifier as a JSON string instead`,
    );
  }
}

function parseStrict(text: string, where: string): JsonNode {
  const errors: ParseError[] = [];
  let root: JsonNode | undefined;
  try {
    root = parseTree(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    });
  } catch {
    throw new Error(`JSON: ${where} could not be parsed`);
  }
  if (!root || errors.length > 0) {
    const offset = errors[0]?.offset;
    const suffix = offset === undefined ? '' : ` at offset ${offset}`;
    throw new Error(`JSON: ${where} is not valid strict JSON${suffix}`);
  }
  const leading = text.slice(0, root.offset);
  const trailing = text.slice(root.offset + root.length);
  if (leading.trim().length > 0 || trailing.trim().length > 0) {
    throw new Error(`JSON: ${where} has content outside the root value`);
  }
  return root;
}

/** Walks the tree once: node/depth limits and numeric PII, before any edit. */
function assertTreeSafe(root: JsonNode, text: string, where: string): void {
  let nodes = 0;

  const visit = (node: JsonNode, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES) {
      throw new Error(`JSON: ${where} exceeds the ${MAX_NODES}-node limit`);
    }

    switch (node.type) {
      case 'object':
      case 'array': {
        if (depth > MAX_DEPTH) {
          throw new Error(`JSON: ${where} exceeds the ${MAX_DEPTH}-level nesting limit`);
        }
        for (const child of node.children ?? []) {
          if (node.type === 'object' && child.type === 'property') {
            const [key, value] = child.children ?? [];
            if (key) visit(key, depth);
            if (value) visit(value, depth + 1);
          } else {
            visit(child, depth + 1);
          }
        }
        return;
      }
      case 'number':
        assertNumericSafe(text.slice(node.offset, node.offset + node.length), where);
        return;
      default:
        return;
    }
  };

  visit(root, 1);
}

interface JsonSegment {
  text: string;
  /** Absolute offset of this segment inside the decoded document. */
  shift: number;
  label: string;
}

const EOL_RE = /\r\n|\n|\r/gu;

/**
 * Single JSON document or one segment per non-empty JSONL line. Splitting does
 * not touch the source: edits carry absolute offsets, so every EOL stays.
 */
function documentSegments(text: string, mode: JsonMode): JsonSegment[] {
  if (mode === 'json') return [{ text, shift: 0, label: 'document' }];

  const segments: JsonSegment[] = [];
  let start = 0;
  let line = 1;
  for (;;) {
    EOL_RE.lastIndex = start;
    const match = EOL_RE.exec(text);
    const end = match ? match.index : text.length;
    const content = text.slice(start, end);
    if (content.trim().length > 0) {
      segments.push({ text: content, shift: start, label: `line ${line}` });
    }
    if (!match) break;
    start = match.index + match[0].length;
    line += 1;
  }
  if (segments.length === 0) {
    throw new Error('JSONL: the file contains no JSON values');
  }
  return segments;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

interface MaskOutcome {
  edits: TextEdit[];
  entities: Map<string, MaskedEntity>;
  warnings: string[];
  /** Absolute source offsets of new occurrences, parallel to vault order. */
  occurrencePositions: number[];
}

const WORD_SEPARATORS_RE = /[^\p{L}\p{N}]+/gu;

function wordsOf(value: string): string[] {
  return value.split(WORD_SEPARATORS_RE).filter((word) => word.length > 0);
}

function titledPhrase(words: readonly string[]): string {
  return words
    .map((word) => {
      const first = word[0];
      return first === undefined ? word : `${first.toUpperCase()}${word.slice(1)}`;
    })
    .join(' ');
}

/** True when PERSON spans cover every non-space character of the text. */
function spansCoverText(text: string, spans: readonly Span[]): boolean {
  const ordered = [...spans].sort((left, right) => left.start - right.start);
  let cursor = 0;
  const skipSpaces = (): void => {
    while (cursor < text.length && /\s/u.test(text[cursor] ?? '')) cursor += 1;
  };
  for (const span of ordered) {
    skipSpaces();
    if (cursor < span.start) return false;
    cursor = Math.max(cursor, span.end);
  }
  skipSpaces();
  return cursor === text.length;
}

function isPersonText(text: string, config: DetectionConfig): boolean {
  const spans = detectAll(text, config).filter((span) => span.label === 'PERSON');
  return spans.length > 0 && spansCoverText(text, spans);
}

function syntheticPersonSpan(text: string, ruleId: string): Span {
  return {
    label: 'PERSON',
    start: 0,
    end: text.length,
    text,
    priority: 95,
    ruleId,
    canonical: text,
  };
}

function assignPersonTag(
  value: string,
  ruleId: string,
  vault: Vault,
  outcome: MaskOutcome,
  index: VaultIndex,
  position: number,
): string {
  const assigned = assignDetection(vault, syntheticPersonSpan(value, ruleId), { index });
  outcome.entities.set(assigned.key, {
    key: assigned.key,
    tag: assigned.tag,
    label: assigned.label,
    canonical: assigned.canonical,
    count: assigned.count,
  });
  outcome.occurrencePositions.push(position);
  return assigned.tag;
}

/**
 * Role-aware name masking (M8-2/M8R2-N2). Adjacent properties named
 * `first`/`last`/`surname`/... are joined for the FULL-name check, but every
 * name-context property is also evaluated on its own: detectAll PERSON
 * (including a partial span of a three-part ФИО), or a one-word first
 * name/surname/patronymic. That covers non-adjacent (`first`,`age`,`last`),
 * cross-level, array-of-objects and lone/interleaved fields; each original
 * value gets its own tag, so restore is exact.
 */
function planNameGroups(
  root: JsonNode,
  shift: number,
  config: DetectionConfig,
  vault: Vault,
  outcome: MaskOutcome,
  handled: Set<JsonNode>,
  vaultIndex: VaultIndex,
): void {
  const visit = (node: JsonNode): void => {
    if (node.type === 'object') {
      const properties = node.children ?? [];
      let index = 0;
      while (index < properties.length) {
        const first = properties[index];
        const firstValue = first?.type === 'property' ? first.children?.[1] : undefined;
        if (!first || !isNameContextProperty(first) || firstValue?.type !== 'string') {
          index += 1;
          continue;
        }

        const group: JsonNode[] = [];
        let cursor = index;
        while (cursor < properties.length) {
          const property = properties[cursor];
          if (!property || !isNameContextProperty(property)) break;
          const value = property.children?.[1];
          if (
            value?.type !== 'string' ||
            typeof value.value !== 'string' ||
            value.value.length === 0
          )
            break;
          group.push(value);
          cursor += 1;
        }
        index = cursor;
        if (group.length < 2) continue;

        const joined = group
          .map((value) => (typeof value.value === 'string' ? value.value.trim() : ''))
          .join(' ');
        const titled = titledPhrase(wordsOf(joined));
        if (!isPersonText(joined, config) && !isPersonText(titled, config)) continue;

        for (const valueNode of group) {
          const original = typeof valueNode.value === 'string' ? valueNode.value : '';
          if (original.length === 0) continue;
          const tag = assignPersonTag(
            original,
            'json.name-context',
            vault,
            outcome,
            vaultIndex,
            shift + valueNode.offset,
          );
          outcome.edits.push({
            start: shift + valueNode.offset,
            end: shift + valueNode.offset + valueNode.length,
            text: JSON.stringify(tag),
          });
          handled.add(valueNode);
        }
      }

      for (const property of properties) {
        if (!isNameContextProperty(property)) continue;
        const valueNode = property.children?.[1];
        if (valueNode?.type !== 'string' || typeof valueNode.value !== 'string') continue;
        if (valueNode.value.length === 0 || handled.has(valueNode)) continue;
        if (!isPersonFieldValue(valueNode.value, config)) continue;
        const tag = assignPersonTag(
          valueNode.value,
          'json.name-context.field',
          vault,
          outcome,
          vaultIndex,
          shift + valueNode.offset,
        );
        outcome.edits.push({
          start: shift + valueNode.offset,
          end: shift + valueNode.offset + valueNode.length,
          text: JSON.stringify(tag),
        });
        handled.add(valueNode);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
}

function isNameContextProperty(property: JsonNode): boolean {
  if (property.type !== 'property') return false;
  const key = property.children?.[0];
  if (key?.type !== 'string' || typeof key.value !== 'string') return false;
  return isNameContextName(key.value);
}

/** Masks string nodes (values and property keys) in source order. */
function maskTree(
  root: JsonNode,
  shift: number,
  config: DetectionConfig,
  vault: Vault,
  outcome: MaskOutcome,
  handled: ReadonlySet<JsonNode>,
  index: VaultIndex,
): void {
  const visit = (node: JsonNode): void => {
    if (node.type === 'string') {
      if (handled.has(node)) return;
      const original = typeof node.value === 'string' ? node.value : '';
      if (original.length === 0) return;
      const masked = anonymizeText(original, config, vault, { inPlace: true, index });
      if (masked.warnings.length > 0) outcome.warnings.push(...masked.warnings);
      for (const entity of masked.entities) outcome.entities.set(entity.key, entity);
      for (const replacement of masked.replacements) {
        outcome.occurrencePositions.push(shift + node.offset + replacement.start);
      }
      if (masked.maskedText === original) return;
      outcome.edits.push({
        start: shift + node.offset,
        end: shift + node.offset + node.length,
        text: JSON.stringify(masked.maskedText),
      });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
}

interface RestoreOutcome {
  edits: TextEdit[];
  replacements: number;
  unknownTags: Set<string>;
}

/** Replaces tags inside string nodes (values and keys) with JSON-escaped originals. */
function restoreTree(
  root: JsonNode,
  shift: number,
  vault: Vault,
  outcome: RestoreOutcome,
  session: RestoreSession,
): void {
  const visit = (node: JsonNode): void => {
    if (node.type === 'string') {
      const original = typeof node.value === 'string' ? node.value : '';
      if (!original.includes('[[')) return;
      const restored = restoreText(original, vault, { session });
      outcome.replacements += restored.replacements;
      for (const tag of restored.unknownTags) outcome.unknownTags.add(tag);
      if (restored.text === original) return;
      outcome.edits.push({
        start: shift + node.offset,
        end: shift + node.offset + node.length,
        text: JSON.stringify(restored.text),
      });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
}

/** Applies non-overlapping splices right-to-left. */
function applyEdits(text: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return text;
  const sorted = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);

  let previousEnd = 0;
  for (const edit of sorted) {
    if (edit.start < previousEnd || edit.end < edit.start || edit.end > text.length) {
      throw new Error('JSON: overlapping or invalid edit range');
    }
    previousEnd = edit.end;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    parts.push(text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
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

function jsonMode(file: Pick<FileInput, 'name' | 'mimeType'>): JsonMode | undefined {
  if (/\.(?:jsonl|ndjson)$/iu.test(file.name)) return 'jsonl';
  const mime = file.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    mime === 'application/x-ndjson' ||
    mime === 'application/ndjson' ||
    mime === 'application/jsonl'
  ) {
    return 'jsonl';
  }
  if (
    /\.json$/iu.test(file.name) ||
    mime === 'application/json' ||
    mime === 'text/json' ||
    mime === 'application/x-json'
  ) {
    return 'json';
  }
  return undefined;
}

export async function anonymizeJson(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();

  const mode = jsonMode(file);
  if (!mode) throw new Error('JSON: unsupported file');

  const detected = detectEncoding(file.bytes);
  const text = decodeTextBytes(file.bytes, detected.encoding, detected.bom);
  const eol = detectEol(text);
  const sha256 = await sha256Hex(file.bytes);
  const warnings: string[] = [];
  if (!detected.bom && (detected.encoding === 'utf-16le' || detected.encoding === 'utf-16be')) {
    warnings.push('UTF-16 without BOM detected; the encoding was inferred');
  }
  if (detected.ambiguous) {
    warnings.push('Text encoding is ambiguous; UTF-8/UTF-16 was inferred');
  }

  const segments = documentSegments(text, mode);
  const parsed = segments.map((segment) => ({
    segment,
    root: parseStrict(segment.text, segment.label),
  }));
  // Validate every line before mutating the vault: JSONL is all-or-nothing.
  for (const { segment, root } of parsed) {
    assertTreeSafe(root, segment.text, segment.label);
  }

  const snapshot = structuredClone(ctx.vault);
  const occurrenceStart = ctx.vault.occurrences.length;
  const outcome: MaskOutcome = {
    edits: [],
    entities: new Map(),
    warnings: [],
    occurrencePositions: [],
  };
  let maskedText: string;
  let maskedBytes: Uint8Array;

  try {
    const handled = new Set<JsonNode>();
    const config = ctx.config ?? {};
    // One index for the whole document: string nodes reuse it incrementally
    // instead of rebuilding over the growing vault on every call (R15 perf).
    const vaultIndex = createVaultIndex(ctx.vault);
    for (const { segment, root } of parsed) {
      planNameGroups(root, segment.shift, config, ctx.vault, outcome, handled, vaultIndex);
    }
    for (const { segment, root } of parsed) {
      maskTree(root, segment.shift, config, ctx.vault, outcome, handled, vaultIndex);
    }
    maskedText = applyEdits(text, outcome.edits);
    maskedBytes = encodeTextBytes(maskedText, 'utf-8', false);
  } catch (error) {
    commitVault(ctx.vault, snapshot);
    throw error;
  }

  const vault = ctx.vault;
  // Name-context planning runs before the source-order string pass, so call
  // order is not document order; reorder the scope by recorded source offsets.
  orderOccurrencesByPosition(vault, occurrenceStart, outcome.occurrencePositions);
  const occurrenceCount = vault.occurrences.length - occurrenceStart;

  vault.files.push({
    originalName: file.name,
    // Filename masking is part of the upload hook; the adapter keeps the name.
    maskedName: file.name,
    format: 'json',
    size: file.bytes.byteLength,
    sha256,
    maskedSha256: await sha256Hex(maskedBytes),
    encoding: detected.encoding,
    bom: detected.bom,
    eol,
    occurrenceStart,
    occurrenceCount,
  });

  return {
    maskedBytes,
    maskedName: file.name,
    maskedMime: mode === 'jsonl' ? 'application/x-ndjson' : 'application/json',
    format: 'json',
    entities: [...outcome.entities.values()],
    occurrences: vault.occurrences.slice(occurrenceStart),
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings: [...warnings, ...outcome.warnings],
  };
}

export async function restoreJson(file: FileInput, vault: Vault): Promise<RestoreResult> {
  let maskedText: string;
  try {
    maskedText = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new Error('Masked JSON file is not valid UTF-8');
  }

  const mode = jsonMode(file);
  if (!mode) throw new Error('JSON: unsupported file');

  const segments = documentSegments(maskedText, mode);
  const outcome: RestoreOutcome = { edits: [], replacements: 0, unknownTags: new Set() };
  let parsed: { segment: JsonSegment; root: JsonNode }[];
  try {
    parsed = segments.map((segment) => ({
      segment,
      root: parseStrict(segment.text, segment.label),
    }));
  } catch (error) {
    throw new Error(
      `Masked JSON is not valid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Masked bytes identify the record first; a shared name is ambiguous
  // unless the hash picks one file (R16-RESTORE-IDENTITY).
  const record = await resolveVaultFile(vault, file);
  // One cursor for the whole document. A legacy record in a multi-file vault
  // is marked ambiguous and restore fails closed on the first known tag.
  const session = createFileRestoreSession(vault, record);
  for (const { segment, root } of parsed) {
    restoreTree(root, segment.shift, vault, outcome, session);
  }

  // The masked JSON text is UTF-8 but keeps the source EOL layout verbatim:
  // re-applying a dominant EOL here would rewrite mixed endings (M8-M1).
  const restoredText = applyEdits(maskedText, outcome.edits);

  const encoding = parseTxtEncoding(record?.encoding) ?? 'utf-8';
  const bytes = encodeTextBytes(restoredText, encoding, record?.bom ?? false);
  // Hash matching also finds a record when the download name was changed;
  // in that case keep the caller's name so its tags are restored as before.
  const fileName =
    record && (record.maskedName === file.name || record.originalName === file.name)
      ? record.originalName
      : file.name;

  const warnings: string[] = [];
  if (outcome.unknownTags.size > 0) {
    warnings.push(`${outcome.unknownTags.size} unknown tag(s) left untouched`);
  }

  return {
    bytes,
    fileName,
    replacements: outcome.replacements,
    unknownTags: [...outcome.unknownTags],
    warnings,
  };
}

export const jsonFormatAdapter: FormatAdapter = {
  format: 'json',
  extensions: ['.json', '.jsonl', '.ndjson'],
  mimeTypes: [
    'application/json',
    'text/json',
    'application/x-ndjson',
    'application/ndjson',
    'application/jsonl',
  ],
  canHandle(file) {
    return jsonMode(file) !== undefined;
  },
  anonymize(file, ctx) {
    return anonymizeJson(file, ctx);
  },
  restore(file, vault) {
    return restoreJson(file, vault);
  },
};
