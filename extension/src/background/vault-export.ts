/**
 * Encrypted vault export/import (M6a).
 *
 * The backup is a JSON document (`dmrelay-export/1`) containing full vaults,
 * encrypted with AES-GCM under a PBKDF2-SHA256 key derived from a separate
 * user passphrase. Only `{salt, iv, ciphertext}` base64 leaves the background.
 * Import validates the same vault contract, refuses to overwrite an existing
 * vault id/prefix (`CONFLICT`) and re-encrypts every vault with the current
 * in-memory master key.
 */

import type { Vault } from '../core';
import { base64ToBytes, bytesToBase64 } from '../shared/base64';
import type {
  EncryptedVaultBackup,
  VaultImportPayload,
  VaultImportResult,
} from '../shared/messages';
import {
  deriveExportKey,
  GCM_IV_BYTES,
  MAX_PASSPHRASE_LENGTH,
  PASSPHRASE_SALT_BYTES,
  parseVaultValue,
} from './crypto';
import { RelayError } from './errors';
import {
  clearVaultTombstones,
  getVault,
  initVaultStore,
  isVaultLocked,
  listVaults,
  restoreVaultTombstones,
  saveVaults,
  withVaultLock,
} from './vault-store';

export const EXPORT_SCHEMA = 'dmrelay-export/1';
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
export const MAX_BACKUP_BASE64_LENGTH = Math.ceil((MAX_BACKUP_BYTES * 4) / 3) + 8;

const MAX_BACKUP_VAULTS = 1000;

interface VaultExportEnvelope {
  schema: typeof EXPORT_SCHEMA;
  createdAt: string;
  vaults: Vault[];
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function assertPassphrase(passphrase: unknown): asserts passphrase is string {
  if (
    typeof passphrase !== 'string' ||
    passphrase.length === 0 ||
    passphrase.length > MAX_PASSPHRASE_LENGTH
  ) {
    throw new RelayError('BAD_PASSPHRASE', 'Passphrase is required');
  }
}

function lockedError(): RelayError {
  return new RelayError('LOCKED', 'Vault is locked');
}

function decodeField(value: unknown, expectedLength?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RelayError('INTERNAL', 'Invalid backup');
  }
  const bytes = base64ToBytes(value);
  if (!bytes) throw new RelayError('INTERNAL', 'Invalid backup');
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new RelayError('INTERNAL', 'Invalid backup');
  }
  return bytes;
}

async function assertUnlocked(): Promise<void> {
  await initVaultStore();
  if (isVaultLocked()) throw lockedError();
}

/**
 * Serializes every vault and encrypts the envelope. Requires an unlocked
 * vault because each ciphertext must be decrypted first.
 */
export async function exportVaults(passphrase: string): Promise<EncryptedVaultBackup> {
  assertPassphrase(passphrase);
  await assertUnlocked();

  const summaries = await listVaults();
  const vaults: Vault[] = [];
  for (const summary of summaries) {
    const vault = await getVault(summary.id);
    if (!vault) throw new RelayError('INTERNAL', 'Vault could not be exported');
    vaults.push(vault);
  }

  const envelope: VaultExportEnvelope = {
    schema: EXPORT_SCHEMA,
    createdAt: new Date().toISOString(),
    vaults,
  };
  const plaintext = utf8(JSON.stringify(envelope));
  if (plaintext.byteLength > MAX_BACKUP_BYTES) {
    plaintext.fill(0);
    throw new RelayError('LIMIT', 'Backup exceeds the size limit');
  }

  try {
    const salt = crypto.getRandomValues(new Uint8Array(PASSPHRASE_SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
    const key = await deriveExportKey(passphrase, salt);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    const bytes = new Uint8Array(ciphertext);
    if (bytes.byteLength > MAX_BACKUP_BYTES) {
      throw new RelayError('LIMIT', 'Backup exceeds the size limit');
    }
    return {
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(bytes),
    };
  } finally {
    plaintext.fill(0);
  }
}

function parseEnvelope(bytes: Uint8Array<ArrayBuffer>): Vault[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RelayError('INTERNAL', 'Invalid backup');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RelayError('INTERNAL', 'Invalid backup');
  }
  const value = parsed as Record<string, unknown>;
  if (value.schema !== EXPORT_SCHEMA || typeof value.createdAt !== 'string') {
    throw new RelayError('INTERNAL', 'Invalid backup');
  }
  if (!Array.isArray(value.vaults) || value.vaults.length > MAX_BACKUP_VAULTS) {
    throw new RelayError('INTERNAL', 'Invalid backup');
  }

  try {
    return value.vaults.map((vault) => parseVaultValue(vault));
  } catch {
    throw new RelayError('INTERNAL', 'Invalid backup');
  }
}

/**
 * Decrypts and imports a backup. Any existing vault id/prefix aborts the whole
 * import with `CONFLICT` before a single row is written.
 */
export async function importVaults(payload: VaultImportPayload): Promise<VaultImportResult> {
  return withVaultLock(async () => {
    const passphrase = payload.passphrase;
    assertPassphrase(passphrase);
    await assertUnlocked();

    const salt = decodeField(payload.salt, PASSPHRASE_SALT_BYTES);
    const iv = decodeField(payload.iv, GCM_IV_BYTES);
    const ciphertext = decodeField(payload.ciphertext);
    if (ciphertext.byteLength > MAX_BACKUP_BYTES) {
      throw new RelayError('LIMIT', 'Backup exceeds the size limit');
    }

    let plaintext: ArrayBuffer;
    try {
      const key = await deriveExportKey(passphrase, salt);
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    } catch {
      // Wrong passphrase and damaged ciphertext are indistinguishable on purpose.
      throw new RelayError('BAD_PASSPHRASE', 'Passphrase is incorrect or the backup is damaged');
    }

    let vaults: Vault[];
    try {
      vaults = parseEnvelope(new Uint8Array(plaintext));
    } finally {
      new Uint8Array(plaintext).fill(0);
    }

    const existing = await listVaults();
    const ids = new Set(existing.map((vault) => vault.id));
    const prefixes = new Set(existing.map((vault) => vault.prefix));
    for (const vault of vaults) {
      if (ids.has(vault.id) || prefixes.has(vault.prefix)) {
        throw new RelayError('CONFLICT', 'A vault with the same id or prefix already exists');
      }
      ids.add(vault.id);
      prefixes.add(vault.prefix);
    }

    // An explicit import is a new user decision: the ids in the backup are
    // allowed to exist again even if they were deleted in this session (R4-M1).
    // Validate everything first, then clear tombstones and write the whole
    // batch atomically; if the write fails, put the tombstones back.
    const clearedTombstones = clearVaultTombstones(vaults.map((vault) => vault.id));
    let files = 0;
    try {
      await saveVaults(vaults);
    } catch (error) {
      restoreVaultTombstones(clearedTombstones);
      throw error;
    }
    for (const vault of vaults) files += vault.files.length;
    return { imported: vaults.length, files };
  });
}
