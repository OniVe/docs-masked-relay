/**
 * HTML adapter.
 *
 * Tolerant, dependency-free scanner: tags, comments, DOCTYPE, processing
 * instructions and CDATA sections are markup; text between them is masked.
 * Attribute values are masked, attribute/element names are structural.
 * Content of `script`, `style`, `textarea` and `title` is raw text until the
 * matching `</tag`, so `<` inside JavaScript/CSS is not misparsed. Comments
 * and CDATA bodies are masked as text and stay restorable because the markup
 * delimiters survive.
 *
 * Detection runs on the raw range text: HTML entities are left as-is and are
 * not decoded before scanning. A name split by an entity (`Иван&nbsp;Петров`)
 * can therefore escape detection; this is a documented limitation, not a
 * reason to rewrite entities (which would change bytes outside replacements).
 *
 * Edits are source-range splices, so every byte outside a replacement stays
 * identical. Encoding/BOM/EOL follow the source and are stored in the vault;
 * the masked output keeps the source encoding, BOM and `<meta charset>`.
 * Malformed input that the scanner cannot delimit fails closed instead of
 * passing text through unmasked.
 */

import { ensureStructuredScanner } from '../detect/wasm-scan';
import {
  anonymizeText,
  createFileRestoreSession,
  orderOccurrencesByPosition,
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
import { createVaultIndex, type VaultIndex } from '../vault';
import {
  decodeTextBytes,
  detectEncoding,
  detectEol,
  encodeTextBytes,
  parseTxtEncoding,
  resolveVaultFile,
  sha256Hex,
} from './txt';

/** A single text/attribute range larger than this is rejected (4 MiB). */
const MAX_RANGE_CHARS = 4 * 1024 * 1024;
/** Hard cap on text/attribute ranges in one document. */
const MAX_RANGES = 1_000_000;

const HTML_MIME = 'text/html';
const XHTML_MIME = 'application/xhtml+xml';

/**
 * Elements whose content is text even when it contains `<` or looks like
 * markup. Case-insensitive per HTML.
 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

interface HtmlRange {
  start: number;
  end: number;
  kind: 'text' | 'attribute';
}

interface HtmlEdit {
  start: number;
  end: number;
  text: string;
}

interface HtmlScan {
  ranges: HtmlRange[];
  /** `src`/`href` values that start with `data:` and were deliberately skipped. */
  dataUriSkips: number;
}

function htmlError(message: string, offset?: number): Error {
  const suffix = offset === undefined ? '' : ` at offset ${offset}`;
  return new Error(`HTML: ${message}${suffix}; the file was rejected (fail-closed)`);
}

/** ASCII letter, the only start of an HTML tag name the scanner accepts. */
function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * `<` starts markup only before a letter, `/`, `!` or `?`. Anything else
 * (`1 < 2`, `<3`) stays text.
 */
function isMarkupStart(text: string, offset: number): boolean {
  const code = text.charCodeAt(offset + 1);
  if (Number.isNaN(code)) return false;
  return code === 0x2f || code === 0x21 || code === 0x3f || isAsciiLetter(code);
}

function nextMarkupStart(text: string, from: number): number {
  let offset = text.indexOf('<', from);
  while (offset >= 0 && !isMarkupStart(text, offset)) {
    offset = text.indexOf('<', offset + 1);
  }
  return offset;
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/**
 * Finds the `>` that closes a tag, respecting quoted attribute values. A `<`
 * outside quotes inside a tag is malformed HTML and fails closed. EOF before
 * `>` (including an unclosed quote) throws.
 */
function findTagEnd(text: string, start: number): number {
  let quote: string | undefined;
  for (let offset = start + 1; offset < text.length; offset += 1) {
    const char = text[offset];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '<') throw htmlError('nested "<" inside a tag', offset);
    if (char === '>') return offset + 1;
  }
  throw htmlError('unclosed tag or quoted attribute value', start);
}

/**
 * Finds the end of a declaration such as `<!DOCTYPE ...>`. Quotes and an
 * internal DTD subset (`[...]`) may contain `>`, so both are tracked.
 */
function findDeclarationEnd(text: string, start: number): number {
  let quote: string | undefined;
  let brackets = 0;
  for (let offset = start + 2; offset < text.length; offset += 1) {
    const char = text[offset];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') {
      brackets += 1;
      continue;
    }
    if (char === ']') {
      if (brackets > 0) brackets -= 1;
      continue;
    }
    if (char === '>' && brackets === 0) return offset + 1;
  }
  throw htmlError('unclosed declaration', start);
}

function readTagName(text: string, start: number): number {
  let offset = start;
  while (offset < text.length) {
    const code = text.charCodeAt(offset);
    if (isWhitespace(code) || code === 0x2f || code === 0x3e) break;
    offset += 1;
  }
  if (offset === start) throw htmlError('tag without a name', start);
  return offset;
}

function isSelfClosingTag(text: string, tagStart: number, tagEnd: number): boolean {
  let offset = tagEnd - 2;
  while (offset > tagStart && isWhitespace(text.charCodeAt(offset))) offset -= 1;
  return text[offset] === '/';
}

interface ParsedStartTag {
  name: string;
  end: number;
  selfClosing: boolean;
}

/**
 * Parses an opening tag enough to locate quoted/unquoted attribute values.
 * Boolean attributes are accepted. Unquoted values end at whitespace or `>`.
 */
function parseStartTag(
  text: string,
  start: number,
  end: number,
  pushRange: (range: HtmlRange) => void,
  countDataUri: (value: string) => boolean,
): ParsedStartTag {
  const nameStart = start + 1;
  const nameEnd = readTagName(text, nameStart);
  const name = text.slice(nameStart, nameEnd);
  let offset = nameEnd;

  while (offset < end - 1) {
    const code = text.charCodeAt(offset);
    if (isWhitespace(code) || code === 0x2f) {
      offset += 1;
      continue;
    }

    const attrStart = offset;
    while (offset < end - 1) {
      const current = text.charCodeAt(offset);
      if (isWhitespace(current) || current === 0x3d || current === 0x3e || current === 0x2f) {
        break;
      }
      offset += 1;
    }
    const attrName = text.slice(attrStart, offset);
    if (attrName.length === 0) throw htmlError('malformed attribute', attrStart);

    while (offset < end - 1 && isWhitespace(text.charCodeAt(offset))) offset += 1;
    if (text[offset] !== '=') continue;

    offset += 1;
    while (offset < end - 1 && isWhitespace(text.charCodeAt(offset))) offset += 1;

    const quote = text[offset];
    let valueStart: number;
    let valueEnd: number;
    if (quote === '"' || quote === "'") {
      valueStart = offset + 1;
      const close = text.indexOf(quote, valueStart);
      if (close < 0 || close >= end - 1) throw htmlError('unclosed quoted attribute', offset);
      valueEnd = close;
      offset = close + 1;
    } else {
      valueStart = offset;
      while (offset < end - 1) {
        const current = text.charCodeAt(offset);
        if (isWhitespace(current) || current === 0x3e) break;
        offset += 1;
      }
      valueEnd = offset;
    }

    if (valueEnd <= valueStart) continue;
    const lowerName = attrName.toLowerCase();
    const value = text.slice(valueStart, valueEnd);
    if ((lowerName === 'src' || lowerName === 'href') && countDataUri(value)) continue;
    if (valueEnd - valueStart > MAX_RANGE_CHARS) {
      throw htmlError('attribute value exceeds the 4 MiB limit', valueStart);
    }
    pushRange({ start: valueStart, end: valueEnd, kind: 'attribute' });
  }

  return { name, end, selfClosing: isSelfClosingTag(text, start, end) };
}

/** First `</tag` delimiter, case-insensitive, at or after `from`. */
function findRawTextClose(text: string, name: string, from: number): number {
  const pattern = new RegExp(`</${name}(?=[\\s/>])`, 'giu');
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  if (!match) throw htmlError(`unclosed <${name}> block`, from);
  return match.index;
}

/**
 * Full tolerant scan. Ranges are emitted in source order: text before each
 * tag, then that tag's attribute values, then raw-text content and so on.
 */
function scanHtml(text: string): HtmlScan {
  const ranges: HtmlRange[] = [];
  let dataUriSkips = 0;

  const pushRange = (range: HtmlRange): void => {
    if (ranges.length >= MAX_RANGES) {
      throw htmlError(`more than ${MAX_RANGES} text/attribute ranges`, range.start);
    }
    ranges.push(range);
  };

  const pushTextRange = (start: number, end: number): void => {
    if (end <= start) return;
    if (end - start > MAX_RANGE_CHARS) {
      throw htmlError('text range exceeds the 4 MiB limit', start);
    }
    // Whitespace-only nodes cannot carry PII; skipping them keeps a large
    // formatted document from calling the masker for every newline.
    if (text.slice(start, end).trim().length === 0) return;
    pushRange({ start, end, kind: 'text' });
  };

  const countDataUri = (value: string): boolean => {
    if (!value.trimStart().toLowerCase().startsWith('data:')) return false;
    dataUriSkips += 1;
    return true;
  };

  let cursor = 0;
  while (cursor < text.length) {
    const tagStart = nextMarkupStart(text, cursor);
    if (tagStart < 0) {
      pushTextRange(cursor, text.length);
      break;
    }
    pushTextRange(cursor, tagStart);

    if (text.startsWith('<!--', tagStart)) {
      const close = text.indexOf('-->', tagStart + 4);
      if (close < 0) throw htmlError('unclosed comment', tagStart);
      pushTextRange(tagStart + 4, close);
      cursor = close + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', tagStart)) {
      const close = text.indexOf(']]>', tagStart + 9);
      if (close < 0) throw htmlError('unclosed CDATA section', tagStart);
      pushTextRange(tagStart + 9, close);
      cursor = close + 3;
      continue;
    }

    if (/^<!doctype/iu.test(text.slice(tagStart, tagStart + 9))) {
      cursor = findDeclarationEnd(text, tagStart);
      continue;
    }

    if (text.startsWith('<?', tagStart)) {
      const close = text.indexOf('?>', tagStart + 2);
      if (close < 0) throw htmlError('unclosed processing instruction', tagStart);
      cursor = close + 2;
      continue;
    }

    if (text.startsWith('<!', tagStart)) {
      // An unknown declaration is structural markup; only its extent matters.
      cursor = findDeclarationEnd(text, tagStart);
      continue;
    }

    const end = findTagEnd(text, tagStart);
    if (text.startsWith('</', tagStart)) {
      // Closing tags carry no user data; their name is structural.
      cursor = end;
      continue;
    }

    const tag = parseStartTag(text, tagStart, end, pushRange, countDataUri);
    cursor = end;
    if (RAW_TEXT_TAGS.has(tag.name.toLowerCase()) && !tag.selfClosing) {
      const close = findRawTextClose(text, tag.name.toLowerCase(), cursor);
      pushTextRange(cursor, close);
      cursor = close;
    }
  }

  return { ranges, dataUriSkips };
}

function assertLinearEditBoundary(text: string, offset: number): void {
  if (offset <= 0 || offset >= text.length) return;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    throw htmlError(`edit boundary at offset ${offset} splits a surrogate pair`);
  }
}

/** Single-pass edit application with overlap/surrogate validation. */
function applyHtmlEditsLinear(text: string, edits: readonly HtmlEdit[]): string {
  if (edits.length === 0) return text;

  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0;
  for (const edit of sorted) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > text.length
    ) {
      throw htmlError(`invalid edit range ${edit.start}..${edit.end}`);
    }
    if (edit.start < previousEnd) {
      throw htmlError(`overlapping edits at offset ${edit.start}`);
    }
    assertLinearEditBoundary(text, edit.start);
    assertLinearEditBoundary(text, edit.end);
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

interface MaskOutcome {
  edits: HtmlEdit[];
  entities: Map<string, MaskedEntity>;
  warnings: string[];
  /** Absolute source offsets of new occurrences, parallel to vault order. */
  occurrencePositions: number[];
}

/** Masks ranges in source order so occurrence order matches restore order. */
function maskRanges(
  text: string,
  ranges: readonly HtmlRange[],
  config: DetectionConfig,
  vault: Vault,
  outcome: MaskOutcome,
  index: VaultIndex,
): void {
  for (const range of ranges) {
    const source = text.slice(range.start, range.end);
    if (source.length === 0) continue;
    const masked = anonymizeText(source, config, vault, { inPlace: true, index });
    if (masked.warnings.length > 0) outcome.warnings.push(...masked.warnings);
    for (const entity of masked.entities) outcome.entities.set(entity.key, entity);
    for (const replacement of masked.replacements) {
      outcome.occurrencePositions.push(range.start + replacement.start);
    }
    if (masked.maskedText === source) continue;
    outcome.edits.push({ start: range.start, end: range.end, text: masked.maskedText });
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

function htmlMode(file: Pick<FileInput, 'name' | 'mimeType'>): boolean {
  const mime = file.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return /\.(?:html|htm)$/iu.test(file.name) || mime === HTML_MIME || mime === XHTML_MIME;
}

export async function anonymizeHtml(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();
  if (!htmlMode(file)) throw new Error('HTML: unsupported file');
  const sourceMime = file.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';

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

  const scan = scanHtml(text);

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
    // One index for the whole document; every range reuses it incrementally.
    const vaultIndex = createVaultIndex(ctx.vault);
    maskRanges(text, scan.ranges, ctx.config ?? {}, ctx.vault, outcome, vaultIndex);
    maskedText = applyHtmlEditsLinear(text, outcome.edits);
    // Keep the source encoding/BOM: `<meta charset>` stays honest without a
    // rewrite, and the masked document remains a valid HTML file for any
    // legacy charset.
    maskedBytes = encodeTextBytes(maskedText, detected.encoding, detected.bom);
  } catch (error) {
    commitVault(ctx.vault, snapshot);
    throw error;
  }

  const vault = ctx.vault;
  // Ranges are processed in source order, so this is already correct; the
  // explicit reorder keeps the same restore-order contract as XML/JSON.
  orderOccurrencesByPosition(vault, occurrenceStart, outcome.occurrencePositions);
  const occurrenceCount = vault.occurrences.length - occurrenceStart;

  vault.files.push({
    originalName: file.name,
    // Filename masking is part of the upload hook; the adapter keeps the name.
    maskedName: file.name,
    format: 'html',
    size: file.bytes.byteLength,
    sha256,
    maskedSha256: await sha256Hex(maskedBytes),
    encoding: detected.encoding,
    bom: detected.bom,
    eol,
    occurrenceStart,
    occurrenceCount,
  });

  if (scan.dataUriSkips > 0) {
    warnings.push(
      `HTML: ${scan.dataUriSkips} data: URI attribute value(s) skipped (binary payload, not scanned)`,
    );
  }

  return {
    maskedBytes,
    maskedName: file.name,
    maskedMime: sourceMime === XHTML_MIME ? XHTML_MIME : HTML_MIME,
    format: 'html',
    entities: [...outcome.entities.values()],
    occurrences: vault.occurrences.slice(occurrenceStart),
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings: [...warnings, ...outcome.warnings],
  };
}

export async function restoreHtml(file: FileInput, vault: Vault): Promise<RestoreResult> {
  if (!htmlMode(file)) throw new Error('HTML: unsupported file');

  // Masked bytes identify the record first; a shared name is ambiguous
  // unless the hash picks one file (R16-RESTORE-IDENTITY).
  const record = await resolveVaultFile(vault, file);
  const detected = detectEncoding(file.bytes);
  const encoding = parseTxtEncoding(record?.encoding) ?? detected.encoding;
  const bom = record?.bom ?? detected.bom;

  let maskedText: string;
  try {
    maskedText = decodeTextBytes(file.bytes, encoding, bom);
  } catch {
    throw new Error(`Masked HTML file is not valid ${encoding}`);
  }

  // One cursor for the whole document, scoped to this file's occurrences when
  // the record carries a range; a legacy record in a multi-file vault is
  // marked ambiguous and restore fails closed on the first known tag.
  const session = createFileRestoreSession(vault, record);
  const restored = restoreText(maskedText, vault, { session });

  // Keep the source encoding/BOM exactly, as the masked upload did.
  const bytes = encodeTextBytes(restored.text, encoding, bom);
  // Hash matching also finds a record when the download name was changed;
  // in that case keep the caller's name so its tags are restored as before.
  const fileName =
    record && (record.maskedName === file.name || record.originalName === file.name)
      ? record.originalName
      : file.name;

  const warnings: string[] = [];
  if (restored.unknownTags.length > 0) {
    warnings.push(`${restored.unknownTags.length} unknown tag(s) left untouched`);
  }

  return {
    bytes,
    fileName,
    replacements: restored.replacements,
    unknownTags: restored.unknownTags,
    warnings,
  };
}

export const htmlFormatAdapter: FormatAdapter = {
  format: 'html',
  extensions: ['.html', '.htm'],
  mimeTypes: [HTML_MIME, XHTML_MIME],
  canHandle(file) {
    return htmlMode(file);
  },
  anonymize(file, ctx) {
    return anonymizeHtml(file, ctx);
  },
  restore(file, vault) {
    return restoreHtml(file, vault);
  },
};
