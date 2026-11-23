import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R2-M3: the vault lock must not be held while the PDF engine runs. The mock
 * keeps `runPdfAnonymize` pending until the test releases it, so a restore in
 * the same chat can only complete if the lock was released before the run.
 */
const pdf = vi.hoisted(() => {
  let resolveRun: (value: unknown) => void = () => {};
  let rejectRun: (error: unknown) => void = () => {};
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const pending = new Promise<unknown>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  return {
    calls: [] as Array<{ name: string; bytes: Uint8Array }>,
    started,
    pending,
    signalStarted: () => signalStarted(),
    resolveRun: (value: unknown) => resolveRun(value),
    rejectRun: (error: unknown) => rejectRun(error),
  };
});

vi.mock('../../src/background/pdf-runner', () => ({
  runPdfAnonymize: (input: { name: string; bytes: Uint8Array }) => {
    pdf.calls.push(input);
    pdf.signalStarted();
    return pdf.pending;
  },
}));

import { resetDb } from '../../src/background/db';
import { processAnonymize, processRestore } from '../../src/background/process';
import { closeVaultStore, getVault, initVaultStore } from '../../src/background/vault-store';

const encoder = new TextEncoder();
const PDF_MIME = 'application/pdf';

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
  pdf.calls.length = 0;
});

afterEach(async () => {
  await closeVaultStore();
});

describe('R2-M3: PDF processing does not hold the vault lock', () => {
  it('lets restore proceed while the PDF engine is still running', async () => {
    const seed = await processAnonymize({
      bytes: encoder.encode('Иванов Иван Иванович'),
      name: 'seed.txt',
      mime: 'text/plain',
      chatId: 'chat-pdf-lock',
    });

    const pdfPromise = processAnonymize({
      bytes: Uint8Array.of(1, 2, 3),
      name: 'scan.pdf',
      mime: PDF_MIME,
      chatId: 'chat-pdf-lock',
    });
    await pdf.started;

    let restoreFinished = false;
    const restorePromise = processRestore({
      bytes: seed.maskedBytes,
      name: 'note.txt',
      mime: 'text/plain',
      chatId: 'chat-pdf-lock',
    }).then((result) => {
      restoreFinished = true;
      return result;
    });

    try {
      const winner = await Promise.race([
        restorePromise.then(() => 'restored'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 250)),
      ]);
      expect(winner).toBe('restored');
      expect(restoreFinished).toBe(true);
    } finally {
      pdf.resolveRun({
        maskedBytes: new Uint8Array([9, 9, 9]),
        file: {
          originalName: 'scan.pdf',
          maskedName: 'scan.pdf',
          format: 'pdf',
          size: 3,
          sha256: 'a'.repeat(64),
        },
        warnings: [],
      });
    }

    const result = await pdfPromise;
    expect(result.vaultId).toBe(seed.vaultId);
    expect(result.format).toBe('pdf');

    const stored = await getVault(seed.vaultId);
    expect(stored?.files.map((file) => file.originalName)).toEqual(['seed.txt', 'scan.pdf']);
  });
});
