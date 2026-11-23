import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openDb,
  resetDb,
  SETTINGS_STORE,
  type SettingsRecord,
  transactionDone,
} from '../../src/background/db';
import { processAnonymize, processRestore } from '../../src/background/process';
import {
  DEFAULT_SETTINGS,
  defaultSettings,
  detectionConfigFromSettings,
  getSettings,
  MAX_MAX_BYTES,
  SETTINGS_KEY,
  setSettings,
} from '../../src/background/settings';
import { closeVaultStore, getVault, initVaultStore } from '../../src/background/vault-store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
});

afterEach(async () => {
  await closeVaultStore();
});

describe('settings store', () => {
  it('returns the documented defaults on a fresh database', async () => {
    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.maxBytes).toBe(25 * 1024 * 1024);
    expect(settings.detection).toMatchObject({
      labels: null,
      aggressive: false,
      customTerms: [],
      customLabel: 'CUSTOM',
      allowlist: [],
      enableDate: false,
      enableUrl: false,
      skipCode: false,
      blockOnLeak: true,
    });
    expect(settings.vaultLockMinutes).toBe(15);
    expect(settings.passphraseEnabled).toBe(false);
  });

  it('repairs corrupted persisted fields with safe defaults', async () => {
    const db = await openDb();
    const transaction = db.transaction(SETTINGS_STORE, 'readwrite');
    const record: SettingsRecord = {
      key: SETTINGS_KEY,
      value: {
        enabled: 'nope',
        maxBytes: 1,
        detection: {
          labels: ['PERSON', 'NOPE'],
          aggressive: 'yes',
          customTerms: ['ok', 5],
          customLabel: 'person',
          blockOnLeak: 'no',
        },
        vaultLockMinutes: 9999,
        maskFilenames: null,
      },
    };
    transaction.objectStore(SETTINGS_STORE).put(record);
    await transactionDone(transaction);

    const settings = await getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.maxBytes).toBe(25 * 1024 * 1024);
    expect(settings.detection.labels).toBeNull();
    expect(settings.detection.aggressive).toBe(false);
    expect(settings.detection.customTerms).toEqual([]);
    expect(settings.detection.customLabel).toBe('CUSTOM');
    expect(settings.detection.blockOnLeak).toBe(true);
    expect(settings.vaultLockMinutes).toBe(15);
    expect(settings.maskFilenames).toBe(true);
  });

  it('merges nested patches and keeps untouched defaults', async () => {
    await setSettings({
      enabled: false,
      maxBytes: 4096,
      detection: { aggressive: true, customTerms: ['Феникс => PROJECT'], customLabel: 'CLIENT' },
      maskFilenames: false,
      vaultLockMinutes: 30,
      passphraseEnabled: true,
    });

    const settings = await getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.maxBytes).toBe(4096);
    expect(settings.detection.aggressive).toBe(true);
    expect(settings.detection.customTerms).toEqual(['Феникс => PROJECT']);
    expect(settings.detection.customLabel).toBe('CLIENT');
    expect(settings.detection.labels).toBeNull();
    expect(settings.detection.blockOnLeak).toBe(true);
    expect(settings.maskFilenames).toBe(false);
    expect(settings.stripMetadata).toBe(true);
    expect(settings.vaultLockMinutes).toBe(30);
    expect(settings.passphraseEnabled).toBe(true);

    // The returned object is a copy: mutating it cannot affect the store.
    settings.detection.customTerms.push('другое');
    expect((await getSettings()).detection.customTerms).toEqual(['Феникс => PROJECT']);
  });

  it('rejects out-of-range and mistyped values without writing them', async () => {
    await setSettings({ maxBytes: 8192 });

    await expect(setSettings({ maxBytes: 512 })).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(setSettings({ maxBytes: MAX_MAX_BYTES + 1 })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    await expect(setSettings({ maxBytes: 1.5 })).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(setSettings({ vaultLockMinutes: 0 })).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(setSettings({ vaultLockMinutes: 241 })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    await expect(
      setSettings({ detection: { customTerms: ['ok', 7 as unknown as string] } }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(
      setSettings({ detection: { labels: ['PERSON', 'NOPE' as never] } }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(setSettings({ detection: { customLabel: 'person' } })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    await expect(setSettings({ detection: { customLabel: 'PERSON' } })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    await expect(setSettings({ enabled: 'yes' as unknown as boolean })).rejects.toMatchObject({
      code: 'INTERNAL',
    });

    expect((await getSettings()).maxBytes).toBe(8192);
  });

  it('converts detection settings for the core engine', async () => {
    const config = detectionConfigFromSettings({
      labels: ['PERSON', 'EMAIL'],
      aggressive: true,
      customTerms: ['Феникс'],
      customLabel: 'CLIENT',
      allowlist: ['Иванов'],
      enableDate: true,
      enableUrl: false,
      skipCode: true,
      blockOnLeak: false,
    });
    expect(config.labels).toEqual(new Set(['PERSON', 'EMAIL']));
    expect(config.aggressive).toBe(true);
    expect(config.customTerms).toEqual(['Феникс']);
    expect(config.customLabel).toBe('CLIENT');
    expect(config.allowlist).toEqual(['Иванов']);
    expect(config.enableDate).toBe(true);
    expect(config.enableUrl).toBe(false);
    expect(config.blockOnLeak).toBe(false);
    expect(defaultSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('process pipeline uses settings', () => {
  it('applies the configured maxBytes to anonymize and restore', async () => {
    await setSettings({ maxBytes: 1024 });
    const large = new Uint8Array(2048).fill(0x61);

    await expect(
      processAnonymize({ bytes: large, name: 'large.txt', mime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'LIMIT' });

    const masked = await processAnonymize({
      bytes: encoder.encode('ok'),
      name: 'ok.txt',
      mime: 'text/plain',
    });
    await expect(
      processRestore({
        bytes: large,
        name: masked.maskedName,
        mime: 'text/plain',
        prefix: masked.vaultPrefix,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT' });
  });

  it('uses custom terms, blockOnLeak and skipCode from settings', async () => {
    await setSettings({
      detection: { customTerms: ['Феникс'] },
    });
    const custom = await processAnonymize({
      bytes: encoder.encode('Проект Феникс согласован'),
      name: 'project.txt',
      mime: 'text/plain',
    });
    expect(decoder.decode(custom.maskedBytes)).not.toContain('Феникс');
    expect(custom.entities[0]?.label).toBe('CUSTOM');

    await setSettings({
      detection: { skipCode: true, customTerms: [] },
    });
    const md = [`Контакт ${EMAIL}`, '', '```text', 'code@example.ru', '```', ''].join('\n');
    const skipped = await processAnonymize({
      bytes: encoder.encode(md),
      name: 'notes.md',
      mime: 'text/markdown',
    });
    const maskedText = decoder.decode(skipped.maskedBytes);
    expect(maskedText).not.toContain(EMAIL);
    expect(maskedText).toContain('code@example.ru');

    await setSettings({
      detection: { labels: [], blockOnLeak: false },
    });
    const leaky = await processAnonymize({
      bytes: encoder.encode(`mail ${EMAIL}`),
      name: 'mail.txt',
      mime: 'text/plain',
    });
    expect(decoder.decode(leaky.maskedBytes)).toContain(EMAIL);

    await setSettings({ detection: { blockOnLeak: true } });
    await expect(
      processAnonymize({
        bytes: encoder.encode(`mail ${EMAIL}`),
        name: 'mail.txt',
        mime: 'text/plain',
      }),
    ).rejects.toThrow(/LeakGuard/u);
  });

  it('applies the custom label and per-line labels from settings, then restores', async () => {
    await setSettings({
      detection: {
        customLabel: 'CLIENT',
        customTerms: ['Феникс => PROJECT', 'секрет'],
      },
    });
    const source = 'Проект Феникс: секрет';
    const masked = await processAnonymize({
      bytes: encoder.encode(source),
      name: 'client.txt',
      mime: 'text/plain',
    });
    const maskedText = decoder.decode(masked.maskedBytes);
    expect(maskedText).toContain(`[[${masked.vaultPrefix}_PROJECT_1]]`);
    expect(maskedText).toContain(`[[${masked.vaultPrefix}_CLIENT_1]]`);

    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: 'text/plain',
      prefix: masked.vaultPrefix,
    });
    expect(decoder.decode(restored.bytes)).toBe(source);
  });

  it('rejects a patch that asks to disable metadata stripping', async () => {
    await expect(setSettings({ stripMetadata: false as unknown as true })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect((await getSettings()).stripMetadata).toBe(true);

    // A corrupted persisted value is repaired on read as well.
    const db = await openDb();
    const transaction = db.transaction(SETTINGS_STORE, 'readwrite');
    transaction.objectStore(SETTINGS_STORE).put({
      key: SETTINGS_KEY,
      value: { stripMetadata: false },
    });
    await transactionDone(transaction);
    expect((await getSettings()).stripMetadata).toBe(true);
  });

  it('blocks anonymize and restore with DISABLED while protection is off', async () => {
    await setSettings({ enabled: false });
    const bytes = encoder.encode(`Договор\n${PERSON}\n`);

    await expect(
      processAnonymize({ bytes, name: 'off.txt', mime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'DISABLED' });
    await expect(
      processRestore({ bytes, name: 'off.txt', mime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'DISABLED' });

    await setSettings({ enabled: true });
    const masked = await processAnonymize({ bytes, name: 'on.txt', mime: 'text/plain' });
    expect(masked.vaultPrefix).toMatch(/^[A-Z0-9]{5}$/u);
    const restored = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: 'text/plain',
      prefix: masked.vaultPrefix,
    });
    expect(decoder.decode(restored.bytes)).toBe(`Договор\n${PERSON}\n`);

    await setSettings({ enabled: false });
    await expect(
      processRestore({
        bytes: masked.maskedBytes,
        name: masked.maskedName,
        mime: 'text/plain',
        prefix: masked.vaultPrefix,
      }),
    ).rejects.toMatchObject({ code: 'DISABLED' });
  });

  it('disables filename masking when requested', async () => {
    await setSettings({ maskFilenames: false });
    const name = `${PERSON} договор.txt`;
    const masked = await processAnonymize({
      bytes: encoder.encode('Текст без сущностей'),
      name,
      mime: 'text/plain',
    });
    expect(masked.maskedName).toBe(name);

    const stored = await getVault(masked.vaultId);
    expect(stored?.files[0]?.maskedName).toBe(name);
    expect(stored?.filenameMap).toEqual([]);

    await setSettings({ maskFilenames: true });
    const maskedAgain = await processAnonymize({
      bytes: encoder.encode('Другой текст'),
      name,
      mime: 'text/plain',
    });
    expect(maskedAgain.maskedName).not.toContain(PERSON);
    expect(maskedAgain.maskedName).toContain('_PERSON_1]]');
  });
});
