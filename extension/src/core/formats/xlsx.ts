/**
 * XLSX format adapter (M2b).
 *
 * In-place OOXML editing on the existing kernel: the package is unzipped, every
 * text-bearing XML part is scanned with the byte-level scanner, and only text
 * node / attribute value ranges are spliced. Numeric and date cells are never
 * converted: their raw `<v>` lexemes stay untouched.
 *
 * Privacy policy:
 * - sharedStrings (plain, rich, unused, phonetic), inlineStr, cached `t="str"`,
 *   comments/threadedComments, chart strings, header/footer, validations,
 *   hyperlinks, pivot cache strings and external-link caches are masked;
 *   numeric PII in pivot shared items/records fails closed;
 * - authors, persons, docProps, fileSharing, customXml and query metadata are
 *   sanitized one-way; calcChain, signatures, revision logs, users, custom
 *   properties and thumbnails are removed;
 * - external relationship targets are redacted;
 * - sheet names, defined names, table/pivot field names and custom number
 *   formats are structural identifiers: if PII is found there, the adapter
 *   fails closed instead of renaming (renaming breaks formulas).
 *
 * Any parse/lint failure throws before bytes are returned. The caller's vault
 * is committed only after the whole package passes the linter and LeakGuard.
 */

import { inn10Valid, inn12Valid, luhnCheck, ogrnValid, snilsValid } from '../checksums';
import { detectAll } from '../detect';
import { ensureStructuredScanner } from '../detect/wasm-scan';
import { anonymizeText, assertClean, createFileRestoreSession } from '../masker';
import {
  applyPartEdits,
  assertPackageValid,
  contentTypeOf,
  escapeXmlAttribute,
  escapeXmlText,
  findMainPart,
  findParts,
  isRelsPartName,
  isXmlPart,
  type PackageBaseline,
  parseContentTypes,
  rawOffsetInTextNode,
  readXmlPart,
  redactExternalRelationships,
  relsPartNameFor,
  removePackagePart,
  snapshotPackage,
  unzipPackage,
  type XmlEdit,
  type XmlElement,
  type XmlScan,
  type XmlTextNode,
  zipPackage,
} from '../ooxml';
import { ensureCodecScanner } from '../ooxml/codec-wasm';
import { AmbiguousVaultFileError } from '../restore-identity';
import { parseTags } from '../tag';
import type {
  AnonymizeContext,
  AnonymizeResult,
  DetectionConfig,
  FileInput,
  FormatAdapter,
  MaskedEntity,
  RestoreResult,
  Vault,
  VaultFile,
} from '../types';
import { canonicalOf } from '../vault';
import { resolveVaultFile, sha256Hex } from './txt';

const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const S_STRICT_NS = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const A_STRICT_NS = 'http://purl.oclc.org/ooxml/drawingml/main';
const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const C_STRICT_NS = 'http://purl.oclc.org/ooxml/drawingml/chart';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const WORKBOOK_CT_RE = /spreadsheetml\.(?:sheet|template)\.main\+xml$/iu;

const EPOCH = '1970-01-01T00:00:00Z';

const CORE_BLANK = new Set([
  'creator',
  'lastModifiedBy',
  'title',
  'subject',
  'keywords',
  'description',
  'category',
  'contentStatus',
  'identifier',
]);
const CORE_EPOCH = new Set(['created', 'modified', 'lastPrinted']);
const APP_BLANK = new Set([
  'Company',
  'Manager',
  'Template',
  'HyperlinkBase',
  'TitlesOfParts',
  'HeadingPairs',
]);
/** TitlesOfParts/HeadingPairs mix labels (lpstr) with numeric counters (i4). */
const APP_TEXT_COLLECTIONS = new Set(['TitlesOfParts', 'HeadingPairs']);
const APP_TEXT_VARIANTS = new Set(['lpstr', 'lpwstr', 'bstr']);
const PERSON_ATTRS = new Set([
  'displayName',
  'userId',
  'providerId',
  'email',
  'author',
  'initials',
]);
const HEADER_FOOTER = new Set([
  'oddHeader',
  'oddFooter',
  'evenHeader',
  'evenFooter',
  'firstHeader',
  'firstFooter',
]);
const PII_HEADER_RE =
  /инн|снилс|телефон|тел\.|сч[её]т|карт|паспорт|полис|огрн|кпп|бик|лицев|account|phone|card|iban|policy|passport/iu;

type PartPolicy =
  | 'sharedStrings'
  | 'worksheet'
  | 'comments'
  | 'threadedComments'
  | 'persons'
  | 'chart'
  | 'drawing'
  | 'pivotCache'
  | 'pivotRecords'
  | 'externalLinks'
  | 'connections'
  | 'customXml'
  | 'core'
  | 'app'
  | 'workbook'
  | 'styles'
  | 'generic'
  | 'skip';

type LeakGuardMode = 'always' | 'when-masked' | 'skip-plain-number';

interface LocalEdit {
  start: number;
  end: number;
  text: string;
}

interface Segment {
  nodes: XmlTextNode[];
  text: string;
}

interface MaskingState {
  vault: Vault;
  touched: Map<string, MaskedEntity>;
  maskedTextByPart: Map<string, string[]>;
  sharedStrings: string[];
  formulaEdits: number;
  unparsedFormulas: number;
  chartEdits: number;
  drawingAltEdits: number;
  attributeEdits: number;
  metadataEdits: number;
  commentEdits: number;
  threadedEdits: number;
}

interface MaskAction {
  start: number;
  run: () => void;
}

function isS(ns: string): boolean {
  return ns === S_NS || ns === S_STRICT_NS;
}

function isA(ns: string): boolean {
  return ns === A_NS || ns === A_STRICT_NS;
}

function isC(ns: string): boolean {
  return ns === C_NS || ns === C_STRICT_NS;
}

function isWhitespaceText(value: string): boolean {
  return value.trim().length === 0;
}

function addWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
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

/** Rejects macro-enabled and legacy spreadsheet names before any parsing. */
function assertSupportedXlsxName(name: string): void {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsm') || lower.endsWith('.xltm') || lower.endsWith('.xlam')) {
    throw new Error(
      'XLSX: macro-enabled files (.xlsm/.xltm/.xlam) are not supported; save the workbook as .xlsx without macros and try again',
    );
  }
  if (lower.endsWith('.xls') || lower.endsWith('.xlt') || lower.endsWith('.xlsb')) {
    throw new Error(
      'XLSX: only .xlsx files are supported by this adapter; convert legacy/binary .xls/.xlsb to .xlsx first',
    );
  }
}

function assertNoMacros(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
): void {
  for (const [partName, contentType] of types.overrides) {
    if (/macroEnabled|vbaProject|macrosheet/iu.test(contentType)) {
      throw new Error(
        `XLSX: package contains macro content (${partName}); macro-enabled workbooks are rejected`,
      );
    }
  }
  for (const partName of parts.keys()) {
    if (
      /(?:^|\/)vbaProject\.bin$/iu.test(partName) ||
      /(?:^|\/)vbaData\.xml$/iu.test(partName) ||
      /^xl\/macrosheets\//iu.test(partName)
    ) {
      throw new Error(
        'XLSX: package contains VBA/macro sheets; save the workbook as .xlsx without macros and try again',
      );
    }
  }
}

function assertWorkbookMainPart(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
): void {
  if (!parts.has('xl/workbook.xml')) {
    throw new Error('XLSX: package has no xl/workbook.xml part');
  }
  const contentType = contentTypeOf(types, 'xl/workbook.xml');
  if (contentType === undefined || !WORKBOOK_CT_RE.test(contentType)) {
    throw new Error('XLSX: xl/workbook.xml does not have a spreadsheet main content type');
  }
  let mainPart: string;
  try {
    mainPart = findMainPart(parts, types);
  } catch {
    throw new Error('XLSX: package has no workbook main-part relationship');
  }
  if (mainPart !== 'xl/workbook.xml') {
    throw new Error(`XLSX: unexpected workbook main part (${mainPart})`);
  }
}

function policyFor(partName: string, contentType: string | undefined): PartPolicy {
  const type = (contentType ?? '').toLowerCase();

  if (
    partName === 'docProps/core.xml' ||
    type === 'application/vnd.openxmlformats-package.core-properties+xml'
  ) {
    return 'core';
  }
  if (
    partName === 'docProps/app.xml' ||
    type === 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
  ) {
    return 'app';
  }
  if (partName.startsWith('customXml/')) return 'customXml';
  if (partName === 'xl/workbook.xml') return 'workbook';
  if (partName === 'xl/sharedStrings.xml' || type.endsWith('sharedstrings+xml')) {
    return 'sharedStrings';
  }
  if (partName === 'xl/styles.xml' || type.endsWith('styles+xml')) return 'styles';
  if (partName.startsWith('xl/worksheets/') || type.endsWith('worksheet+xml')) {
    return 'worksheet';
  }
  if (partName.startsWith('xl/threadedComments/') || type.includes('threadedcomments')) {
    return 'threadedComments';
  }
  if (partName.startsWith('xl/persons/') || type.endsWith('person+xml')) return 'persons';
  if (partName.startsWith('xl/comments') || type.endsWith('comments+xml')) return 'comments';
  if (partName.startsWith('xl/charts/') || type.endsWith('chart+xml')) return 'chart';
  if (partName.startsWith('xl/drawings/') || type.endsWith('drawing+xml')) return 'drawing';
  if (partName.startsWith('xl/pivotCache/pivotCacheRecords')) return 'pivotRecords';
  if (partName.startsWith('xl/pivotCache/pivotCacheDefinition')) return 'pivotCache';
  if (partName.startsWith('xl/externalLinks/')) return 'externalLinks';
  if (partName === 'xl/connections.xml' || partName.startsWith('xl/queryTables/')) {
    return 'connections';
  }
  if (partName.startsWith('xl/activeX/') || partName.startsWith('xl/ctrlProps/')) {
    return 'skip';
  }
  if (partName.endsWith('.vml') || type.includes('vmldrawing')) return 'skip';
  if (partName === 'xl/calcChain.xml' || type.endsWith('calcchain+xml')) return 'skip';
  return 'generic';
}

function attrOf(element: XmlElement, local: string): XmlElement['attrs'][number] | undefined {
  for (const attr of element.attrs) {
    if (attr.ns === '' && attr.local === local) return attr;
  }
  return undefined;
}

function nearestAncestor(
  element: XmlElement,
  predicate: (candidate: XmlElement) => boolean,
): XmlElement | undefined {
  let current: XmlElement | null = element;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function hasAncestorBefore(node: XmlElement, root: XmlElement, local: string): boolean {
  let current: XmlElement | null = node;
  while (current && current !== root) {
    if (current.local === local) return true;
    current = current.parent;
  }
  return false;
}

function collectTextNodes(root: XmlElement, accept: (node: XmlTextNode) => boolean): XmlTextNode[] {
  const result: XmlTextNode[] = [];
  const visit = (element: XmlElement): void => {
    for (const node of element.textNodes) {
      if (accept(node)) result.push(node);
    }
    for (const child of element.children) visit(child);
  };
  visit(root);
  return result;
}

function textOfNodes(nodes: readonly XmlTextNode[]): string {
  return nodes.map((node) => node.text).join('');
}

function partitionPhonetic(
  root: XmlElement,
  nodes: readonly XmlTextNode[],
): { visible: XmlTextNode[]; phonetic: XmlTextNode[][] } {
  const visible: XmlTextNode[] = [];
  const groups = new Map<XmlElement, XmlTextNode[]>();
  for (const node of nodes) {
    const rPh = nearestAncestor(
      node.element,
      (element) => element.local === 'rPh' && element.start >= root.start,
    );
    if (!rPh) {
      visible.push(node);
      continue;
    }
    const group = groups.get(rPh) ?? [];
    group.push(node);
    groups.set(rPh, group);
  }
  return { visible, phonetic: [...groups.values()] };
}

function addMaskedText(
  state: MaskingState,
  partName: string,
  text: string,
  mode: LeakGuardMode,
  masked: boolean,
): void {
  if (text.length === 0) return;
  if (mode === 'when-masked' && !masked) return;
  if (mode === 'skip-plain-number' && !masked && /^[\d\s.,+\-()]+$/u.test(text)) return;
  const chunks = state.maskedTextByPart.get(partName) ?? [];
  chunks.push(text);
  state.maskedTextByPart.set(partName, chunks);
}

function mapSegmentReplacements(
  segment: Segment,
  replacements: readonly { start: number; end: number; tag: string }[],
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
): void {
  let offset = 0;
  const placements = segment.nodes.map((node) => {
    const placement = { node, offset };
    offset += node.text.length;
    return placement;
  });

  for (const replacement of replacements) {
    let first = true;
    for (const { node, offset: nodeOffset } of placements) {
      const nodeEnd = nodeOffset + node.text.length;
      if (replacement.start >= nodeEnd || replacement.end <= nodeOffset) continue;

      const localStart = Math.max(replacement.start, nodeOffset) - nodeOffset;
      const localEnd = Math.min(replacement.end, nodeEnd) - nodeOffset;
      if (localStart >= localEnd) continue;

      const rawStart = rawOffsetInTextNode(node, localStart);
      const rawEnd = rawOffsetInTextNode(node, localEnd);
      if (rawStart < 0 || rawEnd < rawStart) {
        throw new Error('XLSX: internal text offset mapping failed');
      }

      const value = first ? replacement.tag : '';
      edits.push({
        start: node.start + rawStart,
        end: node.start + rawEnd,
        text: escapeXmlText(value),
      });

      const local = nodeEdits.get(node) ?? [];
      local.push({ start: localStart, end: localEnd, text: value });
      nodeEdits.set(node, local);
      first = false;
    }
    if (first) throw new Error('XLSX: replacement did not map to a text node');
  }
}

function needsPreserve(node: XmlTextNode, edits: readonly LocalEdit[]): boolean {
  for (const edit of edits) {
    if (edit.text.length === 0) continue;
    if (edit.start === 0 && /^\s/u.test(edit.text)) return true;
    if (edit.end === node.text.length && /\s$/u.test(edit.text)) return true;
  }
  return false;
}

function addPreserveEdits(
  nodeEdits: ReadonlyMap<XmlTextNode, readonly LocalEdit[]>,
  edits: XmlEdit[],
): void {
  const seen = new Set<XmlElement>();
  for (const [node, localEdits] of nodeEdits) {
    if (seen.has(node.element)) continue;
    if (node.element.local !== 't') continue;
    if (!needsPreserve(node, localEdits)) continue;
    seen.add(node.element);

    const existing = node.element.attrMap.get('xml:space');
    if (existing) {
      if (existing.value !== 'preserve') {
        edits.push({ start: existing.valueStart, end: existing.valueEnd, text: 'preserve' });
      }
      continue;
    }
    edits.push({
      start: node.element.insertAt,
      end: node.element.insertAt,
      text: ' xml:space="preserve"',
    });
  }
}

function processSegment(
  segment: Segment,
  config: DetectionConfig,
  state: MaskingState,
  partName: string,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
  mode: LeakGuardMode,
): number {
  if (segment.text.length === 0) return 0;

  // Structural/numeric values (cell indices, GUIDs, cached numbers) are not
  // user text. Running the masker on them would trip the paranoid digit rule;
  // a numeric identifier that a detector actually recognizes is still masked.
  if (isGuid(segment.text)) return 0;
  if (isPlainNumeric(segment.text) && detectAll(segment.text, config).length === 0) return 0;

  const result = anonymizeText(segment.text, config, state.vault);
  for (const entity of result.entities) state.touched.set(entity.key, entity);
  addMaskedText(state, partName, result.maskedText, mode, result.replacements.length > 0);

  if (result.replacements.length === 0) return 0;
  mapSegmentReplacements(segment, result.replacements, edits, nodeEdits);
  return result.replacements.length;
}

function scheduleSegment(
  actions: MaskAction[],
  nodes: readonly XmlTextNode[],
  config: DetectionConfig,
  state: MaskingState,
  partName: string,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
  mode: LeakGuardMode,
  onMasked?: (count: number) => void,
): void {
  const text = textOfNodes(nodes);
  if (text.length === 0) return;
  actions.push({
    start: nodes[0]?.start ?? 0,
    run: () => {
      const count = processSegment(
        { nodes: [...nodes], text },
        config,
        state,
        partName,
        edits,
        nodeEdits,
        mode,
      );
      if (count > 0) onMasked?.(count);
    },
  });
}

const FORMULA_LOCALS = new Set(['f', 'formula', 'formula1', 'formula2', 'definedName']);

function isFormulaTextNode(node: XmlTextNode): boolean {
  return (
    nearestAncestor(node.element, (element) => FORMULA_LOCALS.has(element.local)) !== undefined
  );
}

function isPlainNumeric(value: string): boolean {
  return /^[\d\s.,+\-()]+$/u.test(value);
}

function isGuid(value: string): boolean {
  return /^\{?[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}?$/u.test(value);
}

function scheduleAttribute(
  actions: MaskAction[],
  attr: XmlElement['attrs'][number],
  config: DetectionConfig,
  state: MaskingState,
  partName: string,
  edits: XmlEdit[],
): void {
  if (isWhitespaceText(attr.value)) return;
  // Attribute values are often structural IDs/GUIDs and may carry long
  // numbers that are not PII. Only mask when a detector actually fires.
  if (isGuid(attr.value)) return;
  if (detectAll(attr.value, config).length === 0) return;
  actions.push({
    start: attr.valueStart,
    run: () => {
      const result = anonymizeText(attr.value, config, state.vault);
      for (const entity of result.entities) state.touched.set(entity.key, entity);
      if (result.replacements.length === 0) return;
      addMaskedText(state, partName, result.maskedText, 'when-masked', true);
      edits.push({
        start: attr.valueStart,
        end: attr.valueEnd,
        text: escapeXmlAttribute(result.maskedText),
      });
      state.attributeEdits += 1;
    },
  });
}

function runActions(actions: MaskAction[]): void {
  actions.sort((left, right) => left.start - right.start);
  for (const action of actions) action.run();
}

function blankTextNodes(
  scan: XmlScan,
  predicate: (node: XmlTextNode) => boolean,
  replacement = '',
): XmlEdit[] {
  const edits: XmlEdit[] = [];
  for (const node of scan.textNodes) {
    if (isWhitespaceText(node.text)) continue;
    if (!predicate(node)) continue;
    if (replacement.length > 0 && node.text === replacement) continue;
    edits.push({
      start: node.start,
      end: node.end,
      text: replacement.length > 0 ? escapeXmlText(replacement) : '',
    });
  }
  return edits;
}

function blankAttribute(element: XmlElement, local: string, edits: XmlEdit[]): boolean {
  const attr = attrOf(element, local);
  if (!attr || attr.value.length === 0) return false;
  edits.push({ start: attr.valueStart, end: attr.valueEnd, text: '' });
  return true;
}

function replaceAttribute(
  element: XmlElement,
  local: string,
  value: string,
  edits: XmlEdit[],
): boolean {
  const attr = attrOf(element, local);
  if (!attr || attr.value === value) return false;
  edits.push({ start: attr.valueStart, end: attr.valueEnd, text: escapeXmlAttribute(value) });
  return true;
}

// ---------------------------------------------------------------------------
// Formula string literals
// ---------------------------------------------------------------------------

interface FormulaLiteral {
  /** Offset of the literal content in the formula text. */
  contentStart: number;
  value: string;
  /** Decoded-value boundary -> formula text offset. */
  map: number[];
}

function scanFormulaLiterals(text: string): {
  literals: FormulaLiteral[];
  malformed: boolean;
} {
  const literals: FormulaLiteral[] = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    index += 1;
    const contentStart = index;
    let value = '';
    const map = [contentStart];
    let closed = false;

    while (index < text.length) {
      if (text[index] === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 2;
          map.push(index);
          continue;
        }
        closed = true;
        index += 1;
        break;
      }
      value += text[index];
      index += 1;
      map.push(index);
    }

    if (!closed) return { literals, malformed: true };
    literals.push({ contentStart, value, map });
  }

  return { literals, malformed: false };
}

function scheduleFormulaLiterals(
  actions: MaskAction[],
  node: XmlTextNode,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  warnings: string[],
): void {
  if (isWhitespaceText(node.text)) return;
  const scanned = scanFormulaLiterals(node.text);
  if (scanned.malformed) {
    state.unparsedFormulas += 1;
    addWarning(
      warnings,
      'Formula(s) with malformed string literals were left unchanged; review them manually',
    );
    return;
  }

  for (const literal of scanned.literals) {
    if (literal.value.length === 0) continue;
    actions.push({
      start: node.start + rawOffsetInTextNode(node, literal.contentStart),
      run: () => {
        const result = anonymizeText(literal.value, config, state.vault);
        for (const entity of result.entities) state.touched.set(entity.key, entity);
        if (result.replacements.length === 0) return;
        for (const replacement of result.replacements) {
          const decodedStart = literal.map[replacement.start];
          const decodedEnd = literal.map[replacement.end];
          if (decodedStart === undefined || decodedEnd === undefined) {
            throw new Error('XLSX: internal formula offset mapping failed');
          }
          const rawStart = rawOffsetInTextNode(node, decodedStart);
          const rawEnd = rawOffsetInTextNode(node, decodedEnd);
          edits.push({
            start: node.start + rawStart,
            end: node.start + rawEnd,
            text: escapeXmlText(replacement.tag),
          });
        }
        state.formulaEdits += result.replacements.length;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Part policies
// ---------------------------------------------------------------------------

function processSharedStrings(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
): void {
  const actions: MaskAction[] = [];
  for (const element of scan.elements) {
    if (!isS(element.ns) || element.local !== 'si') continue;
    const nodes = collectTextNodes(element, (node) => isS(node.ns) && node.local === 't');
    const { visible, phonetic } = partitionPhonetic(element, nodes);
    scheduleSegment(actions, visible, config, state, partName, edits, nodeEdits, 'always');
    for (const group of phonetic) {
      scheduleSegment(actions, group, config, state, partName, edits, nodeEdits, 'always');
    }
  }
  runActions(actions);
}

function cellValueText(cell: XmlElement): string {
  const value = cell.children.find((child) => child.local === 'v');
  if (!value) return '';
  return textOfNodes(collectTextNodes(value, () => true));
}

function cellInlineText(cell: XmlElement): string {
  const inline = cell.children.find((child) => isS(child.ns) && child.local === 'is');
  if (!inline) return '';
  const nodes = collectTextNodes(inline, (node) => node.local === 't');
  return textOfNodes(nodes.filter((node) => !hasAncestorBefore(node.element, inline, 'rPh')));
}

function numericPiiError(label: string, ref: string): Error {
  return new Error(
    `XLSX: numeric ${label} in cell ${ref}; format the column as text or remove the value`,
  );
}

/**
 * Numeric cells are never converted in M2b. High-confidence numeric
 * identifiers therefore reject the file instead of being silently shipped.
 * Dates and ordinary numbers stay untouched.
 */
function assertNumericCellsSafe(scan: XmlScan, sharedStrings: readonly string[]): void {
  const headerColumns = new Set<string>();

  // Pass 1: headers can be above or below the data, so collect them first.
  for (const element of scan.elements) {
    if (!isS(element.ns) || element.local !== 'c') continue;
    const ref = attrOf(element, 'r')?.value;
    if (!ref) continue;
    const match = /^([A-Z]+)(\d+)$/u.exec(ref);
    if (!match) continue;
    const column = match[1] ?? '';
    const type = attrOf(element, 't')?.value;
    const value = cellValueText(element);

    let text = '';
    if (type === 's') {
      const index = Number(value);
      text = Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
    } else if (type === 'inlineStr') {
      text = cellInlineText(element);
    } else if (type === 'str') {
      text = value;
    }
    if (PII_HEADER_RE.test(text)) headerColumns.add(column);
  }

  // Pass 2: fail closed on numeric identifiers that cannot be converted.
  for (const element of scan.elements) {
    if (!isS(element.ns) || element.local !== 'c') continue;
    const type = attrOf(element, 't')?.value;
    if (type !== undefined && type !== 'n') continue;
    const value = cellValueText(element);
    if (!/^\d+$/u.test(value)) continue;

    const ref = attrOf(element, 'r')?.value ?? '(no ref)';
    const match = /^([A-Z]+)(\d+)$/u.exec(ref);
    const column = match?.[1];
    const length = value.length;

    if (length === 10 && inn10Valid(value)) throw numericPiiError('INN', ref);
    if (length === 12 && inn12Valid(value)) throw numericPiiError('INN', ref);
    if (length === 11 && snilsValid(value)) throw numericPiiError('SNILS', ref);
    if ((length === 13 || length === 15) && ogrnValid(value)) {
      throw numericPiiError('OGRN', ref);
    }
    if (length >= 13 && length <= 19 && luhnCheck(value)) {
      throw numericPiiError('CARD', ref);
    }
    if (length === 20) throw numericPiiError('ACCOUNT', ref);
    if (length === 11 && /^[78]\d{10}$/u.test(value)) {
      throw numericPiiError('PHONE', ref);
    }
    if (column !== undefined && headerColumns.has(column) && length >= 9) {
      throw new Error(
        `XLSX: numeric value in cell ${ref} under a PII-like header; format the column as text or remove the value`,
      );
    }
  }
}

function processWorksheet(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
  warnings: string[],
): void {
  const actions: MaskAction[] = [];
  const covered = new Set<XmlTextNode>();
  const attrConfig = structuralConfig(config);
  assertNumericCellsSafe(scan, state.sharedStrings);

  for (const cell of scan.elements) {
    if (!isS(cell.ns) || cell.local !== 'c') continue;
    const type = attrOf(cell, 't')?.value;

    const inline = cell.children.find((child) => isS(child.ns) && child.local === 'is');
    if (inline) {
      const nodes = collectTextNodes(inline, (node) => isS(node.ns) && node.local === 't');
      for (const node of nodes) covered.add(node);
      const { visible, phonetic } = partitionPhonetic(inline, nodes);
      scheduleSegment(actions, visible, config, state, partName, edits, nodeEdits, 'always');
      for (const group of phonetic) {
        scheduleSegment(actions, group, config, state, partName, edits, nodeEdits, 'always');
      }
    }

    const value = cell.children.find((child) => child.local === 'v');
    if (type === 'str' && value) {
      const nodes = collectTextNodes(value, () => true);
      for (const node of nodes) covered.add(node);
      scheduleSegment(actions, nodes, config, state, partName, edits, nodeEdits, 'always');
    }

    for (const formula of cell.children) {
      if (formula.local !== 'f') continue;
      const nodes = collectTextNodes(formula, () => true);
      for (const node of nodes) {
        covered.add(node);
        scheduleFormulaLiterals(actions, node, config, state, edits, warnings);
      }
    }
  }

  for (const element of scan.elements) {
    if (!isS(element.ns) || !HEADER_FOOTER.has(element.local)) continue;
    const nodes = collectTextNodes(element, () => true);
    for (const node of nodes) covered.add(node);
    scheduleSegment(actions, nodes, config, state, partName, edits, nodeEdits, 'always');
  }

  for (const element of scan.elements) {
    if (element.local === 'dataValidation') {
      for (const local of ['promptTitle', 'prompt', 'errorTitle', 'error']) {
        const attr = attrOf(element, local);
        if (attr) scheduleAttribute(actions, attr, attrConfig, state, partName, edits);
      }
      for (const child of element.children) {
        if (child.local !== 'formula1' && child.local !== 'formula2') continue;
        const nodes = collectTextNodes(child, () => true);
        for (const node of nodes) {
          covered.add(node);
          scheduleFormulaLiterals(actions, node, config, state, edits, warnings);
        }
      }
    }

    if (element.local === 'cfRule') {
      const text = attrOf(element, 'text');
      if (text) scheduleAttribute(actions, text, attrConfig, state, partName, edits);
    }

    if (
      element.local === 'formula' &&
      nearestAncestor(element, (item) => item.local === 'cfRule')
    ) {
      const nodes = collectTextNodes(element, () => true);
      for (const node of nodes) {
        covered.add(node);
        scheduleFormulaLiterals(actions, node, config, state, edits, warnings);
      }
    }

    if (element.local === 'hyperlink') {
      for (const local of ['tooltip', 'display']) {
        const attr = attrOf(element, local);
        if (attr) scheduleAttribute(actions, attr, attrConfig, state, partName, edits);
      }
    }

    if (element.local === 'customFilter' || element.local === 'filter') {
      const attr = attrOf(element, 'val');
      if (attr) scheduleAttribute(actions, attr, attrConfig, state, partName, edits);
    }
  }

  for (const node of scan.textNodes) {
    if (isWhitespaceText(node.text) || covered.has(node)) continue;
    if (
      nearestAncestor(
        node.element,
        (element) => element.local === 'v' || element.local === 'f' || element.local === 'is',
      )
    ) {
      continue;
    }
    scheduleSegment(
      actions,
      [node],
      config,
      state,
      partName,
      edits,
      nodeEdits,
      'skip-plain-number',
    );
  }

  runActions(actions);
}

function processComments(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
  warnings: string[],
): void {
  const actions: MaskAction[] = [];
  for (const element of scan.elements) {
    if (element.local !== 'text') continue;
    if (!nearestAncestor(element, (item) => item.local === 'comment')) continue;
    const nodes = collectTextNodes(element, (node) => !isWhitespaceText(node.text));
    scheduleSegment(
      actions,
      nodes,
      config,
      state,
      partName,
      edits,
      nodeEdits,
      'always',
      (count) => {
        state.commentEdits += count;
      },
    );
  }
  runActions(actions);

  const authorEdits = blankTextNodes(scan, (node) => node.element.local === 'author');
  edits.push(...authorEdits);
  if (authorEdits.length > 0) {
    addWarning(warnings, 'Comment text masked; comment authors cleared');
  }
}

function processThreadedComments(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
  warnings: string[],
): void {
  const actions: MaskAction[] = [];
  for (const element of scan.elements) {
    if (element.local !== 'threadedComment') continue;
    for (const local of ['dT', 'date']) {
      if (replaceAttribute(element, local, EPOCH, edits)) state.metadataEdits += 1;
    }

    const groups = new Map<XmlElement | null, XmlTextNode[]>();
    for (const node of collectTextNodes(element, (item) => !isWhitespaceText(item.text))) {
      const textElement = nearestAncestor(node.element, (item) => item.local === 'text');
      const key = textElement ?? null;
      const group = groups.get(key) ?? [];
      group.push(node);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      scheduleSegment(
        actions,
        group,
        config,
        state,
        partName,
        edits,
        nodeEdits,
        'always',
        (count) => {
          state.threadedEdits += count;
        },
      );
    }
  }
  runActions(actions);
  if (state.threadedEdits > 0) {
    addWarning(warnings, 'Threaded comment text masked; comment dates sanitized');
  }
}

function processPersons(scan: XmlScan, edits: XmlEdit[], warnings: string[]): void {
  let cleared = 0;
  for (const element of scan.elements) {
    if (element.local !== 'person') continue;
    for (const local of PERSON_ATTRS) {
      if (blankAttribute(element, local, edits)) cleared += 1;
    }
  }
  edits.push(...blankTextNodes(scan, () => true));
  if (cleared > 0) addWarning(warnings, 'Person display names/user IDs cleared');
}

function isStringChartValue(node: XmlTextNode): boolean {
  let current: XmlElement | null = node.element;
  while (current) {
    if (isC(current.ns)) {
      if (
        current.local === 'strCache' ||
        current.local === 'strRef' ||
        current.local === 'strLit' ||
        current.local === 'multiLvlStrCache' ||
        current.local === 'tx'
      ) {
        return true;
      }
      if (
        current.local === 'numCache' ||
        current.local === 'numRef' ||
        current.local === 'numLit'
      ) {
        return false;
      }
    }
    current = current.parent;
  }
  return false;
}

function splitAtDrawingStops(
  paragraph: XmlElement,
  nodes: readonly XmlTextNode[],
): XmlTextNode[][] {
  const stops = paragraph.children
    .filter((child) => isA(child.ns) && (child.local === 'br' || child.local === 'tab'))
    .map((child) => child.start)
    .sort((left, right) => left - right);
  if (stops.length === 0) return [[...nodes]];

  const groups: XmlTextNode[][] = [];
  let current: XmlTextNode[] = [];
  let stopIndex = 0;
  let lastEnd = -1;

  for (const node of nodes) {
    while (stopIndex < stops.length && (stops[stopIndex] ?? 0) < node.start) {
      const stop = stops[stopIndex] ?? 0;
      if (lastEnd >= 0 && stop >= lastEnd && current.length > 0) {
        groups.push(current);
        current = [];
      }
      stopIndex += 1;
    }
    current.push(node);
    lastEnd = node.end;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function processChart(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
  warnings: string[],
): void {
  const actions: MaskAction[] = [];
  const paragraphs = new Map<XmlElement, XmlTextNode[]>();

  for (const node of scan.textNodes) {
    if (isA(node.ns) && node.local === 't') {
      const paragraph = nearestAncestor(
        node.element,
        (element) => isA(element.ns) && element.local === 'p',
      );
      if (paragraph) {
        const group = paragraphs.get(paragraph) ?? [];
        group.push(node);
        paragraphs.set(paragraph, group);
        continue;
      }
      scheduleSegment(
        actions,
        [node],
        config,
        state,
        partName,
        edits,
        nodeEdits,
        'always',
        (count) => {
          state.chartEdits += count;
        },
      );
      continue;
    }

    if (isC(node.ns) && node.local === 'v' && isStringChartValue(node)) {
      scheduleSegment(
        actions,
        [node],
        config,
        state,
        partName,
        edits,
        nodeEdits,
        'always',
        (count) => {
          state.chartEdits += count;
        },
      );
    }
  }

  for (const [paragraph, nodes] of paragraphs) {
    for (const group of splitAtDrawingStops(paragraph, nodes)) {
      scheduleSegment(
        actions,
        group,
        config,
        state,
        partName,
        edits,
        nodeEdits,
        'always',
        (count) => {
          state.chartEdits += count;
        },
      );
    }
  }

  runActions(actions);
  if (state.chartEdits > 0) {
    addWarning(
      warnings,
      `${state.chartEdits} chart string value(s) masked; chart labels may show tags`,
    );
  }
}

function processDrawing(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
): void {
  const actions: MaskAction[] = [];
  const paragraphs = new Map<XmlElement, XmlTextNode[]>();

  for (const node of scan.textNodes) {
    if (!isA(node.ns) || node.local !== 't') continue;
    const paragraph = nearestAncestor(
      node.element,
      (element) => isA(element.ns) && element.local === 'p',
    );
    if (!paragraph) {
      scheduleSegment(actions, [node], config, state, partName, edits, nodeEdits, 'always');
      continue;
    }
    const group = paragraphs.get(paragraph) ?? [];
    group.push(node);
    paragraphs.set(paragraph, group);
  }

  for (const [paragraph, nodes] of paragraphs) {
    for (const group of splitAtDrawingStops(paragraph, nodes)) {
      scheduleSegment(actions, group, config, state, partName, edits, nodeEdits, 'always');
    }
  }

  for (const element of scan.elements) {
    if (!['cNvPr', 'docPr', 'shape', 'imagedata'].includes(element.local)) continue;
    for (const local of ['descr', 'title', 'name', 'alt']) {
      if (blankAttribute(element, local, edits)) state.drawingAltEdits += 1;
    }
  }

  runActions(actions);
}

function processPivotCache(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
): void {
  assertPivotSharedItemsNumericSafe(scan);

  const actions: MaskAction[] = [];
  for (const element of scan.elements) {
    if (element.local === 's') {
      const parent = element.parent;
      if (parent?.local === 'sharedItems') {
        const attr = attrOf(element, 'v');
        if (attr)
          scheduleAttribute(actions, attr, structuralConfig(config), state, partName, edits);
      }
      continue;
    }
    if (element.local === 'cacheField') {
      for (const local of ['name', 'caption']) {
        const attr = attrOf(element, local);
        if (attr)
          scheduleAttribute(actions, attr, structuralConfig(config), state, partName, edits);
      }
    }
    if (element.local === 'pivotCacheDefinition') {
      // refresh metadata carries the Windows user name and a timestamp.
      blankAttribute(element, 'refreshedBy', edits);
      blankAttribute(element, 'refreshedDate', edits);
    }
  }
  runActions(actions);
}

function pivotRecordPiiError(label: string, index: number): Error {
  return new Error(
    `XLSX: numeric ${label} in pivot cache record #${index}; format the column as text or remove the value`,
  );
}

function pivotSharedItemPiiError(label: string): Error {
  return new Error(
    `XLSX: numeric ${label} in pivot cache shared items; format the column as text or remove the value`,
  );
}

const DOUBLE_LEXEME_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|INF|NaN)$/u;

/**
 * `sharedItems/@minValue`/`@maxValue` are `xsd:double`: Excel may write plain
 * decimals or exponent notation. Expands the literal exactly (no float
 * rounding) and returns the decimal integer it denotes, or undefined when the
 * value is fractional / not a number. Crafted 16-digit CARDs such as
 * `4.111111111111111E+15` must stay detectable.
 */
function canonicalIntegerLexeme(value: string): string | undefined {
  const text = value.trim();
  if (!DOUBLE_LEXEME_RE.test(text)) return undefined;
  if (text === 'INF' || text === '-INF' || text === 'NaN') return undefined;

  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (!match) return undefined;
  const [, sign = '', intPart = '', fraction = '', exponentText] = match;
  const digits = `${intPart}${fraction}`;
  if (digits.length === 0) return undefined;

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
  // A fractional part rejects the value: only whole numbers can be identifiers.
  if (/[1-9]/u.test(fractionalPart)) return undefined;

  const canonical = integerPart.replace(/^0+(?=\d)/u, '');
  if (sign === '-' && canonical !== '0') return undefined;
  return canonical;
}

/**
 * Checks a decimal integer lexeme with the same high-confidence rules as
 * worksheet cells. Returns the PII label, or undefined for ordinary numbers
 * and dates.
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

type PivotNumericVerdict =
  | { kind: 'safe' }
  | { kind: 'pii'; label: string }
  | { kind: 'malformed' };

/**
 * `<n>` and `sharedItems/@minValue`/`@maxValue` are `xsd:double`: the same
 * identifier may be written as `4111111111111111.0` or
 * `4.111111111111111E+15`. Canonicalize before applying the integer rules;
 * a valid fractional/non-finite double cannot be an identifier, while a
 * non-numeric lexeme is malformed and fails closed.
 */
function classifyPivotNumeric(raw: string): PivotNumericVerdict {
  const text = raw.trim();
  if (text.length === 0) return { kind: 'safe' };
  const canonical = canonicalIntegerLexeme(text);
  if (canonical !== undefined) {
    const label = numericPiiLabel(canonical);
    return label ? { kind: 'pii', label } : { kind: 'safe' };
  }
  return DOUBLE_LEXEME_RE.test(text) ? { kind: 'safe' } : { kind: 'malformed' };
}

/**
 * Numeric pivot records are cached copies of source cells. Like worksheet
 * cells they cannot be masked without changing the pivot, so high-confidence
 * identifiers reject the file (fail-closed).
 */
function assertPivotRecordsNumericSafe(scan: XmlScan): void {
  let index = 0;
  for (const element of scan.elements) {
    if (!isS(element.ns) || element.local !== 'r') continue;
    index += 1;
    for (const child of element.children) {
      if (child.local !== 'n') continue;
      const verdict = classifyPivotNumeric(attrOf(child, 'v')?.value ?? '');
      if (verdict.kind === 'pii') throw pivotRecordPiiError(verdict.label, index);
      if (verdict.kind === 'malformed') throw pivotRecordPiiError('value', index);
    }
  }
}

/**
 * `pivotCacheDefinition/sharedItems` normally holds the actual values while
 * records only reference them by `<x v="index"/>`. Numeric identifiers must be
 * rejected here too (EMP-R1); string items are masked, `<d>` dates are left
 * intact (masking them would corrupt `xsd:dateTime`).
 */
function assertPivotSharedItemsNumericSafe(scan: XmlScan): void {
  for (const element of scan.elements) {
    if (!isS(element.ns)) continue;

    if (element.local === 'sharedItems') {
      // Numeric shared items may carry no child values at all: the range is
      // described by xsd:double `minValue`/`maxValue` and records reference
      // items by `<x v="index"/>` (EMP-R1-v2, EMP-R1-v3). Fail closed on
      // identifiers, including `.0`/exponent spellings.
      for (const local of ['minValue', 'maxValue']) {
        const verdict = classifyPivotNumeric(attrOf(element, local)?.value ?? '');
        if (verdict.kind === 'pii') throw pivotSharedItemPiiError(verdict.label);
        if (verdict.kind === 'malformed') throw pivotSharedItemPiiError('value');
      }
      continue;
    }

    if (element.local !== 'n') continue;
    if (element.parent?.local !== 'sharedItems') continue;
    const verdict = classifyPivotNumeric(attrOf(element, 'v')?.value ?? '');
    if (verdict.kind === 'pii') throw pivotSharedItemPiiError(verdict.label);
    if (verdict.kind === 'malformed') throw pivotSharedItemPiiError('value');
  }
}

/**
 * `pivotCacheRecords` stores a copy of the source data as direct values:
 * `<s v="...">` strings and `<n v="...">` numbers. String values go through
 * the masker like shared items; numeric identifiers fail closed. `<d>` date
 * values and `<x>` shared-item references stay untouched.
 */
function processPivotRecords(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
): void {
  assertPivotRecordsNumericSafe(scan);

  const actions: MaskAction[] = [];
  for (const element of scan.elements) {
    if (element.parent?.local !== 'r') continue;
    if (!['s', 'e', 'm'].includes(element.local)) continue;
    const attr = attrOf(element, 'v');
    if (attr) scheduleAttribute(actions, attr, structuralConfig(config), state, partName, edits);
  }
  runActions(actions);
}

function processExternalLinks(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
): void {
  const actions: MaskAction[] = [];
  for (const node of scan.textNodes) {
    if (node.local !== 'v' || isWhitespaceText(node.text)) continue;
    scheduleSegment(
      actions,
      [node],
      structuralConfig(config),
      state,
      partName,
      edits,
      nodeEdits,
      'skip-plain-number',
    );
  }
  for (const element of scan.elements) {
    if (element.local !== 'sheetName') continue;
    const attr = attrOf(element, 'val');
    if (attr) scheduleAttribute(actions, attr, structuralConfig(config), state, partName, edits);
  }
  runActions(actions);
}

function processConnections(scan: XmlScan, edits: XmlEdit[], warnings: string[]): void {
  const attrNames = new Set([
    'connection',
    'command',
    'description',
    'name',
    'sql',
    'post',
    'connectString',
  ]);
  let changed = 0;
  for (const element of scan.elements) {
    for (const attr of element.attrs) {
      if (attr.ns !== '' || !attrNames.has(attr.local)) continue;
      if (attr.value.length === 0) continue;
      edits.push({ start: attr.valueStart, end: attr.valueEnd, text: '' });
      changed += 1;
    }
  }
  const textEdits = blankTextNodes(scan, () => true);
  edits.push(...textEdits);
  changed += textEdits.length;
  if (changed > 0) {
    addWarning(warnings, 'Connection/query metadata cleared (one-way)');
  }
}

function processCustomXml(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  warnings: string[],
): void {
  edits.push(...blankTextNodes(scan, () => true));

  const actions: MaskAction[] = [];
  for (const element of scan.elements) {
    const blanked = new Set<XmlElement['attrs'][number]>();
    for (const attr of element.attrs) {
      if (attr.local !== 'itemName' || attr.value.length === 0) continue;
      edits.push({ start: attr.valueStart, end: attr.valueEnd, text: '' });
      blanked.add(attr);
    }
    for (const attr of element.attrs) {
      if (blanked.has(attr)) continue;
      if (attr.ns === 'http://www.w3.org/2000/xmlns/') continue;
      if (attr.ns === R_NS) continue;
      if (isWhitespaceText(attr.value)) continue;
      scheduleAttribute(actions, attr, structuralConfig(config), state, partName, edits);
    }
  }
  runActions(actions);
  addWarning(warnings, 'customXml text cleared; attribute values masked');
}

function processCore(scan: XmlScan, edits: XmlEdit[]): number {
  const before = edits.length;
  edits.push(...blankTextNodes(scan, (node) => CORE_BLANK.has(node.element.local)));
  edits.push(...blankTextNodes(scan, (node) => CORE_EPOCH.has(node.element.local), EPOCH));
  return edits.length - before;
}

function isAppBlankText(node: XmlTextNode): boolean {
  let current: XmlElement | null = node.element;
  while (current) {
    // Keep numeric variant counters (`vt:i4`) valid inside HeadingPairs.
    if (APP_TEXT_COLLECTIONS.has(current.local)) {
      return APP_TEXT_VARIANTS.has(node.element.local);
    }
    if (APP_BLANK.has(current.local)) return true;
    current = current.parent;
  }
  return false;
}

function processApp(scan: XmlScan, edits: XmlEdit[], warnings: string[]): number {
  const before = edits.length;
  edits.push(...blankTextNodes(scan, isAppBlankText));
  if (edits.length > before) {
    addWarning(
      warnings,
      'Company/Manager/Template/HyperlinkBase/TitlesOfParts/HeadingPairs text cleared',
    );
  }
  return edits.length - before;
}

function processStyles(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
): void {
  const actions: MaskAction[] = [];
  for (const element of scan.elements) {
    if (element.local === 'cellStyle' || element.local === 'tableStyle') {
      const attr = attrOf(element, 'name');
      if (attr) scheduleAttribute(actions, attr, structuralConfig(config), state, partName, edits);
    }
    if (element.local === 'name' && element.parent?.local === 'font') {
      const attr = attrOf(element, 'val');
      if (attr) scheduleAttribute(actions, attr, structuralConfig(config), state, partName, edits);
    }
  }
  runActions(actions);
}

function processWorkbook(scan: XmlScan, edits: XmlEdit[], warnings: string[]): void {
  let changed = 0;
  for (const element of scan.elements) {
    if (element.local === 'fileSharing') {
      if (blankAttribute(element, 'userName', edits)) changed += 1;
    }
    if (element.local === 'definedName') {
      if (blankAttribute(element, 'comment', edits)) changed += 1;
      if (blankAttribute(element, 'description', edits)) changed += 1;
    }
  }
  if (changed > 0) addWarning(warnings, 'Workbook sharing user and defined-name comments cleared');
}

function processGeneric(
  partName: string,
  scan: XmlScan,
  config: DetectionConfig,
  state: MaskingState,
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
): void {
  const actions: MaskAction[] = [];
  const structuralAttrs = new Set([
    'id',
    'r',
    's',
    't',
    'ref',
    'sqref',
    'numFmtId',
    'xfId',
    'sheetId',
    'cacheId',
    'fmtid',
    'pid',
    'guid',
  ]);

  for (const node of scan.textNodes) {
    if (isWhitespaceText(node.text)) continue;
    scheduleSegment(
      actions,
      [node],
      structuralConfig(config),
      state,
      partName,
      edits,
      nodeEdits,
      'skip-plain-number',
    );
  }

  for (const element of scan.elements) {
    for (const attr of element.attrs) {
      if (attr.ns === 'http://www.w3.org/2000/xmlns/') continue;
      if (attr.ns === R_NS) continue;
      if (structuralAttrs.has(attr.local)) continue;
      scheduleAttribute(actions, attr, structuralConfig(config), state, partName, edits);
    }
  }

  runActions(actions);
}

function processXmlPart(
  partName: string,
  parts: Map<string, Uint8Array>,
  contentType: string | undefined,
  config: DetectionConfig,
  state: MaskingState,
  warnings: string[],
): void {
  const policy = policyFor(partName, contentType);
  if (policy === 'skip') return;

  const { decoded, scan } = readXmlPart(parts, partName);
  const edits: XmlEdit[] = [];
  const nodeEdits = new Map<XmlTextNode, LocalEdit[]>();

  switch (policy) {
    case 'sharedStrings':
      processSharedStrings(partName, scan, config, state, edits, nodeEdits);
      break;
    case 'worksheet':
      processWorksheet(partName, scan, config, state, edits, nodeEdits, warnings);
      break;
    case 'comments':
      processComments(partName, scan, config, state, edits, nodeEdits, warnings);
      break;
    case 'threadedComments':
      processThreadedComments(partName, scan, config, state, edits, nodeEdits, warnings);
      break;
    case 'persons':
      processPersons(scan, edits, warnings);
      break;
    case 'chart':
      processChart(partName, scan, config, state, edits, nodeEdits, warnings);
      break;
    case 'drawing':
      processDrawing(partName, scan, config, state, edits, nodeEdits);
      break;
    case 'pivotCache':
      processPivotCache(partName, scan, config, state, edits);
      break;
    case 'pivotRecords':
      processPivotRecords(partName, scan, config, state, edits);
      break;
    case 'externalLinks':
      processExternalLinks(partName, scan, config, state, edits, nodeEdits);
      break;
    case 'connections':
      processConnections(scan, edits, warnings);
      break;
    case 'customXml':
      processCustomXml(partName, scan, config, state, edits, warnings);
      break;
    case 'core': {
      const count = processCore(scan, edits);
      state.metadataEdits += count;
      break;
    }
    case 'app': {
      const count = processApp(scan, edits, warnings);
      state.metadataEdits += count;
      break;
    }
    case 'workbook':
      processWorkbook(scan, edits, warnings);
      break;
    case 'styles':
      processStyles(partName, scan, config, state, edits);
      break;
    case 'generic':
      processGeneric(partName, scan, config, state, edits, nodeEdits);
      break;
  }

  addPreserveEdits(nodeEdits, edits);
  applyPartEdits(parts, partName, decoded, edits);
}

// ---------------------------------------------------------------------------
// Structural identifiers (fail-closed)
// ---------------------------------------------------------------------------

function structuralConfig(config: DetectionConfig): DetectionConfig {
  return { ...config, aggressive: true, enableUrl: true };
}

function containsPii(text: string, config: DetectionConfig): boolean {
  if (text.trim().length === 0) return false;
  return detectAll(text, structuralConfig(config)).length > 0;
}

function assertWorkbookIdentifiersSafe(
  parts: ReadonlyMap<string, Uint8Array>,
  config: DetectionConfig,
): void {
  const { scan } = readXmlPart(parts, 'xl/workbook.xml');
  for (const element of scan.elements) {
    if (element.local === 'sheet') {
      const name = attrOf(element, 'name')?.value;
      if (name && containsPii(name, config)) {
        throw new Error(
          'XLSX: a worksheet name contains PII; renaming it would break formulas. Rename or remove it in Excel and try again',
        );
      }
    }
    if (element.local === 'definedName') {
      const name = attrOf(element, 'name')?.value;
      if (name && containsPii(name, config)) {
        throw new Error(
          'XLSX: a defined name contains PII; renaming it would break formulas. Remove or rename it in Excel and try again',
        );
      }
      for (const node of element.textNodes) {
        if (containsPii(node.text, config)) {
          throw new Error(
            'XLSX: a defined name refers to or contains PII; it cannot be masked without breaking formulas. Remove or rename it in Excel and try again',
          );
        }
      }
    }
  }
}

function assertTablesAndPivotsSafe(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
  config: DetectionConfig,
): void {
  for (const partName of findParts(
    parts,
    (name) =>
      /^xl\/(?:tables|pivotTables)\/[^/]+\.xml$/iu.test(name) &&
      isXmlPart(name, contentTypeOf(types, name)),
  )) {
    const { scan } = readXmlPart(parts, partName);
    for (const element of scan.elements) {
      const names: string[] = [];
      if (element.local === 'table') {
        for (const local of ['displayName', 'name']) {
          const value = attrOf(element, local)?.value;
          if (value) names.push(value);
        }
      }
      if (element.local === 'tableColumn') {
        const value = attrOf(element, 'name')?.value;
        if (value) names.push(value);
      }
      if (
        element.local === 'pivotTableDefinition' ||
        element.local === 'pivotField' ||
        element.local === 'dataField' ||
        element.local === 'pageField' ||
        element.local === 'rowField' ||
        element.local === 'colField'
      ) {
        for (const local of ['name', 'dataCaption', 'tag']) {
          const value = attrOf(element, local)?.value;
          if (value) names.push(value);
        }
      }
      for (const value of names) {
        if (containsPii(value, config)) {
          throw new Error(
            'XLSX: a table/pivot name or field name contains PII; it is referenced by structured formulas and cannot be renamed safely. Rename it in Excel and try again',
          );
        }
      }
    }
  }
}

function assertStylesSafe(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
  config: DetectionConfig,
): void {
  const stylesPart = findParts(
    parts,
    (name) =>
      name === 'xl/styles.xml' ||
      contentTypeOf(types, name)?.toLowerCase().endsWith('styles+xml') === true,
  )[0];
  if (!stylesPart) return;
  const { scan } = readXmlPart(parts, stylesPart);
  for (const element of scan.elements) {
    if (element.local !== 'numFmt') continue;
    const formatCode = attrOf(element, 'formatCode')?.value;
    if (formatCode && containsPii(formatCode, config)) {
      throw new Error(
        'XLSX: a custom number format contains PII; it cannot be masked without changing cell display. Remove the custom format in Excel and try again',
      );
    }
  }
}

function buildSharedStringsText(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
): string[] {
  const partName = findParts(
    parts,
    (name) =>
      name === 'xl/sharedStrings.xml' ||
      contentTypeOf(types, name)?.toLowerCase().endsWith('sharedstrings+xml') === true,
  )[0];
  if (!partName) return [];
  const { scan } = readXmlPart(parts, partName);
  const result: string[] = [];
  for (const element of scan.elements) {
    if (!isS(element.ns) || element.local !== 'si') continue;
    const nodes = collectTextNodes(element, (node) => isS(node.ns) && node.local === 't');
    const { visible } = partitionPhonetic(element, nodes);
    result.push(textOfNodes(visible));
  }
  return result;
}

function collectBinaryWarnings(parts: ReadonlyMap<string, Uint8Array>, warnings: string[]): void {
  const media = findParts(parts, (name) => /^xl\/media\//iu.test(name));
  if (media.length > 0) {
    addWarning(warnings, `${media.length} embedded image/media part(s) are not scanned for text`);
  }
  const embeddings = findParts(parts, (name) => /^xl\/embeddings\//iu.test(name));
  if (embeddings.length > 0) {
    addWarning(
      warnings,
      `${embeddings.length} embedded object(s) are not scanned; remove them if they may contain PII`,
    );
  }
  const activeX = findParts(parts, (name) => /^xl\/(?:activeX|ctrlProps)\//iu.test(name));
  if (activeX.length > 0) addWarning(warnings, `${activeX.length} ActiveX part(s) are not scanned`);
  const vml = findParts(parts, (name) => /\.vml$/iu.test(name));
  if (vml.length > 0) addWarning(warnings, `${vml.length} VML drawing part(s) are not scanned`);
  const model = findParts(parts, (name) => /^xl\/model\//iu.test(name));
  if (model.length > 0) {
    addWarning(warnings, `${model.length} PowerPivot/data-model part(s) are not scanned`);
  }
  const richData = findParts(parts, (name) => /^xl\/richData\//iu.test(name));
  if (richData.length > 0) {
    addWarning(warnings, `${richData.length} rich-data part(s) are not fully scanned`);
  }
}

function removePartsByPredicate(
  parts: Map<string, Uint8Array>,
  predicate: (name: string, bytes: Uint8Array) => boolean,
  removedParts: Set<string>,
): number {
  const names = findParts(parts, predicate);
  if (names.length === 0) return 0;
  for (const name of names) {
    removedParts.add(name);
    if (!isRelsPartName(name)) {
      const ownRels = relsPartNameFor(name);
      if (parts.has(ownRels)) removedParts.add(ownRels);
    }
  }
  for (const name of names) removePackagePart(parts, name);
  return names.length;
}

function removeCustomProperties(
  parts: Map<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
  removedParts: Set<string>,
  warnings: string[],
): void {
  const count = removePartsByPredicate(
    parts,
    (name) =>
      name === 'docProps/custom.xml' ||
      contentTypeOf(types, name) ===
        'application/vnd.openxmlformats-officedocument.custom-properties+xml',
    removedParts,
  );
  if (count > 0) addWarning(warnings, 'Custom document properties removed');
}

function removeThumbnails(
  parts: Map<string, Uint8Array>,
  removedParts: Set<string>,
  warnings: string[],
): void {
  const count = removePartsByPredicate(
    parts,
    (name) => /^docProps\/thumbnail\.[a-z0-9]+$/iu.test(name),
    removedParts,
  );
  if (count > 0) addWarning(warnings, 'Document thumbnail removed');
}

function removeCalcChain(
  parts: Map<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
  removedParts: Set<string>,
  warnings: string[],
): void {
  const count = removePartsByPredicate(
    parts,
    (name) =>
      name === 'xl/calcChain.xml' ||
      contentTypeOf(types, name)?.toLowerCase().endsWith('calcchain+xml') === true,
    removedParts,
  );
  if (count > 0) addWarning(warnings, 'Calculation chain removed (Excel rebuilds it)');
}

function removeSignatures(
  parts: Map<string, Uint8Array>,
  removedParts: Set<string>,
  warnings: string[],
): void {
  const count = removePartsByPredicate(
    parts,
    (name) => name.toLowerCase().startsWith('_xmlsignatures/'),
    removedParts,
  );
  if (count > 0) addWarning(warnings, 'Digital signatures removed (any edit invalidates them)');
}

function removeRevisionLogs(
  parts: Map<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
  removedParts: Set<string>,
  warnings: string[],
): void {
  const revisions = removePartsByPredicate(
    parts,
    (name) => name.startsWith('xl/revisions/'),
    removedParts,
  );
  if (revisions > 0) {
    addWarning(
      warnings,
      'Shared-workbook revision logs removed (they contain user names and old cell values)',
    );
  }
  const users = removePartsByPredicate(
    parts,
    (name) =>
      name === 'xl/users.xml' ||
      contentTypeOf(types, name)?.toLowerCase().endsWith('usernames+xml') === true,
    removedParts,
  );
  if (users > 0) addWarning(warnings, 'Workbook user list removed');
}

function sortedProcessableParts(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
): string[] {
  return [...parts.keys()]
    .filter((name) => {
      if (name === '[Content_Types].xml' || isRelsPartName(name)) return false;
      return isXmlPart(name, contentTypeOf(types, name));
    })
    .sort();
}

// ---------------------------------------------------------------------------
// Anonymize
// ---------------------------------------------------------------------------

export async function anonymizeXlsx(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();
  await ensureCodecScanner();

  assertSupportedXlsxName(file.name);

  const parts = unzipPackage(file.bytes);
  let types = parseContentTypes(parts);
  assertNoMacros(parts, types);
  assertWorkbookMainPart(parts, types);
  assertPackageValid(parts);
  const baseline: PackageBaseline = snapshotPackage(parts);
  const sha256 = await sha256Hex(file.bytes);

  const config = ctx.config ?? {};
  const draft = structuredClone(ctx.vault);
  const occurrenceStart = draft.occurrences.length;
  const warnings: string[] = [];
  const removedParts = new Set<string>();
  const state: MaskingState = {
    vault: draft,
    touched: new Map(),
    maskedTextByPart: new Map(),
    sharedStrings: [],
    formulaEdits: 0,
    unparsedFormulas: 0,
    chartEdits: 0,
    drawingAltEdits: 0,
    attributeEdits: 0,
    metadataEdits: 0,
    commentEdits: 0,
    threadedEdits: 0,
  };

  removeCustomProperties(parts, types, removedParts, warnings);
  removeThumbnails(parts, removedParts, warnings);
  removeCalcChain(parts, types, removedParts, warnings);
  removeSignatures(parts, removedParts, warnings);
  removeRevisionLogs(parts, types, removedParts, warnings);

  const redactedRelationships = redactExternalRelationships(parts);
  if (redactedRelationships > 0) {
    addWarning(
      warnings,
      `${redactedRelationships} external relationship target(s) replaced with https://example.invalid/redacted`,
    );
  }

  types = parseContentTypes(parts);
  assertWorkbookIdentifiersSafe(parts, config);
  assertTablesAndPivotsSafe(parts, types, config);
  assertStylesSafe(parts, types, config);

  state.sharedStrings = buildSharedStringsText(parts, types);

  for (const partName of sortedProcessableParts(parts, types)) {
    ctx.signal?.throwIfAborted();
    processXmlPart(partName, parts, contentTypeOf(types, partName), config, state, warnings);
  }

  if (state.formulaEdits > 0) {
    addWarning(
      warnings,
      `${state.formulaEdits} formula string literal(s) masked; shared/array formula structure preserved`,
    );
  }
  if (state.unparsedFormulas > 0) {
    addWarning(
      warnings,
      `${state.unparsedFormulas} formula(s) with malformed string literals were left unchanged; review manually`,
    );
  }
  if (state.commentEdits > 0) {
    addWarning(warnings, 'Comment text masked; comment authors cleared');
  }
  if (state.threadedEdits > 0) {
    addWarning(warnings, 'Threaded comment text masked; comment dates sanitized');
  }
  if (state.attributeEdits > 0) {
    addWarning(warnings, `${state.attributeEdits} attribute value(s) masked or cleared`);
  }
  if (state.metadataEdits > 0) {
    addWarning(warnings, `${state.metadataEdits} metadata field(s) sanitized`);
  }
  if (state.drawingAltEdits > 0) {
    addWarning(
      warnings,
      `${state.drawingAltEdits} drawing alt-text/tooltip/shape-name attribute(s) cleared`,
    );
  }
  if (
    parts.has('xl/externalLinks/externalLink1.xml') ||
    findParts(parts, (name) => name.startsWith('xl/externalLinks/')).length > 0
  ) {
    addWarning(warnings, 'External links redacted; cached values masked');
  }
  if (
    findParts(
      parts,
      (name) =>
        name.startsWith('xl/pivotCache/pivotCacheDefinition') ||
        name.startsWith('xl/pivotCache/pivotCacheRecords'),
    ).length > 0
  ) {
    addWarning(
      warnings,
      'Pivot cache field names, string items and string record values masked; numeric PII in shared items or records rejects the file; refresh the pivot table in Excel',
    );
  }
  collectBinaryWarnings(parts, warnings);

  const globalText = [...state.maskedTextByPart.values()]
    .map((chunks) => chunks.join(''))
    .join('\n');
  if (globalText.trim().length > 0) {
    assertClean(globalText, config);
  }

  assertPackageValid(parts, { baseline, removedParts });
  const maskedBytes = zipPackage(parts);

  commitVault(ctx.vault, draft);
  const vault = ctx.vault;
  vault.files.push({
    originalName: file.name,
    // Filename masking is part of the upload hook (M3); M2b keeps the name.
    maskedName: file.name,
    format: 'xlsx',
    size: file.bytes.byteLength,
    sha256,
    maskedSha256: await sha256Hex(maskedBytes),
    occurrenceStart,
    occurrenceCount: vault.occurrences.length - occurrenceStart,
  });

  return {
    maskedBytes,
    maskedName: file.name,
    format: 'xlsx',
    entities: [...state.touched.values()],
    occurrences: vault.occurrences.slice(occurrenceStart),
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

interface RestoreReplacement {
  start: number;
  end: number;
  value: string;
}

interface RestoreSession {
  vault: Vault;
  queues: Map<string, string[]>;
  ambiguous: boolean;
  unknown: Set<string>;
}

function buildRestoreSession(vault: Vault, record: VaultFile | undefined): RestoreSession {
  const scoped = createFileRestoreSession(vault, record);
  return {
    vault,
    queues: scoped.queues,
    ambiguous: scoped.ambiguous === true,
    unknown: new Set(),
  };
}

function restoreString(
  text: string,
  session: RestoreSession,
): { text: string; replacements: RestoreReplacement[] } {
  const tags = parseTags(text);
  if (tags.length === 0) return { text, replacements: [] };

  const replacements: RestoreReplacement[] = [];
  for (const tag of tags) {
    if (tag.prefix !== session.vault.prefix) {
      session.unknown.add(tag.raw);
      continue;
    }
    const entity = session.vault.entities[`${tag.label}_${tag.n}`];
    if (!entity) {
      session.unknown.add(tag.raw);
      continue;
    }
    if (session.ambiguous) {
      throw new AmbiguousVaultFileError(
        'this vault file has no occurrence scope while the vault contains several files',
      );
    }
    const key = `${tag.prefix}_${tag.label}_${tag.n}`;
    const queue = session.queues.get(key);
    const value = queue && queue.length > 0 ? (queue.shift() as string) : canonicalOf(entity);
    replacements.push({ start: tag.index, end: tag.index + tag.raw.length, value });
  }

  let result = text;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (!replacement) continue;
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  return { text: result, replacements };
}

function restoreXmlPart(
  partName: string,
  parts: Map<string, Uint8Array>,
  session: RestoreSession,
): number {
  const { decoded, scan } = readXmlPart(parts, partName);
  const edits: XmlEdit[] = [];
  const nodeEdits = new Map<XmlTextNode, LocalEdit[]>();
  let replacements = 0;

  interface RestoreAction {
    start: number;
    run: () => void;
  }
  const actions: RestoreAction[] = [];

  for (const node of scan.textNodes) {
    if (!node.text.includes('[')) continue;
    actions.push({
      start: node.start,
      run: () => {
        const restored = restoreString(node.text, session);
        if (restored.replacements.length === 0) return;
        const localEdits: LocalEdit[] = [];
        for (const replacement of restored.replacements) {
          const rawStart = rawOffsetInTextNode(node, replacement.start);
          const rawEnd = rawOffsetInTextNode(node, replacement.end);
          if (rawStart < 0 || rawEnd < rawStart) {
            throw new Error('XLSX: internal restore offset mapping failed');
          }
          const value = isFormulaTextNode(node)
            ? replacement.value.replace(/"/gu, '""')
            : replacement.value;
          edits.push({
            start: node.start + rawStart,
            end: node.start + rawEnd,
            text: escapeXmlText(value),
          });
          localEdits.push({
            start: replacement.start,
            end: replacement.end,
            text: replacement.value,
          });
          replacements += 1;
        }
        nodeEdits.set(node, localEdits);
      },
    });
  }

  for (const element of scan.elements) {
    for (const attr of element.attrs) {
      if (attr.ns === 'http://www.w3.org/2000/xmlns/') continue;
      if (!attr.value.includes('[')) continue;
      actions.push({
        start: attr.valueStart,
        run: () => {
          const restored = restoreString(attr.value, session);
          if (restored.replacements.length === 0) return;
          edits.push({
            start: attr.valueStart,
            end: attr.valueEnd,
            text: escapeXmlAttribute(restored.text),
          });
          replacements += restored.replacements.length;
        },
      });
    }
  }

  actions.sort((left, right) => left.start - right.start);
  for (const action of actions) action.run();

  addPreserveEdits(nodeEdits, edits);
  applyPartEdits(parts, partName, decoded, edits);
  return replacements;
}

export async function restoreXlsx(file: FileInput, vault: Vault): Promise<RestoreResult> {
  await ensureCodecScanner();
  assertSupportedXlsxName(file.name);

  // Identity is the hash of the exact masked bytes; see `restoreDocx`.
  const record = await resolveVaultFile(vault, { name: file.name, bytes: file.bytes });

  const parts = unzipPackage(file.bytes);
  const types = parseContentTypes(parts);
  assertNoMacros(parts, types);
  assertWorkbookMainPart(parts, types);
  assertPackageValid(parts);
  const baseline = snapshotPackage(parts);

  const session = buildRestoreSession(vault, record);
  let replacements = 0;
  for (const partName of sortedProcessableParts(parts, types)) {
    replacements += restoreXmlPart(partName, parts, session);
  }

  assertPackageValid(parts, { baseline });

  const bytes = zipPackage(parts);
  const warnings: string[] = [];
  if (session.unknown.size > 0) {
    warnings.push(`${session.unknown.size} unknown tag(s) left untouched`);
  }
  warnings.push(
    'Workbook metadata, authors/persons, external links, custom properties and removed parts remain sanitized; only text/attribute tags were restored',
  );

  return {
    bytes,
    // A legacy `.xls` record is stored as XLSX: return the masked (XLSX) name,
    // not the original `.xls` name that no longer describes these bytes.
    fileName: record?.maskedName ?? file.name,
    replacements,
    unknownTags: [...session.unknown],
    warnings,
  };
}

export const xlsxFormatAdapter: FormatAdapter = {
  format: 'xlsx',
  extensions: ['.xlsx'],
  mimeTypes: [XLSX_MIME],
  canHandle(file): boolean {
    const name = file.name.toLowerCase();
    const mime = (file.mimeType.split(';')[0] ?? '').trim().toLowerCase();
    if (/\.(?:xlsm|xltm|xlsb|xls|xlt|xlam|xla)$/u.test(name)) return false;
    if (mime.includes('macroenabled')) return false;
    return name.endsWith('.xlsx') || mime === XLSX_MIME;
  },
  anonymize(file, ctx) {
    return anonymizeXlsx(file, ctx);
  },
  restore(file, vault) {
    return restoreXlsx(file, vault);
  },
};
