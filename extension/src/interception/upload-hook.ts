/**
 * MAIN-world upload interception (M3b).
 *
 * Hooks `window.fetch` and `XMLHttpRequest.open/send` at document_start. Only
 * requests that look like ChatGPT file uploads are touched:
 *   - `POST /backend-api/files` metadata: match a captured File by name+size,
 *     anonymize it through ISOLATED, rewrite `file_name`/`file_size`;
 *   - byte transports: raw PUT (Azure/AWS), estuary FormData, Azure block
 *     uploads.
 *
 * Everything is fail-closed after the metadata request has been identified:
 * an internal error, missing File, unsupported format or unmatched transport
 * aborts the request and shows a toast. Non-target traffic is passed through
 * untouched. PII is never logged.
 */

import type { MainBridge } from './bridge-main';
import type { CapturedFileQueue } from './file-capture';
import { BridgeError, type BridgeErrorCode, MAX_FILE_BYTES, type ToastReason } from './protocol';

const METADATA_PATH_RE = /^\/backend-api\/files\/?$/u;
const ESTUARY_BYTES_PATH_RE = /^\/backend-api\/estuary\/upload_content_bytes\/?$/u;
const MASKED_TTL_MS = 2 * 60_000;
const MAX_MASKED_ENTRIES = 10;
const MAX_METADATA_RESPONSE = 64 * 1024;
/**
 * A metadata response has already been rewritten before the transport runs,
 * so its exact `upload_url` stays a fail-closed tombstone for the whole page
 * lifetime. A time-based expiry opened a fail-open window (R5). Memory stays
 * finite by count; when the bound drops the oldest URL, `overflow` remains set
 * and every unmatched PUT/POST to a known transport is aborted.
 */
const MAX_ANNOUNCED_URLS = 64;
/** Unreadable metadata responses are remembered until page unload (bounded). */
const MAX_UNANNOUNCED_UPLOADS = 64;

/** Headers that describe the old body and must not survive a rewrite. */
const BODY_DEPENDENT_HEADERS = [
  'content-length',
  'content-md5',
  'digest',
  'x-ms-blob-content-md5',
  'x-ms-content-crc64',
  'x-amz-checksum-crc32',
  'x-amz-checksum-crc32c',
  'x-amz-checksum-sha1',
  'x-amz-checksum-sha256',
  'x-amz-checksum-crc64nvme',
] as const;

declare global {
  interface Window {
    __DM_RELAY_HOOKS__?: boolean;
  }
}

type MetadataJson = Record<string, unknown> & {
  file_name: string;
  file_size: number;
};

interface MaskedUpload {
  bytes: Uint8Array;
  name: string;
  mime: string;
  /** Original `file_size`, used as a matching fallback. */
  originalSize: number;
  createdAt: number;
  /** Exact upload URLs reported by the metadata response. */
  urls: Set<string>;
  /**
   * A cloud size match handed this entry to a request that was not identified
   * by URL. The entry stays available for the exact `upload_url`, but any
   * further guess-based transport is aborted instead of passing the original
   * bytes through (R5-N1).
   */
  claimed?: boolean;
}

/**
 * Exact URL reported by a metadata response. Independent of the masked entry
 * lifetime: when the entry is gone, the URL must still abort instead of
 * letting the page retry with the original bytes (R2).
 */
interface AnnouncedUploadUrl {
  href: string;
  base: string;
  originalSize: number;
  maskedSize: number;
  /** FNV-1a fingerprint of the masked bytes; diagnostic only, never logged. */
  maskedHash: number;
}

/**
 * A metadata response could not be read (non-JSON, oversized, malformed or
 * without a usable `upload_url`). The upcoming transport cannot be pinned to an
 * exact URL; remember that fact for the page lifetime so a retry after the
 * masked entry expires cannot carry the original bytes to a known upload host
 * (R6). Values are never logged.
 */
interface UnannouncedUpload {
  originalSize: number;
  maskedSize: number;
  maskedHash: number;
}

interface BlockState {
  entry: MaskedUpload;
  /** The block that carries the whole masked file; retries resend it. */
  payloadBlockId: string;
  ts: number;
}

interface XhrState {
  method: string;
  url: URL;
  generation: number;
  aborted: boolean;
}

class HookAbort extends Error {
  readonly reason: ToastReason;

  constructor(reason: ToastReason) {
    super(reason);
    this.name = 'HookAbort';
    this.reason = reason;
  }
}

export interface InstallUploadHooksOptions {
  queue: CapturedFileQueue;
  bridge: MainBridge;
  target?: Window;
  now?: () => number;
  /** Protection state; defaults to enabled (fail-safe). */
  isEnabled?: () => boolean;
  /** Configured per-file limit; defaults to 25 MB until settings load. */
  maxBytes?: () => number;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type MetadataParse =
  | { kind: 'file'; json: MetadataJson }
  | { kind: 'not-file' }
  | { kind: 'invalid' };

/**
 * Distinguishes a file-create body from ordinary metadata traffic:
 * - `file`: both file fields are present and valid;
 * - `not-file`: valid JSON without file fields (safe pass-through);
 * - `invalid`: unparseable/malformed file-create metadata (fail-closed).
 */
function parseMetadataText(text: string): MetadataParse {
  if (text.length === 0 || text.length > 512 * 1024) return { kind: 'invalid' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(parsed)) return { kind: 'not-file' };

  const hasName = 'file_name' in parsed;
  const hasSize = 'file_size' in parsed;
  if (!hasName && !hasSize) return { kind: 'not-file' };
  if (!hasName || !hasSize) return { kind: 'invalid' };

  if (
    typeof parsed.file_name !== 'string' ||
    parsed.file_name.length === 0 ||
    parsed.file_name.length > 255
  ) {
    return { kind: 'invalid' };
  }
  if (
    typeof parsed.file_size !== 'number' ||
    !Number.isFinite(parsed.file_size) ||
    parsed.file_size < 0
  ) {
    return { kind: 'invalid' };
  }

  return { kind: 'file', json: parsed as MetadataJson };
}

function parseUploadUrl(
  value: string,
  baseHref: string,
): { href: string; base: string } | undefined {
  try {
    const url = new URL(value, baseHref);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return { href: url.href, base: `${url.origin}${url.pathname}` };
  } catch {
    return undefined;
  }
}

function pathMatches(url: URL, pattern: RegExp): boolean {
  return pattern.test(url.pathname);
}

function isKnownUploadHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'oaiusercontent.com' || host.endsWith('.oaiusercontent.com');
}

function isAzureBlock(url: URL): boolean {
  const comp = (url.searchParams.get('comp') ?? '').toLowerCase();
  return comp === 'block' || comp === 'blocklist';
}

function isEstuaryBytes(url: URL): boolean {
  return pathMatches(url, ESTUARY_BYTES_PATH_RE);
}

/**
 * Cross-origin object-storage hosts used by upload `upload_url`s (Azure SAS,
 * S3, CloudFront). A plain Azure SAS PUT has no `comp=block`, and an S3 PUT
 * has no distinguishing path, so host plus body size is the only signal when
 * the metadata response was unreadable (R4-M2).
 */
function isCloudBlobHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === 'blob.core.windows.net' ||
    host.endsWith('.blob.core.windows.net') ||
    host === 'amazonaws.com' ||
    host.endsWith('.amazonaws.com') ||
    host === 'cloudfront.net' ||
    host.endsWith('.cloudfront.net')
  );
}

/**
 * Transports that are known to carry file bytes. The size heuristic may only
 * claim an entry for these URLs (R3-N1): an unrelated same-size PUT/POST must
 * pass through and leave the entry for the real transport.
 */
function isProbableUploadTarget(url: URL): boolean {
  return isKnownUploadHost(url) || isEstuaryBytes(url) || isAzureBlock(url);
}

/** Signature query parameters of Azure SAS, S3 presigned and CloudFront URLs. */
const CLOUD_AUTH_QUERY_PARAMS = [
  'sig',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-algorithm',
  'signature',
  'key-pair-id',
  'policy',
] as const;

/**
 * A cloud object-storage write is an upload only when the request carries
 * upload credentials: a signed URL or the cloud SDK headers. Arbitrary PUTs to
 * `*.blob.core.windows.net`/`*.amazonaws.com`/`*.cloudfront.net` (telemetry,
 * other apps) must not be matched by size alone (R5-N1).
 */
function hasCloudUploadAuth(url: URL, headers?: Headers): boolean {
  for (const name of url.searchParams.keys()) {
    if ((CLOUD_AUTH_QUERY_PARAMS as readonly string[]).includes(name.toLowerCase())) return true;
  }
  if (!headers) return false;
  if (headers.has('x-ms-blob-type')) return true;
  for (const name of headers.keys()) {
    if (name.toLowerCase().startsWith('x-amz-')) return true;
  }
  return false;
}

function isCloudUploadTarget(url: URL, headers?: Headers): boolean {
  return isCloudBlobHost(url) && hasCloudUploadAuth(url, headers);
}

/**
 * A superset used only for size matching. Cloud blob hosts are deliberately
 * excluded from the unconditional fallback in `resolveEntryForUrl`: without an
 * exact `upload_url` they must prove the body has the original size (or be
 * aborted as an opaque stream) and carry upload credentials.
 */
function isSizeMatchTarget(url: URL, headers?: Headers): boolean {
  return isProbableUploadTarget(url) || isCloudUploadTarget(url, headers);
}

function isMultipart(headers: Headers): boolean {
  return (headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data');
}

function bodySize(body: unknown): number | undefined {
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  return undefined;
}

/** Cheap FNV-1a; only distinguishes announcements, never used for security. */
function fingerprintBytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isTextualEntry(entry: MaskedUpload): boolean {
  return (
    entry.mime.toLowerCase().startsWith('text/') ||
    /\.(txt|md|csv|json|xml|html|htm)$/iu.test(entry.name)
  );
}

function bridgeReason(code: BridgeErrorCode): ToastReason {
  switch (code) {
    case 'LIMIT':
    case 'UNSUPPORTED':
    case 'UNSUPPORTED_ARCHIVE':
    case 'TOO_MANY_ENTITIES':
    case 'NO_VAULT':
    case 'LOCKED':
    case 'DISABLED':
    case 'TIMEOUT':
    case 'ABORTED':
    case 'BRIDGE':
      return code;
    default:
      return 'INTERNAL';
  }
}

/**
 * Installs the hooks. Idempotent; the returned cleanup restores originals and
 * is only used by tests/dev tooling.
 */
export function installUploadHooks(options: InstallUploadHooksOptions): () => void {
  const target = options.target ?? window;
  const queue = options.queue;
  const bridge = options.bridge;
  const now = options.now ?? (() => Date.now());
  const isEnabled = options.isEnabled ?? (() => true);
  const limit = options.maxBytes ?? (() => MAX_FILE_BYTES);
  const baseHref = target.location.href;
  const pageOrigin = new URL(baseHref).origin;

  if (target.__DM_RELAY_HOOKS__) return () => {};
  target.__DM_RELAY_HOOKS__ = true;

  const isMetadataUrl = (url: URL): boolean =>
    url.origin === pageOrigin && pathMatches(url, METADATA_PATH_RE);
  const isEstuaryUpload = (url: URL): boolean => url.origin === pageOrigin && isEstuaryBytes(url);

  const maskedEntries: MaskedUpload[] = [];
  const announcedUrls: AnnouncedUploadUrl[] = [];
  const unannouncedUploads: UnannouncedUpload[] = [];
  const blockStates = new Map<string, BlockState>();
  let announcedOverflow = false;

  const enforceAnnouncementBound = (): void => {
    while (announcedUrls.length > MAX_ANNOUNCED_URLS) {
      announcedUrls.shift();
      announcedOverflow = true;
    }
  };

  /** Fail-closed state for transports whose exact URL is not remembered. */
  const isFailClosedUnknown = (): boolean => announcedOverflow || unannouncedUploads.length > 0;

  const isKnownTransportTarget = (url: URL, headers?: Headers): boolean =>
    isProbableUploadTarget(url) || isCloudUploadTarget(url, headers);

  const isUnknownFailClosedTarget = (url: URL, headers?: Headers): boolean =>
    isFailClosedUnknown() && isKnownTransportTarget(url, headers);

  const purge = (): void => {
    const cutoff = now() - MASKED_TTL_MS;
    while (maskedEntries.length > 0 && (maskedEntries[0]?.createdAt ?? 0) < cutoff) {
      maskedEntries.shift();
    }
    while (maskedEntries.length > MAX_MASKED_ENTRIES) maskedEntries.shift();

    for (const [key, state] of blockStates) {
      if (state.ts < cutoff) blockStates.delete(key);
    }
    enforceAnnouncementBound();
  };

  const rememberEntry = (entry: MaskedUpload): void => {
    purge();
    maskedEntries.push(entry);
    while (maskedEntries.length > MAX_MASKED_ENTRIES) maskedEntries.shift();
  };

  const forgetEntry = (entry: MaskedUpload): void => {
    const index = maskedEntries.indexOf(entry);
    if (index !== -1) maskedEntries.splice(index, 1);
  };

  const rememberAnnouncement = (
    entry: MaskedUpload,
    keys: { href: string; base: string },
  ): void => {
    const existing = announcedUrls.find((item) => item.href === keys.href);
    if (existing) {
      existing.originalSize = entry.originalSize;
      existing.maskedSize = entry.bytes.byteLength;
      existing.maskedHash = fingerprintBytes(entry.bytes);
      return;
    }
    announcedUrls.push({
      href: keys.href,
      base: keys.base,
      originalSize: entry.originalSize,
      maskedSize: entry.bytes.byteLength,
      maskedHash: fingerprintBytes(entry.bytes),
    });
    enforceAnnouncementBound();
  };

  const findAnnouncement = (url: URL): AnnouncedUploadUrl | undefined => {
    const href = url.href;
    const base = `${url.origin}${url.pathname}`;
    for (let index = announcedUrls.length - 1; index >= 0; index -= 1) {
      const item = announcedUrls[index];
      if (item && (item.href === href || item.base === base)) return item;
    }
    return undefined;
  };

  /**
   * The metadata response could not tell us the exact `upload_url`. Keep a
   * bounded page-lifetime marker: after the masked entry itself expires, an
   * unmatched PUT/POST to a known upload host must abort instead of receiving
   * the original bytes (R6). The fingerprint deduplicates retries.
   */
  const markUnannounced = (entry: MaskedUpload): void => {
    const maskedHash = fingerprintBytes(entry.bytes);
    const maskedSize = entry.bytes.byteLength;
    const existing = unannouncedUploads.some(
      (item) =>
        item.originalSize === entry.originalSize &&
        item.maskedSize === maskedSize &&
        item.maskedHash === maskedHash,
    );
    if (existing) return;
    unannouncedUploads.push({
      originalSize: entry.originalSize,
      maskedSize,
      maskedHash,
    });
    while (unannouncedUploads.length > MAX_UNANNOUNCED_UPLOADS) unannouncedUploads.shift();
  };

  const addUrls = (entry: MaskedUpload, value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const keys = parseUploadUrl(value, baseHref);
    if (!keys) return false;
    entry.urls.add(keys.href);
    entry.urls.add(keys.base);
    rememberAnnouncement(entry, keys);
    return true;
  };

  const findByUrl = (url: URL): MaskedUpload | undefined => {
    purge();
    const href = url.href;
    const base = `${url.origin}${url.pathname}`;
    // Newest first: the estuary endpoint is reused across uploads.
    for (let index = maskedEntries.length - 1; index >= 0; index -= 1) {
      const entry = maskedEntries[index];
      if (entry && (entry.urls.has(href) || entry.urls.has(base))) return entry;
    }
    return undefined;
  };

  const takeByUrl = (url: URL): MaskedUpload | undefined => {
    const entry = findByUrl(url);
    if (!entry) return undefined;
    const index = maskedEntries.indexOf(entry);
    if (index !== -1) maskedEntries.splice(index, 1);
    return entry;
  };

  const findByOriginalSize = (size: number): MaskedUpload | undefined => {
    purge();
    return maskedEntries.find((entry) => entry.originalSize === size);
  };

  const takeFallback = (): MaskedUpload | undefined => {
    purge();
    const index = maskedEntries.findIndex((entry) => !entry.claimed);
    if (index === -1) return undefined;
    return maskedEntries.splice(index, 1)[0];
  };

  const peekFallback = (): MaskedUpload | undefined => {
    purge();
    return maskedEntries.find((entry) => !entry.claimed);
  };

  const hasClaimedEntries = (): boolean => {
    purge();
    return maskedEntries.some((entry) => entry.claimed);
  };

  const hasPendingSize = (size: number): boolean => {
    purge();
    return maskedEntries.some((entry) => entry.originalSize === size);
  };

  const hasPendingEntries = (): boolean => {
    purge();
    return maskedEntries.length > 0;
  };

  /**
   * `allowGuess=false` (protection just turned off) only matches an exact URL
   * remembered from a metadata response. That lets an in-flight upload finish
   * with the masked bytes its rewritten metadata announced, while a brand-new
   * upload passes through untouched instead of being matched by size heuristics.
   */
  const resolveEntryForUrl = (
    url: URL,
    originalSize?: number,
    allowGuess = true,
    headers?: Headers,
  ): MaskedUpload | undefined => {
    const exact = takeByUrl(url);
    if (exact) return exact;
    // The metadata response announced this exact URL; if the entry is gone
    // (TTL, FIFO eviction or a consumed retry), never guess and never let the
    // original bytes through on a retry. Protection off is an explicit user
    // action: a fresh pass-through metadata request may reuse the endpoint.
    if (allowGuess && findAnnouncement(url)) throw new HookAbort('TRANSPORT');
    if (!allowGuess) return undefined;

    if (originalSize !== undefined && isSizeMatchTarget(url, headers)) {
      const bySize = findByOriginalSize(originalSize);
      if (bySize) {
        if (isCloudUploadTarget(url, headers)) {
          // A size-only cloud match cannot prove this is the real transport,
          // so the entry is claimed rather than consumed: the exact upload
          // URL may still use it, while another guess-based transport is
          // aborted below instead of passing the original bytes (R5-N1).
          if (bySize.claimed) throw new HookAbort('TRANSPORT');
          bySize.claimed = true;
          return bySize;
        }
        forgetEntry(bySize);
        return bySize;
      }
    }

    if (isProbableUploadTarget(url)) {
      const fallback = takeFallback();
      if (fallback) return fallback;
      if (hasClaimedEntries() || isFailClosedUnknown()) throw new HookAbort('TRANSPORT');
      return undefined;
    }
    if (isCloudUploadTarget(url, headers) && (hasClaimedEntries() || isFailClosedUnknown())) {
      throw new HookAbort('TRANSPORT');
    }
    return undefined;
  };

  const blockStateKey = (url: URL): string => {
    const params = [...url.searchParams.entries()]
      .filter(([key]) => key !== 'comp' && key !== 'blockid')
      .sort((left, right) => left[0].localeCompare(right[0]));
    const query = params.map(([key, value]) => `${key}=${value}`).join('&');
    return `${url.origin}${url.pathname}?${query}`;
  };

  const resolveBlockEntry = (url: URL, allowGuess = true): MaskedUpload | undefined => {
    const exact = findByUrl(url);
    if (exact) return exact;
    if (allowGuess && findAnnouncement(url)) throw new HookAbort('TRANSPORT');
    const fallback = allowGuess ? peekFallback() : undefined;
    if (fallback) return fallback;
    if (allowGuess && isFailClosedUnknown()) throw new HookAbort('TRANSPORT');
    return undefined;
  };

  const notifyFailure = (error: unknown): void => {
    let reason: ToastReason = 'INTERNAL';
    if (error instanceof HookAbort) {
      reason = error.reason;
    } else if (error instanceof BridgeError) {
      reason = bridgeReason(error.code);
    } else if (error instanceof DOMException && error.name === 'AbortError') {
      reason = 'ABORTED';
    }
    bridge.notify(reason);
  };

  /**
   * Aborts an XHR that has not reached native `send`. Calling `abort()` on an
   * OPENED XHR without the send flag may not fire `abort`, so dispatch one
   * explicitly; page wrappers then reject instead of hanging.
   */
  const failXhr = (xhr: XMLHttpRequest): void => {
    try {
      xhr.dispatchEvent(new ProgressEvent('abort'));
      xhr.dispatchEvent(new ProgressEvent('loadend'));
    } catch {
      // Synthetic event dispatch is best-effort.
    }
    try {
      xhr.abort();
    } catch {
      // Ignore a state error; the page already saw the abort event.
    }
  };

  const maskMetadata = async (
    json: MetadataJson,
  ): Promise<{ entry: MaskedUpload; body: string }> => {
    const captured = queue.take(json.file_name, json.file_size);
    if (!captured) throw new HookAbort('NO_FILE');
    if (captured.size > limit()) throw new HookAbort('LIMIT');

    const bytes = await captured.file.arrayBuffer();
    if (bytes.byteLength > limit()) throw new HookAbort('LIMIT');

    const mime = typeof json.mime_type === 'string' ? json.mime_type : captured.file.type;
    const result = await bridge.anonymizeFile({
      bytes,
      name: captured.name,
      mime,
    });

    const maskedBytes = new Uint8Array(result.maskedBytes);
    if (maskedBytes.byteLength === 0 || result.maskedName.length === 0) {
      throw new HookAbort('INTERNAL');
    }

    const maskedMime =
      typeof result.maskedMime === 'string' && result.maskedMime.length > 0
        ? result.maskedMime
        : undefined;

    const entry: MaskedUpload = {
      bytes: maskedBytes,
      name: result.maskedName,
      mime: maskedMime ?? (captured.file.type || mime),
      originalSize: captured.size,
      createdAt: now(),
      urls: new Set<string>(),
    };
    rememberEntry(entry);

    return {
      entry,
      // Legacy conversions change the payload format: keep the metadata and
      // the resolved MIME in sync with the bytes we are about to upload.
      body: JSON.stringify({
        ...json,
        file_name: entry.name,
        file_size: entry.bytes.byteLength,
        ...(maskedMime
          ? {
              mime_type: maskedMime,
              client_resolved_mime_type: maskedMime,
            }
          : {}),
      }),
    };
  };

  /**
   * Reads the cloned metadata response. Returns true only when a usable
   * `upload_url` was remembered; every other outcome marks the upload
   * unannounced and therefore fail-closed after the entry expires (R6).
   */
  const rememberUploadUrl = async (response: Response, entry: MaskedUpload): Promise<boolean> => {
    try {
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('json')) return false;

      const length = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(length) && length > MAX_METADATA_RESPONSE) return false;

      const clone = response.clone();
      const text = await clone.text();
      if (text.length > MAX_METADATA_RESPONSE) return false;

      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? addUrls(entry, parsed.upload_url) : false;
    } catch {
      // Unreadable response: the caller marks the upload unannounced.
      return false;
    }
  };

  const rememberXhrUploadUrl = (xhr: XMLHttpRequest, entry: MaskedUpload): void => {
    const inspect = (): void => {
      if (xhr.readyState !== 4) return;
      xhr.removeEventListener('readystatechange', inspect);
      let announced = false;
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          const text = xhr.responseText;
          if (text.length > MAX_METADATA_RESPONSE) {
            markUnannounced(entry);
            return;
          }
          const parsed: unknown = JSON.parse(text);
          announced = isRecord(parsed) ? addUrls(entry, parsed.upload_url) : false;
        } else if (xhr.responseType === 'json') {
          const parsed: unknown = xhr.response;
          announced = isRecord(parsed) ? addUrls(entry, parsed.upload_url) : false;
        }
      } catch {
        announced = false;
      }
      if (!announced) markUnannounced(entry);
    };
    xhr.addEventListener('readystatechange', inspect);
  };

  const headersFor = (input: RequestInfo | URL, init?: RequestInit): Headers => {
    const source =
      init?.headers ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
    const headers = new Headers(source);
    for (const name of BODY_DEPENDENT_HEADERS) headers.delete(name);
    return headers;
  };

  /** Headers for classification; never throws on exotic page headers. */
  const requestHeaders = (input: RequestInfo | URL, init?: RequestInit): Headers | undefined => {
    try {
      const source =
        init?.headers ??
        (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
      return source === undefined ? undefined : new Headers(source);
    } catch {
      return undefined;
    }
  };

  const sendFetchWithBody = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    body: BodyInit,
    headers: Headers,
    originalFetch: typeof fetch,
  ): Promise<Response> => {
    const nextInit: RequestInit = { ...init, body, headers };
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return originalFetch(new Request(input, nextInit));
    }
    return originalFetch(input, nextInit);
  };

  const readBodyText = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<string | undefined> => {
    const body = init?.body;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        try {
          return await body.text();
        } catch {
          return undefined;
        }
      }
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
      if (ArrayBuffer.isView(body)) {
        return new TextDecoder().decode(
          new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        );
      }
      return undefined;
    }

    if (typeof Request !== 'undefined' && input instanceof Request) {
      try {
        return await input.clone().text();
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const effectiveUrl = (input: RequestInfo | URL): URL | undefined => {
    const raw =
      typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
    try {
      return new URL(raw, baseHref);
    } catch {
      return undefined;
    }
  };

  const effectiveMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
    const explicit =
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : undefined);
    if (explicit) return explicit.toUpperCase();
    return init?.body !== undefined && init?.body !== null ? 'POST' : 'GET';
  };

  /**
   * After a metadata rewrite, only *probable* byte transports are aborted when
   * their body cannot be inspected: a known upload host/path, a remembered
   * exact upload URL, or a body whose size equals the pending original size.
   * Unrelated blob/stream traffic (telemetry, JSON Request bodies) passes
   * through, which bounds the over-blocking blast radius (R2-M2). Entries
   * expire after MASKED_TTL_MS.
   */
  const isOpaqueByteBody = (input: RequestInfo | URL, init?: RequestInit): boolean => {
    const method = effectiveMethod(input, init);
    if (method !== 'POST' && method !== 'PUT') return false;

    const body = init?.body;
    const requestStream =
      typeof Request !== 'undefined' && input instanceof Request && input.body !== null;
    if ((body === undefined || body === null) && !requestStream) return false;
    if (typeof body === 'string' || body instanceof URLSearchParams) return false;
    if (typeof Document !== 'undefined' && body instanceof Document) return false;

    const contentType = (
      (init?.headers ? new Headers(init.headers).get('content-type') : undefined) ??
      (typeof Request !== 'undefined' && input instanceof Request
        ? input.headers.get('content-type')
        : undefined) ??
      ''
    ).toLowerCase();
    if (contentType.includes('json')) return false;

    const url = effectiveUrl(input);
    if (!url) return false;
    if (findByUrl(url) || findAnnouncement(url)) return true;
    if (isKnownUploadHost(url) || isEstuaryBytes(url) || isAzureBlock(url)) return true;

    const headers = requestHeaders(input, init);
    const failClosedTarget = isUnknownFailClosedTarget(url, headers);
    const sizeTarget = isSizeMatchTarget(url, headers);
    const size = bodySize(body);
    if (size !== undefined && sizeTarget) return hasPendingSize(size) || failClosedTarget;

    if (sizeTarget && typeof Request !== 'undefined' && input instanceof Request) {
      const declared = Number(input.headers.get('content-length') ?? 'NaN');
      if (Number.isFinite(declared) && hasPendingSize(declared)) return true;
    }

    // An opaque stream to cross-origin object storage has no size to compare:
    // while a rewritten upload is in flight, fail closed instead of letting
    // the original bytes reach the signed URL (R4-M2). The same applies after
    // announcement overflow or an unreadable metadata response (R5/R6).
    if (size === undefined && isCloudBlobHost(url)) return hasPendingEntries() || failClosedTarget;
    return failClosedTarget;
  };

  const isOpaqueXhrBody = (method: string, body: unknown, url: URL | undefined): boolean => {
    if (method !== 'POST' && method !== 'PUT') return false;
    if (body === null || body === undefined) return false;
    if (typeof body === 'string' || body instanceof URLSearchParams) return false;
    if (typeof Document !== 'undefined' && body instanceof Document) return false;

    const size = bodySize(body);
    if (
      size !== undefined &&
      url &&
      isSizeMatchTarget(url) &&
      (hasPendingSize(size) || isUnknownFailClosedTarget(url))
    ) {
      return true;
    }
    if (!url) return false;
    return (
      findByUrl(url) !== undefined ||
      findAnnouncement(url) !== undefined ||
      isKnownUploadHost(url) ||
      isEstuaryBytes(url) ||
      isAzureBlock(url) ||
      (isFailClosedUnknown() && isSizeMatchTarget(url))
    );
  };

  const isByteCandidate = (method: string, url: URL, size?: number, headers?: Headers): boolean => {
    // R5/R6: when the exact URL is unknown (announcement overflow) or was
    // never readable, an unmatched request to a known transport must be
    // classified as a byte candidate so the abort path can fail closed.
    const failClosedTarget = isUnknownFailClosedTarget(url, headers);
    if (method === 'PUT') {
      if (findByUrl(url)) return true;
      if (findAnnouncement(url)) return true;
      // A plain size match on an unknown host is not enough to claim the
      // entry; that is how unrelated PUT traffic used to steal it (R3-N1).
      if (!hasPendingEntries() && !failClosedTarget) return false;
      if (isKnownUploadHost(url) || isAzureBlock(url)) return true;
      // Cross-origin object storage (Azure SAS without `comp`, S3, CDN) is
      // only claimed when the request carries upload credentials and the
      // body size equals the original file (R4-M2/R5-N1). Under fail-closed
      // state, credentials alone identify the transport, so size is optional.
      return (
        isCloudUploadTarget(url, headers) &&
        (failClosedTarget || (size !== undefined && hasPendingSize(size)))
      );
    }
    if (method === 'POST') {
      if (findByUrl(url) || findAnnouncement(url)) return true;
      if ((hasPendingEntries() || failClosedTarget) && isEstuaryUpload(url)) return true;
    }
    return false;
  };

  const formEntry = (form: FormData, url: URL, allowGuess = true): MaskedUpload | undefined => {
    const uploadUrl = form.get('upload_url');
    if (typeof uploadUrl === 'string') {
      const keys = parseUploadUrl(uploadUrl, baseHref);
      if (keys) {
        const target = new URL(keys.href);
        const exact = takeByUrl(target);
        if (exact) return exact;
        if (allowGuess && findAnnouncement(target)) throw new HookAbort('TRANSPORT');
      }
    }
    return resolveEntryForUrl(url, undefined, allowGuess);
  };

  const rewriteFormData = (form: FormData, entry: MaskedUpload): FormData => {
    // Always use the masked payload MIME; the original File type may describe
    // a `.doc`/`.xls` body that no longer matches the bytes.
    form.set(
      'file',
      new File([entry.bytes as unknown as BlobPart], entry.name, { type: entry.mime }),
    );
    return form;
  };

  const processMetadataFetch = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    originalFetch: typeof fetch,
  ): Promise<Response> => {
    const text = await readBodyText(input, init);
    const parsed: MetadataParse =
      text === undefined ? { kind: 'invalid' } : parseMetadataText(text);

    if (parsed.kind === 'not-file') return originalFetch(input, init);
    if (parsed.kind === 'invalid') {
      notifyFailure(new HookAbort('INTERNAL'));
      throw abortError();
    }

    let entry: MaskedUpload | undefined;
    try {
      const masked = await maskMetadata(parsed.json);
      entry = masked.entry;
      const headers = headersFor(input, init);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');

      const response = await sendFetchWithBody(input, init, masked.body, headers, originalFetch);
      const announced = await rememberUploadUrl(response, entry);
      if (!announced) markUnannounced(entry);
      return response;
    } catch (error) {
      if (entry) forgetEntry(entry);
      if (error instanceof BridgeError && error.code === 'DISABLED') {
        // Protection was switched off while the metadata request was in
        // flight: pass it through untouched, exactly as if it were never seen.
        return originalFetch(input, init);
      }
      notifyFailure(error);
      throw abortError();
    }
  };

  const processAzureBlockFetch = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    url: URL,
    originalFetch: typeof fetch,
    strict: boolean,
  ): Promise<Response> => {
    const comp = (url.searchParams.get('comp') ?? '').toLowerCase();
    const key = blockStateKey(url);

    if (comp === 'blocklist') {
      blockStates.delete(key);
      return originalFetch(input, init);
    }

    try {
      const blockId = url.searchParams.get('blockid') ?? '';
      if (blockId.length === 0) throw new HookAbort('TRANSPORT');

      let state = blockStates.get(key);
      if (!state) {
        const entry = resolveBlockEntry(url, strict);
        if (!entry) {
          if (strict && (hasPendingEntries() || isFailClosedUnknown())) {
            throw new HookAbort('TRANSPORT');
          }
          return originalFetch(input, init);
        }
        state = {
          entry,
          payloadBlockId: blockId,
          ts: now(),
        };
        blockStates.set(key, state);
      }

      state.ts = now();
      const body = blockId === state.payloadBlockId ? state.entry.bytes : new Uint8Array(0);
      const headers = headersFor(input, init);

      return await sendFetchWithBody(
        input,
        init,
        body as unknown as BodyInit,
        headers,
        originalFetch,
      );
    } catch (error) {
      notifyFailure(error);
      throw abortError();
    }
  };

  const processBytesFetch = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    url: URL,
    method: string,
    originalFetch: typeof fetch,
    strict: boolean,
  ): Promise<Response> => {
    try {
      const headers = headersFor(input, init);

      if (method === 'POST' && init?.body instanceof FormData) {
        const entry = formEntry(init.body, url, strict);
        if (!entry) {
          if (strict && hasPendingEntries()) throw new HookAbort('TRANSPORT');
          return originalFetch(input, init);
        }
        const rewritten = rewriteFormData(init.body, entry);
        headers.delete('content-type');
        return await sendFetchWithBody(input, init, rewritten, headers, originalFetch);
      }

      if (method === 'POST' && isMultipart(headers)) {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          // A Request body cannot be inspected as FormData; never forward an
          // untouched multipart upload after metadata was rewritten.
          if (
            strict &&
            (findAnnouncement(url) ||
              hasPendingEntries() ||
              isUnknownFailClosedTarget(url, requestHeaders(input, init)))
          ) {
            throw new HookAbort('TRANSPORT');
          }
          return originalFetch(input, init);
        }
      }

      if (method === 'PUT' && isAzureBlock(url)) {
        return await processAzureBlockFetch(input, init, url, originalFetch, strict);
      }

      const entry = resolveEntryForUrl(
        url,
        bodySize(init?.body),
        strict,
        requestHeaders(input, init),
      );
      if (!entry) {
        if (strict && hasPendingEntries()) throw new HookAbort('TRANSPORT');
        return originalFetch(input, init);
      }

      const originalBody = init?.body;
      const body =
        typeof originalBody === 'string'
          ? isTextualEntry(entry)
            ? new TextDecoder().decode(entry.bytes)
            : (() => {
                throw new HookAbort('TRANSPORT');
              })()
          : (entry.bytes as unknown as BodyInit);

      if (
        !headers.has('content-type') &&
        typeof Blob !== 'undefined' &&
        originalBody instanceof Blob
      ) {
        if (originalBody.type) headers.set('content-type', originalBody.type);
      }

      return await sendFetchWithBody(input, init, body, headers, originalFetch);
    } catch (error) {
      notifyFailure(error);
      throw abortError();
    }
  };

  const classifyFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): { kind: 'metadata' | 'bytes'; url: URL; method: string } | undefined => {
    const url = effectiveUrl(input);
    if (!url) return undefined;
    const method = effectiveMethod(input, init);
    const headers = requestHeaders(input, init);

    if (method === 'POST' && isMetadataUrl(url)) {
      return { kind: 'metadata', url, method };
    }
    if (isByteCandidate(method, url, bodySize(init?.body), headers)) {
      return { kind: 'bytes', url, method };
    }
    // Unknown multipart/binary transports after a metadata rewrite must not
    // fall through with the original file bytes. A size match only counts for
    // a probable upload target (R3-N1). Under announcement overflow or an
    // unreadable metadata response, a known transport is classified even
    // without a live entry so the fail-closed abort path runs (R5/R6).
    const failClosedTarget = isUnknownFailClosedTarget(url, headers);
    if (method === 'POST' && (hasPendingEntries() || failClosedTarget)) {
      if (init?.body instanceof FormData) return { kind: 'bytes', url, method };
      const size = bodySize(init?.body);
      if (
        size !== undefined &&
        isSizeMatchTarget(url, headers) &&
        (hasPendingSize(size) || failClosedTarget)
      ) {
        return { kind: 'bytes', url, method };
      }
    }
    return undefined;
  };

  const rawFetch = target.fetch;
  const originalFetch = rawFetch.bind(target);
  const XhrClass = (target as Window & typeof globalThis).XMLHttpRequest;
  const originalXhrProto = XhrClass.prototype;
  const originalOpen = originalXhrProto.open;
  const originalSend = originalXhrProto.send;
  const originalAbort = originalXhrProto.abort;
  const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();

  target.fetch = function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let classified: ReturnType<typeof classifyFetch>;
    try {
      classified = classifyFetch(input, init);
    } catch {
      // A hook must never break non-target page traffic.
      return originalFetch(input, init);
    }

    // Protection off: a new metadata request is passed through untouched.
    // Byte transports are still allowed to finish an already-rewritten
    // in-flight upload (exact URL match only) to keep metadata and body
    // consistent; otherwise they pass through as well.
    const strict = isEnabled();
    if (!classified) {
      // Fail closed only for probable transports while a rewritten upload is
      // in flight; unrelated blob/stream/JSON traffic still passes through.
      if (
        strict &&
        (hasPendingEntries() || isFailClosedUnknown()) &&
        isOpaqueByteBody(input, init)
      ) {
        notifyFailure(new HookAbort('TRANSPORT'));
        return Promise.reject(abortError());
      }
      return originalFetch(input, init);
    }
    if (classified.kind === 'metadata') {
      if (!strict) return originalFetch(input, init);
      return processMetadataFetch(input, init, originalFetch);
    }
    return processBytesFetch(input, init, classified.url, classified.method, originalFetch, strict);
  } as typeof target.fetch;

  originalXhrProto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    const method = String(args[0] ?? 'GET').toUpperCase();
    const rawUrl = args[1];
    const url =
      rawUrl instanceof URL
        ? rawUrl
        : typeof rawUrl === 'string'
          ? (() => {
              try {
                return new URL(rawUrl, baseHref);
              } catch {
                return undefined;
              }
            })()
          : undefined;

    const previous = xhrStates.get(this);
    if (url) {
      xhrStates.set(this, {
        method,
        url,
        generation: (previous?.generation ?? 0) + 1,
        aborted: false,
      });
    } else {
      xhrStates.delete(this);
    }

    return Reflect.apply(originalOpen, this, args);
  } as typeof originalXhrProto.open;

  originalXhrProto.abort = function (this: XMLHttpRequest) {
    const state = xhrStates.get(this);
    if (state) state.aborted = true;
    return originalAbort.call(this);
  } as typeof originalXhrProto.abort;

  const isXhrActive = (state: XhrState, generation: number): boolean =>
    !state.aborted && state.generation === generation;

  const processMetadataXhr = async (
    xhr: XMLHttpRequest,
    state: XhrState,
    generation: number,
    body: Document | XMLHttpRequestBodyInit | null | undefined,
  ): Promise<void> => {
    const text = await bodyToText(body);
    const parsed: MetadataParse =
      text === undefined ? { kind: 'invalid' } : parseMetadataText(text);

    if (parsed.kind === 'invalid') {
      // A metadata POST we cannot inspect is fail-closed: never risk sending
      // the original file bytes unprocessed.
      notifyFailure(new HookAbort('INTERNAL'));
      if (isXhrActive(state, generation)) failXhr(xhr);
      return;
    }

    if (parsed.kind === 'not-file') {
      if (isXhrActive(state, generation)) originalSend.call(xhr, body);
      return;
    }

    let entry: MaskedUpload | undefined;
    try {
      const masked = await maskMetadata(parsed.json);
      entry = masked.entry;
      if (!isXhrActive(state, generation)) {
        forgetEntry(entry);
        return;
      }
      rememberXhrUploadUrl(xhr, masked.entry);
      originalSend.call(xhr, masked.body);
    } catch (error) {
      if (entry) forgetEntry(entry);
      if (error instanceof BridgeError && error.code === 'DISABLED') {
        // Same as the fetch path: protection was turned off mid-flight, so
        // send the request exactly as the page built it.
        if (isXhrActive(state, generation)) originalSend.call(xhr, body);
        return;
      }
      notifyFailure(error);
      if (isXhrActive(state, generation)) failXhr(xhr);
    }
  };

  const rewriteXhrBody = (
    state: XhrState,
    body: Document | XMLHttpRequestBodyInit | null | undefined,
    strict: boolean,
  ): { body: XMLHttpRequestBodyInit | null } | undefined => {
    if (body === null || body === undefined) return undefined;
    const size = bodySize(body);
    const failClosedTarget = isUnknownFailClosedTarget(state.url);
    const candidate =
      isByteCandidate(state.method, state.url, size) ||
      (state.method === 'POST' &&
        (hasPendingEntries() || failClosedTarget) &&
        (body instanceof FormData ||
          (size !== undefined &&
            isSizeMatchTarget(state.url) &&
            (hasPendingSize(size) || failClosedTarget))));
    if (!candidate) return undefined;

    if (state.method === 'POST' && body instanceof FormData) {
      const entry = formEntry(body, state.url, strict);
      if (!entry) {
        if (strict && hasPendingEntries()) throw new HookAbort('TRANSPORT');
        return undefined;
      }
      return { body: rewriteFormData(body, entry) };
    }

    if (state.method === 'PUT' && isAzureBlock(state.url)) {
      const comp = (state.url.searchParams.get('comp') ?? '').toLowerCase();
      if (comp === 'blocklist') {
        blockStates.delete(blockStateKey(state.url));
        return undefined;
      }

      const key = blockStateKey(state.url);
      const blockId = state.url.searchParams.get('blockid') ?? '';
      if (blockId.length === 0) throw new HookAbort('TRANSPORT');

      let blockState = blockStates.get(key);
      if (!blockState) {
        const entry = resolveBlockEntry(state.url, strict);
        if (!entry) {
          if (strict && (hasPendingEntries() || isFailClosedUnknown())) {
            throw new HookAbort('TRANSPORT');
          }
          return undefined;
        }
        blockState = {
          entry,
          payloadBlockId: blockId,
          ts: now(),
        };
        blockStates.set(key, blockState);
      }
      blockState.ts = now();
      return {
        body:
          blockId === blockState.payloadBlockId
            ? (blockState.entry.bytes as unknown as XMLHttpRequestBodyInit)
            : (new Uint8Array(0) as unknown as XMLHttpRequestBodyInit),
      };
    }

    const entry = resolveEntryForUrl(state.url, size, strict);
    if (!entry) {
      if (strict && hasPendingEntries()) throw new HookAbort('TRANSPORT');
      return undefined;
    }

    if (typeof body === 'string') {
      if (!isTextualEntry(entry)) throw new HookAbort('TRANSPORT');
      return { body: new TextDecoder().decode(entry.bytes) };
    }

    return { body: entry.bytes as unknown as XMLHttpRequestBodyInit };
  };

  originalXhrProto.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const state = xhrStates.get(this);
    if (!state) return originalSend.call(this, body);

    const generation = state.generation;
    const strict = isEnabled();
    if (state.method === 'POST' && isMetadataUrl(state.url)) {
      if (!strict) return originalSend.call(this, body);
      void processMetadataXhr(this, state, generation, body);
      return;
    }

    // Announced URL without a live entry: abort before the page's original
    // bytes can leave, even for an empty/opaque body (R2).
    if (
      strict &&
      (state.method === 'PUT' || state.method === 'POST') &&
      !findByUrl(state.url) &&
      findAnnouncement(state.url)
    ) {
      notifyFailure(new HookAbort('TRANSPORT'));
      failXhr(this);
      return;
    }

    try {
      const rewritten = rewriteXhrBody(state, body, strict);
      if (rewritten) return originalSend.call(this, rewritten.body);
    } catch (error) {
      notifyFailure(error);
      failXhr(this);
      return;
    }

    if (
      strict &&
      (hasPendingEntries() || isFailClosedUnknown()) &&
      isOpaqueXhrBody(state.method, body, state.url)
    ) {
      notifyFailure(new HookAbort('TRANSPORT'));
      failXhr(this);
      return;
    }

    return originalSend.call(this, body);
  } as typeof originalXhrProto.send;

  return () => {
    target.fetch = rawFetch;
    originalXhrProto.open = originalOpen;
    originalXhrProto.send = originalSend;
    originalXhrProto.abort = originalAbort;
    delete target.__DM_RELAY_HOOKS__;
  };
}

async function bodyToText(
  body: Document | XMLHttpRequestBodyInit | null | undefined,
): Promise<string | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    try {
      return await body.text();
    } catch {
      return undefined;
    }
  }
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  return undefined;
}
