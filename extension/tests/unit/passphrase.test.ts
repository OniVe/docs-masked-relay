import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../src/background/db';
import { getSettings, setSettings } from '../../src/background/settings';
import {
  closeVaultStore,
  disablePassphrase,
  enablePassphrase,
  getVault,
  getVaultStatus,
  initVaultStore,
  isVaultLocked,
  listVaults,
  lockVaults,
  saveVault,
  touchVaults,
  unlockVaults,
} from '../../src/background/vault-store';
import { createVault, type Vault } from '../../src/core';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const PASSPHRASE = 'correct horse battery staple';

function makeVault(id = 'vault-1', prefix = 'AAAAA'): Vault {
  const vault = createVault('', { id, prefix, now: '2026-11-22T10:00:00.000Z' });
  vault.chatIds.push('chat-passphrase');
  vault.entities.PERSON_1 = {
    label: 'PERSON',
    canonical: PERSON,
    variants: [],
    count: 1,
  };
  vault.entities.EMAIL_1 = {
    label: 'EMAIL',
    canonical: EMAIL,
    variants: [],
    count: 1,
  };
  vault.files.push({
    originalName: `${PERSON}_договор.txt`,
    maskedName: `[[${prefix}_PERSON_1]]_договор.txt`,
    format: 'txt',
    size: 10,
    sha256: 'b'.repeat(64),
  });
  vault.occurrences.push({ tag: `[[${prefix}_PERSON_1]]`, original: PERSON });
  return vault;
}

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeVaultStore();
});

describe('passphrase protection', () => {
  it('enables, locks, rejects a wrong passphrase and unlocks', async () => {
    const vault = makeVault();
    await saveVault(vault);

    await enablePassphrase(PASSPHRASE);
    expect(await getVaultStatus()).toEqual({ locked: false, passphraseEnabled: true });
    expect((await getSettings()).passphraseEnabled).toBe(true);

    lockVaults();
    expect(isVaultLocked()).toBe(true);
    await expect(getVault(vault.id)).rejects.toMatchObject({ code: 'LOCKED' });

    await expect(unlockVaults('wrong passphrase')).rejects.toMatchObject({
      code: 'BAD_PASSPHRASE',
    });
    expect(isVaultLocked()).toBe(true);

    await unlockVaults(PASSPHRASE);
    expect(isVaultLocked()).toBe(false);
    expect((await getVault(vault.id))?.entities.PERSON_1?.canonical).toBe(PERSON);
  });

  it('stays locked after a store close/reopen until the passphrase is supplied', async () => {
    await saveVault(makeVault());
    await enablePassphrase(PASSPHRASE);

    await closeVaultStore();
    await initVaultStore();
    expect(isVaultLocked()).toBe(true);
    expect(await getVaultStatus()).toEqual({ locked: true, passphraseEnabled: true });
    await expect(getVault('vault-1')).rejects.toMatchObject({ code: 'LOCKED' });

    await expect(unlockVaults('nope')).rejects.toMatchObject({ code: 'BAD_PASSPHRASE' });
    await unlockVaults(PASSPHRASE);
    expect(await getVault('vault-1')).toBeDefined();
  });

  it('does not auto-unlock a passphrase record when init gets no passphrase', async () => {
    await saveVault(makeVault());
    await enablePassphrase(PASSPHRASE);
    await expect(initVaultStore({ passphrase: PASSPHRASE })).resolves.toBeUndefined();

    await closeVaultStore();
    await initVaultStore({});
    expect(isVaultLocked()).toBe(true);
    await expect(unlockVaults()).rejects.toMatchObject({ code: 'BAD_PASSPHRASE' });
  });

  it('removes the passphrase and returns to device auto-unlock', async () => {
    await saveVault(makeVault());
    await enablePassphrase(PASSPHRASE);

    await expect(disablePassphrase('wrong passphrase')).rejects.toMatchObject({
      code: 'BAD_PASSPHRASE',
    });
    expect(await getVaultStatus()).toEqual({ locked: false, passphraseEnabled: true });

    await disablePassphrase(PASSPHRASE);
    expect(await getVaultStatus()).toEqual({ locked: false, passphraseEnabled: false });
    expect((await getSettings()).passphraseEnabled).toBe(false);

    await closeVaultStore();
    await initVaultStore();
    expect(isVaultLocked()).toBe(false);
    expect((await getVault('vault-1'))?.id).toBe('vault-1');
  });
});

describe('device-key mode and auto-lock', () => {
  it('keeps device mode auto-unlocked across close/reopen', async () => {
    await saveVault(makeVault());
    await closeVaultStore();
    await initVaultStore();

    expect(isVaultLocked()).toBe(false);
    expect(await getVaultStatus()).toEqual({ locked: false, passphraseEnabled: false });
    expect(await getVault('vault-1')).toBeDefined();
  });

  it('checks the idle deadline on the next access even without a timer', async () => {
    await saveVault(makeVault());
    await setSettings({ vaultLockMinutes: 1 });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T12:00:00.000Z'));
    touchVaults();
    // Move the clock without running timers: ensureMasterKey must notice.
    vi.setSystemTime(new Date('2026-11-22T12:02:00.000Z'));
    await expect(getVault('vault-1')).rejects.toMatchObject({ code: 'LOCKED' });
    expect(isVaultLocked()).toBe(true);
  });

  it('locks after the configured idle timeout and clears access', async () => {
    await saveVault(makeVault());
    await setSettings({ vaultLockMinutes: 1 });

    vi.useFakeTimers();
    touchVaults();
    vi.advanceTimersByTime(60_001);
    expect(isVaultLocked()).toBe(true);

    vi.useRealTimers();
    await expect(getVault('vault-1')).rejects.toMatchObject({ code: 'LOCKED' });
    expect(await listVaults()).toHaveLength(1);

    await unlockVaults();
    expect(isVaultLocked()).toBe(false);
    expect(await getVault('vault-1')).toBeDefined();
  });
});
