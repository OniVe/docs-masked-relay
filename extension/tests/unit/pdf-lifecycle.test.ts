import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R3-M1: a new vault must be persisted while the PDF engine runs, so a second
 * PDF (or TXT) in the same chat joins it; a delete during the run must not be
 * undone by the final save.
 */
const pdf = vi.hoisted(() => {
  interface Run {
    started: Promise<void>;
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }
  const runs: Run[] = [];
  return {
    runs,
    start(): Run {
      let resolveRun: (value: unknown) => void = () => {};
      let rejectRun: (error: unknown) => void = () => {};
      let signalStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const promise = new Promise<unknown>((resolve, reject) => {
        resolveRun = resolve;
        rejectRun = reject;
      });
      signalStarted();
      const run: Run = {
        started,
        promise,
        resolve: (value) => resolveRun(value),
        reject: (error) => rejectRun(error),
      };
      runs.push(run);
      return run;
    },
  };
});

vi.mock('../../src/background/pdf-runner', () => ({
  runPdfAnonymize: () => pdf.start().promise,
}));

import { resetDb } from '../../src/background/db';
import { processAnonymize, processRestore } from '../../src/background/process';
import {
  closeVaultStore,
  deleteVault,
  getVault,
  initVaultStore,
  listVaults,
} from '../../src/background/vault-store';

const encoder = new TextEncoder();
const PDF_MIME = 'application/pdf';
const PERSON = 'Иванов Иван Иванович';

function pdfInput(name = 'scan.pdf', chatId = 'chat-pdf-lifecycle') {
  return { bytes: Uint8Array.of(1, 2, 3), name, mime: PDF_MIME, chatId };
}

function runFile(name: string) {
  return {
    originalName: name,
    maskedName: name,
    format: 'pdf' as const,
    size: 3,
    sha256: 'a'.repeat(64),
  };
}

async function waitForRun(index: number) {
  await vi.waitFor(() => {
    if (!pdf.runs[index]) throw new Error(`PDF run #${index} did not start`);
  });
  return pdf.runs[index] as NonNullable<(typeof pdf.runs)[number]>;
}

beforeEach(async () => {
  await closeVaultStore();
  await resetDb();
  await initVaultStore();
  pdf.runs.length = 0;
});

afterEach(async () => {
  await closeVaultStore();
});

describe('R3-M1: PDF vault identity and lifecycle', () => {
  it('persists a new vault at resolve, so two PDFs share it', async () => {
    const first = processAnonymize(pdfInput('first.pdf', 'chat-two-pdfs'));
    const firstRun = await waitForRun(0);
    expect((await listVaults()).length).toBe(1);

    const second = processAnonymize(pdfInput('second.pdf', 'chat-two-pdfs'));
    const secondRun = await waitForRun(1);
    expect((await listVaults()).length).toBe(1);

    firstRun.resolve({ maskedBytes: Uint8Array.of(9), file: runFile('first.pdf'), warnings: [] });
    secondRun.resolve({ maskedBytes: Uint8Array.of(9), file: runFile('second.pdf'), warnings: [] });

    const [out1, out2] = await Promise.all([first, second]);
    expect(out1.vaultId).toBe(out2.vaultId);
    expect((await listVaults()).length).toBe(1);

    const stored = await getVault(out1.vaultId);
    expect(stored?.files.map((file) => file.originalName).sort()).toEqual([
      'first.pdf',
      'second.pdf',
    ]);
  });

  it('removes the empty vault after two failed PDFs in one chat (R4-N1)', async () => {
    const first = processAnonymize(pdfInput('first.pdf', 'chat-two-failed'));
    const firstRun = await waitForRun(0);
    const second = processAnonymize(pdfInput('second.pdf', 'chat-two-failed'));
    const secondRun = await waitForRun(1);
    expect((await listVaults()).length).toBe(1);

    firstRun.reject(new Error('pdf engine failed'));
    secondRun.reject(new Error('pdf engine failed'));

    await expect(first).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(second).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(await listVaults()).toEqual([]);
  });

  it('does not resurrect a vault deleted while the PDF engine runs', async () => {
    const seed = await processAnonymize({
      bytes: encoder.encode(PERSON),
      name: 'seed.txt',
      mime: 'text/plain',
      chatId: 'chat-delete-during-pdf',
    });

    const pending = processAnonymize(pdfInput('late.pdf', 'chat-delete-during-pdf'));
    const run = await waitForRun(0);
    expect(await deleteVault(seed.vaultId)).toBe(true);

    run.resolve({ maskedBytes: Uint8Array.of(9), file: runFile('late.pdf'), warnings: [] });

    await expect(pending).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(await listVaults()).toEqual([]);
    expect(await getVault(seed.vaultId)).toBeUndefined();
  });

  it('lets a TXT upload join the vault persisted by a running PDF', async () => {
    const pendingPdf = processAnonymize(pdfInput('scan.pdf', 'chat-pdf-txt'));
    const run = await waitForRun(0);

    const txt = await processAnonymize({
      bytes: encoder.encode(`Договор ${PERSON}`),
      name: 'note.txt',
      mime: 'text/plain',
      chatId: 'chat-pdf-txt',
    });
    expect(txt.maskedBytes).not.toEqual(encoder.encode(`Договор ${PERSON}`));

    run.resolve({ maskedBytes: Uint8Array.of(9), file: runFile('scan.pdf'), warnings: [] });
    const pdfResult = await pendingPdf;
    expect(pdfResult.vaultId).toBe(txt.vaultId);
    expect((await listVaults()).length).toBe(1);

    const stored = await getVault(txt.vaultId);
    expect(stored?.files.map((file) => file.originalName).sort()).toEqual(['note.txt', 'scan.pdf']);

    const restored = await processRestore({
      bytes: txt.maskedBytes,
      name: 'note.txt',
      mime: 'text/plain',
      chatId: 'chat-pdf-txt',
    });
    expect(restored.replacements).toBeGreaterThan(0);
    expect(new TextDecoder().decode(restored.bytes)).toBe(`Договор ${PERSON}`);
  });
});
