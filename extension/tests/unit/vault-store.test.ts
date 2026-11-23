import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../../src/background/crypto';
import {
  openDb,
  requestToPromise,
  resetDb,
  transactionDone,
  VAULTS_STORE,
  type VaultRecord,
} from '../../src/background/db';
import {
  addChatId,
  bindChat,
  boundChatIdsFor,
  closeVaultStore,
  deleteVault,
  getVault,
  getVaultByChat,
  getVaultByPrefix,
  initVaultStore,
  listVaultIds,
  listVaults,
  saveVault,
} from '../../src/background/vault-store';
import { createVault, type Vault } from '../../src/core';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';

function makeVault(id: string, prefix: string, chatId = 'chat-alpha'): Vault {
  const originalName = `${PERSON}_договор.docx`;
  const vault = createVault('', { id, prefix, now: '2026-11-22T10:00:00.000Z' });
  vault.chatIds.push(chatId);
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
    originalName,
    maskedName: `[[${prefix}_PERSON_1]]_договор.docx`,
    format: 'docx',
    size: 123,
    sha256: 'a'.repeat(64),
  });
  vault.occurrences.push({ tag: `[[${prefix}_PERSON_1]]`, original: PERSON });
  vault.filenameMap.push({ original: originalName, masked: vault.files[0]?.maskedName ?? '' });
  return vault;
}

async function rawRecord(id: string): Promise<VaultRecord | undefined> {
  const db = await openDb();
  const request = db.transaction(VAULTS_STORE, 'readonly').objectStore(VAULTS_STORE).get(id);
  return (await requestToPromise(request)) as VaultRecord | undefined;
}

async function putRawRecord(record: VaultRecord): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(VAULTS_STORE, 'readwrite');
  transaction.objectStore(VAULTS_STORE).put(record);
  await transactionDone(transaction);
}

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
});

afterEach(async () => {
  await closeVaultStore();
});

describe('vault store lifecycle', () => {
  it('initializes once and keeps data across repeated init', async () => {
    await saveVault(makeVault('vault-1', 'AAAAA'));

    await initVaultStore();
    await initVaultStore();

    const loaded = await getVault('vault-1');
    expect(loaded?.id).toBe('vault-1');
    expect(loaded?.prefix).toBe('AAAAA');
    expect(loaded?.entities.PERSON_1?.canonical).toBe(PERSON);
  });

  it('clears the database on reset and creates fresh keys', async () => {
    await saveVault(makeVault('vault-1', 'AAAAA'));

    await closeVaultStore();
    await resetDb();
    await initVaultStore();

    expect(await listVaults()).toEqual([]);
    expect(await getVault('vault-1')).toBeUndefined();
  });

  it('drops pending chat aliases when the store closes', async () => {
    await bindChat('pending-alias', 'real-chat');
    expect(boundChatIdsFor('pending-alias')).toEqual(['real-chat']);

    await closeVaultStore();

    expect(boundChatIdsFor('pending-alias')).toEqual([]);
  });
});

describe('save and lookup', () => {
  it('round-trips a vault by id, prefix and chat id', async () => {
    await saveVault(makeVault('vault-1', 'AAAAA', 'chat-alpha'));

    const byId = await getVault('vault-1');
    expect(byId?.files[0]?.originalName).toBe(`${PERSON}_договор.docx`);
    expect(byId?.occurrences[0]?.original).toBe(PERSON);

    const byPrefix = await getVaultByPrefix('aaaaa');
    expect(byPrefix?.id).toBe('vault-1');

    const byChat = await getVaultByChat('chat-alpha');
    expect(byChat?.id).toBe('vault-1');

    expect(await getVault('missing')).toBeUndefined();
    expect(await getVaultByPrefix('ZZZZZ')).toBeUndefined();
    expect(await getVaultByChat('missing')).toBeUndefined();
  });

  it('rejects a duplicate prefix instead of corrupting the index', async () => {
    await saveVault(makeVault('vault-1', 'AAAAA'));
    await expect(saveVault(makeVault('vault-2', 'AAAAA'))).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(await listVaults()).toHaveLength(1);
  });

  it('keeps PII out of the raw IndexedDB row', async () => {
    await saveVault(makeVault('vault-1', 'AAAAA', 'chat-alpha'));
    const record = await rawRecord('vault-1');
    if (!record) throw new Error('Expected a raw vault record');

    expect(record.prefix).toBe('AAAAA');
    expect(record.chatIds).toEqual(['chat-alpha']);
    expect(record.iv.length).toBeGreaterThan(0);
    expect(record.ciphertext.length).toBeGreaterThan(32);

    const raw = JSON.stringify(record);
    expect(raw).not.toContain(PERSON);
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain('PERSON_1');
    expect(raw).not.toContain('договор');
  });

  it('fails closed when the ciphertext is tampered with', async () => {
    await saveVault(makeVault('vault-1', 'AAAAA'));
    const record = await rawRecord('vault-1');
    if (!record) throw new Error('Expected a raw vault record');

    const bytes = base64ToBytes(record.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await putRawRecord({ ...record, ciphertext: bytesToBase64(bytes) });

    await expect(getVault('vault-1')).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(getVaultByPrefix('AAAAA')).rejects.toThrow('Vault integrity check failed');
  });
});

describe('metadata operations', () => {
  it('lists and deletes vaults', async () => {
    await saveVault(makeVault('vault-1', 'AAAAA', 'chat-a'));
    await saveVault(makeVault('vault-2', 'BBBBB', 'chat-b'));

    const listed = await listVaults();
    expect(listed.map((vault) => vault.id).sort()).toEqual(['vault-1', 'vault-2']);
    expect(listed.find((vault) => vault.id === 'vault-2')?.chatIds).toEqual(['chat-b']);
    expect((await listVaultIds()).sort()).toEqual(['vault-1', 'vault-2']);

    expect(await deleteVault('vault-1')).toBe(true);
    expect(await deleteVault('vault-1')).toBe(false);
    expect(await getVault('vault-1')).toBeUndefined();
    expect((await listVaults()).map((vault) => vault.id)).toEqual(['vault-2']);
    expect(await listVaultIds()).toEqual(['vault-2']);
  });

  it('adds a chat id and re-encrypts the vault', async () => {
    await saveVault(makeVault('vault-1', 'AAAAA', 'chat-alpha'));

    await addChatId('vault-1', 'chat-beta');
    await addChatId('vault-1', 'chat-beta');

    const loaded = await getVault('vault-1');
    expect(loaded?.chatIds).toEqual(['chat-alpha', 'chat-beta']);
    expect((await getVaultByChat('chat-beta'))?.id).toBe('vault-1');

    const record = await rawRecord('vault-1');
    expect(record?.chatIds).toEqual(['chat-alpha', 'chat-beta']);

    await expect(addChatId('missing', 'chat-gamma')).rejects.toMatchObject({
      code: 'NO_VAULT',
    });
  });
});
