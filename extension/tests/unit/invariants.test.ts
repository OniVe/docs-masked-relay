import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllData } from '../../src/background/clear';
import { resetDb } from '../../src/background/db';
import { processAnonymize, processRestore, processRestoreName } from '../../src/background/process';
import {
  bindChat,
  closeVaultStore,
  getVault,
  getVaultEpoch,
  initVaultStore,
  listVaults,
  saveVault,
} from '../../src/background/vault-store';
import { assignDetection, createVault, createVaultIndex, encodePersonKey } from '../../src/core';
import { anonymizeTxt, detectEncoding, restoreTxt } from '../../src/core/formats/txt';
import { restoreText } from '../../src/core/masker';
import { bindPendingToRealChat } from '../../src/interception/isolated-relay';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PERSON_A = 'Иванов Иван Иванович';
const PERSON_B = 'Кузнецова Ольга Ивановна';
const PERSON_C = 'Сидорова Мария Ильинична';

function utf16(text: string, littleEndian: boolean, bom = false): Uint8Array {
  const bytes = new Uint8Array(text.length * 2 + (bom ? 2 : 0));
  let offset = 0;
  if (bom) {
    bytes[0] = littleEndian ? 0xff : 0xfe;
    bytes[1] = littleEndian ? 0xfe : 0xff;
    offset = 2;
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (littleEndian) {
      bytes[offset] = code & 0xff;
      bytes[offset + 1] = code >> 8;
    } else {
      bytes[offset] = code >> 8;
      bytes[offset + 1] = code & 0xff;
    }
    offset += 2;
  }
  return bytes;
}

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
});

afterEach(async () => {
  await closeVaultStore();
});

describe('INV-M1: concurrent anonymize in one chat', () => {
  it('keeps both entities/files and restores each original (3 repeats)', async () => {
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const chatId = `race-${repeat}`;
      const textA = `Договор A\n${PERSON_A}\n`;
      const textB = `Договор B\n${PERSON_B}\n`;

      const [maskedA, maskedB] = await Promise.all([
        processAnonymize({
          bytes: encoder.encode(textA),
          name: 'a.txt',
          mime: 'text/plain',
          chatId,
        }),
        processAnonymize({
          bytes: encoder.encode(textB),
          name: 'b.txt',
          mime: 'text/plain',
          chatId,
        }),
      ]);

      expect(maskedA.vaultId).toBe(maskedB.vaultId);
      expect(decoder.decode(maskedA.maskedBytes)).toContain(`[[${maskedA.vaultPrefix}_PERSON_1]]`);
      expect(decoder.decode(maskedB.maskedBytes)).toContain(`[[${maskedB.vaultPrefix}_PERSON_2]]`);

      const restoredA = await processRestore({
        bytes: maskedA.maskedBytes,
        name: maskedA.maskedName,
        mime: 'text/plain',
        chatId,
      });
      const restoredB = await processRestore({
        bytes: maskedB.maskedBytes,
        name: maskedB.maskedName,
        mime: 'text/plain',
        chatId,
      });
      expect(decoder.decode(restoredA.bytes)).toBe(textA);
      expect(decoder.decode(restoredB.bytes)).toBe(textB);

      const vault = await getVault(maskedA.vaultId);
      expect(vault?.files.map((file) => file.originalName).sort()).toEqual(['a.txt', 'b.txt']);
      expect(Object.keys(vault?.entities ?? {})).toHaveLength(2);
    }
  });
});

describe('INV-M2: pending chat id binding', () => {
  it('restores by the real /c/<id> after bindChat and by pending fallback', async () => {
    const pendingId = 'pending-4f6b9c1e';
    const realChatId = 'real-chat-77';
    const text = `Письмо\n${PERSON_C}\n`;
    const masked = await processAnonymize({
      bytes: encoder.encode(text),
      name: 'report.txt',
      mime: 'text/plain',
      chatId: pendingId,
    });

    // Before the bind, the real /c/<id> is not in any chat index yet: a rename
    // without a tag prefix cannot resolve by name. (Restoring bytes can still
    // fall back to the masked-hash identity; see process.test.ts.)
    await expect(
      processRestoreName({
        name: masked.maskedName,
        chatId: realChatId,
      }),
    ).rejects.toMatchObject({ code: 'NO_VAULT' });

    expect(await bindChat(pendingId, realChatId)).toBe(1);

    const byReal = await processRestore({
      bytes: masked.maskedBytes,
      name: masked.maskedName,
      mime: 'text/plain',
      chatId: realChatId,
    });
    expect(decoder.decode(byReal.bytes)).toBe(text);

    // A renamed download name carries no prefix; the chat index must resolve it.
    const byName = await processRestoreName({
      name: 'renamed.txt',
      chatId: realChatId,
    });
    expect(byName.fileName).toBe('renamed.txt');

    // A bind that lost the race with the save is covered by pendingChatId.
    const lateMasked = await processAnonymize({
      bytes: encoder.encode(text),
      name: 'late.txt',
      mime: 'text/plain',
      chatId: 'pending-late',
    });
    const fallback = await processRestore({
      bytes: lateMasked.maskedBytes,
      name: lateMasked.maskedName,
      mime: 'text/plain',
      chatId: 'real-late',
      pendingChatId: 'pending-late',
    });
    expect(decoder.decode(fallback.bytes)).toBe(text);
  });
});

describe('INV-M2: SPA navigation binding', () => {
  it('records pendingId -> real chat and consumes the pending marker', () => {
    const storage = new Map<string, string>();
    const target = {
      location: {
        href: 'https://chatgpt.com/c/real-9',
        origin: 'https://chatgpt.com',
        pathname: '/c/real-9',
      },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    } as unknown as Window;

    storage.set('dmrelay:pending', 'pending-9');
    expect(bindPendingToRealChat(target, 'real-9')).toBe(true);
    expect(storage.get('dmrelay:chat-bind')).toBe(
      JSON.stringify({ pendingId: 'pending-9', chatId: 'real-9' }),
    );
    expect(storage.has('dmrelay:pending')).toBe(false);
  });
});

describe('INV-M4: clear-data generation epoch', () => {
  it('rejects a save that captured a pre-clear epoch', async () => {
    const epoch = getVaultEpoch();
    const vault = createVault('', { prefix: 'AAAAA' });

    await clearAllData();
    await expect(saveVault(vault, epoch)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(await listVaults()).toEqual([]);
  });

  it('clear-vs-inflight leaves no vault behind', async () => {
    const pending = processAnonymize({
      bytes: encoder.encode(`Секрет ${PERSON_A}`),
      name: 'inflight.txt',
      mime: 'text/plain',
      chatId: 'clear-race',
    });
    await clearAllData();
    await pending.catch(() => undefined);
    expect(await listVaults()).toEqual([]);
  });
});

describe('INV-M6: restore is linear', () => {
  it('restores 10k/20k/40k tags without quadratic blow-up', () => {
    const vault = createVault('', { prefix: 'AAAAA' });
    vault.entities.PERSON_1 = {
      label: 'PERSON',
      canonical: PERSON_A,
      variants: [],
      count: 40_000,
    };

    const timings: Record<number, number> = {};
    for (const count of [10_000, 20_000, 40_000]) {
      const text = '[[AAAAA_PERSON_1]]\n'.repeat(count);
      const started = performance.now();
      const result = restoreText(text, vault);
      timings[count] = performance.now() - started;
      expect(result.replacements).toBe(count);
      expect(result.text).not.toContain('[[');
    }

    // Before the fix 40k took ~5.4s (quadratic). A hard 200 ms ceiling (plus
    // 20k under 150 ms) catches quadratic regressions without ratio noise from
    // JIT/GC on a loaded CI machine.
    expect(timings[40_000]).toBeLessThan(200);
    expect(timings[20_000]).toBeLessThan(150);
  });
});

describe('EMP-M4: UTF-16 without BOM', () => {
  it.each([
    ['utf-16le', true],
    ['utf-16be', false],
  ] as const)('detects and round-trips %s', async (encoding, littleEndian) => {
    const text = `Договор\n${PERSON_A}\n${PERSON_B}\n`;
    const bytes = utf16(text, littleEndian);
    expect(detectEncoding(bytes)).toEqual({ encoding, bom: false });

    const vault = createVault('');
    const masked = await anonymizeTxt(
      { name: 'u16.txt', mimeType: 'text/plain', bytes },
      { vault, maxBytes: 1024 * 1024 },
    );
    expect(decoder.decode(masked.maskedBytes)).not.toContain(PERSON_A);
    expect(masked.warnings.some((warning) => /without BOM/u.test(warning))).toBe(true);

    const record = vault.files[0];
    expect(record?.encoding).toBe(encoding);
    const restored = await restoreTxt(
      { name: 'u16.txt', mimeType: 'text/plain', bytes: masked.maskedBytes },
      vault,
    );
    expect(new TextDecoder(encoding).decode(restored.bytes)).toBe(text);
  });
});

describe('R3-M2: PERSON surname fallback is indexed', () => {
  function runLoneSurnames(count: number): { duration: number; resolved: number } {
    const vault = createVault('', { prefix: 'AAAAA' });
    for (let index = 0; index < count; index += 1) {
      vault.entities[`PERSON_${index + 1}`] = {
        label: 'PERSON',
        canonical: `Фамилия${index} Имя${index}`,
        variants: [],
        count: 1,
      };
    }
    const index = createVaultIndex(vault);
    const started = performance.now();
    let resolved = 0;
    for (let i = 0; i < count; i += 1) {
      const surname = `Фамилия${i}`;
      const assigned = assignDetection(
        vault,
        {
          label: 'PERSON',
          start: 0,
          end: surname.length,
          text: surname,
          priority: 0,
          ruleId: 'test',
          entityKey: encodePersonKey([surname.toLowerCase(), '', '']),
          canonical: surname,
          canonicalScore: 1,
        },
        { index },
      );
      if (assigned.key === `PERSON_${i + 1}`) resolved += 1;
    }
    return { duration: performance.now() - started, resolved };
  }

  it('2k/4k lone-surname spans stay linear', { timeout: 30_000 }, () => {
    runLoneSurnames(200); // warm up the JIT before measuring
    const twoK = runLoneSurnames(2_000);
    const fourK = runLoneSurnames(4_000);

    expect(twoK.resolved).toBe(2_000);
    expect(fourK.resolved).toBe(4_000);
    // Before the fix the fallback scanned every entity per span: ~1 s at 2k
    // and ~4 s at 4k. The indexed lookup keeps both far below that.
    expect(twoK.duration).toBeLessThan(1_500);
    expect(fourK.duration).toBeLessThan(3_000);
  });
});
