/**
 * PDF format adapter (M5a) — true redaction through EmbedPDF/PDFium.
 *
 * The adapter runs only where a DOM/Worker is available: the Chrome offscreen
 * document or the Safari background page. The background service worker never
 * imports this module, so ordinary uploads do not pull the WASM bundle.
 *
 * Algorithm:
 *   1. pdf-lib preflight: valid PDF, not encrypted, <= 200 pages.
 *   2. PDFium `page.text.get()` per page; a page without a text layer is a scan
 *      and fails closed (no OCR).
 *   3. Detectors run on the text-space snapshot; each span is mapped to
 *      PDFium character space with `charRangeForTextOffsets` and verified with
 *      `page.text.slice()` — never by naively reusing string offsets.
 *   4. Quads come from `doc.search.query()` when its match is the exact mapped
 *      range, otherwise from `layout.segments()` for the mapped range.
 *      Any span that cannot be localized aborts the whole file.
 *   5. `doc.redaction.apply()` + `doc.download({mode:'rewrite'})`.
 *   6. pdf-lib removes Info/XMP/attachments/JavaScript/forms/outlines and
 *      annotation text; the output is reopened and every page is LeakGuard
 *      checked before bytes are returned.
 *
 * PDF redaction cannot be undone: `restorePdf` always throws.
 */

import {
  type AnnotationRef,
  charRangeForTextOffsets,
  type LocalDocumentHandle,
  type LocalPageHandle,
  localEngine,
  type PageRef,
  type PageTextSnapshot,
  type PdfQuad,
  type PdfTextSegment,
  pageRefsEqual,
  type SearchMatch,
  type TextLayout,
} from '@embedpdf/engine';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib';
import { detectAll } from '../detect';
import { resolveOverlaps, type Span } from '../detect/span';
import { ensureStructuredScanner } from '../detect/wasm-scan';
import { assertClean } from '../masker';
import type {
  AnonymizeContext,
  AnonymizeResult,
  DetectionConfig,
  FileInput,
  FormatAdapter,
  RestoreResult,
  Vault,
} from '../types';
import { isPdfFile, MAX_PDF_PAGES } from './pdf-detect';
import { PDF_IRREVERSIBLE_MESSAGE, PdfRedactionError } from './pdf-errors';
import { sha256Hex } from './txt';

let sharedEngine: ReturnType<typeof localEngine> | undefined;

/**
 * One engine per offscreen/background-page lifetime: a second PDF skips the
 * cold WASM boot. `defaultFallbackFonts:false` drops ~425 KB; redaction paints
 * black boxes, so no fallback font is needed (preflight §CSP).
 */
function pdfEngine(): ReturnType<typeof localEngine> {
  sharedEngine ??= localEngine({ defaultFallbackFonts: false });
  return sharedEngine;
}

/** Test/offscreen teardown: destroys the worker and forgets the cached engine. */
export async function destroyPdfEngine(): Promise<void> {
  const engine = sharedEngine;
  sharedEngine = undefined;
  if (!engine) return;
  try {
    await engine.destroy();
  } catch {
    // The worker may already be gone; the engine must not keep a stale handle.
  }
}

function sizeError(): PdfRedactionError {
  return new PdfRedactionError('PDF_SIZE', 'PDF: file exceeds the 25 MB limit');
}

function scannedError(pageNumber: number): PdfRedactionError {
  return new PdfRedactionError(
    'PDF_SCANNED',
    `PDF: scanned page ${pageNumber} has no text layer; OCR not supported`,
  );
}

function locateError(): PdfRedactionError {
  return new PdfRedactionError(
    'PDF_LOCATE',
    'PDF: a detected value could not be located precisely; the file was not sent',
  );
}

function applyError(): PdfRedactionError {
  return new PdfRedactionError(
    'PDF_APPLY',
    'PDF: redaction could not be applied; the file was not sent',
  );
}

function residualError(): PdfRedactionError {
  return new PdfRedactionError(
    'PDF_RESIDUAL',
    'PDF: text remained after redaction; the file was not sent',
  );
}

function metadataError(): PdfRedactionError {
  return new PdfRedactionError(
    'PDF_METADATA',
    'PDF: metadata could not be sanitized; the file was not sent',
  );
}

function runtimeError(): PdfRedactionError {
  return new PdfRedactionError(
    'PDF_RUNTIME',
    'PDF: engine runtime is unavailable in this browser context; use manual mode',
  );
}

function invalidError(): PdfRedactionError {
  return new PdfRedactionError('PDF_INVALID', 'PDF: file is not a valid PDF');
}

/**
 * pdf-lib does the cheap, engine-free checks first: structure, encryption and
 * page count. This also lets Node unit tests enforce the limits without a
 * browser or a WASM boot.
 */
async function inspectPdf(bytes: Uint8Array): Promise<void> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
  } catch {
    throw invalidError();
  }

  if (document.isEncrypted) {
    throw new PdfRedactionError(
      'PDF_ENCRYPTED',
      'PDF: encrypted PDFs are not supported; remove the password and try again',
    );
  }

  let pageCount: number;
  try {
    pageCount = document.getPageCount();
  } catch {
    // pdf-lib defers some structural failures until the page tree is walked.
    throw invalidError();
  }
  if (pageCount === 0) throw invalidError();
  if (pageCount > MAX_PDF_PAGES) {
    throw new PdfRedactionError(
      'PDF_PAGES',
      `PDF: page limit exceeded (${pageCount} pages, maximum ${MAX_PDF_PAGES})`,
    );
  }
}

/** Whitespace-tolerant comparison used only to verify a mapped slice. */
function normalizeForCompare(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * UTF-16BE/LE bytes for one string, optionally with a BOM. PDF text strings
 * use UTF-16BE with a BOM, but writers also leave bare UTF-16 in streams.
 */
function utf16Bytes(value: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const bytes = new Uint8Array(value.length * 2 + (bom ? 2 : 0));
  let offset = 0;
  if (bom) {
    bytes[0] = littleEndian ? 0xff : 0xfe;
    bytes[1] = littleEndian ? 0xfe : 0xff;
    offset = 2;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (littleEndian) {
      bytes[offset] = code & 0xff;
      bytes[offset + 1] = code >> 8;
    } else {
      bytes[offset] = code >> 8;
      bytes[offset + 1] = code & 0xff;
    }
    offset += 2;
  }
  return bytes;
}

/** Exact 1:1 byte→char string, so indexOf works on binary PDF streams. */
function bytesToBinaryString(bytes: Uint8Array): string {
  let result = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return result;
}

/**
 * The raw scan is O(surfaces × PDF bytes). At 4000 unique surfaces on a 25 MB
 * file the scan alone took ~42 s and pushed the whole run past the 45 s
 * offscreen budget (R7). Keep the scan bounded and report truncation as a
 * warning; structural carrier removal and LeakGuard are independent checks, so
 * a truncated byte scan does not turn into a silent fail-open.
 */
export const MAX_RAW_SCAN_SURFACES = 1000;

/** Deterministic, testable projection of a surface list onto the scan budget. */
export function selectRawScanSurfaces(surfaces: readonly string[]): {
  scanned: string[];
  skipped: number;
} {
  const unique = [...new Set(surfaces.filter((surface) => surface.trim().length >= 3))];
  const scanned = unique.slice(0, MAX_RAW_SCAN_SURFACES);
  return { scanned, skipped: unique.length - scanned.length };
}

/**
 * Raw-byte scan of the final PDF for the PII strings detected in the original
 * text layer. Checks UTF-8 and UTF-16BE/LE (with and without BOM), because
 * metadata, annotations and appearance streams can carry any of these even
 * when the text layer is clean. Short surfaces are skipped: a one/two-byte
 * sequence is not evidence in binary data. Exported for engine-free tests.
 */
export function hasRawPiiSurface(bytes: Uint8Array, surfaces: readonly string[]): boolean {
  const { scanned } = selectRawScanSurfaces(surfaces);
  if (scanned.length === 0) return false;

  const haystack = bytesToBinaryString(bytes);
  const encoder = new TextEncoder();
  for (const surface of scanned) {
    for (const variant of [
      encoder.encode(surface),
      utf16Bytes(surface, false, false),
      utf16Bytes(surface, true, false),
      utf16Bytes(surface, false, true),
      utf16Bytes(surface, true, true),
    ]) {
      if (variant.length > haystack.length) continue;
      if (haystack.includes(bytesToBinaryString(variant))) return true;
    }
  }
  return false;
}

const FORBIDDEN_PAGE_KEYS = ['Metadata', 'PieceInfo', 'AF', 'Annots', 'AA'] as const;
const FORBIDDEN_CATALOG_KEYS = [
  'Metadata',
  'Names',
  'AF',
  'AcroForm',
  'PieceInfo',
  'StructTreeRoot',
] as const;
/**
 * Carrier keys that can hide on any reachable dictionary, not only on the
 * catalog/page nodes: image and Form XObjects, fonts, patterns and annotation
 * dictionaries all accept their own `/Metadata` (XMP), `/PieceInfo`, `/AF` and
 * `/AA` (R4). They are removed everywhere reachable, then pruned.
 */
const NESTED_FORBIDDEN_KEYS = ['Metadata', 'PieceInfo', 'AF', 'AA'] as const;

/**
 * Visits every dictionary reachable from the trailer's Root (and Info) once:
 * through references, arrays and stream dictionaries. Shared by the recursive
 * scrub and the final structural check so both use the same reachability rules.
 */
function visitReachableDicts(document: PDFDocument, visitor: (dict: PDFDict) => void): void {
  const context = document.context;
  const seenRefs = new Set<string>();
  const seenDicts = new Set<PDFDict>();

  function visitDict(dict: PDFDict): void {
    if (seenDicts.has(dict)) return;
    seenDicts.add(dict);
    visitor(dict);
    for (const key of dict.keys()) visitValue(dict.get(key));
  }

  function visitValue(value: unknown): void {
    if (value === undefined || value === null) return;
    if (value instanceof PDFRef) {
      const key = refKey(value);
      if (seenRefs.has(key)) return;
      seenRefs.add(key);
      visitValue(context.lookup(value));
      return;
    }
    if (value instanceof PDFStream) {
      visitDict(value.dict);
      return;
    }
    if (value instanceof PDFDict) {
      visitDict(value);
      return;
    }
    if (value instanceof PDFArray) {
      for (let index = 0; index < value.size(); index += 1) visitValue(value.get(index));
    }
    // Other PDFObject types are scalars and cannot carry references.
  }

  visitValue(context.trailerInfo.Root);
  visitValue(context.trailerInfo.Info);
}

/**
 * Fails closed if the sanitized document still exposes a known carrier key on
 * any reachable dictionary. Called on the final bytes, after pruning, so a
 * missed nested entry cannot ship unnoticed. Exported for engine-free tests.
 */
export async function assertNoPdfCarriers(bytes: Uint8Array): Promise<void> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw metadataError();
  }

  const catalog = document.catalog;
  for (const key of FORBIDDEN_CATALOG_KEYS) {
    if (catalog.has(PDFName.of(key))) throw metadataError();
  }
  for (const page of document.getPages()) {
    for (const key of FORBIDDEN_PAGE_KEYS) {
      if (page.node.has(PDFName.of(key))) throw metadataError();
    }
  }
  visitReachableDicts(document, (dict) => {
    for (const key of NESTED_FORBIDDEN_KEYS) {
      if (dict.has(PDFName.of(key))) throw metadataError();
    }
  });
}

const FORM_PII_KEYS = ['V', 'DV', 'AP', 'AA', 'A', 'Parent', 'T', 'TU', 'TM', 'RV'] as const;

/**
 * Walks the AcroForm field tree and clears value/action/appearance/name keys
 * before the catalog entry is deleted. The fields are usually pruned later;
 * this also covers a field dictionary that is reachable from somewhere else.
 */
function scrubFormFields(document: PDFDocument, acroForm: PDFDict): number {
  const context = document.context;
  const seen = new Set<PDFDict>();
  let scrubbed = 0;

  const asDict = (value: unknown): PDFDict | undefined => {
    if (value instanceof PDFRef) return context.lookupMaybe(value, PDFDict) ?? undefined;
    if (value instanceof PDFDict) return value;
    return undefined;
  };

  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) return;
    const field = asDict(value);
    if (!field || seen.has(field)) return;
    seen.add(field);

    const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (let index = 0; index < kids.size(); index += 1) visit(kids.get(index), depth + 1);
    }
    for (const key of [...field.keys()]) {
      const name = key.asString();
      if (!(FORM_PII_KEYS as readonly string[]).includes(name.slice(1))) continue;
      field.delete(key);
      scrubbed += 1;
    }
  };

  const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (fields) {
    for (let index = 0; index < fields.size(); index += 1) visit(fields.get(index), 0);
  }
  return scrubbed;
}

/**
 * Removes carrier keys from every reachable dictionary, not only the catalog
 * and page nodes. A PDFium rewrite can leave `/Metadata` on an image or Form
 * XObject, and fonts/patterns/annotations may carry their own private data.
 * The traversal marks references, so cyclic object graphs terminate.
 */
function scrubNestedCarriers(document: PDFDocument): number {
  let removed = 0;
  visitReachableDicts(document, (dict) => {
    for (const key of NESTED_FORBIDDEN_KEYS) {
      const name = PDFName.of(key);
      if (!dict.has(name)) continue;
      dict.delete(name);
      removed += 1;
    }
  });
  return removed;
}

function quadKey(quad: PdfQuad): string {
  const point = (value: { x: number; y: number }): string => `${value.x}:${value.y}`;
  return [
    point(quad.upperLeft),
    point(quad.upperRight),
    point(quad.lowerLeft),
    point(quad.lowerRight),
  ].join('|');
}

/**
 * Searches the whole document for one literal. The engine returns a cursor for
 * large documents; the cap keeps a pathological file from stalling the tab.
 */
async function searchText(
  doc: LocalDocumentHandle,
  text: string,
  cache: Map<string, Promise<SearchMatch[]>>,
): Promise<SearchMatch[]> {
  const cached = cache.get(text);
  if (cached) return cached;

  const task = (async (): Promise<SearchMatch[]> => {
    const matches: SearchMatch[] = [];
    let cursor: string | undefined;
    for (let batch = 0; batch < 20; batch += 1) {
      const result = await doc.search.query({
        text,
        wholeWord: true,
        ...(cursor ? { cursor } : {}),
      });
      matches.push(...result.matches);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      if (matches.length >= 5000) break;
    }
    return matches;
  })();

  cache.set(text, task);
  return task;
}

/**
 * Converts one detected span into PDFium quads. The mapped character range is
 * authoritative; `search.query()` is preferred when it returns exactly that
 * range, and `layout.segments()` is the fallback after verifying the slice.
 */
async function locateSpan(
  doc: LocalDocumentHandle,
  page: LocalPageHandle,
  pageRef: PageRef,
  snapshot: PageTextSnapshot,
  layout: TextLayout,
  span: Span,
  pageNumber: number,
  searchCache: Map<string, Promise<SearchMatch[]>>,
): Promise<PdfTextSegment[]> {
  const count = span.end - span.start;
  if (count <= 0) throw locateError();

  const mapped = charRangeForTextOffsets(snapshot, { start: span.start, count });
  if (!Number.isFinite(mapped.start) || !Number.isFinite(mapped.count) || mapped.count <= 0) {
    throw locateError();
  }
  if (mapped.start < 0 || mapped.start + mapped.count > layout.charCount) {
    throw locateError();
  }

  const matches = await searchText(doc, span.text, searchCache);
  const exact = matches.find(
    (match) =>
      pageRefsEqual(match.page, pageRef) &&
      match.start === mapped.start &&
      match.count === mapped.count &&
      match.segments.length > 0,
  );
  if (exact) return exact.segments;

  // Search folding may differ from the detector's text (punctuation, case or
  // whitespace); the character range is still exact. Verify it by reading the
  // text back, then take geometry from the layout.
  let slice: string;
  try {
    slice = await page.text.slice(mapped);
  } catch {
    throw locateError();
  }
  if (normalizeForCompare(slice) !== normalizeForCompare(span.text)) {
    // Never guess: a wrong quad would redact innocent content and might leave
    // the PII in place.
    throw new PdfRedactionError(
      'PDF_LOCATE',
      `PDF: a detected value could not be located on page ${pageNumber}; the file was not sent`,
    );
  }

  const segments = layout.segments(mapped);
  if (segments.length === 0) throw locateError();
  return segments;
}

async function collectPageRedactions(
  doc: LocalDocumentHandle,
  config: DetectionConfig,
  signal?: AbortSignal,
): Promise<{
  annotationRefs: AnnotationRef[];
  redactedRegions: number;
  redactedPages: number;
  piiSurfaces: string[];
}> {
  const { pages } = await doc.pages.list();
  const searchCache = new Map<string, Promise<SearchMatch[]>>();
  const annotationRefs: AnnotationRef[] = [];
  const piiSurfaces = new Set<string>();
  let redactedRegions = 0;
  let redactedPages = 0;

  for (let index = 0; index < pages.length; index += 1) {
    signal?.throwIfAborted();
    const pageInfo = pages[index];
    if (!pageInfo) continue;

    const page = doc.page(pageInfo.ref);
    const snapshot = await page.text.get();
    const pageNumber = index + 1;

    // A page with no character cells is an image-only scan. The whole file is
    // refused: sending an unredacted scanned page would leak it wholesale.
    if (snapshot.charCount === 0) throw scannedError(pageNumber);
    if (snapshot.text.trim().length === 0) continue;

    const spans = resolveOverlaps(detectAll(snapshot.text, config));
    if (spans.length === 0) continue;

    const layout = await page.text.layout();
    const quads: PdfQuad[] = [];
    const seen = new Set<string>();

    for (const span of spans) {
      piiSurfaces.add(span.text);
      const segments = await locateSpan(
        doc,
        page,
        pageInfo.ref,
        snapshot,
        layout,
        span,
        pageNumber,
        searchCache,
      );
      for (const segment of segments) {
        const key = quadKey(segment.quad);
        if (seen.has(key)) continue;
        seen.add(key);
        quads.push(segment.quad);
      }
      redactedRegions += 1;
    }

    if (quads.length === 0) throw locateError();

    let created: Awaited<ReturnType<LocalPageHandle['annotations']['create']>>;
    try {
      created = await page.annotations.create({
        subtype: 'redact',
        quadPoints: quads,
        interiorColor: '#000000',
      });
    } catch {
      throw applyError();
    }
    annotationRefs.push(created.annotation.ref);
    redactedPages += 1;
  }

  return { annotationRefs, redactedRegions, redactedPages, piiSurfaces: [...piiSurfaces] };
}

async function applyRedactions(
  doc: LocalDocumentHandle,
  annotationRefs: readonly AnnotationRef[],
): Promise<void> {
  if (annotationRefs.length === 0) return;
  try {
    const result = await doc.redaction.apply({ annotations: [...annotationRefs] });
    if (result.results.some((item) => item.status !== 'applied')) throw applyError();
  } catch (error) {
    if (error instanceof PdfRedactionError) throw error;
    throw applyError();
  }
}

function refKey(ref: PDFRef): string {
  return `${ref.objectNumber}:${ref.generationNumber}`;
}

/**
 * pdf-lib serializes every object in its context, including objects that lost
 * their last reference after a catalog key was deleted. XMP streams, name-tree
 * attachments and file specs would otherwise remain byte-for-byte in the
 * output. Mark from the trailer and delete everything unreachable.
 */
function pruneUnreachableObjects(document: PDFDocument): number {
  const context = document.context;
  const marked = new Set<string>();

  const visit = (value: unknown): void => {
    if (value === undefined || value === null) return;
    if (value instanceof PDFRef) {
      const key = refKey(value);
      if (marked.has(key)) return;
      marked.add(key);
      visit(context.lookup(value));
      return;
    }
    if (value instanceof PDFDict) {
      for (const key of value.keys()) visit(value.get(key));
      return;
    }
    if (value instanceof PDFArray) {
      for (let index = 0; index < value.size(); index += 1) visit(value.get(index));
      return;
    }
    if (value instanceof PDFStream) {
      visit(value.dict);
    }
    // Other PDFObject types are scalars and cannot carry references.
  };

  const trailer = context.trailerInfo;
  visit(trailer.Root);
  visit(trailer.Info);
  visit(trailer.Encrypt);
  visit(trailer.ID);

  const refs = context.enumerateIndirectObjects().map(([ref]) => ref);
  let removed = 0;
  for (const ref of refs) {
    if (marked.has(refKey(ref))) continue;
    if (context.delete(ref)) removed += 1;
  }
  return removed;
}

/**
 * Removes identifying metadata and secondary text carriers that PDF redaction
 * does not touch, then drops every object left unreachable. Everything here is
 * one-way; values are never logged. Exported for engine-free tests.
 *
 * Page-level entries matter: a PDFium rewrite keeps `/Metadata`, `/PieceInfo`
 * and `/AF` on the page node even when the catalog is clean, and widgets /
 * FreeText carry `/V` and `/AP` outside the text layer. Every annotation is
 * removed (redaction annotations are already applied at this point), and form
 * dictionaries are scrubbed before `/AcroForm` and the page `/Annots` arrays
 * are dropped. Nested carriers on image/Form XObjects, fonts, patterns and
 * annotation dictionaries are then scrubbed recursively (R4).
 */
export async function sanitizePdfOutput(
  bytes: Uint8Array,
  warnings: string[] = [],
  options: { useObjectStreams?: boolean } = {},
): Promise<Uint8Array> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw metadataError();
  }

  try {
    const info = document.context.lookupMaybe(document.context.trailerInfo.Info, PDFDict);
    let infoKeys = 0;
    if (info) {
      for (const key of [...info.keys()]) {
        info.delete(key);
        infoKeys += 1;
      }
    }
    if (infoKeys > 0) warnings.push('PDF document metadata cleared');

    const catalog = document.catalog;
    if (catalog.has(PDFName.of('Metadata'))) {
      catalog.delete(PDFName.of('Metadata'));
      warnings.push('PDF XMP metadata removed');
    }

    const names = catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    let hadAttachments = false;
    let hadJavaScript = false;
    if (names) {
      hadAttachments = names.has(PDFName.of('EmbeddedFiles'));
      hadJavaScript = names.has(PDFName.of('JavaScript'));
      catalog.delete(PDFName.of('Names'));
      warnings.push('PDF name tree (attachments, JavaScript, destinations) removed');
    }
    if (hadAttachments) warnings.push('Embedded PDF attachments removed');
    if (hadJavaScript) warnings.push('PDF JavaScript actions removed');

    if (catalog.has(PDFName.of('AF'))) catalog.delete(PDFName.of('AF'));

    let documentActions = 0;
    for (const key of [
      'OpenAction',
      'AA',
      'Outlines',
      'PieceInfo',
      'Collection',
      'SpiderInfo',
    ] as const) {
      if (catalog.has(PDFName.of(key))) {
        catalog.delete(PDFName.of(key));
        documentActions += 1;
      }
    }
    if (documentActions > 0) {
      warnings.push('PDF document actions/outline/private data removed');
    }

    if (catalog.has(PDFName.of('AcroForm'))) {
      const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
      if (acroForm) scrubFormFields(document, acroForm);
      catalog.delete(PDFName.of('AcroForm'));
      warnings.push('Interactive PDF form fields removed');
    }

    // Tagged-PDF structure and alternate text can carry document content that
    // is not in the page text layer; drop it rather than ship it unexamined.
    if (catalog.has(PDFName.of('StructTreeRoot'))) {
      catalog.delete(PDFName.of('StructTreeRoot'));
      catalog.delete(PDFName.of('MarkInfo'));
      warnings.push('PDF structure tree/alt text removed');
    }

    let pageCarriers = 0;
    let pageActions = 0;
    let annotationSets = 0;
    let removedAnnotations = 0;
    for (const page of document.getPages()) {
      for (const key of ['Metadata', 'PieceInfo', 'AF'] as const) {
        if (!page.node.has(PDFName.of(key))) continue;
        page.node.delete(PDFName.of(key));
        pageCarriers += 1;
      }
      if (page.node.has(PDFName.of('AA'))) {
        page.node.delete(PDFName.of('AA'));
        pageActions += 1;
      }

      if (page.node.has(PDFName.of('Annots'))) {
        const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        annotationSets += 1;
        removedAnnotations += annotations?.size() ?? 0;
        // Widgets carry /V, /DV and /AP; FreeText carries /AP; Link/Text carry
        // URLs and author fields. None of them is needed for a redacted file,
        // and any of them can hold the original PII.
        page.node.delete(PDFName.of('Annots'));
      }
    }
    if (pageCarriers > 0) warnings.push('PDF page metadata/private data removed');
    if (pageActions > 0) warnings.push('PDF page actions removed');
    if (annotationSets > 0) {
      warnings.push(
        removedAnnotations > 0
          ? `${removedAnnotations} PDF annotation(s) removed (forms, comments, links)`
          : 'PDF empty annotation list removed',
      );
    }

    const nestedCarriers = scrubNestedCarriers(document);
    if (nestedCarriers > 0) {
      warnings.push('PDF embedded object metadata/private data removed');
    }

    pruneUnreachableObjects(document);
    return await document.save({ useObjectStreams: options.useObjectStreams ?? true });
  } catch (error) {
    if (error instanceof PdfRedactionError) throw error;
    throw metadataError();
  }
}

/**
 * Reopens the final bytes and runs three independent checks: the raw byte scan
 * for every original PII surface (metadata/annotations/appearance streams),
 * a structural check that no carrier key survived pruning, and LeakGuard on
 * every page's text layer. Any hit blocks the file.
 */
async function assertNoResidualPii(
  engine: ReturnType<typeof localEngine>,
  bytes: Uint8Array,
  config: DetectionConfig,
  surfaces: readonly string[],
  warnings: string[],
): Promise<void> {
  const scan = selectRawScanSurfaces(surfaces);
  if (scan.skipped > 0) {
    // R7: a 25 MB / 4k-surface file made the raw scan alone exceed the 45 s
    // offscreen budget. The bound is explicit and surfaced to the user; the
    // structural check and LeakGuard below still run on every byte/page.
    warnings.push(
      `PDF residual scan covered ${scan.scanned.length} of ${
        scan.scanned.length + scan.skipped
      } unique PII surface(s) (bounded)`,
    );
  }
  if (hasRawPiiSurface(bytes, surfaces)) throw residualError();
  await assertNoPdfCarriers(bytes);

  let document: LocalDocumentHandle;
  try {
    document = await engine.open({ kind: 'bytes', bytes });
  } catch {
    throw new PdfRedactionError(
      'PDF_APPLY',
      'PDF: the redacted file could not be reopened; the file was not sent',
    );
  }

  try {
    const { pages } = await document.pages.list();
    for (const pageInfo of pages) {
      const snapshot = await document.page(pageInfo.ref).text.get();
      if (snapshot.text.trim().length === 0) continue;
      try {
        // PDF is one-way: blockOnLeak:false must not be able to ship residue.
        assertClean(snapshot.text, { ...config, blockOnLeak: true });
      } catch {
        throw residualError();
      }
    }
  } finally {
    await document.close().catch(() => {});
  }
}

async function runAnonymizePdf(file: FileInput, ctx: AnonymizeContext): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) throw sizeError();

  await inspectPdf(file.bytes);
  const sha256 = await sha256Hex(file.bytes);
  const config = ctx.config ?? {};
  const warnings: string[] = [];
  const engine = pdfEngine();

  let document: LocalDocumentHandle | undefined;
  let downloaded: Uint8Array;
  let redactedRegions = 0;
  let redactedPages = 0;
  let piiSurfaces: string[] = [];
  try {
    try {
      document = await engine.open({ kind: 'bytes', bytes: file.bytes });
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === 'RuntimeUnavailable') throw runtimeError();
      if (code === 'PasswordRequired' || code === 'Encrypted') {
        throw new PdfRedactionError(
          'PDF_ENCRYPTED',
          'PDF: encrypted PDFs are not supported; remove the password and try again',
        );
      }
      throw invalidError();
    }

    const { pages } = await document.pages.list();
    if (pages.length === 0) throw invalidError();
    if (pages.length > MAX_PDF_PAGES) {
      throw new PdfRedactionError(
        'PDF_PAGES',
        `PDF: page limit exceeded (${pages.length} pages, maximum ${MAX_PDF_PAGES})`,
      );
    }

    const collected = await collectPageRedactions(document, config, ctx.signal);
    redactedRegions = collected.redactedRegions;
    redactedPages = collected.redactedPages;
    piiSurfaces = collected.piiSurfaces;
    await applyRedactions(document, collected.annotationRefs);

    downloaded = await document.download({ mode: 'rewrite' });
    await document.close();
    document = undefined;
  } finally {
    if (document) await document.close().catch(() => {});
  }

  if (!(downloaded instanceof Uint8Array) || downloaded.byteLength === 0) {
    throw new PdfRedactionError('PDF_APPLY', 'PDF: the redacted file could not be saved');
  }

  const sanitized = await sanitizePdfOutput(downloaded, warnings);
  await assertNoResidualPii(engine, sanitized, config, piiSurfaces, warnings);

  if (redactedRegions > 0) {
    warnings.unshift(
      `${redactedRegions} PII region(s) permanently redacted on ${redactedPages} page(s)`,
    );
  } else {
    warnings.unshift('No PII detected; PDF was rewritten with cleared metadata');
  }

  const vault = ctx.vault;
  vault.files.push({
    originalName: file.name,
    // The upload hook masks the name after the adapter returns.
    maskedName: file.name,
    format: 'pdf',
    size: file.bytes.byteLength,
    sha256,
  });

  return {
    maskedBytes: sanitized,
    maskedName: file.name,
    format: 'pdf',
    entities: [],
    occurrences: [],
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings,
  };
}

export async function anonymizePdf(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  await ensureStructuredScanner();
  try {
    return await runAnonymizePdf(file, ctx);
  } catch (error) {
    if (error instanceof PdfRedactionError) throw error;
    // Engine errors may contain internal paths or document hints; never pass
    // them through to the router or logs.
    throw runtimeError();
  }
}

/** PDF redaction is one-way (spec §7.3). Kept for the `FormatAdapter` shape. */
export async function restorePdf(_file: FileInput, _vault: Vault): Promise<RestoreResult> {
  throw new PdfRedactionError('PDF_IRREVERSIBLE', PDF_IRREVERSIBLE_MESSAGE);
}

export const pdfFormatAdapter: FormatAdapter = {
  format: 'pdf',
  extensions: ['.pdf'],
  mimeTypes: ['application/pdf'],
  canHandle(file): boolean {
    return isPdfFile(file.name, file.mimeType);
  },
  anonymize(file, ctx) {
    return anonymizePdf(file, ctx);
  },
  restore(file, vault) {
    return restorePdf(file, vault);
  },
};
