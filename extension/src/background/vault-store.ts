/**
 * Encrypted vault persistence.
 *
 * Public metadata (`id`, `prefix`, `chatIds`, timestamps) lives in the
 * `vaults` object store; everything else (file names, entities, occurrences,
 * filename map) is inside the AES-GCM ciphertext. Prefix/chat indexes are
 * unencrypted on purpose: they are random identifiers used for routing, not
 * PII. Any authentication/shape failure is fail-closed.
 *
 * M6a adds the optional passphrase mode and idle auto-lock. The master key is
 * wrapped either by the non-extractable device key (auto-unlock on start) or
 * by a PBKDF2-derived key (locked until `unlockVaults`). Lock clears the
 * in-memory key and `initPromise`; access then throws `LOCKED`.
 */

import type { Vault } from '../core';
import type { VaultStatus, VaultSummary } from '../shared/messages';
import {
  createDeviceKeyProtector,
  createIndexedDbKeyStorage,
  createPassphraseProtector,
  decryptVault,
  encryptVault,
  type KeyStorage,
  MASTER_KEY_ID,
  MAX_PASSPHRASE_LENGTH,
  type MasterKeyProtector,
  type WrappedKeyRecord,
} from './crypto';
import {
  CHAT_IDS_INDEX,
  closeDb,
  openDb,
  PREFIX_INDEX,
  requestToPromise,
  transactionDone,
  VAULTS_STORE,
  type VaultRecord,
} from './db';
import { RelayError } from './errors';
import {
  cachedVaultLockMinutes,
  DEFAULT_SETTINGS,
  getSettings,
  setPassphraseEnabled,
} from './settings';

export interface VaultStoreOptions {
  /** M6 passphrase/import-export and tests can replace key persistence. */
  keyStorage?: KeyStorage;
  /** M6 passphrase protector seam. Defaults to the device key. */
  protector?: MasterKeyProtector;
  /** Unlocks an existing passphrase-protected key on initialization. */
  passphrase?: string;
}

let initPromise: Promise<void> | undefined;
let initialized = false;
let keyStorage: KeyStorage | undefined;
let deviceProtector: MasterKeyProtector | undefined;
let masterKey: CryptoKey | undefined;
let passphraseMode = false;
let locked = false;
let autoLockMinutes = DEFAULT_SETTINGS.vaultLockMinutes;
let lastActivity = 0;
let autoLockTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Serializes read-modify-write vault operations (process, bind, clear, delete,
 * addChatId, import). Low-level `saveVault`/`getVault*` assume the caller
 * already holds this lock and never take it themselves.
 */
let vaultLockTail: Promise<unknown> = Promise.resolve();

export function withVaultLock<T>(task: () => Promise<T> | T): Promise<T> {
  // Run whether the previous operation fulfilled or rejected; a failed writer
  // must not wedge the queue.
  const run = vaultLockTail.then(task, task);
  vaultLockTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Generation counter bumped by "clear data" and by `closeVaultStore`. In-flight
 * work captures it on entry and passes it to `saveVault`; a stale save is
 * rejected instead of resurrecting a cleared vault under the new master key.
 */
let vaultEpoch = 0;

export function getVaultEpoch(): number {
  return vaultEpoch;
}

export function bumpVaultEpoch(): number {
  vaultEpoch += 1;
  return vaultEpoch;
}

/**
 * Number of "clear data"/store-close operations currently in flight. A bind
 * that starts while this is non-zero is discarded: its navigation belongs to
 * the state that is being wiped, and setting the alias after `closeVaultStore`
 * has already cleared the map would leak it into the fresh store (H1).
 */
let resetInProgress = 0;

export function beginClearData(): void {
  resetInProgress += 1;
}

export function endClearData(): void {
  resetInProgress = Math.max(0, resetInProgress - 1);
}

/**
 * Deleted vault ids in this store session. A long-running PDF run resolves its
 * vault before the engine starts; if the vault is deleted meanwhile, the final
 * save must fail instead of recreating it from a stale reference (R3-M1).
 */
const deletedVaultIds = new Set<string>();

/**
 * `pendingId -> /c/<id>` bindings observed by the ISOLATED navigation hook.
 * They cover the window where the navigation event arrives before the upload
 * has saved its vault; `bindChat` also persists the real id on the vault.
 */
const pendingBindings = new Map<string, string>();
const MAX_PENDING_BINDINGS = 1000;

/** Real chat ids that a pending id has already been bound to. */
export function boundChatIdsFor(chatId: string): string[] {
  const bound = pendingBindings.get(chatId);
  return bound && bound !== chatId ? [bound] : [];
}

function lockedError(): RelayError {
  return new RelayError('LOCKED', 'Vault is locked');
}

function assertPassphrase(passphrase: string | undefined): asserts passphrase is string {
  if (
    typeof passphrase !== 'string' ||
    passphrase.length === 0 ||
    passphrase.length > MAX_PASSPHRASE_LENGTH
  ) {
    throw new RelayError('BAD_PASSPHRASE', 'Passphrase is required');
  }
}

function isWrappedKeyRecord(record: unknown): record is WrappedKeyRecord {
  if (typeof record !== 'object' || record === null) return false;
  return (
    'id' in record &&
    record.id === MASTER_KEY_ID &&
    'kind' in record &&
    (record.kind === 'device' || record.kind === 'passphrase') &&
    'iv' in record &&
    typeof record.iv === 'string' &&
    'wrapped' in record &&
    typeof record.wrapped === 'string' &&
    'createdAt' in record &&
    typeof record.createdAt === 'string' &&
    (!('salt' in record) || record.salt === undefined || typeof record.salt === 'string')
  );
}

function clearAutoLockTimer(): void {
  if (autoLockTimer !== undefined) {
    clearTimeout(autoLockTimer);
    autoLockTimer = undefined;
  }
}

function scheduleAutoLock(): void {
  clearAutoLockTimer();
  if (locked || masterKey === undefined) return;

  const timeout = autoLockMinutes * 60_000;
  const elapsed = lastActivity > 0 ? Date.now() - lastActivity : 0;
  const delay = Math.max(0, timeout - elapsed);
  autoLockTimer = setTimeout(() => {
    autoLockTimer = undefined;
    if (locked) return;
    if (lastActivity > 0 && Date.now() - lastActivity >= timeout) {
      lockVaults();
    } else {
      scheduleAutoLock();
    }
  }, delay);
}

async function loadAutoLockMinutes(): Promise<void> {
  try {
    autoLockMinutes = (await getSettings()).vaultLockMinutes;
  } catch {
    // Keep the last known/default policy; never disable locking on a read error.
    autoLockMinutes = DEFAULT_SETTINGS.vaultLockMinutes;
  }
}

/** Re-reads `vaultLockMinutes` and reschedules the idle timer. */
export async function refreshAutoLockPolicy(): Promise<void> {
  await loadAutoLockMinutes();
  scheduleAutoLock();
}

async function syncPassphraseFlag(enabled: boolean): Promise<void> {
  try {
    await setPassphraseEnabled(enabled);
  } catch {
    // The key record remains authoritative; the setting is display metadata.
  }
}

async function initialize(options: VaultStoreOptions): Promise<void> {
  await openDb();

  keyStorage = options.keyStorage ?? createIndexedDbKeyStorage();
  deviceProtector = options.protector ?? createDeviceKeyProtector(keyStorage);
  const existing = await keyStorage.get(MASTER_KEY_ID);

  if (isWrappedKeyRecord(existing)) {
    passphraseMode = existing.kind === 'passphrase';
    if (passphraseMode) {
      if (options.passphrase === undefined) {
        // Fail closed: a passphrase-protected key never auto-unlocks.
        masterKey = undefined;
        locked = true;
      } else {
        assertPassphrase(options.passphrase);
        try {
          masterKey = await createPassphraseProtector(options.passphrase, existing.salt).unwrap(
            existing,
          );
          locked = false;
        } catch {
          masterKey = undefined;
          locked = true;
          throw new RelayError('BAD_PASSPHRASE', 'Passphrase is incorrect');
        }
      }
    } else {
      try {
        masterKey = await deviceProtector.unwrap(existing);
      } catch {
        throw new RelayError('INTERNAL', 'Master key could not be loaded');
      }
      locked = false;
    }
  } else if (options.passphrase !== undefined) {
    assertPassphrase(options.passphrase);
    const created = await createPassphraseProtector(options.passphrase).create();
    await keyStorage.put(created.record);
    masterKey = created.masterKey;
    passphraseMode = true;
    locked = false;
  } else {
    const created = await deviceProtector.create();
    await keyStorage.put(created.record);
    masterKey = created.masterKey;
    passphraseMode = false;
    locked = false;
  }

  initialized = true;
  lastActivity = masterKey === undefined ? 0 : Date.now();
  await loadAutoLockMinutes();
  await syncPassphraseFlag(passphraseMode);
  scheduleAutoLock();
}

/**
 * Opens the database and loads (or creates) the wrapped master key. Idempotent:
 * repeated calls share the same initialization and never rotate keys. A
 * passphrase-protected record without a passphrase resolves in the locked
 * state instead of throwing.
 */
export function initVaultStore(options: VaultStoreOptions = {}): Promise<void> {
  if (initPromise) return initPromise;
  if (initialized) {
    if (options.passphrase !== undefined && locked) {
      return unlockVaults(options.passphrase);
    }
    return refreshAutoLockPolicy();
  }

  initPromise = initialize(options).catch((error: unknown) => {
    initPromise = undefined;
    masterKey = undefined;
    if (error instanceof RelayError) throw error;
    throw new RelayError('INTERNAL', 'Vault store initialization failed');
  });
  return initPromise;
}

/** Locks the vault and drops the in-memory master key and initialization. */
export function lockVaults(): void {
  masterKey = undefined;
  locked = true;
  initPromise = undefined;
  clearAutoLockTimer();
}

/**
 * Unlocks with a passphrase (passphrase mode) or the device key (device mode).
 * A wrong passphrase returns `BAD_PASSPHRASE` without exposing crypto details.
 */
export async function unlockVaults(passphrase?: string): Promise<void> {
  if (!initialized) await initVaultStore();
  if (!keyStorage || !deviceProtector) {
    throw new RelayError('INTERNAL', 'Vault store is not initialized');
  }

  const record = await keyStorage.get(MASTER_KEY_ID);
  if (!isWrappedKeyRecord(record)) {
    throw new RelayError('INTERNAL', 'Vault key is missing');
  }

  if (record.kind === 'passphrase') {
    assertPassphrase(passphrase);
    try {
      masterKey = await createPassphraseProtector(passphrase, record.salt).unwrap(record);
    } catch {
      masterKey = undefined;
      locked = true;
      throw new RelayError('BAD_PASSPHRASE', 'Passphrase is incorrect');
    }
    passphraseMode = true;
  } else {
    try {
      masterKey = await deviceProtector.unwrap(record);
    } catch {
      throw new RelayError('INTERNAL', 'Master key could not be loaded');
    }
    passphraseMode = false;
  }

  locked = false;
  lastActivity = Date.now();
  await loadAutoLockMinutes();
  await syncPassphraseFlag(passphraseMode);
  scheduleAutoLock();
}

export function isVaultLocked(): boolean {
  return locked;
}

/** Vault status for the UI/router; never includes key material. */
export async function getVaultStatus(): Promise<VaultStatus> {
  await initVaultStore();
  if (!keyStorage) throw new RelayError('INTERNAL', 'Vault store is not initialized');
  const record = await keyStorage.get(MASTER_KEY_ID);
  return {
    locked,
    passphraseEnabled: isWrappedKeyRecord(record) && record.kind === 'passphrase',
  };
}

/** Records activity and re-arms the idle timer. */
export function touchVaults(): void {
  if (locked) return;
  autoLockMinutes = cachedVaultLockMinutes();
  lastActivity = Date.now();
  scheduleAutoLock();
}

/**
 * Decrypts the device-wrapped master key, wraps it with a PBKDF2 key and
 * replaces the key record. The vault ciphertext is untouched.
 */
export async function enablePassphrase(passphrase: string): Promise<void> {
  assertPassphrase(passphrase);
  const key = await ensureMasterKey();
  if (!keyStorage || !deviceProtector) {
    throw new RelayError('INTERNAL', 'Vault store is not initialized');
  }

  const record = await keyStorage.get(MASTER_KEY_ID);
  if (!isWrappedKeyRecord(record)) {
    throw new RelayError('INTERNAL', 'Vault key is missing');
  }
  if (record.kind === 'passphrase') {
    throw new RelayError('INTERNAL', 'Passphrase protection is already enabled');
  }

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await deviceProtector.unwrapRaw(record);
  } catch {
    throw new RelayError('INTERNAL', 'Master key could not be loaded');
  }

  try {
    const next = await createPassphraseProtector(passphrase).wrapRaw(raw);
    await keyStorage.put(next);
    masterKey = key;
    passphraseMode = true;
    locked = false;
  } finally {
    raw.fill(0);
  }

  lastActivity = Date.now();
  await syncPassphraseFlag(true);
  scheduleAutoLock();
}

/**
 * Verifies the passphrase, wraps the same master key with the device key and
 * replaces the record. After this the next start auto-unlocks.
 */
export async function disablePassphrase(passphrase: string): Promise<void> {
  assertPassphrase(passphrase);
  if (!initialized) await initVaultStore();
  if (!keyStorage || !deviceProtector) {
    throw new RelayError('INTERNAL', 'Vault store is not initialized');
  }

  const record = await keyStorage.get(MASTER_KEY_ID);
  if (!isWrappedKeyRecord(record)) {
    throw new RelayError('INTERNAL', 'Vault key is missing');
  }
  if (record.kind !== 'passphrase') {
    throw new RelayError('INTERNAL', 'Passphrase protection is not enabled');
  }

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await createPassphraseProtector(passphrase, record.salt).unwrapRaw(record);
  } catch {
    throw new RelayError('BAD_PASSPHRASE', 'Passphrase is incorrect');
  }

  try {
    const next = await deviceProtector.wrapRaw(raw);
    await keyStorage.put(next);
    masterKey = await deviceProtector.unwrap(next);
  } finally {
    raw.fill(0);
  }

  passphraseMode = false;
  locked = false;
  lastActivity = Date.now();
  await syncPassphraseFlag(false);
  scheduleAutoLock();
}

/**
 * Re-wraps the master key with a new passphrase after verifying the current
 * one. The vault ciphertexts are untouched, so a wrong current passphrase
 * leaves both the key record and the open state unchanged.
 */
export async function changePassphrase(
  currentPassphrase: string,
  newPassphrase: string,
): Promise<void> {
  assertPassphrase(currentPassphrase);
  assertPassphrase(newPassphrase);
  if (!initialized) await initVaultStore();
  if (!keyStorage) {
    throw new RelayError('INTERNAL', 'Vault store is not initialized');
  }

  const record = await keyStorage.get(MASTER_KEY_ID);
  if (!isWrappedKeyRecord(record)) {
    throw new RelayError('INTERNAL', 'Vault key is missing');
  }
  if (record.kind !== 'passphrase') {
    throw new RelayError('INTERNAL', 'Passphrase protection is not enabled');
  }

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await createPassphraseProtector(currentPassphrase, record.salt).unwrapRaw(record);
  } catch {
    throw new RelayError('BAD_PASSPHRASE', 'Passphrase is incorrect');
  }

  try {
    const next = await createPassphraseProtector(newPassphrase).wrapRaw(raw);
    await keyStorage.put(next);
    masterKey = await createPassphraseProtector(newPassphrase, next.salt).unwrap(next);
  } finally {
    raw.fill(0);
  }

  passphraseMode = true;
  locked = false;
  lastActivity = Date.now();
  await syncPassphraseFlag(true);
  scheduleAutoLock();
}

async function ensureMasterKey(): Promise<CryptoKey> {
  if (locked) throw lockedError();
  if (!initialized) await initVaultStore();
  if (locked || !masterKey) throw lockedError();

  await loadAutoLockMinutes();
  const timeout = autoLockMinutes * 60_000;
  if (lastActivity > 0 && Date.now() - lastActivity >= timeout) {
    lockVaults();
    throw lockedError();
  }

  touchVaults();
  return masterKey;
}

function isConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ConstraintError'
  );
}

async function readRecord(id: string): Promise<VaultRecord | undefined> {
  const db = await openDb();
  const request = db.transaction(VAULTS_STORE, 'readonly').objectStore(VAULTS_STORE).get(id);
  return (await requestToPromise(request)) as VaultRecord | undefined;
}

async function decryptRecord(record: VaultRecord): Promise<Vault> {
  const key = await ensureMasterKey();
  try {
    return await decryptVault(record, key);
  } catch {
    throw new RelayError('INTERNAL', 'Vault integrity check failed');
  }
}

/**
 * Encrypts the full vault JSON and upserts the metadata row. `expectedEpoch`
 * is captured by a top-level writer before it awaits anything; if "clear data"
 * bumped the generation in the meantime the save is rejected.
 */
export async function saveVault(vault: Vault, expectedEpoch?: number): Promise<void> {
  if (expectedEpoch !== undefined && expectedEpoch !== vaultEpoch) {
    throw new RelayError('INTERNAL', 'Vault generation changed; save rejected');
  }
  if (deletedVaultIds.has(vault.id)) {
    throw new RelayError('INTERNAL', 'Vault was deleted; save rejected');
  }
  const key = await ensureMasterKey();
  const existing = await readRecord(vault.id);
  const encrypted = await encryptVault(vault, key);

  const record: VaultRecord = {
    id: vault.id,
    prefix: vault.prefix,
    chatIds: [...new Set(vault.chatIds)],
    createdAt: existing?.createdAt ?? vault.createdAt,
    updatedAt: new Date().toISOString(),
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
  };

  const db = await openDb();
  const transaction = db.transaction(VAULTS_STORE, 'readwrite');
  transaction.objectStore(VAULTS_STORE).put(record);
  try {
    await transactionDone(transaction);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new RelayError('INTERNAL', 'Vault prefix is already in use');
    }
    throw new RelayError('INTERNAL', 'Vault could not be saved');
  }
}

/**
 * Writes several vaults in one IndexedDB transaction (explicit import). Every
 * record is encrypted before the transaction opens; a constraint/quota error
 * aborts the whole batch, so a failed import leaves no partial rows (R4-M1).
 * Assumes the caller holds the vault lock.
 */
export async function saveVaults(vaults: readonly Vault[], expectedEpoch?: number): Promise<void> {
  if (expectedEpoch !== undefined && expectedEpoch !== vaultEpoch) {
    throw new RelayError('INTERNAL', 'Vault generation changed; save rejected');
  }
  for (const vault of vaults) {
    if (deletedVaultIds.has(vault.id)) {
      throw new RelayError('INTERNAL', 'Vault was deleted; save rejected');
    }
  }
  if (vaults.length === 0) return;

  const key = await ensureMasterKey();
  const records: VaultRecord[] = [];
  for (const vault of vaults) {
    const existing = await readRecord(vault.id);
    const encrypted = await encryptVault(vault, key);
    records.push({
      id: vault.id,
      prefix: vault.prefix,
      chatIds: [...new Set(vault.chatIds)],
      createdAt: existing?.createdAt ?? vault.createdAt,
      updatedAt: new Date().toISOString(),
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
    });
  }

  const db = await openDb();
  const transaction = db.transaction(VAULTS_STORE, 'readwrite');
  const store = transaction.objectStore(VAULTS_STORE);
  for (const record of records) store.put(record);
  try {
    await transactionDone(transaction);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new RelayError('INTERNAL', 'Vault prefix is already in use');
    }
    throw new RelayError('INTERNAL', 'Vaults could not be saved');
  }
}

/**
 * Drops tombstones for an explicit import of backup ids. Returns the ids that
 * actually had a tombstone so a failed import can restore them. Assumes the
 * caller holds the vault lock and validated the whole backup first.
 */
export function clearVaultTombstones(ids: readonly string[]): string[] {
  const cleared: string[] = [];
  for (const id of ids) {
    if (deletedVaultIds.delete(id)) cleared.push(id);
  }
  return cleared;
}

export function restoreVaultTombstones(ids: readonly string[]): void {
  for (const id of ids) deletedVaultIds.add(id);
}

export async function getVault(id: string): Promise<Vault | undefined> {
  const record = await readRecord(id);
  if (!record) return undefined;
  return decryptRecord(record);
}

export async function getVaultByPrefix(prefix: string): Promise<Vault | undefined> {
  const normalized = prefix.toUpperCase();
  if (!/^[A-Z0-9]{5}$/u.test(normalized)) return undefined;

  const db = await openDb();
  const request = db
    .transaction(VAULTS_STORE, 'readonly')
    .objectStore(VAULTS_STORE)
    .index(PREFIX_INDEX)
    .get(normalized);
  const record = (await requestToPromise(request)) as VaultRecord | undefined;
  if (!record) return undefined;
  return decryptRecord(record);
}

/** Most recently updated vault bound to a chat. */
export async function getVaultByChat(chatId: string): Promise<Vault | undefined> {
  const db = await openDb();
  const request = db
    .transaction(VAULTS_STORE, 'readonly')
    .objectStore(VAULTS_STORE)
    .index(CHAT_IDS_INDEX)
    .getAll(chatId);
  const records = (await requestToPromise(request)) as VaultRecord[];
  records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const record = records[0];
  if (!record) return undefined;
  return decryptRecord(record);
}

/**
 * Ids of every stored vault, without decrypting them. Used by restore when a
 * file carries neither a vault prefix nor a chat id: the caller reads each
 * vault through `getVault`, which fails closed (`LOCKED`/`INTERNAL`) instead of
 * exposing contents that cannot be authenticated.
 */
export async function listVaultIds(): Promise<string[]> {
  const db = await openDb();
  const request = db.transaction(VAULTS_STORE, 'readonly').objectStore(VAULTS_STORE).getAllKeys();
  const keys = (await requestToPromise(request)) as IDBValidKey[];
  return keys.filter((key): key is string => typeof key === 'string');
}

/** Metadata only: listing never decrypts vault contents. */
export async function listVaults(): Promise<VaultSummary[]> {
  const db = await openDb();
  const request = db.transaction(VAULTS_STORE, 'readonly').objectStore(VAULTS_STORE).getAll();
  const records = (await requestToPromise(request)) as VaultRecord[];

  return records
    .map((record) => ({
      id: record.id,
      prefix: record.prefix,
      chatIds: [...record.chatIds],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Assumes the caller holds the vault lock. */
async function deleteVaultRecord(id: string): Promise<boolean> {
  const existing = await readRecord(id);
  if (!existing) return false;

  const db = await openDb();
  const transaction = db.transaction(VAULTS_STORE, 'readwrite');
  transaction.objectStore(VAULTS_STORE).delete(id);
  await transactionDone(transaction);
  deletedVaultIds.add(id);
  return true;
}

/** Returns false when the vault was already absent. */
export async function deleteVault(id: string): Promise<boolean> {
  return withVaultLock(() => deleteVaultRecord(id));
}

/**
 * Removes a vault that was created for a PDF run which failed before writing
 * its file record. Only an untouched vault is removed: if a concurrent upload
 * joined it and saved files/entities, the vault stays (R3-M1).
 */
export async function deleteVaultIfEmpty(id: string, expectedEpoch?: number): Promise<boolean> {
  return withVaultLock(async () => {
    if (expectedEpoch !== undefined && expectedEpoch !== vaultEpoch) return false;
    const vault = await getVault(id);
    if (!vault) return false;
    if (
      vault.files.length > 0 ||
      vault.occurrences.length > 0 ||
      Object.keys(vault.entities).length > 0
    ) {
      return false;
    }
    return deleteVaultRecord(id);
  });
}

/** Decrypts, appends the chat id and re-encrypts the vault. */
export async function addChatId(vaultId: string, chatId: string): Promise<void> {
  await withVaultLock(async () => {
    const vault = await getVault(vaultId);
    if (!vault) throw new RelayError('NO_VAULT', 'Vault not found');
    if (vault.chatIds.includes(chatId)) return;

    vault.chatIds.push(chatId);
    await saveVault(vault);
  });
}

/**
 * Binds the pending chat id used while uploading from `/` to the real
 * `/c/<id>` the SPA navigates to. The in-memory map covers a bind that arrives
 * before the upload has saved its vault; existing vaults get the real id in
 * their `chatIds` index for later restores.
 *
 * A bind that starts after `dm:clear-data` (or a direct store close) began is
 * dropped: the alias belongs to the pre-clear navigation and must not survive
 * into the fresh store (H1). A bind that started earlier runs and records its
 * alias under the vault lock; the close is serialized behind it and then wipes
 * the map, so the alias cannot outlive the reset.
 */
export async function bindChat(pendingId: string, chatId: string): Promise<number> {
  if (pendingId.length === 0 || chatId.length === 0 || pendingId === chatId) return 0;

  const requestEpoch = vaultEpoch;
  const startedDuringReset = resetInProgress > 0;

  return withVaultLock(async () => {
    if (startedDuringReset || resetInProgress > 0 || requestEpoch !== vaultEpoch) return 0;

    const summaries = await listVaults();
    let bound = 0;
    for (const summary of summaries) {
      if (!summary.chatIds.includes(pendingId)) continue;
      const vault = await getVault(summary.id);
      if (!vault) continue;
      if (!vault.chatIds.includes(chatId)) {
        vault.chatIds.push(chatId);
        await saveVault(vault);
      }
      bound += 1;
    }

    // Defense-in-depth: `closeVaultStore` is serialized by the vault lock, but
    // a future close path that bypasses the lock must still not leak this
    // pre-close alias into the fresh store. Re-check the generation right
    // before recording it (H1 direct-close race).
    if (startedDuringReset || resetInProgress > 0 || requestEpoch !== vaultEpoch) return 0;

    pendingBindings.delete(pendingId);
    pendingBindings.set(pendingId, chatId);
    while (pendingBindings.size > MAX_PENDING_BINDINGS) {
      const oldest = pendingBindings.keys().next().value;
      if (typeof oldest !== 'string') break;
      pendingBindings.delete(oldest);
    }

    return bound;
  });
}

/**
 * Closes the store and wipes the in-memory state. Assumes the caller already
 * holds the vault lock (`clearAllData` and the public wrapper below do).
 */
export async function closeVaultStoreLocked(): Promise<void> {
  // Invalidate writers/binds that captured the previous state, then keep the
  // reset window open until the connection is closed.
  bumpVaultEpoch();
  beginClearData();
  try {
    masterKey = undefined;
    initPromise = undefined;
    initialized = false;
    deletedVaultIds.clear();
    pendingBindings.clear();
    keyStorage = undefined;
    deviceProtector = undefined;
    passphraseMode = false;
    // Fail closed until the next init decides device vs passphrase mode.
    locked = true;
    autoLockMinutes = DEFAULT_SETTINGS.vaultLockMinutes;
    lastActivity = 0;
    clearAutoLockTimer();
    await closeDb();
  } finally {
    endClearData();
  }
}

/**
 * Drops the in-memory master key, pending chat aliases and the IndexedDB
 * connection. Serialized with the vault lock: a bind or writer that started
 * earlier finishes first and its alias is wiped here, so a direct close can no
 * longer interleave with an in-flight bind and leak the alias afterwards (H1).
 */
export async function closeVaultStore(): Promise<void> {
  return withVaultLock(() => closeVaultStoreLocked());
}
