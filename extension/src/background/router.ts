/**
 * Background message router.
 *
 * `handleMessage` is a pure async function so it can be smoke-tested in Node;
 * `registerRouter` is the only part that touches `browser.runtime`. Requests
 * are validated before any vault/format work, and every failure is mapped to a
 * stable code with a constant, PII-free message.
 *
 * `dm:ping` stays with the legacy M0 listener in `entrypoints/background.ts`
 * (same `{ok, version}` marker); this router owns file and vault operations.
 */

import { browser } from 'wxt/browser';
import { base64ToBytes, bytesToBase64 } from '../shared/base64';
import type {
  AnonymizeFileResult,
  AppSettings,
  RelayFailureCode,
  RelayResponse,
  RestoreFileResult,
  SettingsPatch,
  VaultChangePassphrasePayload,
  VaultDeletePayload,
  VaultImportPayload,
  VaultPassphrasePayload,
  VaultUnlockPayload,
} from '../shared/messages';
import { clearAllData } from './clear';
import { RelayError } from './errors';
import { processAnonymize, processRestore, processRestoreName } from './process';
import { getSettings, MAX_MAX_BYTES, setSettings } from './settings';
import { exportVaults, importVaults, MAX_BACKUP_BASE64_LENGTH } from './vault-export';
import {
  bindChat,
  changePassphrase,
  deleteVault,
  disablePassphrase,
  enablePassphrase,
  getVaultStatus,
  initVaultStore,
  listVaults,
  lockVaults,
  refreshAutoLockPolicy,
  unlockVaults,
} from './vault-store';

const ROUTED_TYPES = new Set([
  'dm:anonymize-file',
  'dm:restore-file',
  'dm:restore-name',
  'dm:vault-list',
  'dm:vault-delete',
  'dm:settings-get',
  'dm:settings-set',
  'dm:vault-status',
  'dm:vault-lock',
  'dm:vault-unlock',
  'dm:vault-set-passphrase',
  'dm:vault-change-passphrase',
  'dm:vault-remove-passphrase',
  'dm:vault-export',
  'dm:vault-import',
  'dm:bind-chat',
  'dm:clear-data',
]);

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 255;
const MAX_CHAT_ID_LENGTH = 256;
const MAX_VAULT_ID_LENGTH = 128;
const MAX_PASSPHRASE_LENGTH = 1024;
const MAX_BASE64_LENGTH = Math.ceil((MAX_MAX_BYTES * 4) / 3) + 8;
const PREFIX_RE = /^[A-Za-z0-9]{5}$/u;

interface ParsedFilePayload {
  bytes: Uint8Array;
  name: string;
  mime: string;
  chatId?: string;
  pendingChatId?: string;
  prefix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, maxLength: number, allowEmpty = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!allowEmpty && value.length === 0) return undefined;
  if (value.length > maxLength) return undefined;
  return value;
}

/** `undefined` = absent, `null` = present but invalid. */
function optionalString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return readString(value, maxLength) ?? null;
}

function optionalPrefix(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !PREFIX_RE.test(value)) return null;
  return value.toUpperCase();
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_BASE64_LENGTH) return undefined;
    return base64ToBytes(value);
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function parseFilePayload(value: unknown): ParsedFilePayload | undefined {
  if (!isRecord(value)) return undefined;

  const bytes = toBytes(value.bytes);
  const name = readString(value.name, MAX_NAME_LENGTH);
  const mime = readString(value.mime, MAX_NAME_LENGTH, true);
  const chatId = optionalString(value.chatId, MAX_CHAT_ID_LENGTH);
  const pendingChatId = optionalString(value.pendingChatId, MAX_CHAT_ID_LENGTH);
  const prefix = optionalPrefix(value.prefix);

  if (!bytes || name === undefined || mime === undefined) return undefined;
  if (chatId === null || pendingChatId === null || prefix === null) return undefined;

  return { bytes, name, mime, chatId, pendingChatId, prefix };
}

interface ParsedRestoreNamePayload {
  name: string;
  chatId?: string;
  pendingChatId?: string;
  prefix?: string;
}

function parseRestoreNamePayload(value: unknown): ParsedRestoreNamePayload | undefined {
  if (!isRecord(value)) return undefined;

  const name = readString(value.name, MAX_NAME_LENGTH);
  const chatId = optionalString(value.chatId, MAX_CHAT_ID_LENGTH);
  const pendingChatId = optionalString(value.pendingChatId, MAX_CHAT_ID_LENGTH);
  const prefix = optionalPrefix(value.prefix);

  if (name === undefined || chatId === null || pendingChatId === null || prefix === null) {
    return undefined;
  }
  return { name, chatId, pendingChatId, prefix };
}

function parseDeletePayload(value: unknown): VaultDeletePayload | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id, MAX_VAULT_ID_LENGTH);
  return id === undefined ? undefined : { id };
}

function parseBindChatPayload(value: unknown): { pendingId: string; chatId: string } | undefined {
  if (!isRecord(value)) return undefined;
  const pendingId = readString(value.pendingId, MAX_CHAT_ID_LENGTH);
  const chatId = readString(value.chatId, MAX_CHAT_ID_LENGTH);
  if (pendingId === undefined || chatId === undefined) return undefined;
  return { pendingId, chatId };
}

function parsePassphrasePayload(value: unknown): VaultPassphrasePayload | undefined {
  if (!isRecord(value)) return undefined;
  const passphrase = readString(value.passphrase, MAX_PASSPHRASE_LENGTH);
  return passphrase === undefined ? undefined : { passphrase };
}

function parseChangePassphrasePayload(value: unknown): VaultChangePassphrasePayload | undefined {
  if (!isRecord(value)) return undefined;
  const currentPassphrase = readString(value.currentPassphrase, MAX_PASSPHRASE_LENGTH);
  const newPassphrase = readString(value.newPassphrase, MAX_PASSPHRASE_LENGTH);
  if (currentPassphrase === undefined || newPassphrase === undefined) return undefined;
  return { currentPassphrase, newPassphrase };
}

function parseUnlockPayload(value: unknown): VaultUnlockPayload | undefined {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return undefined;
  if (value.passphrase === undefined || value.passphrase === null) return {};
  const passphrase = readString(value.passphrase, MAX_PASSPHRASE_LENGTH);
  return passphrase === undefined ? undefined : { passphrase };
}

function parseImportPayload(value: unknown): VaultImportPayload | undefined {
  if (!isRecord(value)) return undefined;
  const passphrase = readString(value.passphrase, MAX_PASSPHRASE_LENGTH);
  const salt = readString(value.salt, 64);
  const iv = readString(value.iv, 64);
  const ciphertext = readString(value.ciphertext, MAX_BACKUP_BASE64_LENGTH);
  if (
    passphrase === undefined ||
    salt === undefined ||
    iv === undefined ||
    ciphertext === undefined
  ) {
    return undefined;
  }
  return { passphrase, salt, iv, ciphertext };
}

function emptyPayload(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function failure(code: RelayFailureCode, message: string): RelayResponse<never, RelayFailureCode> {
  return { ok: false, error: { code, message } };
}

function failureFromError(error: unknown): RelayResponse<never, RelayFailureCode> {
  if (error instanceof RelayError) return failure(error.code, error.message);
  // Never surface an unknown error's message: it may contain paths or values.
  return failure('INTERNAL', 'Internal error');
}

/** Runtime messages are JSON; return base64 instead of a plain object. */
function encodeAnonymizeResult(result: AnonymizeFileResult): AnonymizeFileResult {
  return {
    ...result,
    maskedBytes:
      typeof result.maskedBytes === 'string'
        ? result.maskedBytes
        : bytesToBase64(result.maskedBytes),
  };
}

function encodeRestoreResult(result: RestoreFileResult): RestoreFileResult {
  return {
    ...result,
    bytes: typeof result.bytes === 'string' ? result.bytes : bytesToBase64(result.bytes),
  };
}

/** Validates one runtime message and dispatches it; `undefined` = not ours. */
export async function handleMessage(
  message: unknown,
): Promise<RelayResponse<unknown, RelayFailureCode> | undefined> {
  if (!isRecord(message)) return undefined;

  const type = message.type;
  if (typeof type !== 'string' || !ROUTED_TYPES.has(type)) return undefined;

  const requestId = message.requestId;
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    requestId.length > MAX_REQUEST_ID_LENGTH
  ) {
    return failure('INTERNAL', 'Malformed request');
  }

  try {
    switch (type) {
      case 'dm:anonymize-file': {
        const payload = parseFilePayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        if (payload.bytes.byteLength > MAX_MAX_BYTES) {
          return failure('LIMIT', 'File exceeds the size limit');
        }
        return { ok: true, result: encodeAnonymizeResult(await processAnonymize(payload)) };
      }

      case 'dm:restore-file': {
        const payload = parseFilePayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        if (payload.bytes.byteLength > MAX_MAX_BYTES) {
          return failure('LIMIT', 'File exceeds the size limit');
        }
        return { ok: true, result: encodeRestoreResult(await processRestore(payload)) };
      }

      case 'dm:restore-name': {
        const payload = parseRestoreNamePayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        return { ok: true, result: await processRestoreName(payload) };
      }

      case 'dm:vault-list': {
        if (message.payload !== undefined && !isRecord(message.payload)) {
          return failure('INTERNAL', 'Malformed request');
        }
        return { ok: true, result: { vaults: await listVaults() } };
      }

      case 'dm:vault-delete': {
        const payload = parseDeletePayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        return { ok: true, result: { deleted: await deleteVault(payload.id) } };
      }

      case 'dm:settings-get': {
        if (!emptyPayload(message.payload)) return failure('INTERNAL', 'Malformed request');
        return { ok: true, result: await getSettings() };
      }

      case 'dm:settings-set': {
        if (!isRecord(message.payload)) return failure('INTERNAL', 'Malformed request');
        const settings = await setSettings(message.payload as SettingsPatch, {
          allowPassphrase: false,
        });
        await refreshAutoLockPolicy();
        return { ok: true, result: settings };
      }

      case 'dm:vault-status': {
        if (!emptyPayload(message.payload)) return failure('INTERNAL', 'Malformed request');
        return { ok: true, result: await getVaultStatus() };
      }

      case 'dm:vault-lock': {
        if (!emptyPayload(message.payload)) return failure('INTERNAL', 'Malformed request');
        await initVaultStore();
        lockVaults();
        return { ok: true, result: await getVaultStatus() };
      }

      case 'dm:vault-unlock': {
        const payload = parseUnlockPayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        await unlockVaults(payload.passphrase);
        return { ok: true, result: await getVaultStatus() };
      }

      case 'dm:vault-set-passphrase': {
        const payload = parsePassphrasePayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        await enablePassphrase(payload.passphrase);
        return { ok: true, result: await getVaultStatus() };
      }

      case 'dm:vault-change-passphrase': {
        const payload = parseChangePassphrasePayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        await changePassphrase(payload.currentPassphrase, payload.newPassphrase);
        return { ok: true, result: await getVaultStatus() };
      }

      case 'dm:vault-remove-passphrase': {
        const payload = parsePassphrasePayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        await disablePassphrase(payload.passphrase);
        return { ok: true, result: await getVaultStatus() };
      }

      case 'dm:vault-export': {
        const payload = parsePassphrasePayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        return { ok: true, result: await exportVaults(payload.passphrase) };
      }

      case 'dm:vault-import': {
        const payload = parseImportPayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        return { ok: true, result: await importVaults(payload) };
      }

      case 'dm:bind-chat': {
        const payload = parseBindChatPayload(message.payload);
        if (!payload) return failure('INTERNAL', 'Malformed request');
        return { ok: true, result: { bound: await bindChat(payload.pendingId, payload.chatId) } };
      }

      case 'dm:clear-data': {
        if (!emptyPayload(message.payload)) return failure('INTERNAL', 'Malformed request');
        await clearAllData();
        return { ok: true, result: { cleared: true } };
      }

      default:
        return undefined;
    }
  } catch (error) {
    return failureFromError(error);
  }
}

/**
 * Tells open content scripts, popup and options pages that the `enabled` flag
 * changed, so interception stops/starts without a page reload. The message is
 * PII-free and contains only the settings document.
 */
export function broadcastSettingsChanged(settings: AppSettings): void {
  // `wxt/browser` resolves to undefined outside an extension context (tests).
  if (typeof browser === 'undefined') return;
  const message = { type: 'dm:settings-changed', payload: { settings } };

  try {
    const pending = browser.runtime.sendMessage(message);
    // An extension with no receiving frames rejects; that is expected.
    void Promise.resolve(pending).catch(() => {});
  } catch {
    // Never fail the settings write because a broadcast could not be sent.
  }

  // `runtime.sendMessage` reaches extension pages, not content scripts in
  // Chromium; deliver the same payload to every ChatGPT tab explicitly.
  void (async () => {
    try {
      const tabs = await browser.tabs.query({
        url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      });
      await Promise.all(
        tabs.map(async (tab) => {
          if (tab.id === undefined) return;
          try {
            await browser.tabs.sendMessage(tab.id, message);
          } catch {
            // No receiver in that tab (for example before document_start).
          }
        }),
      );
    } catch {
      // Missing tabs API or host permission: content scripts keep the last
      // known value and can re-read settings on the next page load.
    }
  })();
}

/** Subscribes the background service worker/background page. */
export function registerRouter(): void {
  // `wxt/browser` resolves to undefined outside an extension context (tests).
  if (typeof browser === 'undefined') return;

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
      // Chrome does not honor a Promise returned from onMessage in every
      // supported version; use the callback protocol and keep the port open
      // only for messages this router owns.
      if (!isRecord(message)) return undefined;
      if (typeof message.type !== 'string' || !ROUTED_TYPES.has(message.type)) return undefined;
      const type = message.type;

      void handleMessage(message).then(
        (response) => {
          if (response?.ok === true) {
            if (type === 'dm:settings-set') {
              broadcastSettingsChanged(response.result as AppSettings);
            } else if (type === 'dm:clear-data') {
              // A cleared store resets settings to defaults (enabled=true).
              void getSettings().then(broadcastSettingsChanged, () => {});
            }
          }
          try {
            sendResponse(response);
          } catch {
            // The page may have navigated away.
          }
        },
        () => {
          try {
            sendResponse(failure('INTERNAL', 'Internal error'));
          } catch {
            // The page may have navigated away.
          }
        },
      );
      return true;
    },
  );
}
