import { describe, expect, it } from 'vitest';
import type { MainBridge } from '../../src/interception/bridge-main';
import { CapturedFileQueue } from '../../src/interception/file-capture';
import {
  backgroundError,
  ERROR_TEXT,
  RESTORE_ERROR_TEXT,
} from '../../src/interception/isolated-relay';
import {
  BRIDGE_VERSION,
  BridgeError,
  ISOLATED_SOURCE,
  MAX_FILE_BYTES,
  parseBridgeResponse,
  type ToastReason,
} from '../../src/interception/protocol';
import { installUploadHooks } from '../../src/interception/upload-hook';

class FakeXhr {
  onload: ((event: Event) => void) | null = null;
  onloadend: ((event: Event) => void) | null = null;
  onreadystatechange: ((event: Event) => void) | null = null;
  readyState = 0;
  status = 0;
  responseType = '';
  response: unknown = null;
  responseText = '';
  open(): void {}
  send(): void {}
  abort(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  getResponseHeader(): string | null {
    return null;
  }
}

function makeWindow(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Window {
  return {
    location: {
      href: 'https://chatgpt.com/',
      origin: 'https://chatgpt.com',
      pathname: '/',
    },
    fetch: fetchImpl as typeof window.fetch,
    XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest,
    postMessage: () => {},
    addEventListener: () => {},
  } as unknown as Window;
}

describe('R22-ARCHIVE-BRIDGE: UNSUPPORTED_ARCHIVE reaches ISOLATED and the toast', () => {
  it('keeps the archive code and constant Russian text instead of INTERNAL', () => {
    const mapped = backgroundError({
      ok: false,
      error: { code: 'UNSUPPORTED_ARCHIVE', message: 'Архив ZIP64 не поддерживается' },
    });
    expect(mapped.code).toBe('UNSUPPORTED_ARCHIVE');
    expect(mapped.message).toBe('Архив ZIP64 не поддерживается');

    expect(ERROR_TEXT.UNSUPPORTED_ARCHIVE).toContain(
      'Архив ZIP64 или зашифрованный ZIP не поддерживается',
    );
    expect(RESTORE_ERROR_TEXT.UNSUPPORTED_ARCHIVE).toContain(
      'Архив ZIP64 или зашифрованный ZIP не поддерживается',
    );
  });

  it('accepts the archive failure code in a bridge response', () => {
    const parsed = parseBridgeResponse({
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id: 'archive-1',
      ok: false,
      error: { code: 'UNSUPPORTED_ARCHIVE', message: 'Архив ZIP64 не поддерживается' },
    });
    expect(parsed?.ok === false ? parsed.error.code : undefined).toBe('UNSUPPORTED_ARCHIVE');
  });

  it('shows the archive reason in the upload toast, not INTERNAL', async () => {
    const window = makeWindow(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ upload_url: 'https://upload.example.test/u/1' }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const queue = new CapturedFileQueue({ now: () => 1_000 });
    queue.add({
      name: 'a.docx',
      size: 1,
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      lastModified: 1,
      arrayBuffer: async () => new Uint8Array(1).buffer,
    } as unknown as File);
    const notifications: ToastReason[] = [];
    const bridge: MainBridge = {
      isEnabled: () => true,
      maxBytes: () => MAX_FILE_BYTES,
      anonymizeFile: async () => {
        throw new BridgeError('UNSUPPORTED_ARCHIVE', 'Архив ZIP64 не поддерживается');
      },
      restoreFile: async () => {
        throw new Error('unused');
      },
      restoreName: async () => {
        throw new Error('unused');
      },
      notify: (reason) => notifications.push(reason),
    };

    const cleanup = installUploadHooks({ queue, bridge, target: window, now: () => 1_000 });
    try {
      await expect(
        window.fetch('https://chatgpt.com/backend-api/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file_name: 'a.docx', file_size: 1 }),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(notifications).toEqual(['UNSUPPORTED_ARCHIVE']);
      expect(notifications).not.toContain('INTERNAL');
    } finally {
      cleanup();
    }
  });
});

describe('R25-DENSITY-BRIDGE: TOO_MANY_ENTITIES reaches ISOLATED and the toast', () => {
  const MESSAGE =
    'Файл содержит слишком много имён или сущностей для обработки. Разбейте его на части.';

  it('keeps the density code and constant Russian text instead of INTERNAL', () => {
    const mapped = backgroundError({
      ok: false,
      error: { code: 'TOO_MANY_ENTITIES', message: MESSAGE },
    });
    expect(mapped.code).toBe('TOO_MANY_ENTITIES');
    expect(mapped.message).toBe(MESSAGE);

    expect(ERROR_TEXT.TOO_MANY_ENTITIES).toBe(MESSAGE);
    expect(RESTORE_ERROR_TEXT.TOO_MANY_ENTITIES).toBe(MESSAGE);
  });

  it('accepts the density failure code in a bridge response', () => {
    const parsed = parseBridgeResponse({
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id: 'density-1',
      ok: false,
      error: { code: 'TOO_MANY_ENTITIES', message: MESSAGE },
    });
    expect(parsed?.ok === false ? parsed.error.code : undefined).toBe('TOO_MANY_ENTITIES');
  });

  it('shows the density reason in the upload toast, not INTERNAL', async () => {
    const window = makeWindow(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ upload_url: 'https://upload.example.test/u/2' }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const queue = new CapturedFileQueue({ now: () => 1_000 });
    queue.add({
      name: 'dense.txt',
      size: 1,
      type: 'text/plain',
      lastModified: 1,
      arrayBuffer: async () => new Uint8Array(1).buffer,
    } as unknown as File);
    const notifications: ToastReason[] = [];
    const bridge: MainBridge = {
      isEnabled: () => true,
      maxBytes: () => MAX_FILE_BYTES,
      anonymizeFile: async () => {
        throw new BridgeError('TOO_MANY_ENTITIES', MESSAGE);
      },
      restoreFile: async () => {
        throw new Error('unused');
      },
      restoreName: async () => {
        throw new Error('unused');
      },
      notify: (reason) => notifications.push(reason),
    };

    const cleanup = installUploadHooks({ queue, bridge, target: window, now: () => 1_000 });
    try {
      await expect(
        window.fetch('https://chatgpt.com/backend-api/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file_name: 'dense.txt', file_size: 1 }),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(notifications).toEqual(['TOO_MANY_ENTITIES']);
      expect(notifications).not.toContain('INTERNAL');
    } finally {
      cleanup();
    }
  });
});
