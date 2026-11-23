/**
 * Legacy Word `.doc` adapter (M5b).
 *
 * The binary OLE/Word stream is read with `word-extractor` (MIT); the masked
 * result is written as a new `.docx` with `docx` (MIT). Layout, images,
 * tables, styles, headers/footers and comments are not preserved: all
 * extracted story text becomes plain paragraphs in one document body.
 *
 * Privacy policy:
 * - body, headers, footers, footnotes, endnotes, comment text and text boxes
 *   are extracted and anonymized through the normal masker/LeakGuard;
 * - if extraction fails, the adapter throws and the original `.doc` is never
 *   sent (fail-closed); `.docm`/`.dot` are rejected;
 * - both legacy libraries are loaded lazily so the service worker does not
 *   evaluate them at startup.
 */

import { ensureStructuredScanner } from '../detect/wasm-scan';
import { anonymizeText } from '../masker';
import type {
  AnonymizeContext,
  AnonymizeResult,
  FileInput,
  FormatAdapter,
  MaskedEntity,
  RestoreResult,
  Vault,
} from '../types';
import { restoreDocx } from './docx';
import { sha256Hex } from './txt';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOC_MIME = 'application/msword';

export const DOC_LOSS_WARNING = 'Форматирование .doc утрачено; отправляется DOCX';
export const DOC_RESTORE_WARNING =
  'Исходный бинарный .doc не восстанавливается; выходной файл — DOCX';

export type DocSectionKind =
  | 'body'
  | 'headers'
  | 'footers'
  | 'footnotes'
  | 'endnotes'
  | 'comments'
  | 'textboxes';

export interface DocSection {
  kind: DocSectionKind;
  text: string;
}

/**
 * Test seam: production code uses the real OLE extractor, unit tests can
 * supply deterministic section text (including PII) without a binary fixture.
 */
export type DocTextExtractor = (bytes: Uint8Array) => Promise<DocSection[]>;

interface ExtractedWordDocument {
  getBody(options?: { filterUnicode?: boolean }): string;
  getHeaders(options?: { filterUnicode?: boolean; includeFooters?: boolean }): string;
  getFooters(options?: { filterUnicode?: boolean }): string;
  getFootnotes(options?: { filterUnicode?: boolean }): string;
  getEndnotes(options?: { filterUnicode?: boolean }): string;
  getAnnotations(options?: { filterUnicode?: boolean }): string;
  getTextboxes(options?: {
    filterUnicode?: boolean;
    includeBody?: boolean;
    includeHeadersAndFooters?: boolean;
  }): string;
}

interface WordOleExtractorLike {
  extract(source: unknown): Promise<ExtractedWordDocument>;
}

type WordOleExtractorCtor = new () => WordOleExtractorLike;

const EXTRACT_ERROR =
  'DOC: не удалось извлечь текст из .doc; файл не отправлен (fail-closed). ' +
  'Сохраните документ как .docx и повторите попытку';
const EMPTY_ERROR =
  'DOC: в .doc не найден текст (только изображения/встроенные объекты?); файл не отправлен';

/** Rejects macro/template names before parsing; only `.doc` is accepted. */
function assertSupportedDocName(name: string): void {
  const lower = name.toLowerCase();
  if (/\.(?:docm|dotm|dotx|docx|rtf)$/u.test(lower)) {
    throw new Error('DOC: this adapter only accepts legacy .doc files');
  }
  if (!lower.endsWith('.doc')) {
    throw new Error('DOC: only .doc files are supported by this adapter');
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index) : '';
}

export function docxNameFor(name: string): string {
  const extension = extensionOf(name);
  const base = extension ? name.slice(0, -extension.length) : name;
  return `${base}.docx`;
}

function commitVault(target: Vault, draft: Vault): void {
  target.prefix = draft.prefix;
  target.createdAt = draft.createdAt;
  target.chatIds = draft.chatIds;
  target.files = draft.files;
  target.entities = draft.entities;
  target.personKeys = draft.personKeys;
  target.occurrences = draft.occurrences;
  target.filenameMap = draft.filenameMap;
}

/** Makes the npm `buffer` polyfill visible to word-extractor's free `Buffer`. */
async function installBufferPolyfill(): Promise<typeof import('buffer').Buffer> {
  const { Buffer } = await import('buffer');
  const global = globalThis as { Buffer?: typeof import('buffer').Buffer };
  global.Buffer ??= Buffer;
  return global.Buffer;
}

/**
 * Extracts every story the library exposes. `filterUnicode: false` keeps the
 * original characters so tags and offsets match what the user sees.
 */
export async function extractDocSections(bytes: Uint8Array): Promise<DocSection[]> {
  // Must run before the extractor module is evaluated: ole-header.js calls
  // Buffer.from() at module scope.
  const BufferCtor = await installBufferPolyfill();

  let Extractor: WordOleExtractorCtor;
  let Reader: new (buffer: unknown) => unknown;
  try {
    const module = (await import('word-extractor/lib/word-ole-extractor.js')) as unknown as {
      default?: WordOleExtractorCtor;
      WordOleExtractor?: WordOleExtractorCtor;
    };
    const candidate = module.default ?? module.WordOleExtractor;
    if (typeof candidate !== 'function') throw new Error('extractor export missing');
    Extractor = candidate;

    // The OLE extractor takes a reader, not a Buffer (that wiring lives in
    // word.js, which also pulls in fs/yauzl for file names and .docx). Use the
    // buffer reader directly so no Node filesystem module enters the bundle.
    const readerModule = (await import('word-extractor/lib/buffer-reader.js')) as unknown as {
      default?: new (buffer: unknown) => unknown;
    };
    if (typeof readerModule.default !== 'function') throw new Error('reader export missing');
    Reader = readerModule.default;
  } catch {
    throw new Error(EXTRACT_ERROR);
  }

  let document: ExtractedWordDocument;
  try {
    const buffer = BufferCtor.from(bytes);
    const reader = new Reader(buffer);
    const extractor = new Extractor();
    document = await extractor.extract(reader);
  } catch {
    // Parser errors may embed stream names or field values; never surface them.
    throw new Error(EXTRACT_ERROR);
  }

  const options = { filterUnicode: false } as const;
  const sections: DocSection[] = [
    { kind: 'body', text: document.getBody(options) },
    { kind: 'headers', text: document.getHeaders({ ...options, includeFooters: false }) },
    { kind: 'footers', text: document.getFooters(options) },
    { kind: 'footnotes', text: document.getFootnotes(options) },
    { kind: 'endnotes', text: document.getEndnotes(options) },
    { kind: 'comments', text: document.getAnnotations(options) },
    {
      kind: 'textboxes',
      text: document.getTextboxes({
        ...options,
        includeBody: true,
        includeHeadersAndFooters: true,
      }),
    },
  ];

  return sections.filter((section) => section.text.trim().length > 0);
}

/** Splits masked text into paragraphs; blank lines remain blank paragraphs. */
async function buildDocx(sections: readonly DocSection[]): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, TextRun } = await import('docx');

  const children: InstanceType<typeof Paragraph>[] = [];
  for (const section of sections) {
    if (children.length > 0) children.push(new Paragraph({ children: [] }));
    const lines = section.text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n');
    for (const line of lines) {
      children.push(
        new Paragraph({
          children: line.length > 0 ? [new TextRun(line)] : [],
        }),
      );
    }
  }

  const document = new Document({
    creator: '',
    lastModifiedBy: '',
    title: '',
    subject: '',
    description: '',
    keywords: '',
    sections: [{ properties: {}, children }],
  });

  const blob = await Packer.toBlob(document);
  return new Uint8Array(await blob.arrayBuffer());
}

export interface DocAnonymizeOptions {
  /** Test seam; production callers leave it undefined. */
  extractor?: DocTextExtractor;
}

export async function anonymizeDoc(
  file: FileInput,
  ctx: AnonymizeContext,
  options: DocAnonymizeOptions = {},
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();
  assertSupportedDocName(file.name);

  const extractor = options.extractor ?? extractDocSections;
  const sections = await extractor(file.bytes);
  if (sections.length === 0) throw new Error(EMPTY_ERROR);

  const sha256 = await sha256Hex(file.bytes);
  const draft = structuredClone(ctx.vault);
  const occurrenceStart = draft.occurrences.length;
  const config = ctx.config ?? {};
  const touched = new Map<string, MaskedEntity>();
  const maskedSections: DocSection[] = [];

  for (const section of sections) {
    ctx.signal?.throwIfAborted();
    const result = anonymizeText(section.text, config, draft);
    for (const entity of result.entities) touched.set(entity.key, entity);
    maskedSections.push({ kind: section.kind, text: result.maskedText });
  }

  const maskedBytes = await buildDocx(maskedSections);
  const maskedName = docxNameFor(file.name);

  commitVault(ctx.vault, draft);
  const vault = ctx.vault;
  vault.files.push({
    originalName: file.name,
    maskedName,
    format: 'docx',
    size: file.bytes.byteLength,
    sha256,
    maskedSha256: await sha256Hex(maskedBytes),
    occurrenceStart,
    occurrenceCount: vault.occurrences.length - occurrenceStart,
  });

  const warnings = [DOC_LOSS_WARNING];
  if (sections.some((section) => section.kind === 'comments')) {
    warnings.push('Текст комментариев перенесён в тело документа');
  }

  return {
    maskedBytes,
    maskedName,
    maskedMime: DOCX_MIME,
    format: 'docx',
    entities: [...touched.values()],
    occurrences: vault.occurrences.slice(occurrenceStart),
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings,
  };
}

/**
 * Restore input is always the generated `.docx`; a binary `.doc` is never
 * produced again. The vault's original `.doc` name is mapped to `.docx`.
 */
export async function restoreDoc(file: FileInput, vault: Vault): Promise<RestoreResult> {
  const result = await restoreDocx(file, vault);
  // restoreDocx already resolved the record by masked-byte hash and returns the
  // stored `.docx` (masked) name for legacy `.doc` records.
  const original = result.fileName;
  const fileName = /\.doc$/iu.test(original) ? docxNameFor(original) : original;

  return {
    ...result,
    fileName,
    warnings: [DOC_RESTORE_WARNING, ...result.warnings],
  };
}

export const docFormatAdapter: FormatAdapter = {
  format: 'doc',
  extensions: ['.doc'],
  mimeTypes: [DOC_MIME],
  canHandle(file): boolean {
    const name = file.name.toLowerCase();
    if (/\.(?:docm|dotm|dotx|docx|rtf)$/u.test(name)) return false;
    // The extension is authoritative; a bare `application/msword` MIME on a
    // random file name must not route here.
    return name.endsWith('.doc');
  },
  anonymize(file, ctx) {
    return anonymizeDoc(file, ctx);
  },
  restore(file, vault) {
    return restoreDoc(file, vault);
  },
};
