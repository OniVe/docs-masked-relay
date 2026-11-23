/**
 * DOCX format adapter (M2a).
 *
 * In-place OOXML editing: the package is unzipped, every text-bearing XML part
 * is scanned with the byte-level scanner, and only text/attribute value ranges
 * are spliced. Paragraph text is stitched across split runs but never across
 * hyperlinks, revisions, fields, text boxes, SDTs, smart tags or custom XML.
 *
 * Privacy policy:
 * - visible text / deleted text / field instructions / comments / headers /
 *   footers / notes / glossary / text boxes / charts / diagrams are masked;
 * - docProps, customXml, comment authors, revision authors, rsids and external
 *   relationship targets are sanitized one-way;
 * - thumbnails and digital signatures are removed (edits invalidate signatures);
 * - .docm is rejected: macros are never uploaded.
 *
 * Any parse/lint failure throws before bytes are returned (fail-closed). The
 * caller's vault is only committed after the whole package passes the linter.
 */

import { ensureStructuredScanner } from '../detect/wasm-scan';
import {
  anonymizeText,
  assertClean,
  createFileRestoreSession,
  type MaskedReplacement,
} from '../masker';
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
  type PackageLintOptions,
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

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W_STRICT_NS = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15_NS = 'http://schemas.microsoft.com/office/word/2012/wordml';
const W16_NS = 'http://schemas.microsoft.com/office/word/2018/wordml';
const W16CEX_NS = 'http://schemas.microsoft.com/office/word/2018/wordml/cex';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const A_STRICT_NS = 'http://purl.oclc.org/ooxml/drawingml/main';
const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const C_STRICT_NS = 'http://purl.oclc.org/ooxml/drawingml/chart';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EPOCH = '1970-01-01T00:00:00Z';
const RSID = '00000000';

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
const PEOPLE_ATTRS = new Set([
  'author',
  'initials',
  'userId',
  'providerId',
  'email',
  'displayName',
  'presenceInfo',
]);

const WML_CUT_ELEMENTS = new Set([
  'hyperlink',
  'ins',
  'del',
  'moveFrom',
  'moveTo',
  'fldSimple',
  'txbxContent',
  'sdt',
  'smartTag',
  'customXml',
]);
const WML_CUT_STOPS = new Set(['tab', 'br', 'cr']);
const DRAWING_CUT_ELEMENTS = new Set(['fld']);
const DRAWING_CUT_STOPS = new Set(['br', 'tab']);

type PartPolicy =
  | 'wml'
  | 'drawing'
  | 'generic'
  | 'core'
  | 'app'
  | 'custom-props'
  | 'custom-xml'
  | 'comments-meta'
  | 'people'
  | 'settings';

interface LocalEdit {
  start: number;
  end: number;
  text: string;
}

interface SegmentNode {
  node: XmlTextNode;
  offset: number;
}

type SegmentKind = 'text' | 'instr' | 'drawing' | 'chart' | 'generic';

interface Segment {
  kind: SegmentKind;
  nodes: SegmentNode[];
  text: string;
}

interface MaskingState {
  vault: Vault;
  touched: Map<string, MaskedEntity>;
  maskedTextByPart: Map<string, string[]>;
  instrSegments: number;
  fieldInstructions: number;
  chartSegments: number;
  metadataEdits: number;
  altTextEdits: number;
  revisionsSeen: boolean;
}

interface PartEdits {
  edits: XmlEdit[];
  nodeEdits: Map<XmlTextNode, LocalEdit[]>;
}

function isW(ns: string): boolean {
  return ns === W_NS || ns === W_STRICT_NS;
}

function isA(ns: string): boolean {
  return ns === A_NS || ns === A_STRICT_NS;
}

function isC(ns: string): boolean {
  return ns === C_NS || ns === C_STRICT_NS;
}

function isOfficeNs(ns: string): boolean {
  return isW(ns) || ns === W14_NS || ns === W15_NS || ns === W16_NS || ns === W16CEX_NS;
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

/** Rejects `.docm`/legacy names before any parsing. */
function assertSupportedDocxName(name: string): void {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docm') || lower.endsWith('.dotm')) {
    throw new Error(
      'DOCX: macro-enabled files (.docm/.dotm) are not supported; save the document as .docx without macros and try again',
    );
  }
  if (/\.(?:doc|dot|dotx|xls|xlsm|xlt|xltm)$/u.test(lower)) {
    throw new Error('DOCX: only .docx files are supported by this adapter');
  }
}

function assertNoMacros(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
): void {
  for (const [partName, contentType] of types.overrides) {
    if (/macroEnabled|vbaProject/iu.test(contentType)) {
      throw new Error(
        `DOCX: package contains macro content (${partName}); macro-enabled documents are rejected`,
      );
    }
  }
  for (const partName of parts.keys()) {
    if (/(?:^|\/)vbaProject\.bin$/iu.test(partName) || /(?:^|\/)vbaData\.xml$/iu.test(partName)) {
      throw new Error(
        'DOCX: package contains VBA macros; save the document as .docx without macros and try again',
      );
    }
  }
}

function assertWordMainPart(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
): void {
  const mainPart = findMainPart(parts, types);
  const contentType = contentTypeOf(types, mainPart);
  if (
    contentType === undefined ||
    !/wordprocessingml\.(?:document|template)\.main\+xml$/iu.test(contentType)
  ) {
    throw new Error('DOCX: package is not a WordprocessingML document');
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
  if (
    partName === 'docProps/custom.xml' ||
    type === 'application/vnd.openxmlformats-officedocument.custom-properties+xml'
  ) {
    return 'custom-props';
  }
  if (partName.startsWith('customXml/')) return 'custom-xml';
  if (partName === 'word/people.xml' || type.endsWith('people+xml')) return 'people';
  if (
    partName === 'word/commentsExtended.xml' ||
    partName === 'word/commentsIds.xml' ||
    partName === 'word/commentsExtensible.xml' ||
    /comments(?:Extended|Ids|Extensible)\+xml$/iu.test(type)
  ) {
    return 'comments-meta';
  }
  if (partName === 'word/settings.xml' || type.endsWith('settings+xml')) return 'settings';

  if (
    /wordprocessingml\.(?:document|template)\.main\+xml$/u.test(type) ||
    /wordprocessingml\.document\.glossary\+xml$/u.test(type) ||
    /wordprocessingml\.(?:header|footer|footnotes|endnotes|comments|glossaryDocument)\+xml$/u.test(
      type,
    )
  ) {
    return 'wml';
  }
  if (/drawingml\.(?:chart|diagram(?:Data|Layout|Style|Colors)?)\+xml$/u.test(type)) {
    return 'drawing';
  }

  if (
    /^word\/(?:document\d*|header\d*|footer\d*|footnotes|endnotes|comments|glossary\/document)\.xml$/iu.test(
      partName,
    )
  ) {
    return 'wml';
  }
  if (/^word\/(?:charts|diagrams|drawings)\//iu.test(partName)) return 'drawing';

  return 'generic';
}

function nearestAncestor(
  element: XmlElement,
  predicate: (element: XmlElement) => boolean,
): XmlElement | undefined {
  let current: XmlElement | null = element;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function boundaryKey(element: XmlElement, cutElements: ReadonlySet<string>, wml: boolean): string {
  const chain: string[] = [];
  let current: XmlElement | null = element;
  while (current) {
    const matches = wml ? isW(current.ns) : isA(current.ns);
    if (matches && cutElements.has(current.local)) chain.push(String(current.start));
    current = current.parent;
  }
  return chain.join(',');
}

function appendNode(segment: Segment, node: XmlTextNode): void {
  segment.nodes.push({ node, offset: segment.text.length });
  segment.text += node.text;
}

function advanceStops(
  stops: readonly number[],
  index: number,
  active: boolean,
  lastNode: XmlTextNode | null,
  node: XmlTextNode,
): { index: number; cut: boolean } {
  let next = index;
  let cut = false;
  while (next < stops.length && (stops[next] ?? 0) < node.start) {
    const stop = stops[next] ?? 0;
    if (active && lastNode !== null && stop >= lastNode.end) cut = true;
    next += 1;
  }
  return { index: next, cut };
}

function buildWmlSegments(scan: XmlScan): Segment[] {
  const segments: Segment[] = [];
  const wmlStops = scan.elements
    .filter((element) => isW(element.ns) && WML_CUT_STOPS.has(element.local))
    .map((element) => element.start)
    .sort((a, b) => a - b);
  const drawingStops = scan.elements
    .filter((element) => isA(element.ns) && DRAWING_CUT_STOPS.has(element.local))
    .map((element) => element.start)
    .sort((a, b) => a - b);

  let current: Segment | null = null;
  let currentKey: string | null = null;
  let lastNode: XmlTextNode | null = null;
  let wmlStopIndex = 0;
  let drawingStopIndex = 0;

  const close = (): void => {
    if (current) segments.push(current);
    current = null;
    currentKey = null;
    lastNode = null;
  };

  for (const node of scan.textNodes) {
    if (isW(node.ns) && (node.local === 't' || node.local === 'delText')) {
      const paragraph = nearestAncestor(
        node.element,
        (element) => isW(element.ns) && element.local === 'p',
      );
      if (!paragraph) {
        close();
        const segment: Segment = { kind: 'text', nodes: [], text: '' };
        appendNode(segment, node);
        segments.push(segment);
        lastNode = node;
        continue;
      }

      const advance = advanceStops(wmlStops, wmlStopIndex, current !== null, lastNode, node);
      wmlStopIndex = advance.index;
      const key = `${paragraph.start}|${boundaryKey(node.element, WML_CUT_ELEMENTS, true)}|${node.local}`;

      if (!current || currentKey !== key || advance.cut) {
        close();
        current = { kind: 'text', nodes: [], text: '' };
        currentKey = key;
      }
      appendNode(current, node);
      lastNode = node;
      continue;
    }

    if (isW(node.ns) && (node.local === 'instrText' || node.local === 'delInstrText')) {
      close();
      const segment: Segment = { kind: 'instr', nodes: [], text: '' };
      appendNode(segment, node);
      segments.push(segment);
      continue;
    }

    if (isA(node.ns) && node.local === 't') {
      const paragraph = nearestAncestor(
        node.element,
        (element) => isA(element.ns) && element.local === 'p',
      );
      const advance = advanceStops(
        drawingStops,
        drawingStopIndex,
        current !== null,
        lastNode,
        node,
      );
      drawingStopIndex = advance.index;
      const key = paragraph
        ? `draw|${paragraph.start}|${boundaryKey(node.element, DRAWING_CUT_ELEMENTS, false)}`
        : `draw-node|${node.start}`;

      if (!current || currentKey !== key || advance.cut) {
        close();
        current = { kind: 'drawing', nodes: [], text: '' };
        currentKey = key;
      }
      appendNode(current, node);
      lastNode = node;
      continue;
    }

    if (isC(node.ns) && node.local === 'v' && isStringChartValue(node)) {
      close();
      const segment: Segment = { kind: 'chart', nodes: [], text: '' };
      appendNode(segment, node);
      segments.push(segment);
      continue;
    }

    if (isC(node.ns) && (node.local === 'v' || node.local === 'f' || node.local === 'formatCode')) {
      // Numeric chart caches and formulas are left untouched; changing them
      // would silently corrupt chart data.
      continue;
    }

    if (isWhitespaceText(node.text)) continue;
    close();
    const segment: Segment = { kind: 'generic', nodes: [], text: '' };
    appendNode(segment, node);
    segments.push(segment);
  }

  close();
  return segments;
}

// Drawing stop offsets are computed per scan in the segment builders.

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

function buildDrawingSegments(scan: XmlScan): Segment[] {
  const segments: Segment[] = [];
  const stops = scan.elements
    .filter((element) => isA(element.ns) && DRAWING_CUT_STOPS.has(element.local))
    .map((element) => element.start)
    .sort((a, b) => a - b);

  let current: Segment | null = null;
  let currentKey: string | null = null;
  let lastNode: XmlTextNode | null = null;
  let stopIndex = 0;

  const close = (): void => {
    if (current) segments.push(current);
    current = null;
    currentKey = null;
    lastNode = null;
  };

  for (const node of scan.textNodes) {
    if (isA(node.ns) && node.local === 't') {
      const paragraph = nearestAncestor(
        node.element,
        (element) => isA(element.ns) && element.local === 'p',
      );
      const advance = advanceStops(stops, stopIndex, current !== null, lastNode, node);
      stopIndex = advance.index;
      const key = paragraph
        ? `draw|${paragraph.start}|${boundaryKey(node.element, DRAWING_CUT_ELEMENTS, false)}`
        : `draw-node|${node.start}`;
      if (!current || currentKey !== key || advance.cut) {
        close();
        current = { kind: 'drawing', nodes: [], text: '' };
        currentKey = key;
      }
      appendNode(current, node);
      lastNode = node;
      continue;
    }
    if (isC(node.ns) && node.local === 'v' && isStringChartValue(node)) {
      close();
      const segment: Segment = { kind: 'chart', nodes: [], text: '' };
      appendNode(segment, node);
      segments.push(segment);
      continue;
    }
    if (isC(node.ns) && (node.local === 'v' || node.local === 'f' || node.local === 'formatCode')) {
      continue;
    }
    if (isWhitespaceText(node.text)) continue;
    close();
    const segment: Segment = { kind: 'generic', nodes: [], text: '' };
    appendNode(segment, node);
    segments.push(segment);
  }

  close();
  return segments;
}

function buildGenericSegments(scan: XmlScan): Segment[] {
  const segments: Segment[] = [];
  for (const node of scan.textNodes) {
    if (isWhitespaceText(node.text)) continue;
    const segment: Segment = { kind: 'generic', nodes: [], text: '' };
    appendNode(segment, node);
    segments.push(segment);
  }
  return segments;
}

function mapSegmentReplacements(
  segment: Segment,
  replacements: readonly MaskedReplacement[],
  edits: XmlEdit[],
  nodeEdits: Map<XmlTextNode, LocalEdit[]>,
): void {
  for (const replacement of replacements) {
    let first = true;
    for (const { node, offset } of segment.nodes) {
      const nodeEnd = offset + node.text.length;
      if (replacement.start >= nodeEnd || replacement.end <= offset) continue;

      const localStart = Math.max(replacement.start, offset) - offset;
      const localEnd = Math.min(replacement.end, nodeEnd) - offset;
      if (localStart >= localEnd) continue;

      const rawStart = rawOffsetInTextNode(node, localStart);
      const rawEnd = rawOffsetInTextNode(node, localEnd);
      if (rawStart < 0 || rawEnd < rawStart) {
        throw new Error('DOCX: internal text offset mapping failed');
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
    if (first) throw new Error('DOCX: replacement did not map to a text node');
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

/**
 * Adds `xml:space="preserve"` (or upgrades `default`) when a replacement at the
 * start/end of a text node introduces whitespace. Never touches `w:rPr`.
 */
function addPreserveEdits(
  nodeEdits: ReadonlyMap<XmlTextNode, readonly LocalEdit[]>,
  edits: XmlEdit[],
): void {
  const seen = new Set<XmlElement>();

  for (const [node, localEdits] of nodeEdits) {
    if (seen.has(node.element)) continue;
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

function blankTextNodes(
  scan: XmlScan,
  predicate: (node: XmlTextNode) => boolean,
  replacement = '',
): XmlEdit[] {
  const edits: XmlEdit[] = [];
  for (const node of scan.textNodes) {
    if (isWhitespaceText(node.text)) continue;
    if (!predicate(node)) continue;
    edits.push({
      start: node.start,
      end: node.end,
      text: replacement.length > 0 ? escapeXmlText(replacement) : '',
    });
  }
  return edits;
}

interface MetadataEditResult {
  edits: XmlEdit[];
  count: number;
  altTextCount: number;
  fieldInstructions: number;
}

function hasLocalAttr(element: XmlElement, local: string): XmlElement['attrs'][number] | undefined {
  for (const attr of element.attrs) {
    if (attr.local === local) return attr;
  }
  return undefined;
}

function metadataEdits(scan: XmlScan, policy: PartPolicy): MetadataEditResult {
  const edits: XmlEdit[] = [];
  let count = 0;
  let altTextCount = 0;
  let fieldInstructions = 0;

  const replaceAttr = (
    attr: { valueStart: number; valueEnd: number },
    value: string,
    countMetadata = true,
  ): void => {
    edits.push({
      start: attr.valueStart,
      end: attr.valueEnd,
      text: escapeXmlAttribute(value),
    });
    if (countMetadata) count += 1;
  };

  for (const element of scan.elements) {
    for (const attr of element.attrs) {
      if (
        attr.local === 'descr' ||
        attr.local === 'tooltip' ||
        attr.local === 'altText' ||
        attr.local === 'alt'
      ) {
        replaceAttr(attr, '', false);
        altTextCount += 1;
        continue;
      }
      if (attr.local === 'name' && (element.local === 'docPr' || element.local === 'cNvPr')) {
        replaceAttr(attr, '', false);
        altTextCount += 1;
        continue;
      }
      if (
        attr.local === 'title' &&
        (element.local === 'docPr' ||
          element.local === 'cNvPr' ||
          element.local === 'shape' ||
          element.local === 'imagedata')
      ) {
        replaceAttr(attr, '', false);
        altTextCount += 1;
        continue;
      }
      if (!isOfficeNs(attr.ns)) continue;

      if (/^rsid/iu.test(attr.local)) {
        replaceAttr(attr, RSID);
        continue;
      }
      if (attr.local === 'author' || attr.local === 'initials') {
        replaceAttr(attr, '');
        continue;
      }
      if (attr.local === 'date' || attr.local === 'dateUtc') {
        replaceAttr(attr, EPOCH);
        continue;
      }
      if (policy === 'people' && PEOPLE_ATTRS.has(attr.local)) {
        replaceAttr(attr, '');
        continue;
      }
      if (policy === 'custom-xml' && attr.local === 'itemName') {
        replaceAttr(attr, '');
        continue;
      }
      if (policy === 'settings' && isW(element.ns)) {
        if (element.local === 'docVar' && (attr.local === 'name' || attr.local === 'val')) {
          replaceAttr(attr, '');
          continue;
        }
        if (
          element.local === 'mailMerge' &&
          (attr.local === 'dataSource' || attr.local === 'query' || attr.local === 'connectString')
        ) {
          replaceAttr(attr, '');
          continue;
        }
        if (element.local === 'odso' && (attr.local === 'uds' || attr.local === 'table')) {
          replaceAttr(attr, '');
        }
      }
    }

    if (isW(element.ns) && element.local === 'rsid') {
      const value = hasLocalAttr(element, 'val');
      if (value) replaceAttr(value, RSID);
    }

    if (policy === 'wml' && isW(element.ns) && element.local === 'fldSimple') {
      const instruction = hasLocalAttr(element, 'instr');
      if (instruction && instruction.value.length > 0) {
        replaceAttr(instruction, '', false);
        fieldInstructions += 1;
      }
    }
  }

  return { edits, count, altTextCount, fieldInstructions };
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
  const { decoded, scan } = readXmlPart(parts, partName);
  const partEdits: PartEdits = { edits: [], nodeEdits: new Map() };

  if (policy === 'wml' || policy === 'drawing' || policy === 'generic') {
    const segments =
      policy === 'wml'
        ? buildWmlSegments(scan)
        : policy === 'drawing'
          ? buildDrawingSegments(scan)
          : buildGenericSegments(scan);

    if (policy === 'wml') {
      for (const element of scan.elements) {
        if (!isW(element.ns)) continue;
        if (
          element.local === 'ins' ||
          element.local === 'del' ||
          element.local === 'moveFrom' ||
          element.local === 'moveTo'
        ) {
          state.revisionsSeen = true;
          break;
        }
      }
    }

    for (const segment of segments) {
      if (segment.text.length === 0) continue;

      if (segment.kind === 'instr') {
        // Field instructions (including file paths and INCLUDETEXT targets)
        // are not visible text and cannot be tag/restored. Clear every
        // instrText node one-way, exactly like fldSimple@instr.
        state.fieldInstructions += 1;
        state.instrSegments += 1;
        for (const { node } of segment.nodes) {
          partEdits.edits.push({ start: node.start, end: node.end, text: '' });
        }
        const masked = state.maskedTextByPart.get(partName) ?? [];
        masked.push('');
        state.maskedTextByPart.set(partName, masked);
        continue;
      }

      const segmentConfig: DetectionConfig =
        segment.kind === 'chart' ? { ...config, enableUrl: true } : config;
      const result = anonymizeText(segment.text, segmentConfig, state.vault);

      const masked = state.maskedTextByPart.get(partName) ?? [];
      masked.push(result.maskedText);
      state.maskedTextByPart.set(partName, masked);

      for (const entity of result.entities) state.touched.set(entity.key, entity);
      if (result.warnings.length > 0) warnings.push(...result.warnings);
      if (result.replacements.length === 0) continue;

      if (segment.kind === 'chart') state.chartSegments += 1;
      mapSegmentReplacements(segment, result.replacements, partEdits.edits, partEdits.nodeEdits);
    }

    addPreserveEdits(partEdits.nodeEdits, partEdits.edits);
  } else if (policy === 'core') {
    partEdits.edits.push(...blankTextNodes(scan, (node) => CORE_BLANK.has(node.element.local)));
    partEdits.edits.push(
      ...blankTextNodes(scan, (node) => CORE_EPOCH.has(node.element.local), EPOCH),
    );
  } else if (policy === 'app') {
    partEdits.edits.push(...blankTextNodes(scan, isAppBlankText));
    addWarning(
      warnings,
      'Company/Manager/Template/HyperlinkBase/TitlesOfParts/HeadingPairs text cleared',
    );
  } else if (policy === 'custom-props') {
    partEdits.edits.push(...blankTextNodes(scan, () => true));
    addWarning(warnings, 'Custom document property values cleared');
  } else if (policy === 'custom-xml') {
    partEdits.edits.push(...blankTextNodes(scan, () => true));
    addWarning(warnings, 'customXml text cleared');
  } else if (policy === 'comments-meta' || policy === 'people') {
    partEdits.edits.push(...blankTextNodes(scan, () => true));
    addWarning(warnings, 'Comment/people metadata sanitized');
  }

  const metadata = metadataEdits(scan, policy);
  if (metadata.edits.length > 0) {
    partEdits.edits.push(...metadata.edits);
    state.metadataEdits += metadata.count;
    state.altTextEdits += metadata.altTextCount;
    state.instrSegments += metadata.fieldInstructions;
    state.fieldInstructions += metadata.fieldInstructions;
  }

  applyPartEdits(parts, partName, decoded, partEdits.edits);
}

function collectBinaryWarnings(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
  warnings: string[],
): void {
  const media = findParts(parts, (name) => /^word\/media\//iu.test(name));
  if (media.length > 0) {
    addWarning(warnings, `${media.length} embedded image/media part(s) are not scanned for text`);
  }

  const embeddings = findParts(parts, (name) => /^word\/embeddings\//iu.test(name));
  if (embeddings.length > 0) {
    addWarning(
      warnings,
      `${embeddings.length} embedded object(s) are not scanned; remove them if they may contain PII`,
    );
  }

  const activeX = findParts(parts, (name) => /^word\/activeX\//iu.test(name));
  if (activeX.length > 0) {
    addWarning(warnings, `${activeX.length} ActiveX part(s) are not scanned`);
  }

  const altChunks = findParts(parts, (name) => {
    const contentType = contentTypeOf(types, name);
    return (
      /^word\/afchunk/iu.test(name) ||
      contentType?.toLowerCase() === 'text/html' ||
      contentType?.toLowerCase() === 'message/rfc822'
    );
  });
  if (altChunks.length > 0) {
    addWarning(warnings, `${altChunks.length} altChunk/HTML part(s) are not scanned`);
  }
}

function removeThumbnails(
  parts: Map<string, Uint8Array>,
  removedParts: Set<string>,
  warnings: string[],
): void {
  const thumbnails = findParts(parts, (name) => /^docProps\/thumbnail\.[a-z0-9]+$/iu.test(name));
  for (const name of thumbnails) {
    const ownRels = relsPartNameFor(name);
    if (parts.has(ownRels)) removedParts.add(ownRels);
    removedParts.add(name);
    removePackagePart(parts, name);
  }
  if (thumbnails.length > 0) addWarning(warnings, 'Document thumbnail removed');
}

function removeSignatures(
  parts: Map<string, Uint8Array>,
  removedParts: Set<string>,
  warnings: string[],
): void {
  const signatureParts = findParts(parts, (name) =>
    name.toLowerCase().startsWith('_xmlsignatures/'),
  );
  if (signatureParts.length === 0) return;
  for (const name of signatureParts) removedParts.add(name);
  for (const name of signatureParts) removePackagePart(parts, name);
  addWarning(warnings, 'Digital signatures removed (any edit invalidates them)');
}

/**
 * Custom document properties can hold arbitrary typed values and property
 * names; removing the part is safer than blanking a numeric/bool value.
 */
function removeCustomProperties(
  parts: Map<string, Uint8Array>,
  types: ReturnType<typeof parseContentTypes>,
  removedParts: Set<string>,
  warnings: string[],
): void {
  const customParts = findParts(
    parts,
    (name) =>
      name === 'docProps/custom.xml' ||
      contentTypeOf(types, name) ===
        'application/vnd.openxmlformats-officedocument.custom-properties+xml',
  );
  for (const name of customParts) {
    const ownRels = relsPartNameFor(name);
    if (parts.has(ownRels)) removedParts.add(ownRels);
    removedParts.add(name);
    removePackagePart(parts, name);
  }
  if (customParts.length > 0) addWarning(warnings, 'Custom document properties removed');
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

export async function anonymizeDocx(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();
  await ensureCodecScanner();

  assertSupportedDocxName(file.name);

  const parts = unzipPackage(file.bytes);
  let types = parseContentTypes(parts);
  assertNoMacros(parts, types);
  assertWordMainPart(parts, types);
  assertPackageValid(parts);
  const baseline: PackageBaseline = snapshotPackage(parts);
  const sha256 = await sha256Hex(file.bytes);

  const draft = structuredClone(ctx.vault);
  const occurrenceStart = draft.occurrences.length;
  const warnings: string[] = [];
  const removedParts = new Set<string>();
  const state: MaskingState = {
    vault: draft,
    touched: new Map(),
    maskedTextByPart: new Map(),
    instrSegments: 0,
    fieldInstructions: 0,
    chartSegments: 0,
    metadataEdits: 0,
    altTextEdits: 0,
    revisionsSeen: false,
  };
  const config = ctx.config ?? {};

  removeThumbnails(parts, removedParts, warnings);
  removeSignatures(parts, removedParts, warnings);
  removeCustomProperties(parts, types, removedParts, warnings);

  const redactedRelationships = redactExternalRelationships(parts);
  if (redactedRelationships > 0) {
    addWarning(
      warnings,
      `${redactedRelationships} external relationship target(s) replaced with https://example.invalid/redacted`,
    );
  }

  types = parseContentTypes(parts);
  collectBinaryWarnings(parts, types, warnings);

  for (const partName of sortedProcessableParts(parts, types)) {
    ctx.signal?.throwIfAborted();
    processXmlPart(partName, parts, contentTypeOf(types, partName), config, state, warnings);
  }

  if (state.instrSegments > 0) {
    addWarning(
      warnings,
      `${state.instrSegments} field instruction(s) cleared one-way; field codes are not restored`,
    );
  }
  const untouchedFields = state.fieldInstructions - state.instrSegments;
  if (untouchedFields > 0) {
    addWarning(
      warnings,
      `${untouchedFields} field instruction(s) left unchanged; hidden field codes may contain text outside the detector set`,
    );
  }
  if (state.chartSegments > 0) {
    addWarning(
      warnings,
      `${state.chartSegments} chart string cache value(s) masked; chart labels may show tags`,
    );
  }
  if (state.metadataEdits > 0) {
    addWarning(warnings, `${state.metadataEdits} metadata attribute(s) sanitized`);
  }
  if (state.altTextEdits > 0) {
    addWarning(warnings, `${state.altTextEdits} alt-text/tooltip/shape-name attribute(s) cleared`);
  }
  if (state.revisionsSeen) {
    addWarning(
      warnings,
      'Tracked changes retained; inserted/deleted text was masked and authors/dates sanitized',
    );
  }
  if (parts.has('word/comments.xml')) {
    addWarning(warnings, 'Comment text masked; comment authors, initials and dates sanitized');
  }

  const globalText = [...state.maskedTextByPart.values()]
    .map((chunks) => chunks.join(''))
    .join('\n');
  if (globalText.trim().length > 0) {
    assertClean(globalText, config);
  }

  const lintOptions: PackageLintOptions = { baseline, removedParts };
  assertPackageValid(parts, lintOptions);

  const maskedBytes = zipPackage(parts);

  commitVault(ctx.vault, draft);
  const vault = ctx.vault;
  vault.files.push({
    originalName: file.name,
    // Filename masking is part of the upload hook (M3); M2a keeps the name.
    maskedName: file.name,
    format: 'docx',
    size: file.bytes.byteLength,
    sha256,
    maskedSha256: await sha256Hex(maskedBytes),
    occurrenceStart,
    occurrenceCount: vault.occurrences.length - occurrenceStart,
  });

  return {
    maskedBytes,
    maskedName: file.name,
    format: 'docx',
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

function restoreNodeText(
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
    replacements.push({
      start: tag.index,
      end: tag.index + tag.raw.length,
      value,
    });
  }

  let result = text;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (!replacement) continue;
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  return { text: result, replacements };
}

function processRestorePart(
  partName: string,
  parts: Map<string, Uint8Array>,
  session: RestoreSession,
): number {
  const { decoded, scan } = readXmlPart(parts, partName);
  const edits: XmlEdit[] = [];
  const nodeEdits = new Map<XmlTextNode, LocalEdit[]>();
  let replacements = 0;

  for (const node of scan.textNodes) {
    const restored = restoreNodeText(node.text, session);
    if (restored.replacements.length === 0) continue;

    const localEdits: LocalEdit[] = [];
    for (const replacement of restored.replacements) {
      const rawStart = rawOffsetInTextNode(node, replacement.start);
      const rawEnd = rawOffsetInTextNode(node, replacement.end);
      if (rawStart < 0 || rawEnd < rawStart) {
        throw new Error('DOCX: internal restore offset mapping failed');
      }
      edits.push({
        start: node.start + rawStart,
        end: node.start + rawEnd,
        text: escapeXmlText(replacement.value),
      });
      localEdits.push({
        start: replacement.start,
        end: replacement.end,
        text: replacement.value,
      });
      replacements += 1;
    }
    nodeEdits.set(node, localEdits);
  }

  addPreserveEdits(nodeEdits, edits);
  applyPartEdits(parts, partName, decoded, edits);
  return replacements;
}

export async function restoreDocx(file: FileInput, vault: Vault): Promise<RestoreResult> {
  await ensureCodecScanner();
  assertSupportedDocxName(file.name);

  // Identity is the hash of the exact masked bytes. A foreign or modified
  // DOCX must never replay this vault's global occurrence queues, even when a
  // tag prefix or a file name happens to match; legacy name lookup is only
  // reachable for vaults without any hashed record (see `resolveVaultFile`).
  const record = await resolveVaultFile(vault, { name: file.name, bytes: file.bytes });

  const parts = unzipPackage(file.bytes);
  const types = parseContentTypes(parts);
  assertNoMacros(parts, types);
  assertWordMainPart(parts, types);
  assertPackageValid(parts);
  const baseline = snapshotPackage(parts);

  const session = buildRestoreSession(vault, record);
  let replacements = 0;

  for (const partName of sortedProcessableParts(parts, types)) {
    replacements += processRestorePart(partName, parts, session);
  }

  assertPackageValid(parts, { baseline });

  const bytes = zipPackage(parts);
  const warnings: string[] = [];
  if (session.unknown.size > 0) {
    warnings.push(`${session.unknown.size} unknown tag(s) left untouched`);
  }
  warnings.push(
    'Document metadata, customXml and field instructions remain sanitized; only text tags were restored',
  );

  return {
    bytes,
    // A legacy `.doc` record is stored as DOCX: return the masked (DOCX) name,
    // not the original `.doc` name that no longer describes these bytes.
    fileName: record?.maskedName ?? file.name,
    replacements,
    unknownTags: [...session.unknown],
    warnings,
  };
}

export const docxFormatAdapter: FormatAdapter = {
  format: 'docx',
  extensions: ['.docx'],
  mimeTypes: [DOCX_MIME],
  canHandle(file): boolean {
    const name = file.name.toLowerCase();
    const mime = (file.mimeType.split(';')[0] ?? '').trim().toLowerCase();
    if (/\.(?:docm|dotm|dotx|doc|dot|xls|xlsm|xlt|xltm)$/u.test(name)) return false;
    if (mime.includes('macroenabled')) return false;
    return name.endsWith('.docx') || mime === DOCX_MIME;
  },
  anonymize(file, ctx) {
    return anonymizeDocx(file, ctx);
  },
  restore(file, vault) {
    return restoreDocx(file, vault);
  },
};
