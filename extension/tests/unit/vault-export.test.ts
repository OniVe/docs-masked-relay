import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base64ToBytes } from '../../src/background/crypto';
import {
  openDb,
  requestToPromise,
  resetDb,
  VAULTS_STORE,
  type VaultRecord,
} from '../../src/background/db';
import { exportVaults, importVaults, MAX_BACKUP_BYTES } from '../../src/background/vault-export';
import {
  closeVaultStore,
  deleteVault,
  enablePassphrase,
  getVault,
  initVaultStore,
  listVaults,
  lockVaults,
  saveVault,
  unlockVaults,
} from '../../src/background/vault-store';
import { createVault, type Vault } from '../../src/core';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const PASSPHRASE = 'backup passphrase';
const VAULT_ID = 'vault-export-1';
const PREFIX = 'AAAAA';

function makeVault(id = VAULT_ID, prefix = PREFIX): Vault {
  const vault = createVault('', { id, prefix, now: '2026-11-22T10:00:00.000Z' });
  vault.chatIds.push('chat-export');
  vault.entities.PERSON_1 = {
    label: 'PERSON',
    canonical: PERSON,
    variants: ['Иванову'],
    count: 2,
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
    size: 42,
    sha256: 'c'.repeat(64),
  });
  vault.occurrences.push({ tag: `[[${prefix}_PERSON_1]]`, original: PERSON });
  vault.filenameMap.push({
    original: `${PERSON}_договор.txt`,
    masked: `[[${prefix}_PERSON_1]]_договор.txt`,
  });
  return vault;
}

async function rawRecord(id: string): Promise<VaultRecord | undefined> {
  const db = await openDb();
  const request = db.transaction(VAULTS_STORE, 'readonly').objectStore(VAULTS_STORE).get(id);
  return (await requestToPromise(request)) as VaultRecord | undefined;
}

async function freshStore(): Promise<void> {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
}

beforeEach(async () => {
  await freshStore();
});

afterEach(async () => {
  await closeVaultStore();
});

describe('vault export/import', () => {
  it('round-trips all vaults with a separate passphrase and no plaintext on the wire', async () => {
    await saveVault(makeVault());

    const backup = await exportVaults(PASSPHRASE);
    expect(base64ToBytes(backup.salt)?.byteLength).toBe(16);
    expect(base64ToBytes(backup.iv)?.byteLength).toBe(12);
    expect(backup.ciphertext.length).toBeGreaterThan(64);

    const wire = JSON.stringify(backup);
    expect(wire).not.toContain(PERSON);
    expect(wire).not.toContain(EMAIL);
    expect(wire).not.toContain(VAULT_ID);
    expect(wire).not.toContain('PERSON_1');

    await freshStore();
    expect(await listVaults()).toEqual([]);

    const imported = await importVaults({ ...backup, passphrase: PASSPHRASE });
    expect(imported).toEqual({ imported: 1, files: 1 });
    expect(await listVaults()).toHaveLength(1);

    const restored = await getVault(VAULT_ID);
    expect(restored?.entities.PERSON_1?.canonical).toBe(PERSON);
    expect(restored?.entities.EMAIL_1?.canonical).toBe(EMAIL);
    expect(restored?.occurrences[0]?.original).toBe(PERSON);
    expect(restored?.files[0]?.originalName).toBe(`${PERSON}_договор.txt`);

    const record = await rawRecord(VAULT_ID);
    if (!record) throw new Error('Expected a raw vault record');
    const raw = JSON.stringify(record);
    expect(raw).not.toContain(PERSON);
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain('PERSON_1');
  });

  it('imports a backup of a vault deleted in this session (R4-M1)', async () => {
    await saveVault(makeVault());
    const backup = await exportVaults(PASSPHRASE);

    expect(await deleteVault(VAULT_ID)).toBe(true);
    // The tombstone still protects the stale writer until the explicit import.
    await expect(saveVault(makeVault())).rejects.toMatchObject({ code: 'INTERNAL' });

    const imported = await importVaults({ ...backup, passphrase: PASSPHRASE });
    expect(imported).toEqual({ imported: 1, files: 1 });
    expect((await getVault(VAULT_ID))?.entities.PERSON_1?.canonical).toBe(PERSON);
  });

  it('does not clear tombstones when the import is rejected as a conflict', async () => {
    await saveVault(makeVault(VAULT_ID, PREFIX));
    const backup = await exportVaults(PASSPHRASE);
    expect(await deleteVault(VAULT_ID)).toBe(true);

    await saveVault(makeVault('other-vault', PREFIX));
    await expect(importVaults({ ...backup, passphrase: PASSPHRASE })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // Validation happens before tombstones are cleared; a stale writer is
    // still rejected and no partial rows were written.
    await expect(saveVault(makeVault(VAULT_ID, 'BBBBB'))).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect((await listVaults()).map((vault) => vault.id)).toEqual(['other-vault']);
  });

  it('rejects a wrong passphrase and imports nothing', async () => {
    await saveVault(makeVault());
    const backup = await exportVaults(PASSPHRASE);
    await freshStore();

    await expect(importVaults({ ...backup, passphrase: 'wrong passphrase' })).rejects.toMatchObject(
      { code: 'BAD_PASSPHRASE' },
    );
    expect(await listVaults()).toEqual([]);
  });

  it('rejects a duplicate prefix or id without overwriting', async () => {
    await saveVault(makeVault());
    const backup = await exportVaults(PASSPHRASE);

    await freshStore();
    await saveVault(makeVault('other-vault', PREFIX));
    await expect(importVaults({ ...backup, passphrase: PASSPHRASE })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await listVaults()).map((vault) => vault.id)).toEqual(['other-vault']);
    expect((await getVault('other-vault'))?.id).toBe('other-vault');

    await freshStore();
    await saveVault(makeVault(VAULT_ID, 'BBBBB'));
    await expect(importVaults({ ...backup, passphrase: PASSPHRASE })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await listVaults()).map((vault) => vault.prefix)).toEqual(['BBBBB']);
  });

  it('requires an unlocked vault and rejects malformed payloads', async () => {
    await saveVault(makeVault());
    await enablePassphrase(PASSPHRASE);
    lockVaults();

    await expect(exportVaults(PASSPHRASE)).rejects.toMatchObject({ code: 'LOCKED' });
    await unlockVaults(PASSPHRASE);

    await expect(
      importVaults({
        passphrase: PASSPHRASE,
        salt: 'not-base64!',
        iv: 'not-base64!',
        ciphertext: 'not-base64!',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    expect(MAX_BACKUP_BYTES).toBe(100 * 1024 * 1024);
  });
});
