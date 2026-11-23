import { describe, expect, it } from 'vitest';
import type { MainBridge } from '../../src/interception/bridge-main';
import { CapturedFileQueue } from '../../src/interception/file-capture';
import { MAX_FILE_BYTES, type ToastReason } from '../../src/interception/protocol';
import { installUploadHooks } from '../../src/interception/upload-hook';

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

class FakeXhr {
  onload: ((event: Event) => void) | null = null;
  onloadend: ((event: Event) => void) | null = null;
  onreadystatechange: ((event: Event) => void) | null = null;
  readyState = 0;
  status = 0;
  responseType = '';
  response: unknown = null;
  responseText = '';
  sentBody: unknown;
  aborted = false;
  open(_method?: string, _url?: string): void {}
  send(body?: unknown): void {
    this.sentBody = body;
  }
  abort(): void {
    this.aborted = true;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
  getResponseHeader(): string | null {
    return null;
  }
}

function makeWindow(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Window {
  return {
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com', pathname: '/' },
    fetch: fetchImpl as typeof window.fetch,
    XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest,
    postMessage: () => {},
    addEventListener: () => {},
  } as unknown as Window;
}

function makeBridge(notifications: ToastReason[]): MainBridge {
  return {
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
}

const METADATA_URL = 'https://chatgpt.com/backend-api/files';
const ORIGINAL_BYTE = 0x41;
const MASKED_BYTE = 0x42;

function metadataBody(name: string): string {
  return JSON.stringify({ file_name: name, file_size: 1 });
}

function originalBlob(): Blob {
  return new Blob([Uint8Array.of(ORIGINAL_BYTE)], { type: 'text/plain' });
}

describe('R2: announced upload URL is a fail-closed tombstone', () => {
  it('aborts an exact-URL retry after the masked entry TTL; unrelated traffic passes', async () => {
    let clock = 1_000;
    let metadataIndex = 0;
    const uploadUrls = ['https://upload.example.test/u/1', 'https://upload.example.test/u/2'];
    const calls: FetchCall[] = [];
    const target = makeWindow((input, init) => {
      calls.push({ input: String(input), init });
      if (String(input) === METADATA_URL) {
        const uploadUrl = uploadUrls[metadataIndex] ?? uploadUrls.at(-1);
        metadataIndex += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ upload_url: uploadUrl }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    });
    const queue = new CapturedFileQueue({ now: () => clock });
    const notifications: ToastReason[] = [];
    const cleanup = installUploadHooks({
      queue,
      bridge: makeBridge(notifications),
      target,
      now: () => clock,
    });

    try {
      queue.add(fakeFile('a.txt', 1));
      await target.fetch(METADATA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: metadataBody('a.txt'),
      });

      // Immediate exact-URL PUT gets the masked bytes.
      await target.fetch(uploadUrls[0] as string, { method: 'PUT', body: originalBlob() });
      const firstBody = calls.at(-1)?.init?.body as Uint8Array | undefined;
      expect(firstBody?.[0]).toBe(MASKED_BYTE);

      // The entry is consumed; a retry on the announced URL must not fall
      // back to the original bytes.
      await expect(
        target.fetch(uploadUrls[0] as string, { method: 'PUT', body: originalBlob() }),
      ).rejects.toMatchObject({ name: 'AbortError' });

      clock += 2 * 60_000 + 1;
      const sentBeforeRetry = calls.length;
      await expect(
        target.fetch(uploadUrls[0] as string, { method: 'PUT', body: originalBlob() }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(sentBeforeRetry);
      expect(notifications).toContain('TRANSPORT');

      // R5: the tombstone is not time-based. Ten more minutes must not reopen
      // the fail-open window the old 10-minute TTL created.
      clock += 10 * 60_000;
      const sentBeforeLateRetry = calls.length;
      await expect(
        target.fetch(uploadUrls[0] as string, { method: 'PUT', body: originalBlob() }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(sentBeforeLateRetry);

      // Unrelated PUT/POST are not tombstoned.
      const unrelated = originalBlob();
      await target.fetch('https://unrelated.example.test/upload', {
        method: 'PUT',
        body: unrelated,
      });
      expect(calls.at(-1)?.init?.body).toBe(unrelated);

      // A new metadata/upload pair still works.
      queue.add(fakeFile('b.txt', 1));
      await target.fetch(METADATA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: metadataBody('b.txt'),
      });
      await target.fetch(uploadUrls[1] as string, { method: 'PUT', body: originalBlob() });
      const secondBody = calls.at(-1)?.init?.body as Uint8Array | undefined;
      expect(secondBody?.[0]).toBe(MASKED_BYTE);
    } finally {
      cleanup();
    }
  });

  it('keeps the announced URL tombstone after FIFO eviction of the entry', async () => {
    const clock = 1_000;
    let metadataIndex = 0;
    const urls = Array.from({ length: 12 }, (_, index) => `https://upload.example.test/e/${index}`);
    const calls: FetchCall[] = [];
    const target = makeWindow((input, init) => {
      calls.push({ input: String(input), init });
      if (String(input) === METADATA_URL) {
        const uploadUrl = urls[metadataIndex] ?? urls.at(-1);
        metadataIndex += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ upload_url: uploadUrl }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok'));
    });
    const queue = new CapturedFileQueue({ now: () => clock });
    const notifications: ToastReason[] = [];
    const cleanup = installUploadHooks({
      queue,
      bridge: makeBridge(notifications),
      target,
      now: () => clock,
    });

    try {
      for (let index = 0; index < 11; index += 1) {
        const name = `f${index}.txt`;
        queue.add(fakeFile(name, 1));
        await target.fetch(METADATA_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: metadataBody(name),
        });
      }

      // The first entry was evicted by MAX_MASKED_ENTRIES, but its URL stays
      // announced for the longer tombstone TTL.
      const sentBefore = calls.length;
      await expect(
        target.fetch(urls[0] as string, { method: 'PUT', body: originalBlob() }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(sentBefore);
      expect(notifications).toContain('TRANSPORT');

      // The newest entry still uploads normally.
      await target.fetch(urls[10] as string, { method: 'PUT', body: originalBlob() });
      const body = calls.at(-1)?.init?.body as Uint8Array | undefined;
      expect(body?.[0]).toBe(MASKED_BYTE);
    } finally {
      cleanup();
    }
  });

  it('aborts an opaque Request stream on the announced URL after TTL', async () => {
    let clock = 1_000;
    const url = 'https://upload.example.test/stream/1';
    const target = makeWindow((input) => {
      if (String(input) === METADATA_URL) {
        return Promise.resolve(
          new Response(JSON.stringify({ upload_url: url }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok'));
    });
    const queue = new CapturedFileQueue({ now: () => clock });
    const notifications: ToastReason[] = [];
    const cleanup = installUploadHooks({
      queue,
      bridge: makeBridge(notifications),
      target,
      now: () => clock,
    });

    try {
      queue.add(fakeFile('a.txt', 1));
      await target.fetch(METADATA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: metadataBody('a.txt'),
      });
      clock += 2 * 60_000 + 1;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(ORIGINAL_BYTE));
          controller.close();
        },
      });
      const request = new Request(url, {
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

  it('aborts an XHR retry on the announced URL after TTL', async () => {
    let clock = 1_000;
    const url = 'https://upload.example.test/xhr/1';
    const target = makeWindow((input) => {
      if (String(input) === METADATA_URL) {
        return Promise.resolve(
          new Response(JSON.stringify({ upload_url: url }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok'));
    });
    const queue = new CapturedFileQueue({ now: () => clock });
    const notifications: ToastReason[] = [];
    const cleanup = installUploadHooks({
      queue,
      bridge: makeBridge(notifications),
      target,
      now: () => clock,
    });

    try {
      queue.add(fakeFile('a.txt', 1));
      await target.fetch(METADATA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: metadataBody('a.txt'),
      });
      clock += 2 * 60_000 + 1;

      const xhr = new FakeXhr();
      xhr.open('PUT', url);
      xhr.send(originalBlob());
      expect(xhr.aborted).toBe(true);
      expect(xhr.sentBody).toBeUndefined();
      expect(notifications).toContain('TRANSPORT');
    } finally {
      cleanup();
    }
  });
});

describe('R5: announced URLs live to page unload; overflow fails closed', () => {
  it('keeps a 64-URL bound and aborts unmatched known-host traffic after overflow', async () => {
    let clock = 1_000;
    const urls = Array.from(
      { length: 65 },
      (_, index) => `https://upload.example.test/overflow/${index}`,
    );
    let metadataIndex = 0;
    const calls: FetchCall[] = [];
    const target = makeWindow((input, init) => {
      calls.push({ input: String(input), init });
      if (String(input) === METADATA_URL) {
        const uploadUrl = urls[metadataIndex] ?? urls.at(-1);
        metadataIndex += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ upload_url: uploadUrl }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok'));
    });
    const queue = new CapturedFileQueue({ now: () => clock });
    const notifications: ToastReason[] = [];
    const cleanup = installUploadHooks({
      queue,
      bridge: makeBridge(notifications),
      target,
      now: () => clock,
    });

    try {
      for (let index = 0; index < 65; index += 1) {
        const name = `overflow-${index}.txt`;
        queue.add(fakeFile(name, 1));
        await target.fetch(METADATA_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: metadataBody(name),
        });
      }

      // More than the old 10-minute TTL: the newest remembered URL is still a
      // fail-closed tombstone after its masked entry has expired.
      clock += 11 * 60_000;
      const sentBefore = calls.length;
      await expect(
        target.fetch(urls[64] as string, { method: 'PUT', body: originalBlob() }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(sentBefore);
      expect(notifications).toContain('TRANSPORT');

      // The 65th announcement overflowed the bound; an unmatched PUT to a
      // known upload host must abort rather than pass the original bytes.
      await expect(
        target.fetch('https://abc.oaiusercontent.com/collect', {
          method: 'PUT',
          body: originalBlob(),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(sentBefore);

      // Unrelated traffic is not collateral damage.
      const unrelated = originalBlob();
      await target.fetch('https://unrelated.example.test/upload', {
        method: 'PUT',
        body: unrelated,
      });
      expect(calls.at(-1)?.init?.body).toBe(unrelated);
    } finally {
      cleanup();
    }
  });
});

describe('R6: unreadable metadata response fails closed after entry expiry', () => {
  it('aborts known-host transport after the entry TTL; unrelated traffic and new uploads pass', async () => {
    let clock = 1_000;
    let readable = false;
    const calls: FetchCall[] = [];
    const target = makeWindow((input, init) => {
      calls.push({ input: String(input), init });
      if (String(input) === METADATA_URL) {
        if (!readable) {
          return Promise.resolve(
            new Response('not-json', { headers: { 'content-type': 'text/plain' } }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ upload_url: 'https://upload.example.test/r6/live' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('ok'));
    });
    const queue = new CapturedFileQueue({ now: () => clock });
    const notifications: ToastReason[] = [];
    const cleanup = installUploadHooks({
      queue,
      bridge: makeBridge(notifications),
      target,
      now: () => clock,
    });

    try {
      queue.add(fakeFile('a.txt', 1));
      await target.fetch(METADATA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: metadataBody('a.txt'),
      });

      // NOW: the live entry still supplies the masked bytes, so nothing leaks.
      await target.fetch('https://abc.oaiusercontent.com/upload', {
        method: 'PUT',
        body: originalBlob(),
      });
      const nowBody = calls.at(-1)?.init?.body as Uint8Array | undefined;
      expect(nowBody?.[0]).toBe(MASKED_BYTE);

      // After the 2-minute entry TTL, the unreadable response must not turn
      // into a pass-through for the original bytes.
      clock += 2 * 60_000 + 1;
      const sentBefore = calls.length;
      await expect(
        target.fetch('https://abc.oaiusercontent.com/upload', {
          method: 'PUT',
          body: originalBlob(),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(sentBefore);
      expect(notifications).toContain('TRANSPORT');

      // Unrelated traffic still passes.
      const unrelated = originalBlob();
      await target.fetch('https://unrelated.example.test/upload', {
        method: 'PUT',
        body: unrelated,
      });
      expect(calls.at(-1)?.init?.body).toBe(unrelated);

      // A later readable metadata response and its exact URL still work.
      readable = true;
      queue.add(fakeFile('b.txt', 1));
      await target.fetch(METADATA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: metadataBody('b.txt'),
      });
      await target.fetch('https://upload.example.test/r6/live', {
        method: 'PUT',
        body: originalBlob(),
      });
      const liveBody = calls.at(-1)?.init?.body as Uint8Array | undefined;
      expect(liveBody?.[0]).toBe(MASKED_BYTE);
    } finally {
      cleanup();
    }
  });
});
