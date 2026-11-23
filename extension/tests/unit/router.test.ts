import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../src/background/db';
import { handleMessage } from '../../src/background/router';
import { boundChatIdsFor, closeVaultStore, initVaultStore } from '../../src/background/vault-store';
import { base64ToBytes } from '../../src/shared/base64';
import type {
  AnonymizeFileResult,
  AppSettings,
  EncryptedVaultBackup,
  RelayFailureCode,
  RelayResponse,
  RestoreFileResult,
  RestoreNameResult,
  VaultStatus,
  VaultSummary,
} from '../../src/shared/messages';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PERSON = 'Иванов Иван Иванович';
const TEXT = `Договор\n${PERSON}\n`;

function resultOf<T>(response: RelayResponse<unknown, RelayFailureCode> | undefined): T {
  if (!response) throw new Error('Expected a response');
  if (!response.ok) throw new Error(`Expected ok, got ${response.error.code}`);
  return response.result as T;
}

function bytesOf(value: Uint8Array | string): Uint8Array {
  if (typeof value !== 'string') return value;
  const decoded = base64ToBytes(value);
  if (!decoded) throw new Error('Invalid base64 result');
  return decoded;
}

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
});

afterEach(async () => {
  await closeVaultStore();
});

describe('handleMessage', () => {
  it('routes anonymize, list, restore and delete', async () => {
    const anonymized = resultOf<AnonymizeFileResult>(
      await handleMessage({
        type: 'dm:anonymize-file',
        requestId: 'req-1',
        payload: {
          bytes: encoder.encode(TEXT),
          name: 'letter.txt',
          mime: 'text/plain',
          chatId: 'chat-router',
        },
      }),
    );
    expect(anonymized.vaultPrefix).toMatch(/^[A-Z0-9]{5}$/u);
    expect(decoder.decode(bytesOf(anonymized.maskedBytes))).not.toContain(PERSON);

    const listed = resultOf<{ vaults: VaultSummary[] }>(
      await handleMessage({ type: 'dm:vault-list', requestId: 'req-2', payload: undefined }),
    );
    expect(listed.vaults).toHaveLength(1);
    expect(listed.vaults[0]?.prefix).toBe(anonymized.vaultPrefix);

    const restored = resultOf<RestoreFileResult>(
      await handleMessage({
        type: 'dm:restore-file',
        requestId: 'req-3',
        payload: {
          bytes: anonymized.maskedBytes,
          name: anonymized.maskedName,
          mime: 'text/plain',
          chatId: 'chat-router',
        },
      }),
    );
    expect(decoder.decode(bytesOf(restored.bytes))).toBe(TEXT);

    const deleted = resultOf<{ deleted: boolean }>(
      await handleMessage({
        type: 'dm:vault-delete',
        requestId: 'req-4',
        payload: { id: anonymized.vaultId },
      }),
    );
    expect(deleted.deleted).toBe(true);
  });

  it('binds a pending chat id to the real /c/<id> over dm:bind-chat', async () => {
    const anonymized = resultOf<AnonymizeFileResult>(
      await handleMessage({
        type: 'dm:anonymize-file',
        requestId: 'bind-anon',
        payload: {
          bytes: encoder.encode(TEXT),
          name: 'pending.txt',
          mime: 'text/plain',
          chatId: 'pending-router',
        },
      }),
    );

    const bound = resultOf<{ bound: number }>(
      await handleMessage({
        type: 'dm:bind-chat',
        requestId: 'bind-1',
        payload: { pendingId: 'pending-router', chatId: 'real-router' },
      }),
    );
    expect(bound.bound).toBe(1);

    const restored = resultOf<RestoreFileResult>(
      await handleMessage({
        type: 'dm:restore-file',
        requestId: 'bind-restore',
        payload: {
          bytes: anonymized.maskedBytes,
          name: 'renamed.txt',
          mime: 'text/plain',
          chatId: 'real-router',
        },
      }),
    );
    expect(decoder.decode(bytesOf(restored.bytes))).toBe(TEXT);
  });

  it('restores download metadata names through dm:restore-name', async () => {
    const anonymized = resultOf<AnonymizeFileResult>(
      await handleMessage({
        type: 'dm:anonymize-file',
        requestId: 'req-name-1',
        payload: {
          bytes: encoder.encode(TEXT),
          name: `${PERSON} договор.txt`,
          mime: 'text/plain',
          chatId: 'chat-name-router',
        },
      }),
    );

    const restored = resultOf<RestoreNameResult>(
      await handleMessage({
        type: 'dm:restore-name',
        requestId: 'req-name-2',
        payload: { name: anonymized.maskedName, chatId: 'chat-name-router' },
      }),
    );
    expect(restored.fileName).not.toContain('[[');
    expect(restored.fileName).toContain(PERSON);
    expect(restored.replacements).toBe(1);
    expect(restored.unknownTags).toEqual([]);

    const byPrefix = resultOf<RestoreNameResult>(
      await handleMessage({
        type: 'dm:restore-name',
        requestId: 'req-name-3',
        payload: { name: anonymized.maskedName, prefix: anonymized.vaultPrefix },
      }),
    );
    expect(byPrefix.fileName).toBe(restored.fileName);
  });

  it('maps dm:restore-name failures to NO_VAULT/INTERNAL without values', async () => {
    const noVault = await handleMessage({
      type: 'dm:restore-name',
      requestId: 'req-name-4',
      payload: { name: '[[ZZZZZ_PERSON_1]]_x.txt' },
    });
    expect(noVault).toMatchObject({ ok: false, error: { code: 'NO_VAULT' } });
    expect(JSON.stringify(noVault)).not.toContain('ZZZZZ');

    const malformed = await handleMessage({
      type: 'dm:restore-name',
      requestId: 'req-name-5',
      payload: { name: '', prefix: 'bad' },
    });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });

  it('maps failures to stable codes without leaking values', async () => {
    const malformed = await handleMessage({
      type: 'dm:anonymize-file',
      requestId: 'req-5',
      payload: { bytes: 'not-bytes', name: 'a.txt', mime: 'text/plain' },
    });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });

    const noVault = await handleMessage({
      type: 'dm:restore-file',
      requestId: 'req-6',
      payload: {
        bytes: encoder.encode('masked'),
        name: 'x.txt',
        mime: 'text/plain',
        prefix: 'ZZZZZ',
      },
    });
    expect(noVault).toMatchObject({ ok: false, error: { code: 'NO_VAULT' } });
    expect(JSON.stringify(noVault)).not.toContain('ZZZZZ');
  });

  it('ignores foreign messages and the M0 ping marker', async () => {
    expect(await handleMessage('nope')).toBeUndefined();
    expect(await handleMessage({ type: 'dm:unknown', requestId: 'req-7' })).toBeUndefined();
    expect(await handleMessage({ type: 'dm:ping', requestId: 'req-8' })).toBeUndefined();
  });
});

const PASSPHRASE = 'router secret passphrase';
const BACKUP_PASSPHRASE = 'router backup passphrase';

describe('settings and vault security routes', () => {
  it('gets and patches settings, rejecting invalid ranges', async () => {
    const defaults = resultOf<AppSettings>(
      await handleMessage({ type: 'dm:settings-get', requestId: 'set-1' }),
    );
    expect(defaults.maxBytes).toBe(25 * 1024 * 1024);
    expect(defaults.vaultLockMinutes).toBe(15);
    expect(defaults.passphraseEnabled).toBe(false);

    const updated = resultOf<AppSettings>(
      await handleMessage({
        type: 'dm:settings-set',
        requestId: 'set-2',
        payload: {
          maxBytes: 4096,
          vaultLockMinutes: 5,
          detection: { aggressive: true, skipCode: true },
        },
      }),
    );
    expect(updated.maxBytes).toBe(4096);
    expect(updated.vaultLockMinutes).toBe(5);
    expect(updated.detection.aggressive).toBe(true);
    expect(updated.detection.skipCode).toBe(true);
    expect(updated.detection.blockOnLeak).toBe(true);

    const invalid = await handleMessage({
      type: 'dm:settings-set',
      requestId: 'set-3',
      payload: { maxBytes: 1 },
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(invalid)).not.toContain(PERSON);

    const after = resultOf<AppSettings>(
      await handleMessage({ type: 'dm:settings-get', requestId: 'set-4' }),
    );
    expect(after.maxBytes).toBe(4096);
  });

  it('returns LOCKED from file work until a device-mode unlock', async () => {
    const locked = resultOf<VaultStatus>(
      await handleMessage({ type: 'dm:vault-lock', requestId: 'lock-1' }),
    );
    expect(locked).toEqual({ locked: true, passphraseEnabled: false });

    const blocked = await handleMessage({
      type: 'dm:anonymize-file',
      requestId: 'lock-2',
      payload: { bytes: encoder.encode(TEXT), name: 'blocked.txt', mime: 'text/plain' },
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    expect(JSON.stringify(blocked)).not.toContain(PERSON);

    const unlocked = resultOf<VaultStatus>(
      await handleMessage({ type: 'dm:vault-unlock', requestId: 'lock-3', payload: {} }),
    );
    expect(unlocked).toEqual({ locked: false, passphraseEnabled: false });

    const works = resultOf<AnonymizeFileResult>(
      await handleMessage({
        type: 'dm:anonymize-file',
        requestId: 'lock-4',
        payload: { bytes: encoder.encode(TEXT), name: 'after.txt', mime: 'text/plain' },
      }),
    );
    expect(works.vaultPrefix).toMatch(/^[A-Z0-9]{5}$/u);
  });

  it('sets and removes a passphrase; wrong passphrase is BAD_PASSPHRASE', async () => {
    const enabled = resultOf<VaultStatus>(
      await handleMessage({
        type: 'dm:vault-set-passphrase',
        requestId: 'pass-1',
        payload: { passphrase: PASSPHRASE },
      }),
    );
    expect(enabled).toEqual({ locked: false, passphraseEnabled: true });

    resultOf<VaultStatus>(await handleMessage({ type: 'dm:vault-lock', requestId: 'pass-2' }));

    const bad = await handleMessage({
      type: 'dm:vault-unlock',
      requestId: 'pass-3',
      payload: { passphrase: 'definitely wrong' },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'BAD_PASSPHRASE' } });
    const badWire = JSON.stringify(bad);
    expect(badWire).not.toContain(PASSPHRASE);
    expect(badWire).not.toContain('definitely wrong');

    const unlocked = resultOf<VaultStatus>(
      await handleMessage({
        type: 'dm:vault-unlock',
        requestId: 'pass-4',
        payload: { passphrase: PASSPHRASE },
      }),
    );
    expect(unlocked.locked).toBe(false);

    const removed = resultOf<VaultStatus>(
      await handleMessage({
        type: 'dm:vault-remove-passphrase',
        requestId: 'pass-5',
        payload: { passphrase: PASSPHRASE },
      }),
    );
    expect(removed).toEqual({ locked: false, passphraseEnabled: false });
  });

  it('changes a passphrase only after verifying the current one', async () => {
    resultOf<VaultStatus>(
      await handleMessage({
        type: 'dm:vault-set-passphrase',
        requestId: 'change-1',
        payload: { passphrase: PASSPHRASE },
      }),
    );

    const wrong = await handleMessage({
      type: 'dm:vault-change-passphrase',
      requestId: 'change-2',
      payload: { currentPassphrase: 'wrong current', newPassphrase: 'next passphrase' },
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'BAD_PASSPHRASE' } });
    expect(JSON.stringify(wrong)).not.toContain('wrong current');

    const changed = resultOf<VaultStatus>(
      await handleMessage({
        type: 'dm:vault-change-passphrase',
        requestId: 'change-3',
        payload: { currentPassphrase: PASSPHRASE, newPassphrase: 'next passphrase' },
      }),
    );
    expect(changed).toEqual({ locked: false, passphraseEnabled: true });

    resultOf<VaultStatus>(await handleMessage({ type: 'dm:vault-lock', requestId: 'change-4' }));
    const oldFails = await handleMessage({
      type: 'dm:vault-unlock',
      requestId: 'change-5',
      payload: { passphrase: PASSPHRASE },
    });
    expect(oldFails).toMatchObject({ ok: false, error: { code: 'BAD_PASSPHRASE' } });

    const unlocked = resultOf<VaultStatus>(
      await handleMessage({
        type: 'dm:vault-unlock',
        requestId: 'change-6',
        payload: { passphrase: 'next passphrase' },
      }),
    );
    expect(unlocked.locked).toBe(false);
  });

  it('clears vaults, keys and settings through dm:clear-data', async () => {
    resultOf<AnonymizeFileResult>(
      await handleMessage({
        type: 'dm:anonymize-file',
        requestId: 'clear-1',
        payload: {
          bytes: encoder.encode(TEXT),
          name: 'clear.txt',
          mime: 'text/plain',
          chatId: 'chat-clear',
        },
      }),
    );
    resultOf<AppSettings>(
      await handleMessage({
        type: 'dm:settings-set',
        requestId: 'clear-2',
        payload: { enabled: false, maxBytes: 4096 },
      }),
    );
    resultOf<{ bound: number }>(
      await handleMessage({
        type: 'dm:bind-chat',
        requestId: 'clear-bind',
        payload: { pendingId: 'pending-clear', chatId: 'real-clear' },
      }),
    );
    expect(boundChatIdsFor('pending-clear')).toEqual(['real-clear']);

    const cleared = resultOf<{ cleared: boolean }>(
      await handleMessage({ type: 'dm:clear-data', requestId: 'clear-3', payload: undefined }),
    );
    expect(cleared.cleared).toBe(true);
    expect(boundChatIdsFor('pending-clear')).toEqual([]);

    const settings = resultOf<AppSettings>(
      await handleMessage({ type: 'dm:settings-get', requestId: 'clear-4' }),
    );
    expect(settings.enabled).toBe(true);
    expect(settings.maxBytes).toBe(25 * 1024 * 1024);
    const listed = resultOf<{ vaults: VaultSummary[] }>(
      await handleMessage({ type: 'dm:vault-list', requestId: 'clear-5' }),
    );
    expect(listed.vaults).toEqual([]);
    const status = resultOf<VaultStatus>(
      await handleMessage({ type: 'dm:vault-status', requestId: 'clear-6' }),
    );
    expect(status).toEqual({ locked: false, passphraseEnabled: false });
  });

  it('rejects anonymize/restore with DISABLED while protection is off', async () => {
    resultOf<AppSettings>(
      await handleMessage({
        type: 'dm:settings-set',
        requestId: 'off-1',
        payload: { enabled: false },
      }),
    );

    const anonymize = await handleMessage({
      type: 'dm:anonymize-file',
      requestId: 'off-2',
      payload: { bytes: encoder.encode(TEXT), name: 'off.txt', mime: 'text/plain' },
    });
    expect(anonymize).toMatchObject({ ok: false, error: { code: 'DISABLED' } });

    const restore = await handleMessage({
      type: 'dm:restore-file',
      requestId: 'off-3',
      payload: {
        bytes: encoder.encode(TEXT),
        name: 'off.txt',
        mime: 'text/plain',
        prefix: 'ZZZZZ',
      },
    });
    expect(restore).toMatchObject({ ok: false, error: { code: 'DISABLED' } });

    const restoreName = await handleMessage({
      type: 'dm:restore-name',
      requestId: 'off-4',
      payload: { name: '[[ZZZZZ_PERSON_1]]_x.txt' },
    });
    expect(restoreName).toMatchObject({ ok: false, error: { code: 'DISABLED' } });

    resultOf<AppSettings>(
      await handleMessage({
        type: 'dm:settings-set',
        requestId: 'off-5',
        payload: { enabled: true },
      }),
    );
    const works = resultOf<AnonymizeFileResult>(
      await handleMessage({
        type: 'dm:anonymize-file',
        requestId: 'off-6',
        payload: { bytes: encoder.encode(TEXT), name: 'on.txt', mime: 'text/plain' },
      }),
    );
    expect(works.vaultPrefix).toMatch(/^[A-Z0-9]{5}$/u);
  });

  it('exports and imports encrypted backups; duplicates are CONFLICT', async () => {
    resultOf<AnonymizeFileResult>(
      await handleMessage({
        type: 'dm:anonymize-file',
        requestId: 'exp-0',
        payload: {
          bytes: encoder.encode(TEXT),
          name: `${PERSON} договор.txt`,
          mime: 'text/plain',
        },
      }),
    );

    const backup = resultOf<EncryptedVaultBackup>(
      await handleMessage({
        type: 'dm:vault-export',
        requestId: 'exp-1',
        payload: { passphrase: BACKUP_PASSPHRASE },
      }),
    );
    expect(backup.salt.length).toBeGreaterThan(0);
    expect(backup.iv.length).toBeGreaterThan(0);
    expect(backup.ciphertext.length).toBeGreaterThan(64);
    const wire = JSON.stringify(backup);
    expect(wire).not.toContain(PERSON);
    expect(wire).not.toContain(PASSPHRASE);

    const wrong = await handleMessage({
      type: 'dm:vault-import',
      requestId: 'exp-2',
      payload: { ...backup, passphrase: 'wrong backup passphrase' },
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'BAD_PASSPHRASE' } });
    expect(JSON.stringify(wrong)).not.toContain('wrong backup passphrase');

    const conflict = await handleMessage({
      type: 'dm:vault-import',
      requestId: 'exp-3',
      payload: { ...backup, passphrase: BACKUP_PASSPHRASE },
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(JSON.stringify(conflict)).not.toContain(PERSON);
  });
});
