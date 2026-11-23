/**
 * PDF runner (M5a): keeps EmbedPDF out of the MV3 service worker.
 *
 * Chromium: lazily create a `chrome.offscreen` document (reason WORKERS) and
 * send it base64 bytes; the offscreen page imports the PDF adapter, boots
 * PDFium in a worker and returns the redacted bytes plus one `VaultFile`.
 * Safari: `browser.offscreen` does not exist, but its background page has a
 * DOM, so the adapter is imported there directly. Anything else fails closed.
 *
 * Runs are serialized because the offscreen page and the engine are shared.
 */

import { browser } from 'wxt/browser';
import { PdfRedactionError } from '../core/formats/pdf-errors';
import type { DetectionConfig, VaultFile } from '../core/types';
import { base64ToBytes, bytesToBase64 } from '../shared/base64';
import {
  createPdfVaultStub,
  encodePdfConfig,
  PDF_ANONYMIZE_MESSAGE,
  type PdfAnonymizeWireMessage,
  parsePdfAnonymizeResponse,
} from './pdf-protocol';

const IDLE_CLOSE_MS = 30_000;
const OFFSCREEN_READY_RETRIES = 20;
const OFFSCREEN_READY_DELAY_MS = 100;
/** A hung offscreen/PDFium run must not wedge the serialized queue forever. */
export const PDF_OFFSCREEN_TIMEOUT_MS = 45_000;
const OFFSCREEN_CLOSE_TIMEOUT_MS = 5_000;
const OFFSCREEN_JUSTIFICATION =
  'Run the bundled PDFium WebAssembly worker to redact PDF files locally';

interface OffscreenApi {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
  hasDocument?(): Promise<boolean>;
}

function offscreenApi(): OffscreenApi | undefined {
  const chromeGlobal = (globalThis as { chrome?: { offscreen?: OffscreenApi } }).chrome;
  return chromeGlobal?.offscreen;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function missingReceiver(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /receiving end does not exist|could not establish connection|message port closed/iu.test(
    message,
  );
}

function offscreenRuntimeError(): PdfRedactionError {
  return new PdfRedactionError(
    'PDF_RUNTIME',
    'PDF: offscreen engine did not start; the file was not sent (use manual mode)',
  );
}

let creatingOffscreen: Promise<void> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function ensureOffscreen(api: OffscreenApi): Promise<void> {
  try {
    if (api.hasDocument && (await api.hasDocument())) return;
  } catch {
    // Older Chrome versions lack hasDocument; createDocument below reports
    // the single-document case instead.
  }

  creatingOffscreen ??= api
    .createDocument({
      url: browser.runtime.getURL('/offscreen.html'),
      reasons: ['WORKERS'],
      justification: OFFSCREEN_JUSTIFICATION,
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Another caller created it between hasDocument() and createDocument().
      if (/single offscreen|already exists/iu.test(message)) return;
      throw error;
    })
    .finally(() => {
      creatingOffscreen = undefined;
    });

  await creatingOffscreen;
}

/** Closes the reusable offscreen document (also used by tests). */
export async function closePdfOffscreen(): Promise<void> {
  const api = offscreenApi();
  if (!api) return;
  try {
    if (api.hasDocument && !(await api.hasDocument())) return;
    await api.closeDocument();
  } catch {
    // No document or the browser is shutting down.
  }
}

function cancelIdleClose(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

function scheduleIdleClose(): void {
  if (!offscreenApi()) return;
  cancelIdleClose();
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    void closePdfOffscreen();
  }, IDLE_CLOSE_MS);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(offscreenRuntimeError());
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function requestOffscreen(message: PdfAnonymizeWireMessage): Promise<unknown> {
  for (let attempt = 0; attempt < OFFSCREEN_READY_RETRIES; attempt += 1) {
    try {
      const response = await withTimeout(
        browser.runtime.sendMessage(message),
        PDF_OFFSCREEN_TIMEOUT_MS,
      );
      if (response !== undefined) return response;
    } catch (error) {
      if (error instanceof PdfRedactionError) throw error;
      if (!missingReceiver(error)) break;
    }
    await sleep(OFFSCREEN_READY_DELAY_MS);
  }
  throw offscreenRuntimeError();
}

/**
 * A timed-out engine may be permanently stuck; close the document so the next
 * run creates a fresh one. Bounded: closeDocument itself may hang.
 */
async function resetOffscreenAfterTimeout(): Promise<void> {
  try {
    await Promise.race([closePdfOffscreen(), sleep(OFFSCREEN_CLOSE_TIMEOUT_MS)]);
  } catch {
    // Best effort; the next ensureOffscreen retries.
  }
}

export interface PdfRunInput {
  bytes: Uint8Array;
  name: string;
  mime: string;
  /** Background vault identity; the offscreen document never sees the vault. */
  vaultId: string;
  vaultPrefix: string;
  config?: DetectionConfig;
  maxBytes: number;
}

export interface PdfRunOutput {
  maskedBytes: Uint8Array;
  /** One record for the background to push into the real vault. */
  file: VaultFile;
  warnings: string[];
}

function validateFile(file: VaultFile, input: PdfRunInput): VaultFile {
  if (
    file.format !== 'pdf' ||
    file.originalName !== input.name ||
    file.size !== input.bytes.byteLength
  ) {
    throw new PdfRedactionError(
      'PDF_RUNTIME',
      'PDF: inconsistent redaction result; the file was not sent',
    );
  }
  return file;
}

async function runInOffscreen(input: PdfRunInput): Promise<PdfRunOutput> {
  const api = offscreenApi();
  if (!api) throw offscreenRuntimeError();

  await ensureOffscreen(api);

  const message: PdfAnonymizeWireMessage = {
    type: PDF_ANONYMIZE_MESSAGE,
    requestId: crypto.randomUUID(),
    payload: {
      bytes: bytesToBase64(input.bytes),
      name: input.name,
      mime: input.mime,
      vaultId: input.vaultId,
      vaultPrefix: input.vaultPrefix,
      config: encodePdfConfig(input.config),
    },
  };

  let raw: unknown;
  try {
    raw = await requestOffscreen(message);
  } catch (error) {
    // Recreate the offscreen document so a hung PDFium worker does not poison
    // every later run; the queued run rejects with PDF_RUNTIME instead.
    await resetOffscreenAfterTimeout();
    throw error;
  }
  const response = parsePdfAnonymizeResponse(raw);
  if (!response) throw offscreenRuntimeError();

  if (!response.ok) {
    if (response.error.code === 'PDF_UNKNOWN') {
      throw new PdfRedactionError('PDF_RUNTIME', response.error.message || 'PDF failed');
    }
    throw new PdfRedactionError(response.error.code, response.error.message);
  }

  const maskedBytes = base64ToBytes(response.result.maskedBytes);
  if (!maskedBytes || maskedBytes.byteLength === 0 || maskedBytes.byteLength > input.maxBytes * 2) {
    throw new PdfRedactionError(
      'PDF_RUNTIME',
      'PDF: redaction returned an invalid payload; the file was not sent',
    );
  }

  return {
    maskedBytes,
    file: validateFile(response.result.file, input),
    warnings: response.result.warnings,
  };
}

/**
 * Safari: the MV3 background is a page, not a worker, so PDFium can run
 * directly. The dynamic import keeps the engine out of the normal background
 * bundle path until the first PDF.
 */
async function runInBackgroundPage(input: PdfRunInput): Promise<PdfRunOutput> {
  // This branch exists only in the Safari build. In Chrome the guard is a
  // build-time constant, so the dynamic import (and the whole EmbedPDF graph)
  // is tree-shaken out of the service-worker bundle.
  if (!import.meta.env.SAFARI) throw offscreenRuntimeError();

  let adapter: typeof import('../core/formats/pdf');
  try {
    adapter = await import('../core/formats/pdf');
  } catch {
    throw offscreenRuntimeError();
  }

  const vault = createPdfVaultStub(input.vaultId, input.vaultPrefix);
  const result = await adapter.anonymizePdf(
    { name: input.name, mimeType: input.mime, bytes: input.bytes },
    { vault, maxBytes: input.maxBytes, config: input.config },
  );
  const file = vault.files[0];
  if (!file) throw offscreenRuntimeError();

  return {
    maskedBytes: result.maskedBytes,
    file: validateFile(file, input),
    warnings: result.warnings,
  };
}

async function execute(input: PdfRunInput): Promise<PdfRunOutput> {
  if (offscreenApi()) return runInOffscreen(input);
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    return runInBackgroundPage(input);
  }
  throw new PdfRedactionError(
    'PDF_RUNTIME',
    'PDF: engine runtime is unavailable in this browser context; use manual mode',
  );
}

let chain: Promise<unknown> = Promise.resolve();
let pendingRuns = 0;

/**
 * Serializes PDF runs. The offscreen document and its PDFium worker are
 * single-instance, and two concurrent messages could race redaction.
 */
export function runPdfAnonymize(input: PdfRunInput): Promise<PdfRunOutput> {
  pendingRuns += 1;
  cancelIdleClose();

  const task = chain.then(
    () => execute(input),
    () => execute(input),
  );
  chain = task
    .catch(() => {})
    .finally(() => {
      pendingRuns -= 1;
      // Only the last queued run starts the idle countdown; a timer scheduled
      // by an earlier run would close the document in the middle of a later one.
      if (pendingRuns === 0) scheduleIdleClose();
    });
  return task;
}
