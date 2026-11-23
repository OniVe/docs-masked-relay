import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../src/background/db';
import {
  bindChat,
  boundChatIdsFor,
  closeVaultStore,
  initVaultStore,
  saveVault,
} from '../../src/background/vault-store';
import { createVault } from '../../src/core';

/**
 * H1 direct-close race: a bind that already passed its entry epoch check must
 * not record its alias after `closeVaultStore()` wiped the map. The direct
 * close bypassed `dm:clear-data`/`withVaultLock` and let the in-flight bind
 * write `pendingBindings` after the reset (empiric 20/20 with the old code).
 */

async function freshStore(): Promise<void> {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
}

beforeEach(freshStore);

afterEach(async () => {
  await closeVaultStore();
});

const CASES = Array.from({ length: 20 }, (_, index) => index + 1);

describe('H1: direct close vs in-flight bind', () => {
  it.each(CASES)('direct close wipes an alias written by a concurrent bind (%i/20)', async (n) => {
    const pendingId = `pending-direct-${n}`;
    // The seeded vault does not carry the pending id: the bind's scan finds
    // nothing to persist and goes straight to recording the alias, which is
    // exactly the write the direct close used to race (empiric 20/20 leak).
    const vault = createVault('', {
      id: `race-vault-${n}`,
      prefix: String(10_000 + n),
      now: '2026-11-22T10:00:00.000Z',
    });
    vault.chatIds.push(`unrelated-${n}`);
    await saveVault(vault);

    // Start the bind first so it captures the current epoch before awaiting
    // the lock, reach its storage await, and only then close directly.
    const binding = bindChat(pendingId, `real-direct-${n}`);
    await Promise.resolve();
    const closing = closeVaultStore();
    await Promise.all([closing, binding]);

    expect(boundChatIdsFor(pendingId)).toEqual([]);
  });

  it('accepts a bind that starts after a direct close finished', async () => {
    await closeVaultStore();

    expect(await bindChat('pending-after-close', 'real-after-close')).toBe(0);
    expect(boundChatIdsFor('pending-after-close')).toEqual(['real-after-close']);
  });
});
