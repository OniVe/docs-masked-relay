/**
 * MAIN-world download interception (M4).
 *
 * ChatGPT downloads run in two steps (spec §5.1):
 *   1. JSON metadata (`file_name`, `download_url`) is fetched;
 *   2. bytes are fetched from `estuary/content`, `content_download`,
 *      `*.oaiusercontent.com` or `/executor/file`, then saved as a Blob.
 *
 * The hook patches both steps. A JSON `file_name` with tags is restored through
 * ISOLATED; downloaded bytes are buffered and restored when they are small
 * enough. Anything that cannot be restored is passed through unchanged with a
 * toast so the user can use manual mode; a download must never be aborted here.
 * Non-target requests and PII-bearing values are never logged.
 */

import { isPdfFile } from '../core/formats/pdf-detect';
import { parseTags } from '../core/tag';
import type { MainBridge } from './bridge-main';
import {
  BridgeError,
  MAX_FILE_BYTES,
  type RestoreFileBridgeResult,
  type RestoreNameBridgeResult,
  toExactArrayBuffer,
} from './protocol';

const MAX_JSON_BYTES = 64 * 1024;
const MAPPING_TTL_MS = 10 * 60_000;
const MAX_MAPPINGS = 20;

const JSON_DOWNLOAD_PATTERNS: readonly RegExp[] = [
  /^\/backend-api\/files\/[^/]+\/download\/?$/u,
  /^\/conversation\/[^/]+\/attachment\/[^/]+\/download\/?$/u,
  /^\/conversation\/[^/]+\/interpreter\/download\/?$/u,
  /^(?:\/backend-api)?\/files\/download\/[^/]+\/?$/u,
];

const ESTUARY_CONTENT_RE = /^\/backend-api\/estuary\/content\/?$/u;
const LIBRARY_CONTENT_RE = /^\/backend-api\/files\/library\/content_download\/?$/u;
const EXECUTOR_FILE_RE = /^\/conversation\/[^/]+\/executor\/file\/?$/u;

const BODY_DEPENDENT_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'content-md5',
  'digest',
]);

export type DownloadKind = 'json' | 'bytes';

export interface InstallDownloadHooksOptions {
  bridge: MainBridge;
  target?: Window;
  now?: () => number;
  /** Defaults to the shared 25 MB upload/download limit. */
  maxBytes?: () => number;
  /** Protection state; defaults to enabled (fail-safe). */
  isEnabled?: () => boolean;
}

declare global {
  interface Window {
    __DM_DOWNLOAD_HOOKS__?: boolean;
  }
}

interface DownloadMapping {
  name: string;
  mime: string;
  prefix?: string;
  ts: number;
}

interface JsonMetadataOutcome {
  updated?: Record<string, unknown>;
}

interface XhrState {
  url: URL;
  kind: DownloadKind;
  generation: number;
  aborted: boolean;
  started: boolean;
  /** Resolves when the response has been patched (or pass-through is final). */
  ready: Promise<void>;
  resolveReady: () => void;
}

type XhrStrategy = 'json' | 'bytes' | 'unsupported';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChatGptHost(url: URL): boolean {
  return url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com';
}

function isOaiUserContentHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'oaiusercontent.com' || host.endsWith('.oaiusercontent.com');
}

/** Pure classifier used by fetch, XHR and unit tests. */
export function classifyDownloadUrl(url: URL, method = 'GET'): DownloadKind | undefined {
  if (method.toUpperCase() !== 'GET') return undefined;

  if (isOaiUserContentHost(url)) return 'bytes';
  if (!isChatGptHost(url)) return undefined;

  if (
    ESTUARY_CONTENT_RE.test(url.pathname) ||
    LIBRARY_CONTENT_RE.test(url.pathname) ||
    EXECUTOR_FILE_RE.test(url.pathname)
  ) {
    return 'bytes';
  }

  if (JSON_DOWNLOAD_PATTERNS.some((pattern) => pattern.test(url.pathname))) return 'json';
  return undefined;
}

/** Primary vault lookup: the first tag prefix in a masked `file_name`. */
export function prefixFromFileName(name: string): string | undefined {
  return parseTags(name)[0]?.prefix;
}

const TEXTUAL_MIME = new Set([
  'application/json',
  'text/json',
  'application/x-json',
  'application/x-ndjson',
  'application/ndjson',
  'application/jsonl',
  'application/xml',
  'text/xml',
]);

/** Extensions whose bytes this extension can restore offline. */
const RESTORE_EXTENSION_RE = /\.(?:txt|md|markdown|json|jsonl|ndjson|xml|docx|xlsx|doc|xls)$/iu;

const RESTORE_MIME = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
  'text/json',
  'application/x-json',
  'application/x-ndjson',
  'application/ndjson',
  'application/jsonl',
  'application/xml',
  'text/xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
]);

function normalizedMime(mime: string): string {
  return mime.split(';')[0]?.trim().toLowerCase() ?? '';
}

function isTextualMime(mime: string): boolean {
  const normalized = normalizedMime(mime);
  return normalized.startsWith('text/') || TEXTUAL_MIME.has(normalized);
}

/** UTF-8 printable sniff used when the response MIME is generic/binary. */
const PRINTABLE_UNICODE = /[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}]/u;

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, BODY_TAG_SCAN_LIMIT));
  const text = new TextDecoder('utf-8').decode(sample);
  let good = 0;
  let bad = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\uFFFD') {
      bad += 1;
    } else if (code === 0x09 || code === 0x0a || code === 0x0d || PRINTABLE_UNICODE.test(char)) {
      good += 1;
    } else {
      bad += 1;
    }
  }
  return good > 0 && bad / (good + bad) <= 0.05;
}

/**
 * The body-tag probe runs only for a textual target: either the *response*
 * content-type is textual or the remembered/derived name has a text
 * extension. Metadata `mime_type` alone is not trusted (M8-N2).
 */
function isTextualRestoreTarget(name: string, mime: string): boolean {
  const normalized = normalizedMime(mime);
  if (normalized.startsWith('text/')) return true;
  if (TEXTUAL_MIME.has(normalized)) return true;
  return RESTORE_EXTENSION_RE.test(name) && !/\.(?:docx|xlsx|doc|xls)$/iu.test(name);
}

/**
 * A bytes step is handed to the restore bridge only when the declared name is
 * a supported restore target or the response itself declares a supported
 * MIME. A binary payload with a lying metadata `mime_type: text/plain` is
 * passed through untouched (M8-N2).
 */
function isRestoreTarget(name: string, responseMime: string): boolean {
  return RESTORE_EXTENSION_RE.test(name) || RESTORE_MIME.has(normalizedMime(responseMime));
}

/** Text-format names whose buffered bytes must look textual before restore. */
const TEXT_RESTORE_NAME_RE = /\.(?:txt|md|markdown|json|jsonl|ndjson|xml)$/iu;

/**
 * A binary body behind a `.txt`/`.json`/`.xml` name must not reach the
 * restore bridge: accept it only with a textual response MIME or a printable
 * UTF-8 sniff. OOXML/legacy office files are binary by design and are not
 * subject to this gate (M8-N2).
 */
function passesTextBytesGate(name: string, responseMime: string, bytes: Uint8Array): boolean {
  if (!TEXT_RESTORE_NAME_RE.test(name)) return true;
  return isTextualMime(responseMime) || looksLikeUtf8Text(bytes);
}

/**
 * Byte budget for the body-tag probe. Masked text files carry their first tag
 * near the top; beyond the cap the download falls back to the filename/chat
 * lookup instead of scanning a multi-megabyte attachment (R3-M3).
 */
const BODY_TAG_SCAN_LIMIT = 256 * 1024;
const BODY_TAG_WINDOW = 256;

/**
 * R2-M5: a renamed masked textual download (TXT/MD/JSON/XML) may carry no tag
 * in its name, but the body still has tags. Scan the masked UTF-8 bytes for the
 * first tag without decoding the whole file; the prefix lets the vault be
 * found even when the chat binding is gone. Byte-level `indexOf` plus one
 * reusable decoder keeps the probe linear; decoding a 256-byte window per `[`
 * was ~3.6 s/MB (R3-M3).
 */
function isTagPrefixByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39);
}

/** Cheap byte-level pre-check: `[[` followed by a 5-char tag prefix. */
function looksLikeTagStart(bytes: Uint8Array, start: number, limit: number): boolean {
  let cursor = start;
  while (cursor < limit && (bytes[cursor] === 0x20 || bytes[cursor] === 0x09)) cursor += 1;
  if (cursor + 5 > limit) return false;
  for (let offset = 0; offset < 5; offset += 1) {
    if (!isTagPrefixByte(bytes[cursor + offset] ?? 0)) return false;
  }
  return true;
}

export function prefixFromBodyTags(
  bytes: Uint8Array,
  name: string,
  mime: string,
): string | undefined {
  if (!isTextualRestoreTarget(name, mime)) return undefined;
  // A text extension alone is not proof: a binary body must not be scanned /
  // restored. Require a textual response MIME or a printable UTF-8 sniff
  // (M8-N2).
  if (!isTextualMime(mime) && !looksLikeUtf8Text(bytes)) return undefined;
  const decoder = new TextDecoder('utf-8');
  const limit = Math.min(bytes.length, BODY_TAG_SCAN_LIMIT);
  let index = 0;
  while (index < limit - 1) {
    index = bytes.indexOf(0x5b, index); // '['
    if (index === -1 || index >= limit - 1) return undefined;
    const next = bytes[index + 1];
    const prefixStart =
      next === 0x5b ? index + 2 : next === 0x5c && bytes[index + 2] === 0x5b ? index + 3 : -1;
    if (prefixStart !== -1 && looksLikeTagStart(bytes, prefixStart, limit)) {
      // "[[", or escaped "\[" — decode only the candidate tag window.
      const windowText = decoder.decode(
        bytes.subarray(index, Math.min(bytes.length, index + BODY_TAG_WINDOW)),
      );
      const tag = parseTags(windowText)[0];
      if (tag) return tag.prefix;
      index += 2;
      continue;
    }
    index += 1;
  }
  return undefined;
}

/** Some signed URLs carry the original file name as a query parameter. */
export function fileNameFromDownloadUrl(url: URL): string | undefined {
  for (const key of ['filename', 'file_name', 'name']) {
    const value = url.searchParams.get(key);
    if (value !== null && value.length > 0 && value.length <= 255) return value;
  }
  return undefined;
}

function mimeFromResponse(response: Response): string {
  const raw = response.headers.get('content-type') ?? '';
  const mime = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime;
}

function mimeFromXhr(xhr: XMLHttpRequest): string {
  const raw = xhr.getResponseHeader('content-type') ?? '';
  return raw.split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Fallback adapter routing when a bytes URL has no remembered file name. */
export function fileNameFromMime(mime: string): string | undefined {
  switch (mime) {
    case 'text/plain':
      return 'download.txt';
    case 'text/markdown':
      return 'download.md';
    case 'application/json':
    case 'text/json':
    case 'application/x-json':
      return 'download.json';
    case 'application/x-ndjson':
    case 'application/ndjson':
    case 'application/jsonl':
      return 'download.jsonl';
    case 'application/xml':
    case 'text/xml':
      return 'download.xml';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'download.docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'download.xlsx';
    default:
      return undefined;
  }
}

function copyHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (BODY_DEPENDENT_HEADERS.has(name.toLowerCase())) return;
    headers.set(name, value);
  });
  return headers;
}

function urlKeys(value: string | URL, baseHref: string): string[] {
  try {
    const url = value instanceof URL ? value : new URL(value, baseHref);
    return [url.href, `${url.origin}${url.pathname}`];
  } catch {
    return [];
  }
}

function rememberMapping(
  mappings: Map<string, DownloadMapping>,
  downloadUrl: string | URL,
  mapping: Omit<DownloadMapping, 'ts'>,
  baseHref: string,
  now: () => number,
): void {
  const entry: DownloadMapping = { ...mapping, ts: now() };
  for (const key of urlKeys(downloadUrl, baseHref)) mappings.set(key, entry);

  const cutoff = now() - MAPPING_TTL_MS;
  for (const [key, value] of mappings) {
    if (value.ts < cutoff) mappings.delete(key);
  }
  while (mappings.size > MAX_MAPPINGS) {
    const oldest = mappings.keys().next().value;
    if (typeof oldest !== 'string') break;
    mappings.delete(oldest);
  }
}

function lookupMapping(
  mappings: Map<string, DownloadMapping>,
  url: URL,
  now: () => number,
): DownloadMapping | undefined {
  const cutoff = now() - MAPPING_TTL_MS;
  // Exact signed URL first; the path-only key is only a tolerant fallback.
  const keys = [url.href, `${url.origin}${url.pathname}`];
  for (const key of keys) {
    const entry = mappings.get(key);
    if (!entry) continue;
    if (entry.ts < cutoff) {
      mappings.delete(key);
      continue;
    }
    return entry;
  }
  return undefined;
}

function notifyRestoreError(bridge: MainBridge, error: unknown, announceNoVault: boolean): void {
  if (error instanceof BridgeError) {
    if (error.code === 'NO_VAULT') {
      if (announceNoVault) bridge.notify('NO_VAULT');
      return;
    }
    if (error.code === 'LOCKED') {
      // Pass-through is fail-open by design (the bytes stay masked), but the
      // user must know why the file was not restored.
      bridge.notify('LOCKED');
      return;
    }
    if (error.code === 'LIMIT') {
      bridge.notify('LARGE_FILE');
      return;
    }
    if (error.code === 'DISABLED') {
      // Turning protection off is not an error; the download stays masked.
      return;
    }
  }
  bridge.notify('MANUAL_FALLBACK');
}

/** Shared JSON step: remember `download_url` and restore tags in `file_name`. */
async function restoreJsonMetadata(
  json: Record<string, unknown>,
  mime: string,
  bridge: MainBridge,
  mappings: Map<string, DownloadMapping>,
  chatId: string | undefined,
  now: () => number,
  baseHref: string,
): Promise<JsonMetadataOutcome> {
  const fileName = typeof json.file_name === 'string' ? json.file_name : undefined;
  if (!fileName || fileName.length > 255) return {};

  const prefix = prefixFromFileName(fileName);
  const downloadUrl = typeof json.download_url === 'string' ? json.download_url : undefined;
  // The metadata response itself is JSON; the file's own MIME is in mime_type.
  // Use it for the bytes step so PDF/text/JSON/XML routing and the body probe
  // see the real format (bounded like file_name).
  const declaredMime = json.mime_type;
  const fileMime =
    typeof declaredMime === 'string' && declaredMime.length > 0 && declaredMime.length <= 255
      ? declaredMime
      : mime;

  if (downloadUrl) {
    rememberMapping(
      mappings,
      downloadUrl,
      { name: fileName, mime: fileMime, prefix },
      baseHref,
      now,
    );
  }

  if (!prefix) return {};

  try {
    const restored: RestoreNameBridgeResult = await bridge.restoreName({
      name: fileName,
      chatId,
      prefix,
    });
    if (restored.replacements === 0) {
      // The name carries a vault prefix but nothing could be restored: the
      // user must see a manual-mode hint instead of silently getting tags.
      bridge.notify('MANUAL_FALLBACK');
      return {};
    }
    if (restored.fileName === fileName) return {};
    return { updated: { ...json, file_name: restored.fileName } };
  } catch (error) {
    notifyRestoreError(bridge, error, true);
    return {};
  }
}

async function processJsonResponse(
  response: Response,
  bridge: MainBridge,
  mappings: Map<string, DownloadMapping>,
  chatId: string | undefined,
  now: () => number,
  baseHref: string,
): Promise<Response> {
  if (!response.ok) return response;
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  // JSON endpoints normally declare their type; a missing header is still
  // worth a parse because the URL itself is an unambiguous metadata route.
  if (contentType && !contentType.includes('json')) return response;

  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return response;

  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    return response;
  }
  if (text.length === 0 || text.length > MAX_JSON_BYTES) return response;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return response;
  }
  if (!isRecord(parsed)) return response;

  const outcome = await restoreJsonMetadata(
    parsed,
    mimeFromResponse(response),
    bridge,
    mappings,
    chatId,
    now,
    baseHref,
  );
  if (!outcome.updated) return response;

  const headers = copyHeaders(response.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(outcome.updated), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function processBytesResponse(
  response: Response,
  url: URL,
  bridge: MainBridge,
  mappings: Map<string, DownloadMapping>,
  chatId: string | undefined,
  now: () => number,
  maxBytes: number,
): Promise<Response> {
  if (!response.ok) return response;

  const mapping = lookupMapping(mappings, url, now);
  const responseMime = mimeFromResponse(response);
  const metadataMime = mapping?.mime;
  const name = mapping?.name ?? fileNameFromDownloadUrl(url) ?? fileNameFromMime(responseMime);
  // Unknown binary (for example a preview image on oaiusercontent): not a
  // restore target, so stay silent and leave it untouched.
  if (!name) return response;

  // PDF redaction is one-way: the body cannot be restored. Either MIME source
  // identifying a PDF is enough to pass through silently.
  if (
    isPdfFile(name, responseMime) ||
    (metadataMime !== undefined && isPdfFile(name, metadataMime))
  ) {
    return response;
  }

  // The restore adapter must see the response content-type when it is
  // textual; a lying metadata `mime_type: application/octet-stream` must not
  // hide the real format (M8R2-M2).
  const mime = isTextualMime(responseMime) ? responseMime : metadataMime || responseMime;

  // Unknown/binary target with no trustworthy textual signal: pass through
  // without calling the restore bridge (M8-N2). A tagged name still deserves
  // the manual-mode hint because there is something to restore.
  if (!isRestoreTarget(name, responseMime)) {
    if (mapping?.prefix || parseTags(name).length > 0) bridge.notify('MANUAL_FALLBACK');
    return response;
  }

  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    bridge.notify('LARGE_FILE');
    return response;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.clone().arrayBuffer());
  } catch {
    bridge.notify('MANUAL_FALLBACK');
    return response;
  }
  if (bytes.byteLength === 0) return response;
  if (bytes.byteLength > maxBytes) {
    bridge.notify('LARGE_FILE');
    return response;
  }
  if (!passesTextBytesGate(name, responseMime, bytes)) {
    if (mapping?.prefix || parseTags(name).length > 0) bridge.notify('MANUAL_FALLBACK');
    return response;
  }

  const prefix =
    mapping?.prefix ?? prefixFromFileName(name) ?? prefixFromBodyTags(bytes, name, responseMime);
  const hadPrefix = Boolean(prefix);

  try {
    const restored: RestoreFileBridgeResult = await bridge.restoreFile({
      bytes: toExactArrayBuffer(bytes),
      name,
      mime,
      chatId,
      prefix,
    });
    if (restored.replacements === 0) {
      if (hadPrefix || parseTags(name).length > 0 || restored.unknownTags.length > 0) {
        bridge.notify('MANUAL_FALLBACK');
      }
      return response;
    }

    const headers = copyHeaders(response.headers);
    if (!headers.has('content-type') && mime) headers.set('content-type', mime);
    return new Response(restored.bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    notifyRestoreError(bridge, error, hadPrefix);
    return response;
  }
}

function effectiveUrl(input: RequestInfo | URL, baseHref: string): URL | undefined {
  const raw =
    typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
  try {
    return new URL(raw, baseHref);
  } catch {
    return undefined;
  }
}

function effectiveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const explicit =
    init?.method ??
    (typeof Request !== 'undefined' && input instanceof Request ? input.method : undefined);
  if (explicit) return explicit.toUpperCase();
  return init?.body !== undefined && init?.body !== null ? 'POST' : 'GET';
}

function currentChatId(target: Window): string | undefined {
  try {
    const match = target.location.pathname.match(/^\/c\/([^/?#]+)/u);
    const chatId = match?.[1];
    return chatId && chatId.length <= 256 ? chatId : undefined;
  } catch {
    return undefined;
  }
}

function xhrStrategy(xhr: XMLHttpRequest, kind: DownloadKind): XhrStrategy {
  if (kind === 'json') {
    return xhr.responseType === '' || xhr.responseType === 'text' || xhr.responseType === 'json'
      ? 'json'
      : 'unsupported';
  }
  return xhr.responseType === 'blob' || xhr.responseType === 'arraybuffer'
    ? 'bytes'
    : 'unsupported';
}

function xhrJsonText(xhr: XMLHttpRequest): string | undefined {
  try {
    if (xhr.responseType === 'json') {
      const value: unknown = xhr.response;
      return isRecord(value) ? JSON.stringify(value) : undefined;
    }
    const text = xhr.responseText;
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

function defineGetter(xhr: XMLHttpRequest, property: string, get: () => unknown): void {
  try {
    Object.defineProperty(xhr, property, { configurable: true, get });
  } catch {
    // Native properties may be non-configurable in exotic environments.
  }
}

async function finishXhrJson(
  xhr: XMLHttpRequest,
  bridge: MainBridge,
  mappings: Map<string, DownloadMapping>,
  chatId: string | undefined,
  now: () => number,
  baseHref: string,
): Promise<void> {
  const text = xhrJsonText(xhr);
  if (!text || text.length > MAX_JSON_BYTES) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;

  const outcome = await restoreJsonMetadata(
    parsed,
    mimeFromXhr(xhr),
    bridge,
    mappings,
    chatId,
    now,
    baseHref,
  );
  if (!outcome.updated) return;

  const updatedText = JSON.stringify(outcome.updated);
  if (xhr.responseType === 'json') {
    defineGetter(xhr, 'response', () => outcome.updated);
  } else {
    defineGetter(xhr, 'responseText', () => updatedText);
    defineGetter(xhr, 'response', () => updatedText);
  }
}

async function finishXhrBytes(
  xhr: XMLHttpRequest,
  state: XhrState,
  bridge: MainBridge,
  mappings: Map<string, DownloadMapping>,
  chatId: string | undefined,
  now: () => number,
  maxBytes: number,
): Promise<void> {
  const mapping = lookupMapping(mappings, state.url, now);
  const responseMime = mimeFromXhr(xhr);
  const metadataMime = mapping?.mime;
  const name =
    mapping?.name ?? fileNameFromDownloadUrl(state.url) ?? fileNameFromMime(responseMime);
  // Unknown binary: not a restore target; leave it untouched without a toast.
  if (!name) return;

  // One-way PDF: no body restoration, no manual-fallback toast.
  if (
    isPdfFile(name, responseMime) ||
    (metadataMime !== undefined && isPdfFile(name, metadataMime))
  ) {
    return;
  }
  // Response content-type wins over metadata when textual (M8R2-M2).
  const mime = isTextualMime(responseMime) ? responseMime : metadataMime || responseMime;
  // Same binary/lying-metadata gate as the fetch path (M8-N2).
  if (!isRestoreTarget(name, responseMime)) {
    if (mapping?.prefix || parseTags(name).length > 0) bridge.notify('MANUAL_FALLBACK');
    return;
  }

  let bytes: Uint8Array;
  let originalBlob: Blob | undefined;
  try {
    if (xhr.responseType === 'blob') {
      originalBlob = xhr.response as Blob;
      bytes = new Uint8Array(await originalBlob.arrayBuffer());
    } else {
      const response: unknown = xhr.response;
      const buffer =
        response instanceof ArrayBuffer
          ? response
          : ArrayBuffer.isView(response)
            ? toExactArrayBuffer(
                new Uint8Array(response.buffer, response.byteOffset, response.byteLength),
              )
            : undefined;
      if (!buffer) return;
      // Copy: transferring the native XHR buffer would detach the page's
      // response even if no tag is found and the request passes through.
      bytes = new Uint8Array(buffer).slice();
    }
  } catch {
    bridge.notify('MANUAL_FALLBACK');
    return;
  }

  if (bytes.byteLength === 0) return;
  if (bytes.byteLength > maxBytes) {
    bridge.notify('LARGE_FILE');
    return;
  }
  if (!passesTextBytesGate(name, responseMime, bytes)) {
    if (mapping?.prefix || parseTags(name).length > 0) bridge.notify('MANUAL_FALLBACK');
    return;
  }

  const prefix =
    mapping?.prefix ?? prefixFromFileName(name) ?? prefixFromBodyTags(bytes, name, responseMime);
  const hadPrefix = Boolean(prefix);

  try {
    const restored: RestoreFileBridgeResult = await bridge.restoreFile({
      bytes: toExactArrayBuffer(bytes),
      name,
      mime,
      chatId,
      prefix,
    });
    if (restored.replacements === 0) {
      if (hadPrefix || parseTags(name).length > 0 || restored.unknownTags.length > 0) {
        bridge.notify('MANUAL_FALLBACK');
      }
      return;
    }

    if (xhr.responseType === 'blob') {
      const type = originalBlob?.type || mime;
      defineGetter(xhr, 'response', () => new Blob([restored.bytes], { type }));
    } else {
      defineGetter(xhr, 'response', () => restored.bytes);
    }
  } catch (error) {
    notifyRestoreError(bridge, error, hadPrefix);
  }
}

/**
 * Installs fetch/XHR download hooks. Idempotent; the returned cleanup restores
 * the previous wrappers (used by tests/dev tooling).
 */
export function installDownloadHooks(options: InstallDownloadHooksOptions): () => void {
  const target = options.target ?? window;
  const bridge = options.bridge;
  const now = options.now ?? (() => Date.now());
  const maxBytes = options.maxBytes ?? (() => MAX_FILE_BYTES);
  const isEnabled = options.isEnabled ?? (() => true);
  const baseHref = target.location.href;

  if (target.__DM_DOWNLOAD_HOOKS__) return () => {};
  target.__DM_DOWNLOAD_HOOKS__ = true;

  const mappings = new Map<string, DownloadMapping>();

  const rawFetch = target.fetch;
  const originalFetch = rawFetch.bind(target);
  const XhrClass = (target as Window & typeof globalThis).XMLHttpRequest;
  const originalXhrProto = XhrClass.prototype;
  const originalOpen = originalXhrProto.open;
  const originalSend = originalXhrProto.send;
  const originalAbort = originalXhrProto.abort;
  const originalAddEventListener = originalXhrProto.addEventListener;
  const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();

  const deliverListener = (
    listener: EventListenerOrEventListenerObject,
    xhr: XMLHttpRequest,
    event: Event,
  ): void => {
    if (typeof listener === 'function') listener.call(xhr, event);
    else listener.handleEvent(event);
  };

  /**
   * Chromium invokes an XHR `onload` attribute before capture listeners, so
   * native events cannot be suppressed. Instead, listeners registered after
   * `open` are wrapped to await the restore before the page sees them.
   */
  const deferXhrListeners = (xhr: XMLHttpRequest): void => {
    try {
      Object.defineProperty(xhr, 'addEventListener', {
        configurable: true,
        value: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) => {
          const current = xhrStates.get(xhr);
          if (!current || !listener) {
            return Reflect.apply(originalAddEventListener, xhr, [type, listener, options]);
          }

          if (type === 'load' || type === 'loadend') {
            const wrapped = (event: Event): void => {
              void current.ready.then(() => {
                if (!current.aborted) deliverListener(listener, xhr, event);
              });
            };
            return Reflect.apply(originalAddEventListener, xhr, [type, wrapped, options]);
          }

          if (type === 'readystatechange') {
            const wrapped = (event: Event): void => {
              const deliver = (): void => {
                if (!current.aborted) deliverListener(listener, xhr, event);
              };
              if (xhr.readyState === 4) void current.ready.then(deliver);
              else deliver();
            };
            return Reflect.apply(originalAddEventListener, xhr, [type, wrapped, options]);
          }

          return Reflect.apply(originalAddEventListener, xhr, [type, listener, options]);
        },
      });
    } catch {
      // Some engines may not allow shadowing; the hook still restores fetch.
    }
  };

  target.fetch = function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (!isEnabled()) return originalFetch(input, init);

    let url: URL | undefined;
    let kind: DownloadKind | undefined;
    try {
      url = effectiveUrl(input, baseHref);
      kind = url ? classifyDownloadUrl(url, effectiveMethod(input, init)) : undefined;
    } catch {
      return originalFetch(input, init);
    }
    if (!url || !kind) return originalFetch(input, init);

    const chatId = currentChatId(target);
    return originalFetch(input, init).then(async (response) => {
      try {
        if (kind === 'json') {
          return await processJsonResponse(response, bridge, mappings, chatId, now, baseHref);
        }
        return await processBytesResponse(response, url, bridge, mappings, chatId, now, maxBytes());
      } catch {
        // A hook must never break a download; manual mode remains available.
        bridge.notify('MANUAL_FALLBACK');
        return response;
      }
    });
  } as typeof target.fetch;

  originalXhrProto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    const method = String(args[0] ?? 'GET').toUpperCase();
    const rawUrl = args[1];
    let url: URL | undefined;
    try {
      if (rawUrl instanceof URL) url = rawUrl;
      else if (typeof rawUrl === 'string') url = new URL(rawUrl, baseHref);
    } catch {
      url = undefined;
    }

    const previous = xhrStates.get(this);
    previous?.resolveReady();
    const kind = url ? classifyDownloadUrl(url, method) : undefined;
    if (url && kind) {
      let resolveReady = (): void => {};
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });

      xhrStates.set(this, {
        url,
        kind,
        generation: (previous?.generation ?? 0) + 1,
        aborted: false,
        started: false,
        ready,
        resolveReady,
      });
      deferXhrListeners(this);
    } else {
      xhrStates.delete(this);
    }

    return Reflect.apply(originalOpen, this, args);
  } as typeof originalXhrProto.open;

  originalXhrProto.abort = function (this: XMLHttpRequest) {
    const state = xhrStates.get(this);
    if (state) {
      state.aborted = true;
      state.resolveReady();
    }
    return originalAbort.call(this);
  } as typeof originalXhrProto.abort;

  originalXhrProto.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const state = xhrStates.get(this);
    if (!state || state.aborted) return originalSend.call(this, body);
    if (!isEnabled()) {
      state.resolveReady();
      return originalSend.call(this, body);
    }

    const generation = state.generation;
    const strategy = xhrStrategy(this, state.kind);
    if (strategy === 'unsupported') {
      bridge.notify('MANUAL_FALLBACK');
      state.resolveReady();
      return originalSend.call(this, body);
    }

    const chatId = currentChatId(target);

    // Event handler attributes run before capture listeners in Chromium;
    // replace the handlers captured at send time and gate them on `ready`.
    const originalOnLoad = this.onload;
    if (typeof originalOnLoad === 'function') {
      this.onload = function (event: ProgressEvent): void {
        void state.ready.then(() => {
          if (!state.aborted) Reflect.apply(originalOnLoad, this, [event]);
        });
      };
    }

    const originalOnLoadEnd = this.onloadend;
    if (typeof originalOnLoadEnd === 'function') {
      this.onloadend = function (event: ProgressEvent): void {
        void state.ready.then(() => {
          if (!state.aborted) Reflect.apply(originalOnLoadEnd, this, [event]);
        });
      };
    }

    const originalOnReadyStateChange = this.onreadystatechange;
    if (typeof originalOnReadyStateChange === 'function') {
      this.onreadystatechange = function (event: Event): void {
        if (this.readyState !== 4) {
          Reflect.apply(originalOnReadyStateChange, this, [event]);
          return;
        }
        void state.ready.then(() => {
          if (!state.aborted) Reflect.apply(originalOnReadyStateChange, this, [event]);
        });
      };
    }

    const onReadyStateChange = (): void => {
      if (state.generation !== generation || state.aborted || state.started) return;
      if (this.readyState !== 4) return;
      state.started = true;

      if (this.status < 200 || this.status >= 300) {
        state.resolveReady();
        return;
      }

      const task =
        strategy === 'json'
          ? finishXhrJson(this, bridge, mappings, chatId, now, baseHref)
          : finishXhrBytes(this, state, bridge, mappings, chatId, now, maxBytes());

      void task
        .catch(() => {
          bridge.notify('MANUAL_FALLBACK');
        })
        .finally(() => {
          if (state.generation === generation) state.resolveReady();
        });
    };

    // Bypass the per-instance addEventListener wrapper for our internal hook.
    Reflect.apply(originalAddEventListener, this, ['readystatechange', onReadyStateChange, true]);

    try {
      return originalSend.call(this, body);
    } catch (error) {
      state.resolveReady();
      throw error;
    }
  } as typeof originalXhrProto.send;

  return () => {
    target.fetch = rawFetch;
    originalXhrProto.open = originalOpen;
    originalXhrProto.send = originalSend;
    originalXhrProto.abort = originalAbort;
    delete target.__DM_DOWNLOAD_HOOKS__;
  };
}
