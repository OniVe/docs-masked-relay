/**
 * Markdown adapter (M1b2). The document is parsed with mdast so replacements
 * hit source ranges only: text nodes, inline/block code, HTML, YAML
 * frontmatter values, link/image destinations and image alt text.
 *
 * Edits are applied to the original decoded string right-to-left, never via a
 * Markdown serializer. That keeps markers, escaping, table pipes, list
 * indentation and line endings byte-identical outside the masked values.
 *
 * Known limits:
 * - A PII value split across inline formatting (`Иван **Петров**`) is two
 *   mdast text nodes and is not stitched back together.
 * - Inline HTML is masked as plain text; nested markup is not parsed, hence
 *   the warning returned from `anonymizeMd`.
 * - Unquoted YAML values are replaced with a bare tag, which keeps the text
 *   round-trippable but may make the frontmatter invalid YAML. Keys and
 *   delimiters are preserved.
 */

import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { frontmatter } from 'micromark-extension-frontmatter';
import { visit } from 'unist-util-visit';
import { ensureStructuredScanner } from '../detect/wasm-scan';
import { anonymizeText, createFileRestoreSession, restoreText } from '../masker';
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
import {
  applyEol,
  decodeTextBytes,
  detectEncoding,
  detectEol,
  encodeTextBytes,
  parseTxtEncoding,
  resolveVaultFile,
  sha256Hex,
} from './txt';

type RangeKind = 'text' | 'inlineCode' | 'code' | 'html' | 'frontmatter' | 'destination';

interface SourceRange {
  start: number;
  end: number;
  kind: RangeKind;
  /** Link label or image alt: a lone first name is acceptable evidence here. */
  nameContext?: boolean;
}

interface OffsetRange {
  start: number;
  end: number;
}

function nodeRange(node: Nodes): OffsetRange | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    return undefined;
  }
  return { start, end };
}

function pushRange(
  out: SourceRange[],
  range: OffsetRange | undefined,
  kind: RangeKind,
  nameContext = false,
): void {
  if (!range || range.end <= range.start) return;
  out.push({ start: range.start, end: range.end, kind, nameContext });
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/** Backtick/tilde run length at the start of an inline-code node. */
function inlineCodeValueRange(source: string, range: OffsetRange): OffsetRange | undefined {
  const raw = source.slice(range.start, range.end);
  const ticks = /^`+/u.exec(raw)?.[0].length ?? 0;
  if (ticks === 0 || raw.length <= ticks * 2) return undefined;
  return { start: range.start + ticks, end: range.end - ticks };
}

/**
 * Fenced code: mask everything between the opening fence line and the closing
 * fence line, keeping both fences and the info string. Indented code: mask the
 * content of each line after its four-space indent (one range per line).
 */
function codeValueRanges(source: string, range: OffsetRange): OffsetRange[] {
  const raw = source.slice(range.start, range.end);
  const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/u.exec(raw);

  if (opening) {
    const contentStart = range.start + opening[0].length;
    let contentEnd = range.end;

    // The AST usually ends at the closing fence, but tolerate a trailing line
    // break so a future parser change cannot swallow the fence as content.
    let lastLineEnd = range.end;
    if (source[lastLineEnd - 1] === '\n') lastLineEnd -= 1;
    if (source[lastLineEnd - 1] === '\r') lastLineEnd -= 1;
    const lastLineStart = source.lastIndexOf('\n', lastLineEnd - 1) + 1;
    const lastLine = source.slice(lastLineStart, lastLineEnd);
    if (/^ {0,3}(?:`{3,}|~{3,})[ \t]*$/u.test(lastLine)) {
      contentEnd = lastLineStart;
      // Do not include the line break that belongs to the fence line.
      if (contentEnd > contentStart && source[contentEnd - 1] === '\n') contentEnd -= 1;
      if (contentEnd > contentStart && source[contentEnd - 1] === '\r') contentEnd -= 1;
    }
    return contentEnd > contentStart ? [{ start: contentStart, end: contentEnd }] : [];
  }

  const ranges: OffsetRange[] = [];
  let cursor = range.start;
  while (cursor < range.end) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? range.end : newline;
    const line = source.slice(cursor, lineEnd).replace(/\r$/u, '');
    const indent = /^(?: {4}|\t)/u.exec(line)?.[0].length ?? 0;
    const contentStart = cursor + indent;
    const contentEnd = cursor + line.length;
    if (contentEnd > contentStart) ranges.push({ start: contentStart, end: contentEnd });
    cursor = newline === -1 ? range.end : newline + 1;
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Links, images, definitions
// ---------------------------------------------------------------------------

/**
 * Locates the destination inside a raw link/image/definition slice. mdast
 * gives a decoded URL, while the source may use `<...>` or escapes, so the
 * raw syntax is parsed first and `node.url` is only used to confirm the end.
 */
function destinationRange(
  source: string,
  range: OffsetRange,
  url: string | undefined,
): OffsetRange | undefined {
  const raw = source.slice(range.start, range.end);
  let from = -1;

  const inline = raw.lastIndexOf('](');
  if (inline >= 0) {
    from = inline + 2;
  } else {
    const definition = /^[ \t]{0,3}\[[^\]\r\n]*\]:[ \t]*/u.exec(raw);
    if (definition) from = definition[0].length;
  }

  // Autolink: `<https://example.ru>`.
  if (from < 0) {
    if (raw.startsWith('<') && raw.endsWith('>') && raw.length > 2) {
      return { start: range.start + 1, end: range.end - 1 };
    }
    return undefined;
  }

  while (from < raw.length && /[ \t\r\n]/u.test(raw[from] ?? '')) from += 1;

  if (raw[from] === '<') {
    const close = raw.indexOf('>', from + 1);
    if (close <= from + 1) return undefined;
    return { start: range.start + from + 1, end: range.start + close };
  }

  if (url !== undefined && url.length > 0 && raw.startsWith(url, from)) {
    return { start: range.start + from, end: range.start + from + url.length };
  }

  let i = from;
  let depth = 0;
  while (i < raw.length) {
    const char = raw[i] ?? '';
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
      continue;
    }
    if (/[ \t\r\n]/u.test(char)) break;
    i += 1;
  }

  return i > from ? { start: range.start + from, end: range.start + i } : undefined;
}

/** Alt text of `![alt](url)` or `![alt][ref]` (between `![` and the delimiter). */
function imageAltRange(source: string, range: OffsetRange): OffsetRange | undefined {
  const raw = source.slice(range.start, range.end);
  if (!raw.startsWith('![')) return undefined;

  const inline = raw.lastIndexOf('](');
  if (inline > 2) return { start: range.start + 2, end: range.start + inline };

  const reference = raw.lastIndexOf('][');
  if (reference > 2) return { start: range.start + 2, end: range.start + reference };

  const closing = raw.indexOf(']', 2);
  if (closing > 2) return { start: range.start + 2, end: range.start + closing };

  return undefined;
}

// ---------------------------------------------------------------------------
// YAML frontmatter
// ---------------------------------------------------------------------------

function maskValue(out: SourceRange[], absoluteValueStart: number, value: string): void {
  const trailing = /[ \t]*$/u.exec(value)?.[0].length ?? 0;
  let start = 0;
  let end = value.length - trailing;
  if (end <= start) return;
  const first = value[0] ?? '';
  if (first === '"' || first === "'") {
    const close = value.lastIndexOf(first);
    if (close > 0) {
      start = 1;
      end = close;
    }
  }
  if (end <= start) return;
  out.push({
    start: absoluteValueStart + start,
    end: absoluteValueStart + end,
    kind: 'frontmatter',
  });
}

/**
 * Masks only the value side of `key: value` lines (and scalar list items or
 * block-scalar continuations), keeping indentation, keys and colons intact.
 */
function frontmatterValueRanges(source: string, range: OffsetRange): SourceRange[] {
  const out: SourceRange[] = [];
  const raw = source.slice(range.start, range.end);
  let cursor = 0;

  while (cursor < raw.length) {
    const newline = raw.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? raw.length : newline;
    const line = raw.slice(cursor, lineEnd).replace(/\r$/u, '');
    const lineStart = range.start + cursor;

    if (/^(?:---|\+\+\+|\.\.\.)[ \t]*$/u.test(line) || /^[ \t]*#/u.test(line)) {
      cursor = newline === -1 ? raw.length : newline + 1;
      continue;
    }

    const keyValue = /^([ \t]*(?:-[ \t]+)?)([^:#\r\n]+?)([ \t]*:[ \t]*)(.*)$/u.exec(line);
    if (keyValue) {
      const [, prefix = '', key = '', separator = '', value = ''] = keyValue;
      const valueStart = prefix.length + key.length + separator.length;
      if (value.length > 0 && !/^[|>]/u.test(value)) {
        maskValue(out, lineStart + valueStart, value);
      }
    } else {
      const listItem = /^[ \t]*(?:-[ \t]+)?/u.exec(line)?.[0].length ?? 0;
      if (line.trim().length > 0) {
        maskValue(out, lineStart + listItem, line.slice(listItem));
      }
    }

    cursor = newline === -1 ? raw.length : newline + 1;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Range collection
// ---------------------------------------------------------------------------

function collectRanges(
  tree: Root,
  source: string,
  skipCode: boolean,
): {
  ranges: SourceRange[];
  htmlNodes: number;
} {
  const ranges: SourceRange[] = [];
  let htmlNodes = 0;

  // Link labels are ordinary text nodes, but a lone first name there is a
  // stronger signal than in prose; mark them for the opt-in PERSON mode.
  // Reference links (`[Иван][ref]`) have the same label semantics.
  const linkLabelStarts = new Set<number>();
  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'linkReference') return;
    visit(node, (child) => {
      if (child.type !== 'text') return;
      const range = nodeRange(child);
      if (range) linkLabelStarts.add(range.start);
    });
  });

  visit(tree, (node) => {
    const range = nodeRange(node);

    switch (node.type) {
      case 'text':
        pushRange(ranges, range, 'text', range !== undefined && linkLabelStarts.has(range.start));
        break;
      case 'inlineCode':
        if (!skipCode && range)
          pushRange(ranges, inlineCodeValueRange(source, range), 'inlineCode');
        break;
      case 'code':
        if (!skipCode && range) {
          for (const codeRange of codeValueRanges(source, range)) {
            pushRange(ranges, codeRange, 'code');
          }
        }
        break;
      case 'html':
        if (range) {
          htmlNodes += 1;
          pushRange(ranges, range, 'html');
        }
        break;
      case 'yaml':
        if (range) ranges.push(...frontmatterValueRanges(source, range));
        break;
      case 'image':
        if (range) {
          pushRange(ranges, imageAltRange(source, range), 'text', true);
          pushRange(ranges, destinationRange(source, range, node.url), 'destination');
        }
        break;
      case 'imageReference':
        if (range) pushRange(ranges, imageAltRange(source, range), 'text', true);
        break;
      case 'link':
        if (range) pushRange(ranges, destinationRange(source, range, node.url), 'destination');
        break;
      case 'definition':
        if (range) pushRange(ranges, destinationRange(source, range, node.url), 'destination');
        break;
      default:
        break;
    }
  });

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  // Defensive: two nodes must never own the same source range. Keep the first
  // (outer-to-inner visit order is stable) and drop overlaps.
  const unique: SourceRange[] = [];
  for (const range of ranges) {
    const previous = unique[unique.length - 1];
    if (previous && range.start < previous.end) continue;
    unique.push(range);
  }

  return { ranges: unique, htmlNodes };
}

// ---------------------------------------------------------------------------
// Vault commit / rollback
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function anonymizeMd(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();

  const detected = detectEncoding(file.bytes);
  const text = decodeTextBytes(file.bytes, detected.encoding, detected.bom);
  const eol = detectEol(text);
  const sha256 = await sha256Hex(file.bytes);

  const tree = fromMarkdown(text, {
    extensions: [frontmatter(['yaml'])],
    mdastExtensions: [frontmatterFromMarkdown('yaml')],
  });
  const { ranges, htmlNodes } = collectRanges(tree, text, ctx.skipCode === true);

  const snapshot = structuredClone(ctx.vault);
  const occurrenceStart = ctx.vault.occurrences.length;
  const warnings: string[] = [];
  const touched = new Map<string, MaskedEntity>();
  const replacements: { start: number; end: number; text: string }[] = [];

  try {
    // Left-to-right for tag assignment: vault occurrences must follow document
    // order, which is what sequential restore replays.
    for (const range of ranges) {
      const segment = text.slice(range.start, range.end);
      if (segment.length === 0) continue;

      const baseConfig = ctx.config ?? {};
      const config: DetectionConfig =
        range.kind === 'destination'
          ? { ...baseConfig, enableUrl: true }
          : range.nameContext === true
            ? { ...baseConfig, loneFirstNames: true }
            : baseConfig;
      const masked = anonymizeText(segment, config, ctx.vault);
      if (masked.warnings.length > 0) warnings.push(...masked.warnings);
      for (const entity of masked.entities) touched.set(entity.key, entity);
      if (masked.maskedText === segment) continue;
      replacements.push({ start: range.start, end: range.end, text: masked.maskedText });
    }
  } catch (error) {
    commitVault(ctx.vault, snapshot);
    throw error;
  }

  // Right-to-left for the actual edit: every index to the left still refers to
  // the original source string. Markup outside the range is never rewritten.
  let maskedText = text;
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const replacement = replacements[i];
    if (!replacement) continue;
    maskedText =
      maskedText.slice(0, replacement.start) + replacement.text + maskedText.slice(replacement.end);
  }

  if (htmlNodes > 0) {
    warnings.push(
      `${htmlNodes} HTML node(s) masked as plain text; nested HTML markup is not parsed`,
    );
  }

  const maskedBytes = encodeTextBytes(maskedText, 'utf-8', false);
  const vault = ctx.vault;
  const occurrenceCount = vault.occurrences.length - occurrenceStart;

  vault.files.push({
    originalName: file.name,
    // Filename masking is part of the upload hook (M3); M1b2 keeps the name.
    maskedName: file.name,
    format: 'md',
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
    format: 'md',
    entities: [...touched.values()],
    occurrences: vault.occurrences.slice(occurrenceStart),
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings,
  };
}

export async function restoreMd(file: FileInput, vault: Vault): Promise<RestoreResult> {
  let maskedText: string;
  try {
    maskedText = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new Error('Masked Markdown file is not valid UTF-8');
  }

  const record = await resolveVaultFile(vault, file);
  const session = createFileRestoreSession(vault, record);
  const restored = restoreText(maskedText, vault, { session });
  const text = record?.eol ? applyEol(restored.text, record.eol) : restored.text;

  const encoding = parseTxtEncoding(record?.encoding) ?? 'utf-8';
  const bytes = encodeTextBytes(text, encoding, record?.bom ?? false);
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

export const mdFormatAdapter: FormatAdapter = {
  format: 'md',
  extensions: ['.md', '.markdown'],
  mimeTypes: ['text/markdown'],
  canHandle(file): boolean {
    return (
      /\.(?:md|markdown)$/iu.test(file.name) || file.mimeType.toLowerCase() === 'text/markdown'
    );
  },
  anonymize(file, ctx) {
    return anonymizeMd(file, ctx);
  },
  restore(file, vault) {
    return restoreMd(file, vault);
  },
};
