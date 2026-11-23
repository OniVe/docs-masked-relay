/**
 * Background <-> content script/popup protocol (M3).
 *
 * Only masked bytes and tags travel in responses. Plaintext originals stay in
 * the background vault; `dm:anonymize-file` payload is the one place that
 * carries original file bytes and it is never echoed back.
 */

import type { EntityLabel, FileFormat } from '../core';

export const RELAY_MESSAGE_TYPES = [
  'dm:ping',
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
] as const;

export type RelayMessageType = (typeof RELAY_MESSAGE_TYPES)[number];

/**
 * Error codes are stable protocol values; messages never contain PII.
 * `LOCKED` means the vault must be unlocked; `BAD_PASSPHRASE`/`CONFLICT` keep
 * credential and duplicate details out of responses. They live in
 * `VaultErrorCode` so existing UI code can keep its legacy error map until
 * M6b wires the new states.
 */
export type RelayErrorCode =
  | 'LIMIT'
  | 'UNSUPPORTED'
  /** ZIP64 or encrypted OOXML archive; fail-closed, message is constant. */
  | 'UNSUPPORTED_ARCHIVE'
  /**
   * Too many candidate names/entities for a whole-document PERSON pass; the
   * file is rejected before a vault or any output exists.
   */
  | 'TOO_MANY_ENTITIES'
  | 'NO_VAULT'
  | 'INTERNAL'
  | 'DISABLED';
export type VaultErrorCode = 'LOCKED' | 'BAD_PASSPHRASE' | 'CONFLICT';
export type RelayFailureCode = RelayErrorCode | VaultErrorCode;

export interface AnonymizeFilePayload {
  /**
   * Original bytes. Content scripts send base64 because Chrome JSON-serializes
   * extension messages; direct callers (tests) may pass a typed array.
   */
  bytes: Uint8Array | string;
  name: string;
  mime: string;
  /** Binds the new/used vault to a chat (`/c/<id>`). */
  chatId?: string;
  /** Reuses an existing vault by its five-character prefix. */
  prefix?: string;
}

export interface RestoreFilePayload {
  /** Base64 from content scripts, typed array from direct callers. */
  bytes: Uint8Array | string;
  name: string;
  mime: string;
  /** Fallback lookup when the masked name/bytes carry no vault prefix. */
  chatId?: string;
  /** Pending id bound to this chat before the SPA navigation completed. */
  pendingChatId?: string;
  /** Primary lookup: the vault prefix found in tags or supplied by the UI. */
  prefix?: string;
}

/** Metadata-only restore: the JSON download step carries a tagged `file_name`. */
export interface RestoreNamePayload {
  name: string;
  /** Fallback lookup when the tagged name has no vault prefix. */
  chatId?: string;
  /** Pending id bound to this chat before the SPA navigation completed. */
  pendingChatId?: string;
  /** Primary lookup extracted from tags by the caller. */
  prefix?: string;
}

/** SPA navigation bound the pending new-chat id to a real `/c/<id>`. */
export interface BindChatPayload {
  /** Pending id generated on `/` before ChatGPT assigned a real chat id. */
  pendingId: string;
  /** Real chat id extracted from `/c/<id>`. */
  chatId: string;
}

export interface VaultDeletePayload {
  id: string;
}

/** UI-facing detector settings. `labels: null` means the built-in defaults. */
export interface DetectionSettings {
  labels: EntityLabel[] | null;
  aggressive: boolean;
  customTerms: string[];
  /** Default tag label for custom terms, `CUSTOM` by default. */
  customLabel: string;
  allowlist: string[];
  enableDate: boolean;
  enableUrl: boolean;
  /** Markdown only: leave fenced/indented/inline code untouched. */
  skipCode: boolean;
  blockOnLeak: boolean;
}

/** Persisted settings. `passphraseEnabled` mirrors the master-key record. */
export interface AppSettings {
  enabled: boolean;
  maxBytes: number;
  detection: DetectionSettings;
  maskFilenames: boolean;
  stripMetadata: boolean;
  vaultLockMinutes: number;
  passphraseEnabled: boolean;
}

export interface SettingsPatch {
  enabled?: boolean;
  maxBytes?: number;
  detection?: Partial<DetectionSettings>;
  maskFilenames?: boolean;
  /**
   * Metadata stripping is a product invariant. Only `true` is accepted; a
   * `false` patch is rejected instead of being silently repaired.
   */
  stripMetadata?: true;
  vaultLockMinutes?: number;
  /** Accepted only from background code; the router ignores user values. */
  passphraseEnabled?: boolean;
}

/** Liveness of the vault key, never key material. */
export interface VaultStatus {
  locked: boolean;
  passphraseEnabled: boolean;
}

export interface VaultPassphrasePayload {
  passphrase: string;
}

/** Changes the passphrase only after the current one is verified. */
export interface VaultChangePassphrasePayload {
  currentPassphrase: string;
  newPassphrase: string;
}

export interface VaultUnlockPayload {
  /** Omitted in device-key mode. */
  passphrase?: string;
}

/** Encrypted backup wire shape; all byte fields are base64. */
export interface EncryptedVaultBackup {
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface VaultImportPayload extends EncryptedVaultBackup {
  passphrase: string;
}

export interface VaultImportResult {
  imported: number;
  files: number;
}

/** Unencrypted vault metadata returned by `dm:vault-list`. */
export interface VaultSummary {
  id: string;
  prefix: string;
  chatIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** Entity metadata safe to show in a toast: no canonical/variant values. */
export interface ProcessedEntity {
  key: string;
  tag: string;
  label: EntityLabel;
  count: number;
}

export interface AnonymizeFileResult {
  /** Base64 on the runtime-message wire; typed array from `processAnonymize`. */
  maskedBytes: Uint8Array | string;
  maskedName: string;
  /** MIME of the masked bytes; legacy DOC/XLS return DOCX/XLSX MIME. */
  maskedMime?: string;
  format: FileFormat;
  entities: ProcessedEntity[];
  warnings: string[];
  vaultId: string;
  vaultPrefix: string;
}

export interface RestoreFileResult {
  /** Base64 on the runtime-message wire; typed array from `processRestore`. */
  bytes: Uint8Array | string;
  fileName: string;
  replacements: number;
  unknownTags: string[];
  warnings: string[];
}

/** Same metadata as `RestoreFileResult` without file bytes. */
export interface RestoreNameResult {
  fileName: string;
  replacements: number;
  unknownTags: string[];
  warnings: string[];
}

export interface RelayPayloads {
  'dm:ping': undefined;
  'dm:anonymize-file': AnonymizeFilePayload;
  'dm:restore-file': RestoreFilePayload;
  'dm:restore-name': RestoreNamePayload;
  'dm:vault-list': undefined;
  'dm:vault-delete': VaultDeletePayload;
  'dm:settings-get': undefined;
  'dm:settings-set': SettingsPatch;
  'dm:vault-status': undefined;
  'dm:vault-lock': undefined;
  'dm:vault-unlock': VaultUnlockPayload | undefined;
  'dm:vault-set-passphrase': VaultPassphrasePayload;
  'dm:vault-change-passphrase': VaultChangePassphrasePayload;
  'dm:vault-remove-passphrase': VaultPassphrasePayload;
  'dm:vault-export': VaultPassphrasePayload;
  'dm:vault-import': VaultImportPayload;
  'dm:bind-chat': BindChatPayload;
  'dm:clear-data': undefined;
}

export interface RelayResults {
  'dm:ping': { version: string };
  'dm:anonymize-file': AnonymizeFileResult;
  'dm:restore-file': RestoreFileResult;
  'dm:restore-name': RestoreNameResult;
  'dm:vault-list': { vaults: VaultSummary[] };
  'dm:vault-delete': { deleted: boolean };
  'dm:settings-get': AppSettings;
  'dm:settings-set': AppSettings;
  'dm:vault-status': VaultStatus;
  'dm:vault-lock': VaultStatus;
  'dm:vault-unlock': VaultStatus;
  'dm:vault-set-passphrase': VaultStatus;
  'dm:vault-change-passphrase': VaultStatus;
  'dm:vault-remove-passphrase': VaultStatus;
  'dm:vault-export': EncryptedVaultBackup;
  'dm:vault-import': VaultImportResult;
  'dm:bind-chat': { bound: number };
  'dm:clear-data': ClearDataResult;
}

export interface ClearDataResult {
  cleared: true;
}

/**
 * Background broadcast after settings are saved or all data is cleared.
 * Content scripts update interception state without a page reload.
 */
export interface SettingsChangedMessage {
  type: 'dm:settings-changed';
  payload: { settings: AppSettings };
}

function settingsFromBroadcast(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== 'dm:settings-changed') return undefined;
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const settings = (payload as Record<string, unknown>).settings;
  return typeof settings === 'object' && settings !== null
    ? (settings as Record<string, unknown>)
    : undefined;
}

/** Reads the `enabled` flag from a broadcast; `undefined` = not this message. */
export function readSettingsChangedEnabled(value: unknown): boolean | undefined {
  const enabled = settingsFromBroadcast(value)?.enabled;
  return typeof enabled === 'boolean' ? enabled : undefined;
}

/** Reads enabled + maxBytes from a broadcast for content-script interception. */
export function readSettingsChangedState(
  value: unknown,
): { enabled: boolean; maxBytes?: number } | undefined {
  const settings = settingsFromBroadcast(value);
  if (!settings || typeof settings.enabled !== 'boolean') return undefined;
  const maxBytes = settings.maxBytes;
  if (
    typeof maxBytes === 'number' &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= 1024 &&
    maxBytes <= 100 * 1024 * 1024
  ) {
    return { enabled: settings.enabled, maxBytes };
  }
  return { enabled: settings.enabled };
}

export type RelayRequest = {
  [K in RelayMessageType]: {
    type: K;
    requestId: string;
    payload: RelayPayloads[K];
  };
}[RelayMessageType];

export type RelayRequestOf<T extends RelayMessageType> = Extract<RelayRequest, { type: T }>;

export interface RelaySuccess<T> {
  ok: true;
  result: T;
}

export interface RelayFailure<C extends string = RelayErrorCode> {
  ok: false;
  error: {
    code: C;
    message: string;
  };
}

export type RelayResponse<T = unknown, C extends string = RelayErrorCode> =
  | RelaySuccess<T>
  | RelayFailure<C>;
