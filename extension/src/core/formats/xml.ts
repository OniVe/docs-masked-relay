/**
 * Generic XML adapter (M8).
 *
 * Reuses the byte-level OOXML XML scanner, but without OOXML policies: text
 * nodes, CDATA and attribute values are masked; element/attribute names,
 * namespace declarations and `xml:*` attributes stay structural. Comments and
 * processing instructions are cleared one-way (their content is not stored in
 * the vault). DOCTYPE/DTD and unknown entities are rejected by the scanner.
 * Edits are source-range splices, so namespaces, prefixes, attribute order and
 * untouched formatting stay byte-identical. Encoding/BOM/EOL follow TXT, and
 * the XML declaration encoding is rewritten to match the emitted bytes.
 */

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
import {
  escapeXmlAttribute,
  escapeXmlText,
  scanXml,
  validateXmlText,
  type XmlAttribute,
  type XmlEdit,
  type XmlElement,
  XmlError,
  type XmlScan,
  type XmlTextNode,
} from '../ooxml';
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
  type TxtEncoding,
} from './txt';

const MAX_DEPTH = 200;
const MAX_NODES = 1_000_000;
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

function assertLinearEditBoundary(text: string, offset: number): void {
  if (offset <= 0 || offset >= text.length) return;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    throw new XmlError(`Edit boundary at offset ${offset} splits a surrogate pair`);
  }
}

/**
 * Same validation as the shared `applyXmlEdits`, but assembles the output in a
 * single pass. The shared helper rebuilds the whole string for every edit
 * (O(n*k)); for a 25 MB document with thousands of edits that dominates both
 * time and transient memory (R15 perf). Kept local to the generic XML adapter
 * so OOXML package emission keeps its existing helper.
 */
function applyXmlEditsLinear(xml: string, edits: readonly XmlEdit[]): string {
  if (edits.length === 0) return xml;

  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0;
  for (const edit of sorted) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > xml.length
    ) {
      throw new XmlError(`Invalid XML edit range ${edit.start}..${edit.end}`);
    }
    if (edit.start < previousEnd) {
      throw new XmlError(`Overlapping XML edits at offset ${edit.start}`);
    }
    assertLinearEditBoundary(xml, edit.start);
    assertLinearEditBoundary(xml, edit.end);
    previousEnd = edit.end;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    parts.push(xml.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(xml.slice(cursor));
  return parts.join('');
}

/**
 * Namespace declarations and the two value-less-in-practice reserved
 * attributes are structural. `xml:base` and `xml:id` are user data: they can
 * carry an e-mail or a person id, so they are masked like ordinary values.
 */
function isStructuralAttribute(attr: XmlAttribute): boolean {
  if (attr.qname === 'xmlns' || attr.prefix === 'xmlns') return true;
  return attr.qname === 'xml:lang' || attr.qname === 'xml:space';
}

/** Element/attribute names in these name contexts are person-part fields. */
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

function normalizedNameKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function isNameContextName(local: string): boolean {
  return NAME_CONTEXT_KEYS.has(normalizedNameKey(local));
}

/**
 * Field-type names are not person data even when a dictionary would read them
 * as a surname (`Фамилия` is caught by `looksLikeSurname`). They may appear as
 * element/attribute names (`<Фамилия>Петров</Фамилия>`) and must pass the
 * structural guard; their *values* are still masked by the role-aware pass.
 */
const STRUCTURAL_FIELD_ALLOWLIST = new Set(
  [
    'Фамилия',
    'Имя',
    'Отчество',
    'first',
    'last',
    'middle',
    'surname',
    'given',
    'family',
    'patronymic',
    'name',
    'firstName',
    'lastName',
    'fullName',
    'id',
    'value',
    'item',
    'data',
    'root',
    'type',
    'status',
  ].map(normalizedNameKey),
);

function isStructuralFieldName(word: string): boolean {
  return STRUCTURAL_FIELD_ALLOWLIST.has(normalizedNameKey(word));
}

/**
 * Latin transliterations of common RU first names/surnames. The RU detectors
 * only know Cyrillic, and a URL path segment or a one-word XML name is too
 * short for the general heuristics; this dictionary closes the asymmetric
 * Latin blind spot without turning generic technical words (`root`, `path`,
 * `user`, `example`) into PII.
 */
const LATIN_FIRST_NAMES = new Set(
  (
    'alexander alexandra alexey alexei anastasia anatoly andrei andrey anna anton ' +
    'arkady artem artur boris dmitry dmitri ekaterina elena fedor georgy gleb ' +
    'gregory igor ilya ivan kirill konstantin leonid marina maria maxim mikhail ' +
    'natalia natalya nikita nikolai nikolay oleg olga pavel petr peter roman ' +
    'sergey sergei sofia svetlana tatiana tatiana valentin valentina valery ' +
    'vasily viktor viktoria vladimir vladislav yakov yuri yury'
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

/** Case-insensitive Latin first-name/surname dictionary match. */
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

function xmlMode(file: Pick<FileInput, 'name' | 'mimeType'>): boolean {
  const mime = file.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return /\.xml$/iu.test(file.name) || mime === 'application/xml' || mime === 'text/xml';
}

/** Depth/node budget for a document that survived scanning. */
function assertXmlLimits(scan: XmlScan): void {
  let nodes = scan.elements.length + scan.textNodes.length;
  for (const element of scan.elements) nodes += element.attrs.length;
  if (nodes > MAX_NODES) {
    throw new Error(`XML: document exceeds the ${MAX_NODES}-node limit`);
  }

  const stack: { element: (typeof scan.elements)[number]; depth: number }[] = [
    { element: scan.root, depth: 1 },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.depth > MAX_DEPTH) {
      throw new Error(`XML: document exceeds the ${MAX_DEPTH}-level nesting limit`);
    }
    for (const child of current.element.children) {
      stack.push({ element: child, depth: current.depth + 1 });
    }
  }
}

/**
 * Original `encoding="..."` label from the source declaration. Stored in the
 * file record so restore can reproduce the exact spelling (`utf8`, `cp1251`),
 * not only the canonical label (M8R2-N3).
 */
function originalDeclarationEncoding(text: string): string | undefined {
  const match = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*(['"])([^'"]+)\1/u.exec(text);
  const label = match?.[2];
  if (!label) return undefined;
  return /^[A-Za-z][A-Za-z0-9._-]*$/u.test(label) ? label : undefined;
}

/** Maps the stored encoding to the label written into the XML declaration. */
function declarationEncodingLabel(encoding: TxtEncoding): string {
  switch (encoding) {
    case 'utf-16le':
    case 'utf-16be':
      return 'UTF-16';
    case 'windows-1251':
      return 'windows-1251';
    default:
      return 'UTF-8';
  }
}

/**
 * Replaces the `encoding="..."` value of an XML declaration, keeping version,
 * standalone, quote style and whitespace. No-op when the value already matches.
 */
function rewriteDeclarationEncoding(declaration: string, encoding: string): string {
  const match = /(\bencoding\s*=\s*)(['"])([^'"]*)\2/iu.exec(declaration);
  if (!match) return declaration;
  const current = match[3] ?? '';
  if (current.toLowerCase() === encoding.toLowerCase()) return declaration;
  const valueStart = match.index + (match[1]?.length ?? 0) + 1;
  const valueEnd = valueStart + current.length;
  return declaration.slice(0, valueStart) + encoding + declaration.slice(valueEnd);
}

const CYRILLIC_CAPITAL_START = /^[А-ЯЁ]/u;
const LATIN_WORD_RE = /^[A-Za-z][A-Za-z0-9]*$/u;
const STRUCTURAL_SEPARATORS_RE = /[^\p{L}\p{N}]+/gu;

function wordsOf(value: string): string[] {
  return value.split(STRUCTURAL_SEPARATORS_RE).filter((word) => word.length > 0);
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

/**
 * Structural names, namespace URIs and PI targets cannot be masked in place
 * (rewriting an element name would break markup and references), so any
 * high-confidence PII there rejects the file. Machine names (`root`,
 * `urn:example`, `xml:lang`) pass; a capitalised Cyrillic name token or a
 * lower-case identifier that title-cases into a full PERSON span fails.
 */
function hasStructuralPii(value: string): boolean {
  if (value.length === 0) return false;
  if (detectAll(value).length > 0) return true;

  const words = wordsOf(value);
  if (words.length === 0) return false;
  const spaced = words.join(' ');
  if (spaced !== value && detectAll(spaced).length > 0) return true;

  for (const word of words) {
    if (isStructuralFieldName(word)) continue;
    if (CYRILLIC_CAPITAL_START.test(word)) {
      if (looksLikeSurname(word) || isFirstName(word) || isPatronymic(word)) return true;
    }
    // Single Latin name/surname (`<ivan/>`, `urn:ivan`, `attr_ivan`); the
    // case-insensitive dictionary also catches `Ivan`/`IVAN`.
    if (isLatinPersonWord(word)) return true;
  }

  if (words.length >= 2 && words.every((word) => LATIN_WORD_RE.test(word))) {
    const titled = titledPhrase(words);
    if (titled !== value && isPersonText(titled, {})) return true;
  }

  return false;
}

function structuralError(kind: string, offset: number): Error {
  return new Error(
    `XML: possible PII in a structural ${kind} at offset ${offset}; the file was rejected (fail-closed)`,
  );
}

/** BCP47-like language tag; invalid values cannot be masked (structural). */
const XML_LANG_RE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const XML_SPACE_VALUES = new Set(['default', 'preserve']);

function invalidXmlAttributeError(name: string, offset: number): Error {
  return new Error(
    `XML: invalid ${name} value at offset ${offset}; the file was rejected (fail-closed)`,
  );
}

/** A language subtag that reads as a person name (`en-Ivan`) is not a tag. */
function langSubtagHasPersonPii(subtag: string): boolean {
  if (isLatinPersonWord(subtag)) return true;
  return detectAll(subtag).some((span) => span.label === 'PERSON');
}

/**
 * `xml:lang`/`xml:space` are structural: their values are never emitted into
 * the masked document, so a crafted value would leak verbatim. Validate the
 * allowed shapes and reject the file otherwise (M8R2-M1). An empty `xml:lang`
 * is valid XML 1.0 and stays structural (M8R3-M2); non-empty subtags must not
 * carry a PERSON name (M8R3).
 */
function assertReservedXmlAttributes(scan: XmlScan): void {
  for (const element of scan.elements) {
    for (const attr of element.attrs) {
      if (attr.qname === 'xml:lang') {
        if (attr.value.length === 0) continue;
        if (!XML_LANG_RE.test(attr.value)) {
          throw invalidXmlAttributeError('xml:lang', attr.valueStart);
        }
        for (const subtag of attr.value.split('-')) {
          if (langSubtagHasPersonPii(subtag)) {
            throw structuralError('xml:lang value', attr.valueStart);
          }
        }
      }
      if (attr.qname === 'xml:space' && !XML_SPACE_VALUES.has(attr.value)) {
        throw invalidXmlAttributeError('xml:space', attr.valueStart);
      }
    }
  }
}

/** Rejects PII in element/attribute names, namespace URIs and PI targets. */
function assertStructuralSafe(scan: XmlScan): void {
  assertReservedXmlAttributes(scan);
  for (const element of scan.elements) {
    if (hasStructuralPii(element.qname)) {
      throw structuralError('element name', element.start);
    }
    for (const attr of element.attrs) {
      if (hasStructuralPii(attr.qname)) {
        throw structuralError('attribute name', attr.valueStart);
      }
      if (attr.qname === 'xmlns' || attr.prefix === 'xmlns') {
        // A namespace URI can hide PII behind percent-encoding (`urn:%D0%98...`);
        // check both the raw and the safely decoded form (M8R3-M1).
        const decoded = decodeUriComponentSafe(attr.value);
        if (hasStructuralPii(attr.value) || (decoded !== attr.value && hasStructuralPii(decoded))) {
          throw structuralError('namespace URI', attr.valueStart);
        }
      }
    }
  }
  for (const token of scan.tokens) {
    if (token.kind !== 'pi' || token.target.toLowerCase() === 'xml') continue;
    if (hasStructuralPii(token.target)) {
      throw structuralError('processing-instruction target', token.start);
    }
  }
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

/** URI/identifier separators; a person name may hide in one segment. */
const URI_SEGMENT_SEPARATORS_RE = /[/\\?#&=_.%:@+\-\s]+/u;

/**
 * Absolute or protocol-relative URI with a userinfo component:
 * `scheme://user:password@host` or `//user@host` (M8-1 r3). The email detector
 * masks only `password@host`, so the login name would stay in the masked
 * document; userinfo is credential material and the whole URI is masked.
 */
const URI_USERINFO_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)[^/@\s]+@/u;

/** A value that is entirely one absolute/protocol-relative URI (M8-1 r3). */
const URI_WHOLE_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)[^\s<>"']+$/u;

/**
 * A URI substring inside prose (`scheme://...` or a protocol-relative
 * `//user@host`), e.g. in a text node or an ordinary attribute value. Only the
 * matched URI is replaced, the prose stays intact (M8-1 r3).
 */
const URI_SUBSTRING_RE =
  /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+|(?<![A-Za-z0-9+.:/])\/\/[^/@\s]+@[^\s<>"']*)/gu;

/**
 * A scheme URI without `//` (`urn:ivan`, `mailto:...`, `tel:...`). Used for
 * ordinary attribute values, where an opaque id can carry a person name; an
 * email inside (`mailto:ivan@example.ru`) keeps the email-detector's masking
 * instead of a whole-URI person tag (M8-1 r3).
 */
const OPAQUE_URI_SUBSTRING_RE = /(?<![A-Za-z0-9+.\-/])[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"']+/gu;

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent escapes are common in opaque ids; keep the literal.
    return value;
  }
}

function isPiiSegmentLabel(label: string): boolean {
  return label === 'PERSON' || label === 'EMAIL' || label === 'PHONE' || label === 'URL';
}

function textHasPii(text: string, config: DetectionConfig): boolean {
  return detectAll(text, config).some((span) => isPiiSegmentLabel(span.label));
}

function uriHasEmail(uri: string, config: DetectionConfig): boolean {
  return detectAll(uri, config).some((span) => span.label === 'EMAIL');
}

/** One URI path/query segment: a detector hit or a single known name word. */
function segmentLooksPersonal(segment: string, config: DetectionConfig): boolean {
  if (segment.length === 0) return false;
  if (textHasPii(segment, config)) return true;
  if (!personLabelsEnabled(config)) return false;
  const words = wordsOf(segment);
  if (words.length !== 1) return false;
  const word = words[0] as string;
  return (
    isFirstName(word) || looksLikeSurname(word) || isPatronymic(word) || isLatinPersonWord(word)
  );
}

/** Two or three adjacent segments joined by spaces (name across separators). */
function segmentWindowLooksPersonal(joined: string, config: DetectionConfig): boolean {
  if (textHasPii(joined, config)) return true;
  if (!personLabelsEnabled(config)) return false;
  const words = wordsOf(joined);
  if (words.length < 2 || words.length > 3) return false;
  return words.every((word) => isLatinPersonWord(word));
}

/**
 * `xml:base`/`xml:id` values are ordinary data. A name can sit in one URI
 * segment (`/ivan`, `/ivan_petrov`, `/Иван_Петров`) or be hidden behind
 * separators; percent-encoded values are decoded first. Any hit masks the
 * whole attribute value under one tag, so restore is exact (M8-1).
 */
function personIdentifierTag(
  value: string,
  config: DetectionConfig,
  vault: Vault,
  outcome: MaskOutcome,
  vaultIndex: VaultIndex,
  position: number,
): string | undefined {
  for (const candidate of new Set([value, decodeUriComponentSafe(value)])) {
    const segments = candidate.split(URI_SEGMENT_SEPARATORS_RE).filter((part) => part.length > 0);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      if (segmentLooksPersonal(segment, config)) {
        return assignPersonTag(
          value,
          'xml.attribute.person-id',
          vault,
          outcome,
          vaultIndex,
          position,
        );
      }
      for (const width of [2, 3]) {
        if (index + width > segments.length) continue;
        const joined = segments.slice(index, index + width).join(' ');
        if (segmentWindowLooksPersonal(joined, config)) {
          return assignPersonTag(
            value,
            'xml.attribute.person-id',
            vault,
            outcome,
            vaultIndex,
            position,
          );
        }
      }
    }
  }
  return undefined;
}

/**
 * Whole-value tag for a URI with userinfo. Applied before the email/other
 * detectors so a non-dictionary login (`sidorov`, `sasha`) cannot survive as a
 * partial mask; the canonical original restores exactly (M8-1 r3).
 */
function userinfoTag(
  value: string,
  vault: Vault,
  outcome: MaskOutcome,
  index: VaultIndex,
  position: number,
): string | undefined {
  const trimmed = value.trim();
  if (!URI_WHOLE_RE.test(trimmed) || !URI_USERINFO_RE.test(trimmed)) return undefined;
  return assignPersonTag(value, 'xml.userinfo-uri', vault, outcome, index, position);
}

interface MaskOutcome {
  edits: XmlEdit[];
  entities: Map<string, MaskedEntity>;
  warnings: string[];
  comments: number;
  instructions: number;
  cdataSections: number;
  /** Absolute source offsets of new occurrences, parallel to vault order. */
  occurrencePositions: number[];
}

/**
 * Masks URI substrings inside a text/attribute value: a URI with userinfo
 * always, and (for ordinary attributes) a URI whose path/query segments carry
 * a person name. Only the matched URI is replaced; the surrounding prose is
 * still passed through `anonymizeText`, so ordinary PII in the same value is
 * masked as before. Returns undefined when no URI substring needs masking, so
 * the caller keeps the plain `anonymizeText` path (M8-1 r3).
 */
function maskUrisInValue(
  value: string,
  base: number,
  config: DetectionConfig,
  vault: Vault,
  outcome: MaskOutcome,
  personPaths: boolean,
  pattern: RegExp,
  skipEmailUris: boolean,
  index: VaultIndex,
): string | undefined {
  let result = '';
  let cursor = 0;
  let changed = false;
  for (const match of value.matchAll(pattern)) {
    const uri = match[0];
    const start = match.index ?? 0;
    let tag: string | undefined;
    if (URI_USERINFO_RE.test(uri)) {
      tag = assignPersonTag(uri, 'xml.userinfo-uri', vault, outcome, index, base + start);
    } else if (personPaths && !(skipEmailUris && uriHasEmail(uri, config))) {
      tag = personIdentifierTag(uri, config, vault, outcome, index, base + start);
    }
    if (tag === undefined) continue;

    const prose = anonymizeText(value.slice(cursor, start), config, vault, {
      inPlace: true,
      index,
    });
    if (prose.warnings.length > 0) outcome.warnings.push(...prose.warnings);
    for (const entity of prose.entities) outcome.entities.set(entity.key, entity);
    for (const replacement of prose.replacements) {
      outcome.occurrencePositions.push(base + cursor + replacement.start);
    }
    result += prose.maskedText + tag;
    cursor = start + uri.length;
    changed = true;
  }
  if (!changed) return undefined;

  const tail = anonymizeText(value.slice(cursor), config, vault, { inPlace: true, index });
  if (tail.warnings.length > 0) outcome.warnings.push(...tail.warnings);
  for (const entity of tail.entities) outcome.entities.set(entity.key, entity);
  for (const replacement of tail.replacements) {
    outcome.occurrencePositions.push(base + cursor + replacement.start);
  }
  return result + tail.maskedText;
}

/** A text-only element whose value is a candidate person-name part. */
function simpleTextNode(element: XmlElement): XmlTextNode | undefined {
  if (element.children.length > 0 || element.textNodes.length !== 1) return undefined;
  const node = element.textNodes[0];
  if (node?.kind !== 'text' || node.text.trim().length === 0) return undefined;
  return node;
}

/** True when the element or one of its ancestors is a name-context field. */
function elementInNameContext(element: XmlElement): boolean {
  for (let current: XmlElement | null = element; current; current = current.parent) {
    if (isNameContextName(current.local)) return true;
  }
  return false;
}

/** Masks one whole text/CDATA node; a CDATA section is replaced as a unit. */
function maskPersonTextNode(
  node: XmlTextNode,
  ruleId: string,
  vault: Vault,
  outcome: MaskOutcome,
  index: VaultIndex,
): void {
  const tag = assignPersonTag(node.text, ruleId, vault, outcome, index, node.start);
  if (node.kind === 'text') {
    outcome.edits.push({
      start: node.start,
      end: node.end,
      text: escapeXmlText(tag),
    });
    return;
  }
  outcome.edits.push({
    start: node.start - CDATA_OPEN.length,
    end: node.end + CDATA_CLOSE.length,
    text: escapeXmlText(tag),
  });
  outcome.cdataSections += 1;
}

interface NameFieldOutcome {
  text: Set<XmlTextNode>;
  attrs: Set<XmlAttribute>;
}

/**
 * Role-aware name masking (M8-2/M8R2-N2). Adjacent `first`/`last` siblings are
 * still joined for the FULL-name check, but every name-context value is also
 * evaluated on its own: detectAll PERSON (including a partial span of a
 * three-part ФИО), or a one-word first name/surname/patronymic. That covers
 * non-adjacent elements, nested children, CDATA, XML attributes and different
 * parents; values that are not person parts (`Север`, `Нью-Йорк`-style
 * multi-word non-PERSON) stay untouched.
 */
function maskNameGroups(
  scan: XmlScan,
  config: DetectionConfig,
  vault: Vault,
  outcome: MaskOutcome,
  vaultIndex: VaultIndex,
): NameFieldOutcome {
  const handledText = new Set<XmlTextNode>();
  const handledAttrs = new Set<XmlAttribute>();

  for (const parent of scan.elements) {
    let index = 0;
    while (index < parent.children.length) {
      const first = parent.children[index];
      const firstText = first ? simpleTextNode(first) : undefined;
      if (!first || !firstText || !isNameContextName(first.local)) {
        index += 1;
        continue;
      }

      const group: { node: XmlTextNode }[] = [];
      let cursor = index;
      while (cursor < parent.children.length) {
        const child = parent.children[cursor];
        const node = child ? simpleTextNode(child) : undefined;
        if (!child || !node || !isNameContextName(child.local)) break;
        group.push({ node });
        cursor += 1;
      }
      index = cursor;
      if (group.length < 2) continue;

      const joined = group.map((item) => item.node.text.trim()).join(' ');
      const titled = titledPhrase(wordsOf(joined));
      if (!isPersonText(joined, config) && !isPersonText(titled, config)) continue;

      for (const item of group) {
        maskPersonTextNode(item.node, 'xml.name-context', vault, outcome, vaultIndex);
        handledText.add(item.node);
      }
    }
  }

  for (const node of scan.textNodes) {
    if (handledText.has(node) || node.text.trim().length === 0) continue;
    if (!elementInNameContext(node.element)) continue;
    if (!isPersonFieldValue(node.text, config)) continue;
    maskPersonTextNode(node, 'xml.name-context.field', vault, outcome, vaultIndex);
    handledText.add(node);
  }

  for (const element of scan.elements) {
    for (const attr of element.attrs) {
      if (isStructuralAttribute(attr) || !isNameContextName(attr.local)) continue;
      if (attr.value.trim().length === 0 || !isPersonFieldValue(attr.value, config)) continue;
      const tag = assignPersonTag(
        attr.value,
        'xml.attribute.name-context',
        vault,
        outcome,
        vaultIndex,
        attr.valueStart,
      );
      outcome.edits.push({
        start: attr.valueStart,
        end: attr.valueEnd,
        text: escapeXmlAttribute(tag),
      });
      handledAttrs.add(attr);
    }
  }

  return { text: handledText, attrs: handledAttrs };
}

/**
 * A CDATA section is replaced as a whole with escaped character data: keeping
 * the `]]>` wrapper while inserting a tag that itself ends with `]]` would
 * produce an accidental `]]>` terminator. Text semantics are preserved.
 */
function maskXmlContent(
  scan: XmlScan,
  config: DetectionConfig,
  vault: Vault,
  outcome: MaskOutcome,
  index: VaultIndex,
): void {
  const handled = maskNameGroups(scan, config, vault, outcome, index);

  for (const node of scan.textNodes) {
    if (handled.text.has(node) || node.text.trim().length === 0) continue;
    // Text/CDATA use the same URI-segment person analysis as attributes: a
    // name in a path (`See https://example.ru/ivan now`) is PII too.
    const uriMasked = maskUrisInValue(
      node.text,
      node.start,
      config,
      vault,
      outcome,
      true,
      URI_SUBSTRING_RE,
      false,
      index,
    );
    if (uriMasked !== undefined) {
      if (node.kind === 'text') {
        outcome.edits.push({
          start: node.start,
          end: node.end,
          text: escapeXmlText(uriMasked),
        });
      } else {
        outcome.edits.push({
          start: node.start - CDATA_OPEN.length,
          end: node.end + CDATA_CLOSE.length,
          text: escapeXmlText(uriMasked),
        });
        outcome.cdataSections += 1;
      }
      continue;
    }
    const masked = anonymizeText(node.text, config, vault, { inPlace: true, index });
    if (masked.warnings.length > 0) outcome.warnings.push(...masked.warnings);
    for (const entity of masked.entities) outcome.entities.set(entity.key, entity);
    for (const replacement of masked.replacements) {
      outcome.occurrencePositions.push(node.start + replacement.start);
    }
    if (masked.maskedText === node.text) continue;

    if (node.kind === 'text') {
      outcome.edits.push({
        start: node.start,
        end: node.end,
        text: escapeXmlText(masked.maskedText),
      });
    } else {
      outcome.edits.push({
        start: node.start - CDATA_OPEN.length,
        end: node.end + CDATA_CLOSE.length,
        text: escapeXmlText(masked.maskedText),
      });
      outcome.cdataSections += 1;
    }
  }

  for (const element of scan.elements) {
    for (const attr of element.attrs) {
      if (handled.attrs.has(attr) || isStructuralAttribute(attr)) continue;
      if (attr.value.trim().length === 0) continue;
      // Userinfo URLs are masked as a whole before the email detector can leave
      // the login name (`https://ivan:petrov@example.ru/path`) in cleartext.
      const userinfo = userinfoTag(attr.value, vault, outcome, index, attr.valueStart);
      if (userinfo !== undefined) {
        outcome.edits.push({
          start: attr.valueStart,
          end: attr.valueEnd,
          text: escapeXmlAttribute(userinfo),
        });
        continue;
      }
      // Ordinary attributes: a person name in a URI path/query segment is PII
      // too (`url="https://example.ru/ivan"`); only the URI substring is
      // replaced, prose around it stays (M8-1 r3).
      const uriMasked = maskUrisInValue(
        attr.value,
        attr.valueStart,
        config,
        vault,
        outcome,
        true,
        URI_SUBSTRING_RE,
        false,
        index,
      );
      if (uriMasked !== undefined) {
        outcome.edits.push({
          start: attr.valueStart,
          end: attr.valueEnd,
          text: escapeXmlAttribute(uriMasked),
        });
        continue;
      }
      // Opaque scheme URIs (`urn:ivan`, `tel:...`) carry the same path/PII
      // semantics; an email (`mailto:...`) keeps the email detector's tag.
      const opaqueMasked = maskUrisInValue(
        attr.value,
        attr.valueStart,
        config,
        vault,
        outcome,
        true,
        OPAQUE_URI_SUBSTRING_RE,
        true,
        index,
      );
      if (opaqueMasked !== undefined) {
        outcome.edits.push({
          start: attr.valueStart,
          end: attr.valueEnd,
          text: escapeXmlAttribute(opaqueMasked),
        });
        continue;
      }
      const masked = anonymizeText(attr.value, config, vault, { inPlace: true, index });
      if (masked.warnings.length > 0) outcome.warnings.push(...masked.warnings);
      for (const entity of masked.entities) outcome.entities.set(entity.key, entity);
      for (const replacement of masked.replacements) {
        outcome.occurrencePositions.push(attr.valueStart + replacement.start);
      }
      let replacement = masked.maskedText;
      if (replacement === attr.value && attr.prefix === 'xml') {
        // `xml:base`/`xml:id` used to be skipped entirely; a separator-joined
        // person id keeps its spelling in the tag for an exact restore.
        replacement =
          personIdentifierTag(attr.value, config, vault, outcome, index, attr.valueStart) ??
          replacement;
      }
      if (replacement === attr.value) continue;
      outcome.edits.push({
        start: attr.valueStart,
        end: attr.valueEnd,
        text: escapeXmlAttribute(replacement),
      });
    }
  }
}

/** Clears comment and processing-instruction bodies; the XML declaration stays. */
function planOneWayClearing(scan: XmlScan, outcome: MaskOutcome): void {
  for (const token of scan.tokens) {
    if (token.kind === 'comment') {
      outcome.edits.push({ start: token.start + 4, end: token.end - 3, text: '' });
      outcome.comments += 1;
    } else if (token.kind === 'pi' && token.target.toLowerCase() !== 'xml') {
      outcome.edits.push({
        start: token.start + 2 + token.target.length,
        end: token.end - 2,
        text: '',
      });
      outcome.instructions += 1;
    }
  }
}

/** Rewrites the declaration encoding so the emitted bytes stay self-describing. */
function planDeclarationEncoding(
  scan: XmlScan,
  text: string,
  encoding: string,
  edits: XmlEdit[],
): void {
  for (const token of scan.tokens) {
    if (token.kind !== 'pi' || token.target.toLowerCase() !== 'xml') continue;
    const declaration = text.slice(token.start, token.end);
    const rewritten = rewriteDeclarationEncoding(declaration, encoding);
    if (rewritten !== declaration) {
      edits.push({ start: token.start, end: token.end, text: rewritten });
    }
    return;
  }
}

interface RestoreOutcome {
  edits: XmlEdit[];
  replacements: number;
  unknownTags: Set<string>;
}

function restoreXmlContent(
  scan: XmlScan,
  vault: Vault,
  outcome: RestoreOutcome,
  session: RestoreSession,
): void {
  // Masking pre-passes (name groups, URI/person analysis, attributes) assign
  // tags out of source order; the file scope is reordered by source position.
  // Restore must consume it in the same source order (R15-RESTORE), so merge
  // text nodes and attribute values into one offset-sorted stream.
  const textTargets = scan.textNodes
    .filter((node) => node.text.includes('[['))
    .map((node) => ({ start: node.start, node }));
  const attrTargets = scan.elements.flatMap((element) =>
    element.attrs
      .filter((attr) => !isStructuralAttribute(attr) && attr.value.includes('[['))
      .map((attr) => ({ start: attr.valueStart, attr })),
  );
  const targets = [
    ...textTargets.map((target) => ({ ...target, kind: 'text' as const })),
    ...attrTargets.map((target) => ({ ...target, kind: 'attr' as const })),
  ].sort((left, right) => left.start - right.start);

  for (const target of targets) {
    if (target.kind === 'text') {
      const node = target.node;
      const restored = restoreText(node.text, vault, { session });
      outcome.replacements += restored.replacements;
      for (const tag of restored.unknownTags) outcome.unknownTags.add(tag);
      if (restored.text === node.text) continue;

      if (node.kind === 'text') {
        outcome.edits.push({
          start: node.start,
          end: node.end,
          text: escapeXmlText(restored.text),
        });
      } else {
        outcome.edits.push({
          start: node.start - CDATA_OPEN.length,
          end: node.end + CDATA_CLOSE.length,
          text: escapeXmlText(restored.text),
        });
      }
      continue;
    }

    const attr = target.attr;
    const restored = restoreText(attr.value, vault, { session });
    outcome.replacements += restored.replacements;
    for (const tag of restored.unknownTags) outcome.unknownTags.add(tag);
    if (restored.text === attr.value) continue;
    outcome.edits.push({
      start: attr.valueStart,
      end: attr.valueEnd,
      text: escapeXmlAttribute(restored.text),
    });
  }
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

function scanAndValidate(text: string, label: string): XmlScan {
  let scan: XmlScan;
  try {
    scan = scanXml(text);
  } catch (error) {
    throw new Error(
      `${label} is not well-formed XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateXmlText(text);
  assertXmlLimits(scan);
  return scan;
}

export async function anonymizeXml(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();
  if (!xmlMode(file)) throw new Error('XML: unsupported file');
  const sourceMime = file.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';

  const detected = detectEncoding(file.bytes);
  const text = decodeTextBytes(file.bytes, detected.encoding, detected.bom);
  const eol = detectEol(text);
  const declarationEncoding = originalDeclarationEncoding(text);
  const sha256 = await sha256Hex(file.bytes);
  const warnings: string[] = [];
  if (!detected.bom && (detected.encoding === 'utf-16le' || detected.encoding === 'utf-16be')) {
    warnings.push('UTF-16 without BOM detected; the encoding was inferred');
  }
  if (detected.ambiguous) {
    warnings.push('Text encoding is ambiguous; UTF-8/UTF-16 was inferred');
  }

  const scan = scanAndValidate(text, 'XML');
  // Structural PII cannot be masked in place; reject before touching the vault.
  assertStructuralSafe(scan);

  const snapshot = structuredClone(ctx.vault);
  const occurrenceStart = ctx.vault.occurrences.length;
  const outcome: MaskOutcome = {
    edits: [],
    entities: new Map(),
    warnings: [],
    comments: 0,
    instructions: 0,
    cdataSections: 0,
    occurrencePositions: [],
  };
  let maskedText: string;
  let maskedBytes: Uint8Array;

  try {
    // One index for the whole document; text/CDATA/attribute calls reuse it
    // incrementally instead of rebuilding it per value (R15 perf).
    const vaultIndex = createVaultIndex(ctx.vault);
    maskXmlContent(scan, ctx.config ?? {}, ctx.vault, outcome, vaultIndex);
    planOneWayClearing(scan, outcome);
    // The masked upload is UTF-8 without BOM; keep the declaration honest.
    planDeclarationEncoding(scan, text, 'UTF-8', outcome.edits);
    maskedText = applyXmlEditsLinear(text, outcome.edits);
    validateXmlText(maskedText);
    maskedBytes = encodeTextBytes(maskedText, 'utf-8', false);
  } catch (error) {
    commitVault(ctx.vault, snapshot);
    throw error;
  }

  const vault = ctx.vault;
  // Name/URI/attribute pre-passes assign tags out of source order; reorder the
  // scope by recorded source offsets before storing it on the file record.
  orderOccurrencesByPosition(vault, occurrenceStart, outcome.occurrencePositions);
  const occurrenceCount = vault.occurrences.length - occurrenceStart;

  vault.files.push({
    originalName: file.name,
    // Filename masking is part of the upload hook; the adapter keeps the name.
    maskedName: file.name,
    format: 'xml',
    size: file.bytes.byteLength,
    sha256,
    maskedSha256: await sha256Hex(maskedBytes),
    encoding: detected.encoding,
    declarationEncoding,
    bom: detected.bom,
    eol,
    occurrenceStart,
    occurrenceCount,
  });

  if (outcome.comments > 0 || outcome.instructions > 0) {
    warnings.push(
      `XML: ${outcome.comments} comment(s) and ${outcome.instructions} processing instruction(s) cleared one-way; their content cannot be restored`,
    );
  }
  if (outcome.cdataSections > 0) {
    warnings.push(
      `XML: ${outcome.cdataSections} CDATA section(s) with masked content were converted to text`,
    );
  }

  return {
    maskedBytes,
    maskedName: file.name,
    maskedMime: sourceMime === 'text/xml' ? 'text/xml' : 'application/xml',
    format: 'xml',
    entities: [...outcome.entities.values()],
    occurrences: vault.occurrences.slice(occurrenceStart),
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings: [...warnings, ...outcome.warnings],
  };
}

export async function restoreXml(file: FileInput, vault: Vault): Promise<RestoreResult> {
  let maskedText: string;
  try {
    maskedText = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new Error('Masked XML file is not valid UTF-8');
  }
  if (!xmlMode(file)) throw new Error('XML: unsupported file');

  const scan = scanAndValidate(maskedText, 'Masked XML');
  const outcome: RestoreOutcome = { edits: [], replacements: 0, unknownTags: new Set() };

  // Masked bytes identify the record first; a shared name is ambiguous
  // unless the hash picks one file (R16-RESTORE-IDENTITY).
  const record = await resolveVaultFile(vault, file);
  // One cursor for the whole document, scoped to this file's occurrences when
  // the record carries a range; a legacy record in a multi-file vault is
  // marked ambiguous and restore fails closed on the first known tag.
  const session = createFileRestoreSession(vault, record);
  restoreXmlContent(scan, vault, outcome, session);

  const encoding = parseTxtEncoding(record?.encoding) ?? 'utf-8';
  if (record) {
    planDeclarationEncoding(
      scan,
      maskedText,
      record.declarationEncoding ?? declarationEncodingLabel(encoding),
      outcome.edits,
    );
  }

  // The masked document is UTF-8 but keeps the source EOL layout verbatim:
  // re-applying a dominant EOL here would rewrite mixed endings (M8-M1).
  const restoredText = applyXmlEditsLinear(maskedText, outcome.edits);
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
  const cleared = scan.tokens.some(
    (token) =>
      token.kind === 'comment' || (token.kind === 'pi' && token.target.toLowerCase() !== 'xml'),
  );
  if (cleared) {
    warnings.push(
      'XML: comment/processing-instruction contents were cleared one-way and cannot be restored',
    );
  }

  return {
    bytes,
    fileName,
    replacements: outcome.replacements,
    unknownTags: [...outcome.unknownTags],
    warnings,
  };
}

export const xmlFormatAdapter: FormatAdapter = {
  format: 'xml',
  extensions: ['.xml'],
  mimeTypes: ['application/xml', 'text/xml'],
  canHandle(file) {
    return xmlMode(file);
  },
  anonymize(file, ctx) {
    return anonymizeXml(file, ctx);
  },
  restore(file, vault) {
    return restoreXml(file, vault);
  },
};
