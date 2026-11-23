/**
 * IndexedDB schema for the background vault store.
 *
 * `vaults` holds only unencrypted routing metadata (`id`, `prefix`, `chatIds`,
 * timestamps) plus the AES-GCM IV/ciphertext of the full `Vault` JSON. Prefixes
 * and chat ids are random identifiers, not PII; original names, entities and
 * occurrences only ever exist inside `ciphertext`.
 */

export const DB_NAME = 'dmrelay';
export const DB_VERSION = 1;

export const VAULTS_STORE = 'vaults';
export const KEYS_STORE = 'keys';
export const SETTINGS_STORE = 'settings';

export const PREFIX_INDEX = 'prefix';
export const CHAT_IDS_INDEX = 'chatIds';
export const UPDATED_AT_INDEX = 'updatedAt';

/** Raw IndexedDB row for one vault. */
export interface VaultRecord {
  id: string;
  prefix: string;
  chatIds: string[];
  createdAt: string;
  updatedAt: string;
  /** Base64 of the random 12-byte AES-GCM IV. */
  iv: string;
  /** Base64 of the AES-GCM ciphertext (includes the GCM tag). */
  ciphertext: string;
}

export interface SettingsRecord {
  key: string;
  value: unknown;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(VAULTS_STORE)) {
    const vaults = db.createObjectStore(VAULTS_STORE, { keyPath: 'id' });
    vaults.createIndex(PREFIX_INDEX, 'prefix', { unique: true });
    vaults.createIndex(CHAT_IDS_INDEX, 'chatIds', { multiEntry: true });
    vaults.createIndex(UPDATED_AT_INDEX, 'updatedAt');
  }
  if (!db.objectStoreNames.contains(KEYS_STORE)) {
    db.createObjectStore(KEYS_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
    db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
  }
}

/** Opens (and caches) the `dmrelay` database; safe to call concurrently. */
export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;

    request.onupgradeneeded = () => {
      upgrade(request.result);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        // The open was reported as blocked, but the upgrade completed later.
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      dbPromise = undefined;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      // Another context still holds an old connection; fail clearly instead of
      // hanging. The late-success branch above closes a leaked connection.
      if (settled) return;
      settled = true;
      dbPromise = undefined;
      reject(new Error('IndexedDB open blocked by another connection'));
    };
  });

  return dbPromise;
}

export async function closeDb(): Promise<void> {
  const pending = dbPromise;
  dbPromise = undefined;
  if (!pending) return;
  try {
    (await pending).close();
  } catch {
    // A failed open has nothing to close.
  }
}

/** Deletes the whole database. Tests only; call `closeVaultStore()` first. */
export async function resetDb(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
    request.onblocked = () => reject(new Error('IndexedDB delete blocked by another connection'));
  });
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}
