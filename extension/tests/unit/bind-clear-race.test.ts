import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllData } from '../../src/background/clear';
import { resetDb } from '../../src/background/db';
import { processAnonymize } from '../../src/background/process';
import { handleMessage } from '../../src/background/router';
import {
  bindChat,
  boundChatIdsFor,
  closeVaultStore,
  getVault,
  initVaultStore,
} from '../../src/background/vault-store';

/**
 * Gate inside `resetDb` so the test can deterministically observe the middle
 * of `dm:clear-data`: the store has already been closed (pending bindings
 * wiped) but the clear is still in progress. Only armed explicitly by the
 * race test; every other call delegates to the real implementation.
 */
const dbGate = vi.hoisted(() => {
  const state = {
    armed: false,
    entered: undefined as Promise<void> | undefined,
    release: undefined as Promise<void> | undefined,
    resolveEntered: () => {},
    resolveRelease: () => {},
  };
  return {
    state,
    arm(): Promise<void> {
      state.armed = true;
      state.entered = new Promise<void>((resolve) => {
        state.resolveEntered = resolve;
      });
      state.release = new Promise<void>((resolve) => {
        state.resolveRelease = resolve;
      });
      return state.entered;
    },
  };
});

vi.mock('../../src/background/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/background/db')>();
  return {
    ...actual,
    resetDb: async () => {
      if (dbGate.state.armed) {
        dbGate.state.armed = false;
        dbGate.state.resolveEntered();
        await dbGate.state.release;
      }
      return actual.resetDb();
    },
  };
});

const encoder = new TextEncoder();

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
});

afterEach(async () => {
  await closeVaultStore();
});

describe('H1: bind vs clear/close race', () => {
  it('keeps a normal bind alias on an existing vault', async () => {
    const uploaded = await processAnonymize({
      bytes: encoder.encode('Договор\n'),
      name: 'bind-normal.txt',
      mime: 'text/plain',
      chatId: 'pending-normal',
    });

    expect(await bindChat('pending-normal', 'real-normal')).toBe(1);
    expect(boundChatIdsFor('pending-normal')).toEqual(['real-normal']);
    expect((await getVault(uploaded.vaultId))?.chatIds).toContain('real-normal');
  });

  it('keeps a bind that arrives before the upload creates its vault', async () => {
    await bindChat('pending-upload', 'real-upload');
    expect(boundChatIdsFor('pending-upload')).toEqual(['real-upload']);

    const uploaded = await processAnonymize({
      bytes: encoder.encode('Договор\n'),
      name: 'bind-upload.txt',
      mime: 'text/plain',
      chatId: 'pending-upload',
    });

    expect((await getVault(uploaded.vaultId))?.chatIds).toEqual(
      expect.arrayContaining(['pending-upload', 'real-upload']),
    );
  });

  it('drops a bind that arrives while dm:clear-data is in progress', async () => {
    const entered = dbGate.arm();
    const clearing = handleMessage({
      type: 'dm:clear-data',
      requestId: 'race-clear-route',
      payload: undefined,
    });
    await entered;

    const binding = bindChat('pending-route', 'real-route');
    dbGate.state.resolveRelease();
    const response = await clearing;
    await binding;

    expect(response).toMatchObject({ ok: true });
    expect(boundChatIdsFor('pending-route')).toEqual([]);
  });

  it('drops a bind that races a direct closeVaultStore()', async () => {
    const closing = closeVaultStore();
    const binding = bindChat('pending-close', 'real-close');
    await closing;
    await binding;

    expect(boundChatIdsFor('pending-close')).toEqual([]);
  });

  it('accepts a bind after clear finishes and keeps it for the next upload', async () => {
    await clearAllData();
    await bindChat('pending-late', 'real-late');
    expect(boundChatIdsFor('pending-late')).toEqual(['real-late']);

    const uploaded = await processAnonymize({
      bytes: encoder.encode('Договор\n'),
      name: 'bind-late.txt',
      mime: 'text/plain',
      chatId: 'pending-late',
    });
    expect((await getVault(uploaded.vaultId))?.chatIds).toEqual(
      expect.arrayContaining(['pending-late', 'real-late']),
    );
  });
});
