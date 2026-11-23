/**
 * ISOLATED-world relay (M3b/M4).
 *
 * Receives validated MAIN requests, talks to the background router and sends
 * back only masked/restored bytes plus PII-free counters. The page never gets a
 * runtime API, and the background never returns canonical PII to this layer
 * except inside file bytes that the page is already downloading.
 */

import { browser } from 'wxt/browser';
import { parseTags } from '../core/tag';
import { base64ToBytes, bytesToBase64 } from '../shared/base64';
import type {
  AnonymizeFileResult,
  RelayResponse,
  RestoreFileResult,
  RestoreNameResult,
} from '../shared/messages';
import { pluralRu } from '../ui/api';
import {
  type AnonymizeBridgeResult,
  BRIDGE_VERSION,
  type BridgeErrorCode,
  type BridgeFailureResponse,
  type BridgeRequest,
  type BridgeResponse,
  ISOLATED_SOURCE,
  MAX_RESULT_BYTES,
  parseBridgeRequest,
  RELAY_TIMEOUT_MS,
  RESTORE_TIMEOUT_MS,
  type RestoreFileBridgeResult,
  type RestoreNameBridgeResult,
  readArrayBuffer,
  type ToastReason,
  toExactArrayBuffer,
} from './protocol';
import { installSettingsSync } from './settings-sync';
import { showToast } from './toast';

const CHAT_PATH_RE = /^\/c\/([^/?#]+)/u;
const PENDING_KEY = 'dmrelay:pending';
const BIND_KEY = 'dmrelay:chat-bind';
const VALID_CHAT_ID_RE = /^[A-Za-z0-9-]{1,256}$/u;
const MAX_SEEN_IDS = 100;

export const ERROR_TEXT: Record<BridgeErrorCode, string> = {
  LIMIT: 'Файл больше лимита — загрузка отменена',
  UNSUPPORTED: 'Формат файла не поддерживается — загрузка отменена',
  UNSUPPORTED_ARCHIVE: 'Архив ZIP64 или зашифрованный ZIP не поддерживается — загрузка отменена',
  TOO_MANY_ENTITIES:
    'Файл содержит слишком много имён или сущностей для обработки. Разбейте его на части.',
  NO_VAULT: 'Хранилище не найдено — загрузка отменена',
  INTERNAL: 'Ошибка обработки — загрузка отменена',
  LOCKED: 'Хранилище заблокировано — разблокируйте в окне расширения. Загрузка отменена',
  DISABLED: 'Защита выключена — загрузка не перехвачена',
  TIMEOUT: 'Превышено время обработки — загрузка отменена',
  ABORTED: 'Загрузка отменена',
  BRIDGE: 'Ошибка связи с расширением — загрузка отменена',
};

export const RESTORE_ERROR_TEXT: Record<BridgeErrorCode, string> = {
  LIMIT: 'Файл больше лимита — восстановление пропущено',
  UNSUPPORTED: 'Формат файла не поддерживается — восстановление пропущено',
  UNSUPPORTED_ARCHIVE:
    'Архив ZIP64 или зашифрованный ZIP не поддерживается — восстановление пропущено',
  TOO_MANY_ENTITIES:
    'Файл содержит слишком много имён или сущностей для обработки. Разбейте его на части.',
  NO_VAULT: 'Хранилище не найдено — файл сохранён без изменений',
  INTERNAL: 'Ошибка восстановления — файл сохранён без изменений',
  LOCKED: 'Хранилище заблокировано — разблокируйте в окне расширения. Файл сохранён без изменений',
  DISABLED: 'Защита выключена — файл сохранён без изменений',
  TIMEOUT: 'Превышено время восстановления — файл сохранён без изменений',
  ABORTED: 'Восстановление отменено',
  BRIDGE: 'Ошибка связи с расширением — файл сохранён без изменений',
};

const REASON_TEXT: Record<ToastReason, string> = {
  NO_FILE: 'Файл не найден в очереди — загрузка отменена',
  UNSUPPORTED: ERROR_TEXT.UNSUPPORTED,
  UNSUPPORTED_ARCHIVE: ERROR_TEXT.UNSUPPORTED_ARCHIVE,
  LIMIT: ERROR_TEXT.LIMIT,
  TOO_MANY_ENTITIES: ERROR_TEXT.TOO_MANY_ENTITIES,
  NO_VAULT: 'Хранилище не найдено — файл сохранён без изменений',
  INTERNAL: ERROR_TEXT.INTERNAL,
  LOCKED: 'Хранилище заблокировано — разблокируйте в окне расширения. Загрузка отменена',
  DISABLED: 'Защита выключена — загрузка не перехвачена',
  TIMEOUT: ERROR_TEXT.TIMEOUT,
  TRANSPORT: 'Не удалось подменить данные — загрузка отменена',
  ABORTED: ERROR_TEXT.ABORTED,
  BRIDGE: ERROR_TEXT.BRIDGE,
  LARGE_FILE: 'Файл больше лимита — восстановление пропущено',
  MANUAL_FALLBACK: 'Автоматическое восстановление не удалось — используйте ручной режим',
};

const BACKGROUND_CODES = new Set<BridgeErrorCode>([
  'LIMIT',
  'UNSUPPORTED',
  'UNSUPPORTED_ARCHIVE',
  'TOO_MANY_ENTITIES',
  'NO_VAULT',
  'INTERNAL',
  'LOCKED',
  'DISABLED',
]);

function chatIdFromPath(target: Window = window): string | undefined {
  const match = target.location.pathname.match(CHAT_PATH_RE);
  const fromPath = match?.[1];
  return fromPath && fromPath.length <= 256 ? fromPath : undefined;
}

function resolveChatId(target: Window = window): string | undefined {
  const fromPath = chatIdFromPath(target);
  if (fromPath) return fromPath;

  try {
    const existing = sessionStorage.getItem(PENDING_KEY);
    if (existing && /^[A-Za-z0-9-]{1,256}$/u.test(existing)) return existing;

    const generated =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    sessionStorage.setItem(PENDING_KEY, generated);
    return generated;
  } catch {
    // Safari private mode / disabled storage: keep the upload usable; the
    // vault is still discoverable by its tag prefix.
    return undefined;
  }
}

interface ChatBinding {
  pendingId: string;
  chatId: string;
}

function readChatBinding(target: Window): ChatBinding | undefined {
  try {
    const raw = target.sessionStorage.getItem(BIND_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pendingId !== 'string' || typeof record.chatId !== 'string') return undefined;
    if (!VALID_CHAT_ID_RE.test(record.pendingId) || !VALID_CHAT_ID_RE.test(record.chatId)) {
      return undefined;
    }
    return { pendingId: record.pendingId, chatId: record.chatId };
  } catch {
    return undefined;
  }
}

/** Pending id only when it is known to belong to the given real chat. */
function pendingChatIdFor(target: Window, chatId: string | undefined): string | undefined {
  if (!chatId) return undefined;
  const binding = readChatBinding(target);
  return binding?.chatId === chatId ? binding.pendingId : undefined;
}

function requestChatBind(pendingId: string, chatId: string): void {
  if (typeof browser === 'undefined') return;
  try {
    const pending = browser.runtime.sendMessage({
      type: 'dm:bind-chat' as const,
      requestId: `bind-${pendingId}`.slice(0, 128),
      payload: { pendingId, chatId },
    });
    void Promise.resolve(pending).catch(() => {});
  } catch {
    // Binding is best-effort; restore also falls back to the pending id.
  }
}

/**
 * Records `pendingId -> /c/<id>` and tells the background. Called on SPA
 * navigations; safe to call repeatedly (the pending marker is consumed once).
 */
export function bindPendingToRealChat(target: Window, chatId: string): boolean {
  if (!VALID_CHAT_ID_RE.test(chatId)) return false;
  try {
    const pending = target.sessionStorage.getItem(PENDING_KEY);
    if (!pending || !VALID_CHAT_ID_RE.test(pending) || pending === chatId) return false;

    target.sessionStorage.setItem(BIND_KEY, JSON.stringify({ pendingId: pending, chatId }));
    // The next upload from `/` starts a new chat and must get a new pending id.
    target.sessionStorage.removeItem(PENDING_KEY);
    requestChatBind(pending, chatId);
    return true;
  } catch {
    return false;
  }
}

/** One navigation check: bind a new-chat pending id or do nothing. */
export function syncChatBinding(target: Window = window): void {
  const chatId = chatIdFromPath(target);
  if (chatId) bindPendingToRealChat(target, chatId);
}

function installChatBinding(target: Window): void {
  syncChatBinding(target);
  try {
    target.addEventListener('popstate', () => syncChatBinding(target));
  } catch {
    // Non-DOM test target.
  }
  try {
    const navigation = (
      target as Window & {
        navigation?: { addEventListener?: (type: string, listener: () => void) => void };
      }
    ).navigation;
    navigation?.addEventListener?.('navigate', () => syncChatBinding(target));
  } catch {
    // Navigation API is optional (older Safari).
  }

  // In an ISOLATED world the page's own pushState calls may not hit this
  // wrapper; the poll below is the reliable fallback.
  for (const method of ['pushState', 'replaceState'] as const) {
    try {
      const history = target.history;
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = function (this: History, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args) as unknown;
        syncChatBinding(target);
        return result;
      } as History['pushState'];
    } catch {
      // Some engines disallow shadowing; popstate/navigation still apply.
    }
  }

  try {
    target.setInterval(() => syncChatBinding(target), 1000);
  } catch {
    // No timers in a minimal test target.
  }
}

function sendWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sanitizeMessage(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) {
    return 'Internal error';
  }
  return value;
}

/** Exported for unit tests (code mapping must stay observable). */
export function backgroundError(response: unknown): BridgeFailureResponse['error'] {
  if (typeof response !== 'object' || response === null) {
    return { code: 'BRIDGE', message: 'Extension did not respond' };
  }

  const record = response as Record<string, unknown>;
  if (record.ok === false && typeof record.error === 'object' && record.error !== null) {
    const error = record.error as Record<string, unknown>;
    const code = error.code;
    if (typeof code === 'string' && BACKGROUND_CODES.has(code as BridgeErrorCode)) {
      return { code: code as BridgeErrorCode, message: sanitizeMessage(error.message) };
    }
  }

  return { code: 'INTERNAL', message: 'Internal error' };
}

function errorFromUnknown(error: unknown): BridgeFailureResponse['error'] {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string' && Object.hasOwn(ERROR_TEXT, code)) {
      const message = 'message' in error ? sanitizeMessage(error.message) : 'Internal error';
      return { code: code as BridgeErrorCode, message };
    }
  }
  return { code: 'INTERNAL', message: 'Internal error' };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 64);
}

function maskedResult(result: AnonymizeFileResult): AnonymizeBridgeResult | undefined {
  const maskBytes =
    typeof result.maskedBytes === 'string' ? base64ToBytes(result.maskedBytes) : undefined;
  const buffer = maskBytes ? toExactArrayBuffer(maskBytes) : readArrayBuffer(result.maskedBytes);
  if (!buffer || buffer.byteLength === 0) return undefined;

  const entities = Array.isArray(result.entities)
    ? result.entities
        .filter((entity) => typeof entity?.label === 'string' && Number.isFinite(entity.count))
        .map((entity) => ({ label: entity.label, count: Math.trunc(entity.count) }))
    : [];

  if (typeof result.maskedName !== 'string' || result.maskedName.length === 0) return undefined;

  const maskedMime =
    typeof result.maskedMime === 'string' &&
    result.maskedMime.length > 0 &&
    result.maskedMime.length <= 255
      ? result.maskedMime
      : undefined;

  return {
    maskedBytes: buffer,
    maskedName: result.maskedName.slice(0, 255),
    ...(maskedMime ? { maskedMime } : {}),
    entities,
    warnings: stringList(result.warnings),
  };
}

function restoredBytes(value: RestoreFileResult['bytes']): ArrayBuffer | undefined {
  if (typeof value === 'string') {
    const bytes = base64ToBytes(value);
    if (!bytes) return undefined;
    const buffer = toExactArrayBuffer(bytes);
    return buffer.byteLength > 0 && buffer.byteLength <= MAX_RESULT_BYTES ? buffer : undefined;
  }

  const buffer = readArrayBuffer(value);
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_RESULT_BYTES) return undefined;
  return buffer;
}

function restoreFileResult(result: RestoreFileResult): RestoreFileBridgeResult | undefined {
  const buffer = restoredBytes(result.bytes);
  if (!buffer) return undefined;
  if (typeof result.fileName !== 'string' || result.fileName.length === 0) return undefined;
  if (!Number.isFinite(result.replacements) || result.replacements < 0) return undefined;

  return {
    bytes: buffer,
    fileName: result.fileName.slice(0, 255),
    replacements: Math.trunc(result.replacements),
    unknownTags: stringList(result.unknownTags),
    warnings: stringList(result.warnings),
  };
}

function restoreNameResult(result: RestoreNameResult): RestoreNameBridgeResult | undefined {
  if (typeof result.fileName !== 'string' || result.fileName.length === 0) return undefined;
  if (!Number.isFinite(result.replacements) || result.replacements < 0) return undefined;

  return {
    fileName: result.fileName.slice(0, 255),
    replacements: Math.trunc(result.replacements),
    unknownTags: stringList(result.unknownTags),
    warnings: stringList(result.warnings),
  };
}

const TOAST_WARNING_LIMIT = 3;

function toastSummary(
  entities: AnonymizeBridgeResult['entities'],
  warnings: AnonymizeBridgeResult['warnings'] = [],
): { text: string; kind: 'success' | 'warning' } {
  const total = entities.reduce((sum, entity) => sum + Math.max(0, entity.count), 0);
  const byLabel = new Map<string, number>();
  for (const entity of entities) {
    byLabel.set(entity.label, (byLabel.get(entity.label) ?? 0) + entity.count);
  }

  const detail = [...byLabel.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => `${label}×${count}`)
    .join(', ');

  const base =
    detail.length > 0 ? `Анонимизировано: ${total} (${detail})` : `Анонимизировано: ${total}`;
  if (warnings.length === 0) return { text: base, kind: 'success' };

  // The auto path used to show only counts: adapter warnings (unscanned
  // embedded objects, altChunk, inferred encoding, PDF metadata) were visible
  // only in the popup. Show the first few plus an exact remainder (R3).
  const shown = warnings.slice(0, TOAST_WARNING_LIMIT);
  const hidden = warnings.length - shown.length;
  const text = `${base}\n${shown.join('\n')}${hidden > 0 ? `\n…ещё ${hidden}` : ''}`;
  return { text, kind: 'warning' };
}

function restoreToast(result: { replacements: number; unknownTags: string[] }): void {
  const tags = `${result.replacements} ${pluralRu(result.replacements, ['тег', 'тега', 'тегов'])}`;
  const unknown = `${result.unknownTags.length} ${pluralRu(result.unknownTags.length, ['тег', 'тега', 'тегов'])}`;
  if (result.replacements > 0) {
    showToast(`Восстановлено: ${tags}`, 'success');
    if (result.unknownTags.length > 0) {
      showToast(`Не распознано: ${unknown}`, 'warning');
    }
    return;
  }
  if (result.unknownTags.length > 0) {
    showToast(`Не распознано: ${unknown}`, 'warning');
  }
}

function postResponse(target: Window, response: BridgeResponse, transfer: Transferable[]): void {
  try {
    target.postMessage(response, target.location.origin, transfer);
  } catch {
    // The page may have navigated away; nothing else to do.
  }
}

function postFailure(target: Window, id: string, error: BridgeFailureResponse['error']): void {
  postResponse(
    target,
    {
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id,
      ok: false,
      error,
    },
    [],
  );
}

async function anonymizeInBackground(
  requestId: string,
  payload: { bytes: ArrayBuffer; name: string; mime: string; chatId?: string },
): Promise<AnonymizeBridgeResult> {
  const message = {
    type: 'dm:anonymize-file' as const,
    requestId,
    payload: {
      bytes: bytesToBase64(new Uint8Array(payload.bytes)),
      name: payload.name,
      mime: payload.mime,
      chatId: payload.chatId,
    },
  };

  let response: RelayResponse<AnonymizeFileResult> | undefined;
  try {
    response = await sendWithTimeout(
      browser.runtime.sendMessage(message) as Promise<RelayResponse<AnonymizeFileResult>>,
      RELAY_TIMEOUT_MS,
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'timeout';
    throw {
      code: timedOut ? 'TIMEOUT' : 'BRIDGE',
      message: timedOut ? 'File processing timed out' : 'Extension did not respond',
    } satisfies BridgeFailureResponse['error'];
  }

  if (response?.ok !== true || !response.result) {
    throw backgroundError(response);
  }

  const result = maskedResult(response.result);
  if (!result) throw { code: 'INTERNAL', message: 'Malformed background result' };
  return result;
}

async function restoreFileInBackground(
  requestId: string,
  payload: {
    bytes: ArrayBuffer;
    name: string;
    mime: string;
    chatId?: string;
    pendingChatId?: string;
    prefix?: string;
  },
): Promise<RestoreFileBridgeResult> {
  const message = {
    type: 'dm:restore-file' as const,
    requestId,
    payload: {
      bytes: bytesToBase64(new Uint8Array(payload.bytes)),
      name: payload.name,
      mime: payload.mime,
      chatId: payload.chatId,
      pendingChatId: payload.pendingChatId,
      prefix: payload.prefix,
    },
  };

  let response: RelayResponse<RestoreFileResult> | undefined;
  try {
    response = await sendWithTimeout(
      browser.runtime.sendMessage(message) as Promise<RelayResponse<RestoreFileResult>>,
      RESTORE_TIMEOUT_MS,
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'timeout';
    throw {
      code: timedOut ? 'TIMEOUT' : 'BRIDGE',
      message: timedOut ? 'Restore timed out' : 'Extension did not respond',
    } satisfies BridgeFailureResponse['error'];
  }

  if (response?.ok !== true || !response.result) {
    throw backgroundError(response);
  }

  const result = restoreFileResult(response.result);
  if (!result) throw { code: 'INTERNAL', message: 'Malformed background result' };
  return result;
}

async function restoreNameInBackground(
  requestId: string,
  payload: { name: string; chatId?: string; pendingChatId?: string; prefix?: string },
): Promise<RestoreNameBridgeResult> {
  const message = {
    type: 'dm:restore-name' as const,
    requestId,
    payload,
  };

  let response: RelayResponse<RestoreNameResult> | undefined;
  try {
    response = await sendWithTimeout(
      browser.runtime.sendMessage(message) as Promise<RelayResponse<RestoreNameResult>>,
      RESTORE_TIMEOUT_MS,
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'timeout';
    throw {
      code: timedOut ? 'TIMEOUT' : 'BRIDGE',
      message: timedOut ? 'Restore timed out' : 'Extension did not respond',
    } satisfies BridgeFailureResponse['error'];
  }

  if (response?.ok !== true || !response.result) {
    throw backgroundError(response);
  }

  const result = restoreNameResult(response.result);
  if (!result) throw { code: 'INTERNAL', message: 'Malformed background result' };
  return result;
}

async function dispatchRequest(target: Window, request: BridgeRequest): Promise<void> {
  if (request.type === 'anonymize-file') {
    const chatId = resolveChatId(target);
    try {
      const result = await anonymizeInBackground(request.id, { ...request.payload, chatId });
      postResponse(
        target,
        {
          source: ISOLATED_SOURCE,
          v: BRIDGE_VERSION,
          id: request.id,
          ok: true,
          result,
        },
        [result.maskedBytes],
      );
      const summary = toastSummary(result.entities, result.warnings);
      showToast(summary.text, summary.kind);
    } catch (error) {
      const failure = errorFromUnknown(error);
      postFailure(target, request.id, failure);
      showToast(ERROR_TEXT[failure.code], 'error');
    }
    return;
  }

  if (request.type === 'restore-file') {
    const chatId = request.payload.chatId ?? chatIdFromPath(target);
    const pendingChatId = request.payload.pendingChatId ?? pendingChatIdFor(target, chatId);
    try {
      const result = await restoreFileInBackground(request.id, {
        ...request.payload,
        chatId,
        pendingChatId,
      });
      postResponse(
        target,
        {
          source: ISOLATED_SOURCE,
          v: BRIDGE_VERSION,
          id: request.id,
          ok: true,
          result,
        },
        [result.bytes],
      );
      restoreToast(result);
    } catch (error) {
      const failure = errorFromUnknown(error);
      postFailure(target, request.id, failure);
      const hasTags = Boolean(request.payload.prefix) || parseTags(request.payload.name).length > 0;
      if (failure.code !== 'NO_VAULT' || hasTags) {
        showToast(RESTORE_ERROR_TEXT[failure.code], 'error');
      }
    }
    return;
  }

  if (request.type === 'restore-name') {
    const chatId = request.payload.chatId ?? chatIdFromPath(target);
    const pendingChatId = request.payload.pendingChatId ?? pendingChatIdFor(target, chatId);
    try {
      const result = await restoreNameInBackground(request.id, {
        ...request.payload,
        chatId,
        pendingChatId,
      });
      postResponse(
        target,
        {
          source: ISOLATED_SOURCE,
          v: BRIDGE_VERSION,
          id: request.id,
          ok: true,
          result,
        },
        [],
      );
      restoreToast(result);
    } catch (error) {
      const failure = errorFromUnknown(error);
      postFailure(target, request.id, failure);
      showToast(RESTORE_ERROR_TEXT[failure.code], 'error');
    }
  }
}

/**
 * Installs the ISOLATED listener at document_start. Idempotent per window.
 */
export function installIsolatedRelay(target: Window = window): void {
  const seen = new Set<string>();
  const installed = (target as Window & { __DM_RELAY_ISOLATED__?: boolean }).__DM_RELAY_ISOLATED__;
  if (installed) return;
  (target as Window & { __DM_RELAY_ISOLATED__?: boolean }).__DM_RELAY_ISOLATED__ = true;

  target.addEventListener('message', (event: MessageEvent) => {
    // Same-document only; ignore other frames and foreign origins.
    if (event.source !== target) return;
    if (event.origin !== target.location.origin) return;

    const request = parseBridgeRequest(event.data);
    if (!request) return;

    if (request.type === 'notify') {
      showToast(REASON_TEXT[request.payload.reason], 'error');
      return;
    }

    if (seen.has(request.id)) return;
    seen.add(request.id);
    if (seen.size > MAX_SEEN_IDS) {
      const oldest = seen.values().next().value;
      if (typeof oldest === 'string') seen.delete(oldest);
    }

    void dispatchRequest(target, request);
  });

  installChatBinding(target);

  const markProtection = (enabled: boolean): void => {
    try {
      target.document.documentElement.dataset.dmProtection = enabled ? 'on' : 'off';
    } catch {
      // Dataset is a test/debug marker only.
    }
  };

  // Fail-safe until the background answers: MAIN defaults to enabled and the
  // dataset says "on"; the real value replaces it immediately after load.
  markProtection(true);
  installSettingsSync((state) => {
    markProtection(state.enabled);
    try {
      target.postMessage(
        {
          source: ISOLATED_SOURCE,
          v: BRIDGE_VERSION,
          type: 'settings',
          enabled: state.enabled,
          ...(state.maxBytes === undefined ? {} : { maxBytes: state.maxBytes }),
        },
        target.location.origin,
      );
    } catch {
      // The page may be navigating away; MAIN keeps its last known state.
    }
  });
}
