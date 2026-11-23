/**
 * "Clear data" route (M6b): removes vaults, wrapped keys and settings.
 *
 * Deleting the whole IndexedDB database is the only operation that reliably
 * drops every crypto handle, including the non-extractable device key. The
 * background closes its connection first, deletes the database, then
 * re-initializes an empty store so the next message gets a fresh device key
 * and default settings.
 */

import { resetDb } from './db';
import {
  beginClearData,
  bumpVaultEpoch,
  closeVaultStoreLocked,
  endClearData,
  initVaultStore,
  withVaultLock,
} from './vault-store';

export async function clearAllData(): Promise<void> {
  // The flag is set before queueing on the lock and remains set for the whole
  // reset; a bind that starts meanwhile is dropped instead of leaking an alias
  // into the freshly initialized store (H1). The generation bump makes a
  // writer that was queued before this clear fail instead of resurrecting its
  // vault.
  beginClearData();
  try {
    await withVaultLock(async () => {
      bumpVaultEpoch();
      // Already under the vault lock: take the locked variant so the reset
      // does not deadlock on the public (`withVaultLock`) close.
      await closeVaultStoreLocked();
      await resetDb();
      await initVaultStore();
    });
  } finally {
    endClearData();
  }
}
