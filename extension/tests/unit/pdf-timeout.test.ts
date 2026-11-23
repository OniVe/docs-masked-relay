import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getURL: vi.fn((path: string) => `chrome-extension://dmrelay-test${path}`),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendMessage: transport.sendMessage,
      getURL: transport.getURL,
    },
  },
}));

import {
  closePdfOffscreen,
  PDF_OFFSCREEN_TIMEOUT_MS,
  runPdfAnonymize,
} from '../../src/background/pdf-runner';

interface OffscreenState {
  hasDocument: boolean;
  created: number;
  closed: number;
}

function installOffscreen(): OffscreenState {
  const state: OffscreenState = { hasDocument: false, created: 0, closed: 0 };
  (globalThis as { chrome?: unknown }).chrome = {
    offscreen: {
      hasDocument: async () => state.hasDocument,
      createDocument: async () => {
        state.hasDocument = true;
        state.created += 1;
      },
      closeDocument: async () => {
        state.hasDocument = false;
        state.closed += 1;
      },
    },
  };
  return state;
}

const INPUT = {
  bytes: new Uint8Array([1, 2, 3]),
  name: 'a.pdf',
  mime: 'application/pdf',
  vaultId: 'vault-1',
  vaultPrefix: 'AAAAA',
  maxBytes: 1024,
};

describe('INV-M7: PDF offscreen timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    transport.sendMessage.mockReset();
    transport.sendMessage.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closePdfOffscreen();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('rejects PDF_RUNTIME on a never-resolving offscreen and recreates it', async () => {
    const state = installOffscreen();

    const first = runPdfAnonymize(INPUT);
    await vi.advanceTimersByTimeAsync(PDF_OFFSCREEN_TIMEOUT_MS);
    await expect(first).rejects.toMatchObject({ code: 'PDF_RUNTIME' });
    expect(state.closed).toBe(1);
    expect(state.hasDocument).toBe(false);

    const second = runPdfAnonymize(INPUT);
    await vi.advanceTimersByTimeAsync(PDF_OFFSCREEN_TIMEOUT_MS);
    await expect(second).rejects.toMatchObject({ code: 'PDF_RUNTIME' });
    expect(state.created).toBe(2);
  });
});
