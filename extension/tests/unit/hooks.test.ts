import { describe, expect, it } from 'vitest';
import type { MainBridge } from '../../src/interception/bridge-main';
import { installDownloadHooks } from '../../src/interception/download-hook';
import { CapturedFileQueue } from '../../src/interception/file-capture';
import { MAX_FILE_BYTES, type ToastReason } from '../../src/interception/protocol';
import { installUploadHooks } from '../../src/interception/upload-hook';

class FakeXhr {
  static sent = 0;
  static lastBody: unknown;
  onload: ((event: Event) => void) | null = null;
  onloadend: ((event: Event) => void) | null = null;
  onreadystatechange: ((event: Event) => void) | null = null;
  readyState = 0;
  status = 0;
  responseType = '';
  response: unknown = null;
  responseText = '';
  open(_method?: string, _url?: string): void {}
  send(body?: unknown): void {
    FakeXhr.sent += 1;
    FakeXhr.lastBody = body;
  }
  abort(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  getResponseHeader(): string | null {
    return null;
  }
}

interface FetchCall {
  input: string;
  init?: RequestInit;
}

function fakeFile(name: string, size: number): File {
  return {
    name,
    size,
    type: 'text/plain',
    lastModified: 1,
    arrayBuffer: async () => new Uint8Array(size).fill(0x41).buffer,
  } as unknown as File;
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

describe('INV-M8: upload fail-closed after metadata rewrite', () => {
  it('aborts an uninspectable POST/PUT instead of passing original bytes through', async () => {
    const calls: FetchCall[] = [];
    const window = makeWindow((input, init) => {
      calls.push({ input: String(input), init });
      if (String(input) === 'https://chatgpt.com/backend-api/files') {
        return Promise.resolve(
          new Response(JSON.stringify({ upload_url: 'https://upload.example.test/u/1' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    });

    const queue = new CapturedFileQueue({ now: () => 1_000 });
    queue.add(fakeFile('a.txt', 1));
    const notifications: ToastReason[] = [];
    const bridge: MainBridge = {
      isEnabled: () => true,
      maxBytes: () => MAX_FILE_BYTES,
      anonymizeFile: async () => ({
        maskedBytes: new Uint8Array([0x42]).buffer,
        maskedName: 'a.txt',
        entities: [],
        warnings: [],
      }),
      restoreFile: async () => ({
        bytes: new ArrayBuffer(1),
        fileName: 'a.txt',
        replacements: 0,
        unknownTags: [],
        warnings: [],
      }),
      restoreName: async () => ({
        fileName: 'a.txt',
        replacements: 0,
        unknownTags: [],
        warnings: [],
      }),
      notify: (reason) => notifications.push(reason),
    };

    const cleanup = installUploadHooks({ queue, bridge, target: window, now: () => 1_000 });
    try {
      await window.fetch('https://chatgpt.com/backend-api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: 'a.txt', file_size: 1 }),
      });
      expect(calls).toHaveLength(1);

      // A probable transport (known OpenAI upload host) with an uninspectable
      // Request body is still aborted.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('original-bytes'));
          controller.close();
        },
      });
      const request = new Request('https://abc.oaiusercontent.com/collect', {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit);

      await expect(window.fetch(request)).rejects.toMatchObject({ name: 'AbortError' });
      expect(notifications).toContain('TRANSPORT');

      // Collateral traffic is no longer blocked while a rewritten upload is
      // pending: an unrelated Blob POST...
      await window.fetch('https://telemetry.example.test/collect', {
        method: 'POST',
        body: new Blob(['telemetry']),
      });
      // ...and a JSON Request with a stream body.
      const jsonStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"message":"hi"}'));
          controller.close();
        },
      });
      await window.fetch(
        new Request('https://chatgpt.com/backend-api/conversation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonStream,
          duplex: 'half',
        } as RequestInit),
      );
      expect(calls).toHaveLength(3);

      // Plain same-origin JSON (chat messages) must keep working.
      await window.fetch('https://chatgpt.com/backend-api/conversation', {
        method: 'POST',
        body: '{"message":"hi"}',
      });
      expect(calls).toHaveLength(4);

      // XHR collateral: an unrelated Blob body passes through.
      FakeXhr.sent = 0;
      const xhr = new FakeXhr();
      xhr.open('POST', 'https://telemetry.example.test/xhr');
      xhr.send(new Blob(['telemetry']));
      expect(FakeXhr.sent).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe('INV-M3: silent pass-through when nothing was restored', () => {
  it('shows MANUAL_FALLBACK for a tagged name/body with zero replacements', async () => {
    const notifications: ToastReason[] = [];
    const bridge: MainBridge = {
      isEnabled: () => true,
      maxBytes: () => MAX_FILE_BYTES,
      anonymizeFile: async () => ({
        maskedBytes: new ArrayBuffer(1),
        maskedName: 'a.txt',
        entities: [],
        warnings: [],
      }),
      restoreName: async () => ({
        fileName: '[[ABCDE_PERSON_1]]_a.txt',
        replacements: 0,
        unknownTags: ['[[ABCDE_PERSON_1]]'],
        warnings: ['1 unknown tag(s) left untouched'],
      }),
      restoreFile: async () => ({
        bytes: new TextEncoder().encode('masked').buffer,
        fileName: 'a.txt',
        replacements: 0,
        unknownTags: [],
        warnings: [],
      }),
      notify: (reason) => notifications.push(reason),
    };

    const window = makeWindow((input) => {
      if (String(input) === 'https://chatgpt.com/backend-api/files/file-1/download') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file_name: '[[ABCDE_PERSON_1]]_a.txt',
              download_url: 'https://cdn.oaiusercontent.com/content/1',
              mime_type: 'text/plain',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('masked', { headers: { 'content-type': 'text/plain' } }));
    });

    const cleanup = installDownloadHooks({ bridge, target: window, now: () => 1_000 });
    try {
      const json = await window.fetch('https://chatgpt.com/backend-api/files/file-1/download');
      expect(json.ok).toBe(true);
      await window.fetch('https://cdn.oaiusercontent.com/content/1');
      expect(notifications.filter((reason) => reason === 'MANUAL_FALLBACK')).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

describe('R3-N1: size match only claims probable upload transports', () => {
  it('keeps an unrelated same-size PUT from stealing the masked entry', async () => {
    const calls: FetchCall[] = [];
    const target = makeWindow((input, init) => {
      calls.push({ input: String(input), init });
      if (String(input) === 'https://chatgpt.com/backend-api/files') {
        return Promise.resolve(
          new Response(JSON.stringify({ upload_url: 'https://upload.example.test/u/1' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    });

    const queue = new CapturedFileQueue({ now: () => 1_000 });
    queue.add(fakeFile('a.txt', 1));
    const bridge: MainBridge = {
      isEnabled: () => true,
      maxBytes: () => MAX_FILE_BYTES,
      anonymizeFile: async () => ({
        maskedBytes: new Uint8Array([0x42]).buffer,
        maskedName: 'a.txt',
        entities: [],
        warnings: [],
      }),
      restoreFile: async () => ({
        bytes: new ArrayBuffer(1),
        fileName: 'a.txt',
        replacements: 0,
        unknownTags: [],
        warnings: [],
      }),
      restoreName: async () => ({
        fileName: 'a.txt',
        replacements: 0,
        unknownTags: [],
        warnings: [],
      }),
      notify: () => {},
    };

    const cleanup = installUploadHooks({ queue, bridge, target, now: () => 1_000 });
    try {
      await target.fetch('https://chatgpt.com/backend-api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: 'a.txt', file_size: 1 }),
      });

      // Same size, unrelated host: the entry must not be claimed or rewritten.
      const unrelatedBody = new Blob([Uint8Array.of(0x41)], { type: 'text/plain' });
      await target.fetch('https://unrelated.example.test/upload', {
        method: 'PUT',
        body: unrelatedBody,
      });
      expect(calls[1]?.init?.body).toBe(unrelatedBody);

      // The real transport (exact URL from the metadata response) still gets it.
      const realBody = new Blob([Uint8Array.of(0x41)], { type: 'text/plain' });
      await target.fetch('https://upload.example.test/u/1', {
        method: 'PUT',
        body: realBody,
      });
      const rewritten = calls[2]?.init?.body as Uint8Array | undefined;
      expect(rewritten?.[0]).toBe(0x42);
    } finally {
      cleanup();
    }
  });
});

describe('R4-M2/R5-N1: Azure SAS / S3 uploads are size-matched probable targets', () => {
  function setup(uploadUrl?: string): {
    target: Window;
    queue: CapturedFileQueue;
    calls: FetchCall[];
    notifications: ToastReason[];
    cleanup: () => void;
  } {
    const calls: FetchCall[] = [];
    const notifications: ToastReason[] = [];
    const target = makeWindow((input, init) => {
      calls.push({ input: String(input), init });
      if (String(input) === 'https://chatgpt.com/backend-api/files') {
        // Without upload_url the metadata response is unreadable to the hook,
        // so only the host + original-size heuristic can classify the
        // transport. Tests that need an exact URL pass it explicitly.
        return Promise.resolve(
          new Response(JSON.stringify(uploadUrl ? { upload_url: uploadUrl } : { status: 'ok' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    });

    const queue = new CapturedFileQueue({ now: () => 1_000 });
    const bridge: MainBridge = {
      isEnabled: () => true,
      maxBytes: () => MAX_FILE_BYTES,
      anonymizeFile: async () => ({
        maskedBytes: new Uint8Array([0x42]).buffer,
        maskedName: 'a.txt',
        entities: [],
        warnings: [],
      }),
      restoreFile: async () => ({
        bytes: new ArrayBuffer(1),
        fileName: 'a.txt',
        replacements: 0,
        unknownTags: [],
        warnings: [],
      }),
      restoreName: async () => ({
        fileName: 'a.txt',
        replacements: 0,
        unknownTags: [],
        warnings: [],
      }),
      notify: (reason) => notifications.push(reason),
    };
    const cleanup = installUploadHooks({ queue, bridge, target, now: () => 1_000 });
    return { target, queue, calls, notifications, cleanup };
  }

  async function beginUpload(target: Window, queue: CapturedFileQueue): Promise<void> {
    queue.add(fakeFile('a.txt', 1));
    await target.fetch('https://chatgpt.com/backend-api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_name: 'a.txt', file_size: 1 }),
    });
  }

  it('rewrites a plain Azure SAS PUT without comp=block', async () => {
    const { target, queue, calls, cleanup } = setup();
    try {
      await beginUpload(target, queue);
      const original = new Blob([Uint8Array.of(0x41)], { type: 'text/plain' });
      await target.fetch('https://acct.blob.core.windows.net/c/b?sig=x', {
        method: 'PUT',
        body: original,
      });
      const rewritten = calls[1]?.init?.body as Uint8Array | undefined;
      expect(rewritten).toBeInstanceOf(Uint8Array);
      expect(rewritten?.[0]).toBe(0x42);
      expect(calls[1]?.init?.body).not.toBe(original);
    } finally {
      cleanup();
    }
  });

  it('rewrites an S3 PUT selected by host and original size', async () => {
    const { target, queue, calls, cleanup } = setup();
    try {
      await beginUpload(target, queue);
      await target.fetch('https://bucket.s3.eu-central-1.amazonaws.com/key?sig=x', {
        method: 'PUT',
        body: new Blob([Uint8Array.of(0x41)], { type: 'text/plain' }),
      });
      const rewritten = calls[1]?.init?.body as Uint8Array | undefined;
      expect(rewritten?.[0]).toBe(0x42);
    } finally {
      cleanup();
    }
  });

  it('rewrites an XHR blob PUT to a CloudFront host', async () => {
    const { target, queue, cleanup } = setup();
    try {
      await beginUpload(target, queue);
      const xhr = new FakeXhr();
      xhr.open('PUT', 'https://d111.cloudfront.net/upload?sig=x');
      xhr.send(new Blob([Uint8Array.of(0x41)], { type: 'text/plain' }));
      const rewritten = FakeXhr.lastBody as Uint8Array | undefined;
      expect(rewritten).toBeInstanceOf(Uint8Array);
      expect(rewritten?.[0]).toBe(0x42);
    } finally {
      cleanup();
    }
  });

  it('aborts an opaque Request stream to Azure SAS instead of passing it through', async () => {
    const { target, queue, notifications, cleanup } = setup();
    try {
      await beginUpload(target, queue);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('original-bytes'));
          controller.close();
        },
      });
      const request = new Request('https://acct.blob.core.windows.net/c/b?sig=x', {
        method: 'PUT',
        body: stream,
        duplex: 'half',
      } as RequestInit);

      await expect(target.fetch(request)).rejects.toMatchObject({ name: 'AbortError' });
      expect(notifications).toContain('TRANSPORT');
    } finally {
      cleanup();
    }
  });

  it('still passes a same-origin app PUT of the same size through', async () => {
    const { target, queue, calls, cleanup } = setup();
    try {
      await beginUpload(target, queue);
      const unrelated = new Blob([Uint8Array.of(0x41)], { type: 'text/plain' });
      await target.fetch('https://chatgpt.com/backend-api/unrelated', {
        method: 'PUT',
        body: unrelated,
      });
      expect(calls[1]?.init?.body).toBe(unrelated);
    } finally {
      cleanup();
    }
  });

  it('R5-N1: an unsigned cloud PUT does not claim the entry of the real transport', async () => {
    const { target, queue, calls, cleanup } = setup();
    try {
      await beginUpload(target, queue);
      const unrelated = new Blob([Uint8Array.of(0x41)], { type: 'text/plain' });
      await target.fetch('https://unrelated.blob.core.windows.net/c/b', {
        method: 'PUT',
        body: unrelated,
      });
      expect(calls[1]?.init?.body).toBe(unrelated);

      await target.fetch('https://bucket.s3.eu-central-1.amazonaws.com/key?X-Amz-Signature=x', {
        method: 'PUT',
        body: new Blob([Uint8Array.of(0x41)], { type: 'text/plain' }),
      });
      const rewritten = calls[2]?.init?.body as Uint8Array | undefined;
      expect(rewritten?.[0]).toBe(0x42);
    } finally {
      cleanup();
    }
  });

  it('R5-N1: an unrelated signed cloud PUT does not steal the exact upload URL', async () => {
    const { target, queue, calls, cleanup } = setup('https://upload.example.test/u/1');
    try {
      await beginUpload(target, queue);
      await target.fetch('https://a.blob.core.windows.net/c/b?sig=1', {
        method: 'PUT',
        body: new Blob([Uint8Array.of(0x41)]),
      });
      expect(calls[1]?.init?.body).toBeInstanceOf(Uint8Array);

      const real = new Blob([Uint8Array.of(0x41)], { type: 'text/plain' });
      await target.fetch('https://upload.example.test/u/1', { method: 'PUT', body: real });
      const rewritten = calls[2]?.init?.body as Uint8Array | undefined;
      expect(rewritten).not.toBe(real);
      expect(rewritten?.[0]).toBe(0x42);
    } finally {
      cleanup();
    }
  });

  it('R5-N1: a repeated size-only cloud transport aborts instead of passing the original', async () => {
    const { target, queue, calls, notifications, cleanup } = setup();
    try {
      await beginUpload(target, queue);
      await target.fetch('https://a.blob.core.windows.net/c/b?sig=1', {
        method: 'PUT',
        body: new Blob([Uint8Array.of(0x41)]),
      });
      const first = calls[1]?.init?.body as Uint8Array | undefined;
      expect(first?.[0]).toBe(0x42);

      await expect(
        target.fetch('https://b.blob.core.windows.net/c/d?sig=2', {
          method: 'PUT',
          body: new Blob([Uint8Array.of(0x41)]),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(notifications).toContain('TRANSPORT');
      expect(calls).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});
