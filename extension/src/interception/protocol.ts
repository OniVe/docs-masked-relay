/**
 * MAIN <-> ISOLATED bridge protocol (M3b).
 *
 * The page world never sees the extension APIs; only masked bytes and
 * PII-free counters cross back. Every message is validated on both sides and
 * anything malformed is ignored (ISOLATED) or treated as a failed request
 * (MAIN). Keep this module free of `browser`/`window` imports so it can be
 * used from either world and from unit tests.
 */

export const BRIDGE_VERSION = 1 as const;
export const MAIN_SOURCE = 'dm-relay-main' as const;
export const ISOLATED_SOURCE = 'dm-relay-isolated' as const;

/** Default automatic limit; the popup/options `maxBytes` setting overrides it. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Absolute ceiling shared with `settings.maxBytes` (spec §3). */
export const MAX_CONFIGURED_BYTES = 100 * 1024 * 1024;
/** Inbound bridge slack above the hard ceiling (protocol overhead). */
export const MAX_BRIDGE_BYTES = MAX_CONFIGURED_BYTES + 1024 * 1024;
/**
 * Masked output can grow from tags; allow headroom above the input limit while
 * still bounding what MAIN is willing to receive.
 */
export const MAX_RESULT_BYTES = MAX_CONFIGURED_BYTES * 2;
export const RELAY_TIMEOUT_MS = 60_000;
/** Restore is a single vault lookup + format parse (spec §4). */
export const RESTORE_TIMEOUT_MS = 30_000;

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 255;
const MAX_CHAT_ID_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 400;

/** Background error codes plus bridge-local failures. */
export type BridgeErrorCode =
  | 'LIMIT'
  | 'UNSUPPORTED'
  /** ZIP64 or encrypted OOXML archive; constant message, no entry names. */
  | 'UNSUPPORTED_ARCHIVE'
  /** Name/entity density guard; the file was rejected before masking. */
  | 'TOO_MANY_ENTITIES'
  | 'NO_VAULT'
  | 'INTERNAL'
  | 'LOCKED'
  | 'DISABLED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'BRIDGE';

/** Reasons MAIN may ask ISOLATED to show; mapped to fixed Russian text. */
export type ToastReason =
  | 'NO_FILE'
  | 'UNSUPPORTED'
  | 'UNSUPPORTED_ARCHIVE'
  | 'LIMIT'
  | 'TOO_MANY_ENTITIES'
  | 'NO_VAULT'
  | 'INTERNAL'
  | 'LOCKED'
  | 'DISABLED'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'ABORTED'
  | 'BRIDGE'
  | 'LARGE_FILE'
  | 'MANUAL_FALLBACK';

export interface AnonymizeBridgePayload {
  /** Exact slice; transferred to ISOLATED and detached in MAIN. */
  bytes: ArrayBuffer;
  name: string;
  mime: string;
  chatId?: string;
}

/** Download bytes: masked bytes go to ISOLATED, restored bytes come back. */
export interface RestoreFileBridgePayload {
  bytes: ArrayBuffer;
  name: string;
  mime: string;
  chatId?: string;
  /** Pending id bound to this chat; fallback when the vault index lags. */
  pendingChatId?: string;
  /** Vault prefix extracted from a tagged `file_name`; primary lookup. */
  prefix?: string;
}

/** Download metadata: restore tags in the JSON `file_name` only. */
export interface RestoreNameBridgePayload {
  name: string;
  chatId?: string;
  /** Pending id bound to this chat; fallback when the vault index lags. */
  pendingChatId?: string;
  prefix?: string;
}

export interface NotifyBridgePayload {
  reason: ToastReason;
}

export interface BridgeRequestMap {
  'anonymize-file': AnonymizeBridgePayload;
  'restore-file': RestoreFileBridgePayload;
  'restore-name': RestoreNameBridgePayload;
  notify: NotifyBridgePayload;
}

export type BridgeRequestType = keyof BridgeRequestMap;

export type BridgeRequest = {
  [K in BridgeRequestType]: {
    source: typeof MAIN_SOURCE;
    v: typeof BRIDGE_VERSION;
    id: string;
    type: K;
    payload: BridgeRequestMap[K];
  };
}[BridgeRequestType];

/** Safe entity projection: tags/counters only, never canonical values. */
export interface BridgeEntityInfo {
  label: string;
  count: number;
}

export interface AnonymizeBridgeResult {
  maskedBytes: ArrayBuffer;
  maskedName: string;
  /** MIME of the masked bytes; absent means "keep the source MIME". */
  maskedMime?: string;
  entities: BridgeEntityInfo[];
  warnings: string[];
}

export interface RestoreFileBridgeResult {
  bytes: ArrayBuffer;
  fileName: string;
  replacements: number;
  unknownTags: string[];
  warnings: string[];
}

export interface RestoreNameBridgeResult {
  fileName: string;
  replacements: number;
  unknownTags: string[];
  warnings: string[];
}

export type BridgeResult =
  | AnonymizeBridgeResult
  | RestoreFileBridgeResult
  | RestoreNameBridgeResult;

interface BridgeSuccessBase {
  source: typeof ISOLATED_SOURCE;
  v: typeof BRIDGE_VERSION;
  id: string;
  ok: true;
}

export type BridgeSuccessResponse =
  | (BridgeSuccessBase & { result: AnonymizeBridgeResult })
  | (BridgeSuccessBase & { result: RestoreFileBridgeResult })
  | (BridgeSuccessBase & { result: RestoreNameBridgeResult });

export interface BridgeFailureResponse {
  source: typeof ISOLATED_SOURCE;
  v: typeof BRIDGE_VERSION;
  id: string;
  ok: false;
  error: {
    code: BridgeErrorCode;
    message: string;
  };
}

export type BridgeResponse = BridgeSuccessResponse | BridgeFailureResponse;

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maxLength;
}

/**
 * Returns an exact ArrayBuffer for structured-clone/transfer. Typed-array
 * views are copied so a transfer never detaches an unrelated backing buffer.
 */
export function readArrayBuffer(value: unknown): ArrayBuffer | undefined {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return copy.buffer;
  }
  return undefined;
}

export function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

const TOAST_REASONS = new Set<ToastReason>([
  'NO_FILE',
  'UNSUPPORTED',
  'UNSUPPORTED_ARCHIVE',
  'LIMIT',
  'TOO_MANY_ENTITIES',
  'NO_VAULT',
  'INTERNAL',
  'LOCKED',
  'DISABLED',
  'TIMEOUT',
  'TRANSPORT',
  'ABORTED',
  'BRIDGE',
  'LARGE_FILE',
  'MANUAL_FALLBACK',
]);

const PREFIX_RE = /^[A-Z0-9]{5}$/u;

/** `undefined` = absent; `null` = present but invalid. */
function parseOptionalPrefix(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  return PREFIX_RE.test(upper) ? upper : null;
}

function parseOptionalChatId(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return isBoundedString(value, MAX_CHAT_ID_LENGTH) ? value : null;
}

function parseAnonymizePayload(value: unknown): AnonymizeBridgePayload | undefined {
  if (!isRecord(value)) return undefined;

  const bytes = readArrayBuffer(value.bytes);
  const name = value.name;
  const mime = value.mime;
  const chatId = value.chatId;

  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_BRIDGE_BYTES) return undefined;
  if (!isBoundedString(name, MAX_NAME_LENGTH)) return undefined;
  if (!isBoundedString(mime, MAX_NAME_LENGTH, true)) return undefined;

  if (chatId !== undefined && !isBoundedString(chatId, MAX_CHAT_ID_LENGTH)) return undefined;

  return { bytes, name, mime, chatId };
}

function parseRestoreFilePayload(value: unknown): RestoreFileBridgePayload | undefined {
  if (!isRecord(value)) return undefined;

  const bytes = readArrayBuffer(value.bytes);
  const name = value.name;
  const mime = value.mime;
  const chatId = parseOptionalChatId(value.chatId);
  const pendingChatId = parseOptionalChatId(value.pendingChatId);
  const prefix = parseOptionalPrefix(value.prefix);

  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_BRIDGE_BYTES) return undefined;
  if (!isBoundedString(name, MAX_NAME_LENGTH)) return undefined;
  if (!isBoundedString(mime, MAX_NAME_LENGTH, true)) return undefined;
  if (chatId === null || pendingChatId === null || prefix === null) return undefined;

  return { bytes, name, mime, chatId, pendingChatId, prefix };
}

function parseRestoreNamePayload(value: unknown): RestoreNameBridgePayload | undefined {
  if (!isRecord(value)) return undefined;

  const name = value.name;
  const chatId = parseOptionalChatId(value.chatId);
  const pendingChatId = parseOptionalChatId(value.pendingChatId);
  const prefix = parseOptionalPrefix(value.prefix);

  if (!isBoundedString(name, MAX_NAME_LENGTH)) return undefined;
  if (chatId === null || pendingChatId === null || prefix === null) return undefined;

  return { name, chatId, pendingChatId, prefix };
}

function parseNotifyPayload(value: unknown): NotifyBridgePayload | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.reason !== 'string' || !TOAST_REASONS.has(value.reason as ToastReason)) {
    return undefined;
  }
  return { reason: value.reason as ToastReason };
}

/** Validates an incoming request in ISOLATED; `undefined` = not ours. */
export function parseBridgeRequest(value: unknown): BridgeRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (value.source !== MAIN_SOURCE || value.v !== BRIDGE_VERSION) return undefined;
  if (!isBoundedString(value.id, MAX_ID_LENGTH)) return undefined;

  switch (value.type) {
    case 'anonymize-file': {
      const payload = parseAnonymizePayload(value.payload);
      if (!payload) return undefined;
      return {
        source: MAIN_SOURCE,
        v: BRIDGE_VERSION,
        id: value.id,
        type: 'anonymize-file',
        payload,
      };
    }
    case 'restore-file': {
      const payload = parseRestoreFilePayload(value.payload);
      if (!payload) return undefined;
      return {
        source: MAIN_SOURCE,
        v: BRIDGE_VERSION,
        id: value.id,
        type: 'restore-file',
        payload,
      };
    }
    case 'restore-name': {
      const payload = parseRestoreNamePayload(value.payload);
      if (!payload) return undefined;
      return {
        source: MAIN_SOURCE,
        v: BRIDGE_VERSION,
        id: value.id,
        type: 'restore-name',
        payload,
      };
    }
    case 'notify': {
      const payload = parseNotifyPayload(value.payload);
      if (!payload) return undefined;
      return {
        source: MAIN_SOURCE,
        v: BRIDGE_VERSION,
        id: value.id,
        type: 'notify',
        payload,
      };
    }
    default:
      return undefined;
  }
}

const ERROR_CODES = new Set<BridgeErrorCode>([
  'LIMIT',
  'UNSUPPORTED',
  'UNSUPPORTED_ARCHIVE',
  'TOO_MANY_ENTITIES',
  'NO_VAULT',
  'INTERNAL',
  'LOCKED',
  'DISABLED',
  'TIMEOUT',
  'ABORTED',
  'BRIDGE',
]);

/**
 * ISOLATED -> MAIN protection state push. It is not a request/response and
 * carries no id; MAIN defaults to enabled until the first push (fail-safe).
 */
export interface SettingsPush {
  source: typeof ISOLATED_SOURCE;
  v: typeof BRIDGE_VERSION;
  type: 'settings';
  enabled: boolean;
  /** Configured per-file limit; absent means "keep the current value". */
  maxBytes?: number;
}

export interface ProtectionStatePush {
  enabled: boolean;
  maxBytes?: number;
}

/** Returns the pushed protection state, or `undefined` for foreign messages. */
export function parseSettingsPush(value: unknown): ProtectionStatePush | undefined {
  if (!isRecord(value)) return undefined;
  if (value.source !== ISOLATED_SOURCE || value.v !== BRIDGE_VERSION) return undefined;
  if (value.type !== 'settings') return undefined;
  if (typeof value.enabled !== 'boolean') return undefined;

  const maxBytes = value.maxBytes;
  if (
    maxBytes !== undefined &&
    (typeof maxBytes !== 'number' ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_CONFIGURED_BYTES)
  ) {
    return undefined;
  }
  return maxBytes === undefined ? { enabled: value.enabled } : { enabled: value.enabled, maxBytes };
}

function parseEntity(value: unknown): BridgeEntityInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (!isBoundedString(value.label, 32)) return undefined;
  if (typeof value.count !== 'number' || !Number.isFinite(value.count) || value.count < 0) {
    return undefined;
  }
  return { label: value.label, count: Math.trunc(value.count) };
}

function parseStringList(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  if (!value.every((item) => isBoundedString(item, MAX_MESSAGE_LENGTH))) return undefined;
  return [...value];
}

function parseRestoreCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

function parseAnonymizeResult(value: unknown): AnonymizeBridgeResult | undefined {
  if (!isRecord(value)) return undefined;

  const maskedBytes = readArrayBuffer(value.maskedBytes);
  const maskedName = value.maskedName;
  const warnings = parseStringList(value.warnings, 64);
  const entities = value.entities;
  const maskedMime =
    value.maskedMime === undefined
      ? undefined
      : isBoundedString(value.maskedMime, MAX_NAME_LENGTH)
        ? value.maskedMime
        : null;

  if (!maskedBytes || maskedBytes.byteLength === 0 || maskedBytes.byteLength > MAX_RESULT_BYTES) {
    return undefined;
  }
  if (!isBoundedString(maskedName, MAX_NAME_LENGTH)) return undefined;
  if (maskedMime === null) return undefined;
  if (!warnings) return undefined;
  if (!Array.isArray(entities) || entities.length > 256) return undefined;

  const parsedEntities: BridgeEntityInfo[] = [];
  for (const entity of entities) {
    const parsed = parseEntity(entity);
    if (!parsed) return undefined;
    parsedEntities.push(parsed);
  }

  return {
    maskedBytes,
    maskedName,
    ...(maskedMime ? { maskedMime } : {}),
    entities: parsedEntities,
    warnings,
  };
}

function parseRestoreFileResult(value: unknown): RestoreFileBridgeResult | undefined {
  if (!isRecord(value)) return undefined;

  const bytes = readArrayBuffer(value.bytes);
  const fileName = value.fileName;
  const replacements = parseRestoreCount(value.replacements);
  const unknownTags = parseStringList(value.unknownTags, 64);
  const warnings = parseStringList(value.warnings, 64);

  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_RESULT_BYTES) return undefined;
  if (!isBoundedString(fileName, MAX_NAME_LENGTH)) return undefined;
  if (replacements === undefined || !unknownTags || !warnings) return undefined;

  return { bytes, fileName, replacements, unknownTags, warnings };
}

function parseRestoreNameResult(value: unknown): RestoreNameBridgeResult | undefined {
  if (!isRecord(value)) return undefined;

  const fileName = value.fileName;
  const replacements = parseRestoreCount(value.replacements);
  const unknownTags = parseStringList(value.unknownTags, 64);
  const warnings = parseStringList(value.warnings, 64);

  if (!isBoundedString(fileName, MAX_NAME_LENGTH)) return undefined;
  if (replacements === undefined || !unknownTags || !warnings) return undefined;

  return { fileName, replacements, unknownTags, warnings };
}

function parseBridgeResult(value: unknown): BridgeResult | undefined {
  if (!isRecord(value)) return undefined;
  if ('maskedBytes' in value) return parseAnonymizeResult(value);
  if ('bytes' in value) return parseRestoreFileResult(value);
  if ('fileName' in value) return parseRestoreNameResult(value);
  return undefined;
}

export type BridgeResultKind = 'anonymize-file' | 'restore-file' | 'restore-name';

export function bridgeResultKind(result: BridgeResult): BridgeResultKind {
  if ('maskedBytes' in result) return 'anonymize-file';
  if ('bytes' in result) return 'restore-file';
  return 'restore-name';
}

/** Validates a response in MAIN; foreign/unknown messages are ignored. */
export function parseBridgeResponse(value: unknown): BridgeResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (value.source !== ISOLATED_SOURCE || value.v !== BRIDGE_VERSION) return undefined;
  if (!isBoundedString(value.id, MAX_ID_LENGTH)) return undefined;

  if (value.ok === true) {
    const result = parseBridgeResult(value.result);
    if (!result) return undefined;
    // `parseBridgeResult` validated the shape of exactly one result variant.
    return {
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id: value.id,
      ok: true,
      result,
    } as BridgeSuccessResponse;
  }

  if (value.ok === false && isRecord(value.error)) {
    const code = value.error.code;
    const message = value.error.message;
    if (typeof code !== 'string' || !ERROR_CODES.has(code as BridgeErrorCode)) return undefined;
    if (!isBoundedString(message, MAX_MESSAGE_LENGTH, true)) return undefined;
    return {
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id: value.id,
      ok: false,
      error: { code: code as BridgeErrorCode, message },
    };
  }

  return undefined;
}
