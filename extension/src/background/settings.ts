/**
 * Persisted extension settings (M6a).
 *
 * One `settings` row (`key: app`) holds a JSON-friendly document. Defaults are
 * merged on every read, so installing or repairing a corrupted row never
 * leaves missing fields. Validation is strict on write and per-field
 * fail-safe on read: a bad value falls back to its default instead of
 * disabling protection silently.
 */

import {
  ALL_LABELS,
  DEFAULT_CUSTOM_LABEL,
  type DetectionConfig,
  type EntityLabel,
  isCustomTagLabel,
  normalizeCustomLabel,
} from '../core';
import type { AppSettings, DetectionSettings, SettingsPatch } from '../shared/messages';
import {
  openDb,
  requestToPromise,
  SETTINGS_STORE,
  type SettingsRecord,
  transactionDone,
} from './db';
import { RelayError } from './errors';

export const SETTINGS_KEY = 'app';

export const MIN_MAX_BYTES = 1024;
export const MAX_MAX_BYTES = 100 * 1024 * 1024;
export const MIN_VAULT_LOCK_MINUTES = 1;
export const MAX_VAULT_LOCK_MINUTES = 240;

const MAX_LIST_ITEMS = 500;
const MAX_LIST_ITEM_LENGTH = 1024;

const LABEL_SET: ReadonlySet<string> = new Set(ALL_LABELS);

const DEFAULT_DETECTION: DetectionSettings = {
  labels: null,
  aggressive: false,
  customTerms: [],
  customLabel: DEFAULT_CUSTOM_LABEL,
  allowlist: [],
  enableDate: false,
  enableUrl: false,
  skipCode: false,
  blockOnLeak: true,
};

export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  enabled: true,
  maxBytes: 25 * 1024 * 1024,
  detection: Object.freeze({
    ...DEFAULT_DETECTION,
    customTerms: Object.freeze([]) as unknown as string[],
    allowlist: Object.freeze([]) as unknown as string[],
  }) as DetectionSettings,
  maskFilenames: true,
  stripMetadata: true,
  vaultLockMinutes: 15,
  passphraseEnabled: false,
});

/** Last persisted/read policy, exposed for the synchronous idle timer. */
let cachedLockMinutes = DEFAULT_SETTINGS.vaultLockMinutes;

export function cachedVaultLockMinutes(): number {
  return cachedLockMinutes;
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    detection: {
      ...settings.detection,
      labels: settings.detection.labels === null ? null : [...settings.detection.labels],
      customTerms: [...settings.detection.customTerms],
      allowlist: [...settings.detection.allowlist],
    },
  };
}

export function defaultSettings(): AppSettings {
  return cloneSettings(DEFAULT_SETTINGS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidSettings(): never {
  throw new RelayError('INTERNAL', 'Invalid settings');
}

function isMaxBytes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_MAX_BYTES &&
    value <= MAX_MAX_BYTES
  );
}

function isLockMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_VAULT_LOCK_MINUTES &&
    value <= MAX_VAULT_LOCK_MINUTES
  );
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST_ITEMS &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_LIST_ITEM_LENGTH)
  );
}

function isLabels(value: unknown): value is EntityLabel[] {
  return (
    Array.isArray(value) &&
    value.length <= ALL_LABELS.length &&
    value.every((item) => typeof item === 'string' && LABEL_SET.has(item))
  );
}

function normalizeStringList(value: unknown, fallback: readonly string[]): string[] {
  if (!isStringList(value)) return [...fallback];
  return [...value];
}

function normalizeLabels(value: unknown): EntityLabel[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > ALL_LABELS.length) return null;
  const seen = new Set<EntityLabel>();
  for (const item of value) {
    if (typeof item !== 'string' || !LABEL_SET.has(item)) return null;
    seen.add(item as EntityLabel);
  }
  return [...seen];
}

function normalizeDetection(value: unknown): DetectionSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS.detection };
  const defaults = DEFAULT_SETTINGS.detection;
  return {
    labels: value.labels === undefined ? null : normalizeLabels(value.labels),
    aggressive: typeof value.aggressive === 'boolean' ? value.aggressive : defaults.aggressive,
    customTerms: normalizeStringList(value.customTerms, defaults.customTerms),
    // A corrupted or reserved label is repaired on read: invalid input must
    // never make restore address a tag that no entity can match.
    customLabel: normalizeCustomLabel(value.customLabel),
    allowlist: normalizeStringList(value.allowlist, defaults.allowlist),
    enableDate: typeof value.enableDate === 'boolean' ? value.enableDate : defaults.enableDate,
    enableUrl: typeof value.enableUrl === 'boolean' ? value.enableUrl : defaults.enableUrl,
    skipCode: typeof value.skipCode === 'boolean' ? value.skipCode : defaults.skipCode,
    blockOnLeak: typeof value.blockOnLeak === 'boolean' ? value.blockOnLeak : defaults.blockOnLeak,
  };
}

/** Repairs a stored/corrupted document field by field. */
function normalizeSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return defaultSettings();
  const defaults = DEFAULT_SETTINGS;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
    maxBytes: isMaxBytes(value.maxBytes) ? value.maxBytes : defaults.maxBytes,
    detection: normalizeDetection(value.detection),
    maskFilenames:
      typeof value.maskFilenames === 'boolean' ? value.maskFilenames : defaults.maskFilenames,
    // Metadata stripping is a product invariant (spec §7.1/§7.2): a persisted
    // `false` from an older build is repaired to `true` on read.
    stripMetadata: true,
    vaultLockMinutes: isLockMinutes(value.vaultLockMinutes)
      ? value.vaultLockMinutes
      : defaults.vaultLockMinutes,
    passphraseEnabled:
      typeof value.passphraseEnabled === 'boolean'
        ? value.passphraseEnabled
        : defaults.passphraseEnabled,
  };
}

async function readRawSettings(): Promise<unknown> {
  const db = await openDb();
  const request = db
    .transaction(SETTINGS_STORE, 'readonly')
    .objectStore(SETTINGS_STORE)
    .get(SETTINGS_KEY);
  const record = (await requestToPromise(request)) as SettingsRecord | undefined;
  return record?.value;
}

async function writeSettings(settings: AppSettings): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(SETTINGS_STORE, 'readwrite');
  transaction.objectStore(SETTINGS_STORE).put({ key: SETTINGS_KEY, value: settings });
  await transactionDone(transaction);
}

/** Reads settings, merging persisted values over defaults. */
export async function getSettings(): Promise<AppSettings> {
  try {
    const settings = normalizeSettings(await readRawSettings());
    cachedLockMinutes = settings.vaultLockMinutes;
    return settings;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('INTERNAL', 'Settings are unavailable');
  }
}

function validateDetectionPatch(value: unknown): Partial<DetectionSettings> {
  if (!isRecord(value)) invalidSettings();
  const patch: Partial<DetectionSettings> = {};

  if (value.labels !== undefined) {
    if (value.labels !== null && !isLabels(value.labels)) invalidSettings();
    patch.labels = value.labels === null ? null : [...new Set(value.labels)];
  }
  for (const key of ['aggressive', 'enableDate', 'enableUrl', 'skipCode', 'blockOnLeak'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') invalidSettings();
    patch[key] = value[key];
  }
  for (const key of ['customTerms', 'allowlist'] as const) {
    if (value[key] === undefined) continue;
    if (!isStringList(value[key])) invalidSettings();
    patch[key] = [...value[key]];
  }
  if (value.customLabel !== undefined) {
    if (typeof value.customLabel !== 'string' || !isCustomTagLabel(value.customLabel)) {
      invalidSettings();
    }
    patch.customLabel = value.customLabel;
  }
  return patch;
}

function validatePatch(value: unknown, allowPassphrase: boolean): SettingsPatch {
  if (!isRecord(value)) invalidSettings();
  const patch: SettingsPatch = {};

  for (const key of ['enabled', 'maskFilenames'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') invalidSettings();
    patch[key] = value[key];
  }
  // Metadata stripping is a product invariant: only `true` is accepted; a
  // `false` patch is rejected instead of being silently repaired.
  if (value.stripMetadata !== undefined) {
    if (value.stripMetadata !== true) invalidSettings();
    patch.stripMetadata = true;
  }
  if (value.maxBytes !== undefined) {
    if (!isMaxBytes(value.maxBytes)) invalidSettings();
    patch.maxBytes = value.maxBytes;
  }
  if (value.vaultLockMinutes !== undefined) {
    if (!isLockMinutes(value.vaultLockMinutes)) invalidSettings();
    patch.vaultLockMinutes = value.vaultLockMinutes;
  }
  if (value.detection !== undefined) {
    patch.detection = validateDetectionPatch(value.detection);
  }
  if (value.passphraseEnabled !== undefined) {
    if (typeof value.passphraseEnabled !== 'boolean') invalidSettings();
    // User-facing callers cannot toggle the flag; the key record is the
    // authority and background vault operations update it.
    if (allowPassphrase) patch.passphraseEnabled = value.passphraseEnabled;
  }
  return patch;
}

export interface SetSettingsOptions {
  /** Background-only: allow the derived `passphraseEnabled` flag (default true). */
  allowPassphrase?: boolean;
}

/**
 * Validates and merges a patch. Throws `INTERNAL` without echoing values when
 * a type or range is invalid; invalid input never reaches storage.
 */
export async function setSettings(
  patch: SettingsPatch,
  options: SetSettingsOptions = {},
): Promise<AppSettings> {
  const validated = validatePatch(patch, options.allowPassphrase !== false);
  const current = await getSettings();
  const next: AppSettings = {
    ...current,
    ...validated,
    // Never persist an off switch: the format adapters always sanitize
    // metadata, so the flag is informational and forced on.
    stripMetadata: true,
    detection: {
      ...current.detection,
      ...(validated.detection ?? {}),
    },
  };
  await writeSettings(next);
  cachedLockMinutes = next.vaultLockMinutes;
  return cloneSettings(next);
}

/** Derived flag update from vault key operations; never stores a passphrase. */
export async function setPassphraseEnabled(enabled: boolean): Promise<void> {
  await setSettings({ passphraseEnabled: enabled });
}

/** Converts UI settings into the core detector contract. */
export function detectionConfigFromSettings(settings: DetectionSettings): DetectionConfig {
  return {
    labels: settings.labels === null ? undefined : new Set(settings.labels),
    aggressive: settings.aggressive,
    customTerms: [...settings.customTerms],
    customLabel: settings.customLabel,
    allowlist: [...settings.allowlist],
    enableDate: settings.enableDate,
    enableUrl: settings.enableUrl,
    blockOnLeak: settings.blockOnLeak,
  };
}
