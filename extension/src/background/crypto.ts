/**
 * WebCrypto primitives for the vault store.
 *
 * Key hierarchy:
 * - device key: non-extractable AES-GCM-256 `CryptoKey`, generated once and
 *   stored as a `CryptoKey` in the `keys` store (structured-cloneable in
 *   Chromium, Safari and fake-indexeddb 6);
 * - master key: random 256-bit value, wrapped with the device key (AES-GCM,
 *   fixed AAD). Only `{iv, wrapped}` bytes are persisted; the working key is
 *   imported as `extractable: false`;
 * - vault: JSON encrypted with the master key, random 12-byte IV,
 *   AAD = `${id}|${schema}`.
 *
 * M6 adds the optional passphrase protector (PBKDF2-SHA256, >= 600k
 * iterations, 16-byte salt) and `deriveExportKey` for encrypted backups; both
 * plug into the same `MasterKeyProtector` / vault record format.
 */

import { type FileFormat, VAULT_SCHEMA, type Vault } from '../core';
import { KEYS_STORE, openDb, requestToPromise, transactionDone, type VaultRecord } from './db';

export const AES_GCM = 'AES-GCM';
export const AES_GCM_KEY_BYTES = 32;
export const GCM_IV_BYTES = 12;

export const DEVICE_KEY_ID = 'device';
export const MASTER_KEY_ID = 'master';

/** Passphrase KDF floor from the spec (§8, §10): PBKDF2-SHA256 >= 600k. */
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_HASH = 'SHA-256';
export const PASSPHRASE_SALT_BYTES = 16;
export const MAX_PASSPHRASE_LENGTH = 1024;

const MASTER_KEY_AAD = 'dmrelay:master-key';
const INTEGRITY_ERROR = 'Vault integrity check failed';

/** Persisted formats only; an imported record outside this set fails closed. */
const FILE_FORMATS: ReadonlySet<FileFormat> = new Set<FileFormat>([
  'docx',
  'xlsx',
  'txt',
  'md',
  'pdf',
  'doc',
  'xls',
  'json',
  'xml',
  'html',
]);

export type MasterKeyKind = 'device' | 'passphrase';

export interface DeviceKeyRecord {
  id: typeof DEVICE_KEY_ID;
  /** Non-extractable AES-GCM key; IndexedDB clones it natively. */
  key: CryptoKey;
}

export interface WrappedKeyRecord {
  id: string;
  kind: MasterKeyKind;
  /** Base64 AES-GCM IV used for the key wrap. */
  iv: string;
  /** Base64 wrapped master-key bytes. */
  wrapped: string;
  /** Base64 16-byte PBKDF2 salt; present on passphrase records only. */
  salt?: string;
  createdAt: string;
}

export type KeyRecord = DeviceKeyRecord | WrappedKeyRecord;

/** Persistence seam: IndexedDB in the extension, injectable in tests. */
export interface KeyStorage {
  get(id: string): Promise<KeyRecord | undefined>;
  put(record: KeyRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface CreatedMasterKey {
  masterKey: CryptoKey;
  record: WrappedKeyRecord;
}

/**
 * Wraps/unwraps the master key. The device protector is the default; the
 * passphrase protector (PBKDF2) is used for optional passphrase mode. Raw
 * variants support enabling/disabling a passphrase without exporting the
 * in-memory master `CryptoKey`.
 */
export interface MasterKeyProtector {
  readonly kind: MasterKeyKind;
  create(): Promise<CreatedMasterKey>;
  unwrap(record: WrappedKeyRecord): Promise<CryptoKey>;
  /** Decrypts wrapped bytes for rewrap. The caller must zero the result. */
  unwrapRaw(record: WrappedKeyRecord): Promise<Uint8Array<ArrayBuffer>>;
  /** Wraps existing master-key bytes (passphrase enable/disable). */
  wrapRaw(raw: Uint8Array<ArrayBuffer>): Promise<WrappedKeyRecord>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x2000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function randomIv(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
}

/** AAD binds ciphertext to the vault identity and schema version. */
export function vaultAad(id: string, schema: string = VAULT_SCHEMA): Uint8Array<ArrayBuffer> {
  return utf8(`${id}|${schema}`);
}

export function createIndexedDbKeyStorage(): KeyStorage {
  return {
    async get(id) {
      const db = await openDb();
      const request = db.transaction(KEYS_STORE, 'readonly').objectStore(KEYS_STORE).get(id);
      return (await requestToPromise(request)) as KeyRecord | undefined;
    },
    async put(record) {
      const db = await openDb();
      const transaction = db.transaction(KEYS_STORE, 'readwrite');
      transaction.objectStore(KEYS_STORE).put(record);
      await transactionDone(transaction);
    },
    async delete(id) {
      const db = await openDb();
      const transaction = db.transaction(KEYS_STORE, 'readwrite');
      transaction.objectStore(KEYS_STORE).delete(id);
      await transactionDone(transaction);
    },
  };
}

function isDeviceKeyRecord(record: KeyRecord | undefined): record is DeviceKeyRecord {
  return record !== undefined && record.id === DEVICE_KEY_ID && 'key' in record;
}

async function importMasterKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: AES_GCM }, false, ['encrypt', 'decrypt']);
}

function randomSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(PASSPHRASE_SALT_BYTES));
}

function decodeSalt(value: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new Error('Invalid passphrase salt');
  }
  if (bytes.byteLength !== PASSPHRASE_SALT_BYTES) {
    throw new Error('Invalid passphrase salt');
  }
  return bytes;
}

export function createDeviceKeyProtector(
  storage: KeyStorage = createIndexedDbKeyStorage(),
): MasterKeyProtector {
  let deviceKeyPromise: Promise<CryptoKey> | undefined;

  async function loadOrCreateDeviceKey(): Promise<CryptoKey> {
    const existing = await storage.get(DEVICE_KEY_ID);
    if (isDeviceKeyRecord(existing)) return existing.key;

    const key = await crypto.subtle.generateKey({ name: AES_GCM, length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await storage.put({ id: DEVICE_KEY_ID, key });
    return key;
  }

  function deviceKey(): Promise<CryptoKey> {
    deviceKeyPromise ??= loadOrCreateDeviceKey().catch((error: unknown) => {
      deviceKeyPromise = undefined;
      throw error;
    });
    return deviceKeyPromise;
  }

  async function wrapRaw(raw: Uint8Array<ArrayBuffer>): Promise<WrappedKeyRecord> {
    if (raw.byteLength !== AES_GCM_KEY_BYTES) throw new Error('Invalid master key length');
    const wrappingKey = await deviceKey();
    const iv = randomIv();
    // AES-GCM key encapsulation: the device key only needs encrypt/decrypt
    // usages, and the master key never leaves the device in plaintext.
    const wrapped = await crypto.subtle.encrypt(
      { name: AES_GCM, iv, additionalData: utf8(MASTER_KEY_AAD) },
      wrappingKey,
      raw,
    );
    return {
      id: MASTER_KEY_ID,
      kind: 'device',
      iv: bytesToBase64(iv),
      wrapped: bytesToBase64(new Uint8Array(wrapped)),
      createdAt: new Date().toISOString(),
    };
  }

  async function unwrapRaw(record: WrappedKeyRecord): Promise<Uint8Array<ArrayBuffer>> {
    if (record.kind !== 'device') {
      throw new Error('Master key was wrapped by a different protector');
    }
    const wrappingKey = await deviceKey();
    try {
      const buffer = await crypto.subtle.decrypt(
        {
          name: AES_GCM,
          iv: base64ToBytes(record.iv),
          additionalData: utf8(MASTER_KEY_AAD),
        },
        wrappingKey,
        base64ToBytes(record.wrapped),
      );
      return new Uint8Array(buffer);
    } catch {
      throw new Error('Master key unwrap failed');
    }
  }

  return {
    kind: 'device',

    async create(): Promise<CreatedMasterKey> {
      const raw = crypto.getRandomValues(new Uint8Array(AES_GCM_KEY_BYTES));
      try {
        const record = await wrapRaw(raw);
        return { masterKey: await importMasterKey(raw), record };
      } finally {
        raw.fill(0);
      }
    },

    async unwrap(record: WrappedKeyRecord): Promise<CryptoKey> {
      const raw = await unwrapRaw(record);
      try {
        return await importMasterKey(raw);
      } finally {
        raw.fill(0);
      }
    },

    unwrapRaw,
    wrapRaw,
  };
}

/**
 * PBKDF2-SHA256 passphrase protector.
 *
 * The passphrase is held only in this in-memory object while a wrap/unwrap is
 * in flight; it is never persisted, logged or returned. A wrong passphrase
 * surfaces as a generic unwrap failure (mapped to `BAD_PASSPHRASE` by the
 * vault store).
 */
export class PassphraseProtector implements MasterKeyProtector {
  readonly kind = 'passphrase' as const;
  readonly salt: string;

  private readonly passphrase: string;
  private kekPromise: Promise<CryptoKey> | undefined;

  constructor(passphrase: string, salt?: string) {
    if (
      typeof passphrase !== 'string' ||
      passphrase.length === 0 ||
      passphrase.length > MAX_PASSPHRASE_LENGTH
    ) {
      throw new Error('Invalid passphrase');
    }
    this.passphrase = passphrase;
    this.salt = salt ?? bytesToBase64(randomSalt());
    decodeSalt(this.salt);
  }

  private kek(): Promise<CryptoKey> {
    this.kekPromise ??= deriveExportKey(this.passphrase, decodeSalt(this.salt)).catch(
      (error: unknown) => {
        this.kekPromise = undefined;
        throw error;
      },
    );
    return this.kekPromise;
  }

  async wrapRaw(raw: Uint8Array<ArrayBuffer>): Promise<WrappedKeyRecord> {
    if (raw.byteLength !== AES_GCM_KEY_BYTES) throw new Error('Invalid master key length');
    const wrappingKey = await this.kek();
    const iv = randomIv();
    const wrapped = await crypto.subtle.encrypt(
      { name: AES_GCM, iv, additionalData: utf8(MASTER_KEY_AAD) },
      wrappingKey,
      raw,
    );
    return {
      id: MASTER_KEY_ID,
      kind: 'passphrase',
      salt: this.salt,
      iv: bytesToBase64(iv),
      wrapped: bytesToBase64(new Uint8Array(wrapped)),
      createdAt: new Date().toISOString(),
    };
  }

  async unwrapRaw(record: WrappedKeyRecord): Promise<Uint8Array<ArrayBuffer>> {
    if (record.kind !== 'passphrase' || typeof record.salt !== 'string') {
      throw new Error('Master key was wrapped by a different protector');
    }
    const wrappingKey = await deriveExportKey(this.passphrase, decodeSalt(record.salt));
    try {
      const buffer = await crypto.subtle.decrypt(
        {
          name: AES_GCM,
          iv: base64ToBytes(record.iv),
          additionalData: utf8(MASTER_KEY_AAD),
        },
        wrappingKey,
        base64ToBytes(record.wrapped),
      );
      return new Uint8Array(buffer);
    } catch {
      throw new Error('Master key unwrap failed');
    }
  }

  async create(): Promise<CreatedMasterKey> {
    const raw = crypto.getRandomValues(new Uint8Array(AES_GCM_KEY_BYTES));
    try {
      const record = await this.wrapRaw(raw);
      return { masterKey: await importMasterKey(raw), record };
    } finally {
      raw.fill(0);
    }
  }

  async unwrap(record: WrappedKeyRecord): Promise<CryptoKey> {
    const raw = await this.unwrapRaw(record);
    try {
      return await importMasterKey(raw);
    } finally {
      raw.fill(0);
    }
  }
}

export function createPassphraseProtector(passphrase: string, salt?: string): PassphraseProtector {
  return new PassphraseProtector(passphrase, salt);
}

/**
 * Derives the AES-GCM key used for encrypted exports/imports. The same
 * PBKDF2 floor and 16-byte salt are used for the master-key wrap and backups.
 */
export async function deriveExportKey(
  passphrase: string,
  saltInput: Uint8Array<ArrayBuffer> | string,
): Promise<CryptoKey> {
  if (
    typeof passphrase !== 'string' ||
    passphrase.length === 0 ||
    passphrase.length > MAX_PASSPHRASE_LENGTH
  ) {
    throw new Error('Invalid passphrase');
  }
  const salt = typeof saltInput === 'string' ? decodeSalt(saltInput) : saltInput;
  if (salt.byteLength !== PASSPHRASE_SALT_BYTES) {
    throw new Error('Invalid passphrase salt');
  }
  const material = await crypto.subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    material,
    { name: AES_GCM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptedVault {
  iv: string;
  ciphertext: string;
}

export async function encryptVault(vault: Vault, masterKey: CryptoKey): Promise<EncryptedVault> {
  const iv = randomIv();
  const plaintext = utf8(JSON.stringify(vault));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: AES_GCM, iv, additionalData: vaultAad(vault.id, vault.schema) },
      masterKey,
      plaintext,
    );
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
  } finally {
    plaintext.fill(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Lowercase SHA-256 hex as produced by `sha256Hex`. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Optional `VaultFile` fields have documented value domains (R24-VAULT-1):
 * `encoding` is limited to the adapter encodings `parseTxtEncoding` accepts,
 * `declarationEncoding` is an XML declaration label (letters, digits, `.`,
 * `_`, `-`, starting with a letter), `bom` is a boolean and `eol` is one of
 * the persisted line endings. Missing fields stay allowed for legacy records.
 */
const FILE_ENCODINGS: ReadonlySet<string> = new Set([
  'utf-8',
  'utf-16le',
  'utf-16be',
  'windows-1251',
]);
const FILE_EOLS: ReadonlySet<string> = new Set(['lf', 'crlf', 'cr']);
const DECLARATION_ENCODING_RE = /^[A-Za-z][A-Za-z0-9._-]*$/u;

/**
 * Full `VaultFile` shape for decrypted/imported vaults (R2/R23-IDENT-2). A
 * record that only carries `format` and `maskedSha256` would pass the format
 * guard yet lack the names, size and hashes restore identity depends on, so
 * every persisted field is validated here and any mismatch fails closed.
 */
function assertVaultFile(file: unknown): void {
  if (!isRecord(file)) throw new Error(INTEGRITY_ERROR);
  if (typeof file.originalName !== 'string' || file.originalName.length === 0) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (typeof file.maskedName !== 'string' || file.maskedName.length === 0) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (typeof file.format !== 'string' || !FILE_FORMATS.has(file.format as FileFormat)) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (!isNonNegativeSafeInteger(file.size)) throw new Error(INTEGRITY_ERROR);
  if (typeof file.sha256 !== 'string' || !SHA256_HEX_RE.test(file.sha256)) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (
    file.maskedSha256 !== undefined &&
    (typeof file.maskedSha256 !== 'string' || !SHA256_HEX_RE.test(file.maskedSha256))
  ) {
    throw new Error(INTEGRITY_ERROR);
  }
  for (const field of ['occurrenceStart', 'occurrenceCount'] as const) {
    if (file[field] !== undefined && !isNonNegativeSafeInteger(file[field])) {
      throw new Error(INTEGRITY_ERROR);
    }
  }
  if (
    file.encoding !== undefined &&
    (typeof file.encoding !== 'string' || !FILE_ENCODINGS.has(file.encoding))
  ) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (
    file.declarationEncoding !== undefined &&
    (typeof file.declarationEncoding !== 'string' ||
      !DECLARATION_ENCODING_RE.test(file.declarationEncoding))
  ) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (file.bom !== undefined && typeof file.bom !== 'boolean') {
    throw new Error(INTEGRITY_ERROR);
  }
  if (file.eol !== undefined && (typeof file.eol !== 'string' || !FILE_EOLS.has(file.eol))) {
    throw new Error(INTEGRITY_ERROR);
  }
}

function parseVault(text: string, expectedId: string): Vault {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(INTEGRITY_ERROR);
  }
  return parseVaultValue(value, expectedId);
}

/**
 * Validates a decrypted/imported vault object. Any shape mismatch throws; a
 * partially decrypted vault is never returned. Kept separate from decryption
 * so vault import can use the exact same contract.
 */
export function parseVaultValue(value: unknown, expectedId?: string): Vault {
  if (!isRecord(value)) throw new Error(INTEGRITY_ERROR);
  if (value.schema !== VAULT_SCHEMA) throw new Error(INTEGRITY_ERROR);
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (expectedId !== undefined && value.id !== expectedId) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (typeof value.prefix !== 'string' || !/^[A-Z0-9]{5}$/u.test(value.prefix)) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (typeof value.createdAt !== 'string' || !isRecord(value.entities)) {
    throw new Error(INTEGRITY_ERROR);
  }
  if (
    !Array.isArray(value.chatIds) ||
    !value.chatIds.every((chatId) => typeof chatId === 'string')
  ) {
    throw new Error(INTEGRITY_ERROR);
  }
  for (const field of ['files', 'occurrences', 'filenameMap'] as const) {
    if (!Array.isArray(value[field])) throw new Error(INTEGRITY_ERROR);
  }
  // `files[].format` drives restore identity (format class) and adapter
  // selection; an arbitrary string would let a hashed record bypass the class
  // guard. The rest of `VaultFile` (names, size, hashes, occurrence scope) is
  // required too: a record without them cannot be restored safely
  // (R22-IDENT-1, R2/R23-IDENT-2).
  for (const file of value.files as unknown[]) {
    assertVaultFile(file);
  }
  if (value.personKeys !== undefined) {
    if (!isRecord(value.personKeys)) throw new Error(INTEGRITY_ERROR);
    if (!Object.values(value.personKeys).every((key) => typeof key === 'string')) {
      throw new Error(INTEGRITY_ERROR);
    }
  }

  return value as unknown as Vault;
}

/**
 * Decrypts and validates a vault row. Any authentication failure or shape
 * mismatch throws; a partially decrypted vault is never returned.
 */
export async function decryptVault(
  record: Pick<VaultRecord, 'id' | 'iv' | 'ciphertext'>,
  masterKey: CryptoKey,
): Promise<Vault> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: AES_GCM,
        iv: base64ToBytes(record.iv),
        additionalData: vaultAad(record.id),
      },
      masterKey,
      base64ToBytes(record.ciphertext),
    );
  } catch {
    throw new Error(INTEGRITY_ERROR);
  }

  return parseVault(new TextDecoder().decode(plaintext), record.id);
}
