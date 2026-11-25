import { describe, expect, it } from 'vitest';
import type { MainBridge } from '../../src/interception/bridge-main';
import {
  classifyDownloadUrl,
  fileNameFromDownloadUrl,
  fileNameFromMime,
  installDownloadHooks,
  prefixFromBodyTags,
  prefixFromFileName,
} from '../../src/interception/download-hook';
import {
  BridgeError,
  type RestoreFileBridgeResult,
  type RestoreNameBridgeResult,
  type ToastReason,
} from '../../src/interception/protocol';

const encoder = new TextEncoder();

class FakeXhr {
  responseType = '';
  readyState = 0;
  status = 0;
  response: unknown = null;
  responseText = '';

  getResponseHeader(): string | null {
    return null;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
  open(): void {}
  send(): void {}
  abort(): void {}
}

type NameInput = Parameters<MainBridge['restoreName']>[0];
type FileInput = Parameters<MainBridge['restoreFile']>[0];

interface StubBridge {
  bridge: MainBridge;
  notifications: ToastReason[];
  nameCalls: NameInput[];
  fileCalls: FileInput[];
}

interface StubOptions {
  throwNoVault?: boolean;
  nameResult?: (input: NameInput) => RestoreNameBridgeResult;
  fileResult?: (input: FileInput) => RestoreFileBridgeResult;
}

function makeBridge(options: StubOptions = {}): StubBridge {
  const notifications: ToastReason[] = [];
  const nameCalls: NameInput[] = [];
  const fileCalls: FileInput[] = [];

  const bridge: MainBridge = {
    isEnabled: () => true,
    maxBytes: () => 25 * 1024 * 1024,
    async anonymizeFile() {
      throw new Error('not used in download tests');
    },
    async restoreName(input) {
      nameCalls.push(input);
      if (options.throwNoVault) throw new BridgeError('NO_VAULT', 'No vault');
      return (
        options.nameResult?.(input) ?? {
          fileName: input.name,
          replacements: 0,
          unknownTags: [],
          warnings: [],
        }
      );
    },
    async restoreFile(input) {
      fileCalls.push(input);
      if (options.throwNoVault) throw new BridgeError('NO_VAULT', 'No vault');
      if (options.fileResult) return options.fileResult(input);

      const prefix = prefixFromFileName(input.name);
      if (!prefix) {
        return {
          bytes: input.bytes.slice(0),
          fileName: input.name,
          replacements: 0,
          unknownTags: [],
          warnings: [],
        };
      }
      return {
        bytes: encoder.encode('restored body').buffer,
        fileName: 'restored.txt',
        replacements: 1,
        unknownTags: [],
        warnings: [],
      };
    },
    notify(reason) {
      notifications.push(reason);
    },
  };

  return { bridge, notifications, nameCalls, fileCalls };
}

function makeTarget(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Window {
  return {
    location: {
      href: 'https://chatgpt.com/c/chat-1',
      pathname: '/c/chat-1',
      origin: 'https://chatgpt.com',
    },
    fetch: fetchImpl,
    XMLHttpRequest: FakeXhr,
  } as unknown as Window;
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('download URL classification', () => {
  it('matches JSON metadata and byte transports, and ignores non-GET', () => {
    expect(
      classifyDownloadUrl(new URL('https://chatgpt.com/backend-api/files/file_1/download')),
    ).toBe('json');
    expect(
      classifyDownloadUrl(new URL('https://chatgpt.com/conversation/c1/attachment/f1/download')),
    ).toBe('json');
    expect(
      classifyDownloadUrl(new URL('https://chatgpt.com/conversation/c1/interpreter/download')),
    ).toBe('json');
    expect(classifyDownloadUrl(new URL('https://chatgpt.com/backend-api/files/download/f1'))).toBe(
      'json',
    );

    expect(
      classifyDownloadUrl(new URL('https://chatgpt.com/backend-api/estuary/content?id=1')),
    ).toBe('bytes');
    expect(
      classifyDownloadUrl(
        new URL('https://chatgpt.com/backend-api/files/library/content_download?id=1'),
      ),
    ).toBe('bytes');
    expect(classifyDownloadUrl(new URL('https://chatgpt.com/conversation/c1/executor/file'))).toBe(
      'bytes',
    );
    expect(classifyDownloadUrl(new URL('https://abc.oaiusercontent.com/file/1'))).toBe('bytes');

    expect(
      classifyDownloadUrl(new URL('https://example.com/backend-api/estuary/content'), 'GET'),
    ).toBeUndefined();
    expect(
      classifyDownloadUrl(new URL('https://chatgpt.com/backend-api/estuary/content'), 'POST'),
    ).toBeUndefined();
    expect(classifyDownloadUrl(new URL('https://chatgpt.com/backend-api/models'))).toBeUndefined();
  });

  it('extracts prefixes, names and MIME fallbacks', () => {
    expect(prefixFromFileName('[[ABCDE_PERSON_1]]_договор.txt')).toBe('ABCDE');
    expect(prefixFromFileName('plain.txt')).toBeUndefined();

    expect(fileNameFromDownloadUrl(new URL('https://x.test/a?filename=report%20final.txt'))).toBe(
      'report final.txt',
    );
    expect(fileNameFromDownloadUrl(new URL('https://x.test/a'))).toBeUndefined();

    expect(fileNameFromMime('text/plain')).toBe('download.txt');
    expect(fileNameFromMime('text/markdown')).toBe('download.md');
    expect(fileNameFromMime('application/json')).toBe('download.json');
    expect(fileNameFromMime('application/x-ndjson')).toBe('download.jsonl');
    expect(fileNameFromMime('application/ndjson')).toBe('download.jsonl');
    expect(fileNameFromMime('application/jsonl')).toBe('download.jsonl');
    expect(fileNameFromMime('application/xml')).toBe('download.xml');
    expect(fileNameFromMime('text/xml')).toBe('download.xml');
    expect(fileNameFromMime('text/html')).toBe('download.html');
    expect(fileNameFromMime('application/xhtml+xml')).toBe('download.html');
    expect(fileNameFromMime('image/png')).toBeUndefined();
  });
});

describe('download fetch hook', () => {
  it('restores JSON file_name and byte bodies through the bridge', async () => {
    const responses = [
      jsonResponse({
        status: 'success',
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=1',
        file_name: '[[ABCDE_PERSON_1]]_доклад.txt',
        mime_type: 'text/plain',
      }),
      new Response('masked body [[ABCDE_PERSON_1]]', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': '34' },
      }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge({
      nameResult: () => ({
        fileName: 'Иванов доклад.txt',
        replacements: 1,
        unknownTags: [],
        warnings: [],
      }),
      fileResult: () => ({
        bytes: encoder.encode('restored body').buffer,
        fileName: 'Иванов доклад.txt',
        replacements: 1,
        unknownTags: [],
        warnings: [],
      }),
    });
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 1_000 });

    try {
      const metaResponse = await target.fetch(
        'https://chatgpt.com/backend-api/files/file_1/download',
      );
      const meta = (await metaResponse.json()) as { file_name: string };
      expect(meta.file_name).toBe('Иванов доклад.txt');
      expect(metaResponse.headers.get('content-type')).toContain('json');

      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=1',
      );
      expect(await bytesResponse.text()).toBe('restored body');
      expect(bytesResponse.headers.get('content-type')).toContain('text/plain');
      expect(bytesResponse.headers.get('content-length')).toBeNull();

      expect(stub.nameCalls).toHaveLength(1);
      expect(stub.nameCalls[0]?.prefix).toBe('ABCDE');
      expect(stub.fileCalls).toHaveLength(1);
      expect(stub.fileCalls[0]?.prefix).toBe('ABCDE');
      expect(stub.fileCalls[0]?.chatId).toBe('chat-1');
      expect(stub.fileCalls[0]?.name).toBe('[[ABCDE_PERSON_1]]_доклад.txt');
      expect(stub.notifications).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('passes untagged names and bytes through unchanged', async () => {
    const responses = [
      jsonResponse({
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=2',
        file_name: 'plain.txt',
        mime_type: 'text/plain',
      }),
      new Response('plain body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge();
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 2_000 });

    try {
      const metaResponse = await target.fetch(
        'https://chatgpt.com/backend-api/files/file_2/download',
      );
      const meta = (await metaResponse.json()) as { file_name: string };
      expect(meta.file_name).toBe('plain.txt');

      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=2',
      );
      expect(await bytesResponse.text()).toBe('plain body');
      expect(stub.nameCalls).toHaveLength(0);
      expect(stub.fileCalls).toHaveLength(1);
      expect(stub.notifications).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('finds a vault prefix in a masked TXT body when the name has none (R2-M5)', async () => {
    const taggedBody = 'report for [[ABCDE_PERSON_1]] and [[ABCDE_EMAIL_1]]';
    const responses = [
      jsonResponse({
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=2b',
        file_name: 'report.txt',
        mime_type: 'text/plain',
      }),
      new Response(taggedBody, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge({ throwNoVault: true });
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 2_500 });

    try {
      await target.fetch('https://chatgpt.com/backend-api/files/file_2b/download');
      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=2b',
      );
      expect(await bytesResponse.text()).toBe(taggedBody);
      expect(stub.fileCalls).toHaveLength(1);
      expect(stub.fileCalls[0]?.prefix).toBe('ABCDE');
      // A tag in the body counts as a tag: the user must see the warning.
      expect(stub.notifications).toEqual(['NO_VAULT']);
    } finally {
      cleanup();
    }
  });

  it('passes through an unknown prefix and warns without aborting', async () => {
    const taggedBody = '[[ZZZZZ_PERSON_1]] secret';
    const responses = [
      jsonResponse({
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=3',
        file_name: '[[ZZZZZ_PERSON_1]]_secret.txt',
        mime_type: 'text/plain',
      }),
      new Response(taggedBody, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge({ throwNoVault: true });
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 3_000 });

    try {
      const metaResponse = await target.fetch(
        'https://chatgpt.com/backend-api/files/file_3/download',
      );
      const meta = (await metaResponse.json()) as { file_name: string };
      expect(meta.file_name).toBe('[[ZZZZZ_PERSON_1]]_secret.txt');

      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=3',
      );
      expect(await bytesResponse.text()).toBe(taggedBody);
      expect(stub.notifications).toEqual(['NO_VAULT', 'NO_VAULT']);
    } finally {
      cleanup();
    }
  });

  it('passes large files through with a warning before buffering', async () => {
    const url = new URL('https://chatgpt.com/backend-api/estuary/content?id=4');
    url.searchParams.set('filename', '[[ABCDE_PERSON_1]]_big.txt');
    const target = makeTarget(
      async () =>
        new Response('small mock body', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': String(26 * 1024 * 1024),
          },
        }),
    );
    const stub = makeBridge();
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 4_000 });

    try {
      const response = await target.fetch(url);
      expect(await response.text()).toBe('small mock body');
      expect(stub.fileCalls).toHaveLength(0);
      expect(stub.notifications).toEqual(['LARGE_FILE']);
    } finally {
      cleanup();
    }
  });

  it('leaves non-target requests untouched', async () => {
    const target = makeTarget(async () => jsonResponse({ ok: true }));
    const stub = makeBridge();
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 5_000 });

    try {
      const response = await target.fetch('https://chatgpt.com/backend-api/models');
      expect(await response.text()).toBe('{"ok":true}');
      expect(stub.nameCalls).toHaveLength(0);
      expect(stub.fileCalls).toHaveLength(0);
      expect(stub.notifications).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('M8: body-tag restore for JSON/XML', () => {
  it('accepts JSON/XML extensions and MIME types in the body probe', () => {
    const json = encoder.encode('{"tag":"[[ABCDE_PERSON_1]]"}');
    const xml = encoder.encode('<root a="[[ABCDE_PERSON_1]]">x</root>');

    expect(prefixFromBodyTags(json, 'report.json', 'application/octet-stream')).toBe('ABCDE');
    expect(prefixFromBodyTags(json, 'report.bin', 'application/json')).toBe('ABCDE');
    expect(prefixFromBodyTags(json, 'report.bin', 'application/x-ndjson')).toBe('ABCDE');
    expect(prefixFromBodyTags(json, 'report.bin', 'application/ndjson')).toBe('ABCDE');
    expect(prefixFromBodyTags(json, 'report.bin', 'application/jsonl')).toBe('ABCDE');
    expect(prefixFromBodyTags(xml, 'report.xml', 'application/octet-stream')).toBe('ABCDE');
    expect(prefixFromBodyTags(xml, 'report.bin', 'application/xml')).toBe('ABCDE');
    expect(prefixFromBodyTags(xml, 'report.bin', 'text/xml')).toBe('ABCDE');

    expect(
      prefixFromBodyTags(encoder.encode('{"tag":"plain"}'), 'report.json', 'application/json'),
    ).toBeUndefined();
    expect(
      prefixFromBodyTags(encoder.encode('<root>plain</root>'), 'report.xml', 'application/xml'),
    ).toBeUndefined();

    const binary = new Uint8Array(64);
    binary.set(encoder.encode('[[ABCDE_PERSON_1]]'), 8);
    expect(prefixFromBodyTags(binary, 'report.txt', 'application/octet-stream')).toBeUndefined();
  });

  it('prefers a textual response MIME over a lying metadata mime_type (M8R2-M2)', async () => {
    const responses = [
      jsonResponse({
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=lie',
        file_name: 'export',
        mime_type: 'application/octet-stream',
      }),
      new Response('{"name":"[[ABCDE_PERSON_1]]"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge({
      fileResult: () => ({
        bytes: encoder.encode('{"name":"Иван Петров"}').buffer,
        fileName: 'export',
        replacements: 1,
        unknownTags: [],
        warnings: [],
      }),
    });
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 6_000 });

    try {
      await target.fetch('https://chatgpt.com/backend-api/files/file_lie/download');
      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=lie',
      );
      expect(await bytesResponse.text()).toBe('{"name":"Иван Петров"}');
      expect(stub.fileCalls).toHaveLength(1);
      expect(stub.fileCalls[0]?.name).toBe('export');
      expect(stub.fileCalls[0]?.mime).toBe('application/json');
    } finally {
      cleanup();
    }
  });

  it('does not restore a binary body behind a .txt name (M8-N2)', async () => {
    const binary = new Uint8Array(96);
    binary.set(encoder.encode('[[ABCDE_PERSON_1]]'), 8);
    const responses = [
      jsonResponse({
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=bin',
        file_name: '[[ABCDE_PERSON_1]]_report.txt',
        mime_type: 'text/plain',
      }),
      new Response(binary, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge();
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 7_000 });

    try {
      await target.fetch('https://chatgpt.com/backend-api/files/file_bin/download');
      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=bin',
      );
      expect(new Uint8Array(await bytesResponse.arrayBuffer())).toEqual(binary);
      expect(stub.fileCalls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('restores a JSON body by its tag prefix when the name has none', async () => {
    const taggedBody = '{"name":"[[ABCDE_PERSON_1]]","email":"[[ABCDE_EMAIL_1]]"}';
    const restoredBody = '{"name":"Иван Петров","email":"ivan@example.ru"}';
    const responses = [
      jsonResponse({
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=json-body',
        file_name: 'report.json',
        mime_type: 'application/json',
      }),
      new Response(taggedBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge({
      fileResult: (input) =>
        input.prefix === 'ABCDE'
          ? {
              bytes: encoder.encode(restoredBody).buffer,
              fileName: 'report.json',
              replacements: 2,
              unknownTags: [],
              warnings: [],
            }
          : {
              bytes: input.bytes.slice(0),
              fileName: input.name,
              replacements: 0,
              unknownTags: [],
              warnings: [],
            },
    });
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 10_000 });

    try {
      await target.fetch('https://chatgpt.com/backend-api/files/file_json/download');
      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=json-body',
      );
      expect(await bytesResponse.text()).toBe(restoredBody);
      expect(stub.fileCalls).toHaveLength(1);
      expect(stub.fileCalls[0]?.prefix).toBe('ABCDE');
      expect(stub.fileCalls[0]?.mime).toBe('application/json');
      expect(stub.notifications).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('restores an XML body by its tag prefix when the name has none', async () => {
    const taggedBody = '<root name="[[ABCDE_PERSON_1]]">[[ABCDE_EMAIL_1]]</root>';
    const restoredBody = '<root name="Иван Петров">ivan@example.ru</root>';
    const responses = [
      jsonResponse({
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=xml-body',
        file_name: 'report.xml',
        mime_type: 'application/xml',
      }),
      new Response(taggedBody, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge({
      fileResult: (input) =>
        input.prefix === 'ABCDE'
          ? {
              bytes: encoder.encode(restoredBody).buffer,
              fileName: 'report.xml',
              replacements: 2,
              unknownTags: [],
              warnings: [],
            }
          : {
              bytes: input.bytes.slice(0),
              fileName: input.name,
              replacements: 0,
              unknownTags: [],
              warnings: [],
            },
    });
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 10_500 });

    try {
      await target.fetch('https://chatgpt.com/backend-api/files/file_xml/download');
      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=xml-body',
      );
      expect(await bytesResponse.text()).toBe(restoredBody);
      expect(stub.fileCalls).toHaveLength(1);
      expect(stub.fileCalls[0]?.prefix).toBe('ABCDE');
      expect(stub.fileCalls[0]?.mime).toBe('application/xml');
      expect(stub.notifications).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('probes a JSON body when the name comes from the response MIME (M8-4)', async () => {
    const taggedBody = '{"name":"[[ABCDE_PERSON_1]]"}';
    const restoredBody = '{"name":"Иван Петров"}';
    const target = makeTarget(
      async () =>
        new Response(taggedBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const stub = makeBridge({
      fileResult: (input) =>
        input.prefix === 'ABCDE'
          ? {
              bytes: encoder.encode(restoredBody).buffer,
              fileName: 'download.json',
              replacements: 1,
              unknownTags: [],
              warnings: [],
            }
          : {
              bytes: input.bytes.slice(0),
              fileName: input.name,
              replacements: 0,
              unknownTags: [],
              warnings: [],
            },
    });
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 10_800 });

    try {
      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=mime-json',
      );
      expect(await bytesResponse.text()).toBe(restoredBody);
      expect(stub.fileCalls).toHaveLength(1);
      expect(stub.fileCalls[0]?.name).toBe('download.json');
      expect(stub.fileCalls[0]?.prefix).toBe('ABCDE');
      expect(stub.notifications).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('does not trust metadata mime_type for binary bodies (M8-N2)', async () => {
    const tag = encoder.encode('binary payload [[ABCDE_PERSON_1]]');
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tag]);
    const responses = [
      jsonResponse({
        download_url: 'https://chatgpt.com/backend-api/estuary/content?id=binary-lie',
        file_name: 'photo.png',
        mime_type: 'text/plain',
      }),
      new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    ];
    const target = makeTarget(async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    });
    const stub = makeBridge();
    const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 10_900 });

    try {
      await target.fetch('https://chatgpt.com/backend-api/files/file_binary/download');
      const bytesResponse = await target.fetch(
        'https://chatgpt.com/backend-api/estuary/content?id=binary-lie',
      );
      expect(new Uint8Array(await bytesResponse.arrayBuffer())).toEqual(png);
      expect(stub.fileCalls).toHaveLength(0);
      expect(stub.notifications).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('passes untagged JSON/XML bodies through unchanged', async () => {
    const cases = [
      {
        id: 'plain-json',
        name: 'plain.json',
        mime: 'application/json',
        body: '{"name":"plain"}',
      },
      {
        id: 'plain-xml',
        name: 'plain.xml',
        mime: 'application/xml',
        body: '<root>plain</root>',
      },
    ];

    for (const item of cases) {
      const responses = [
        jsonResponse({
          download_url: `https://chatgpt.com/backend-api/estuary/content?id=${item.id}`,
          file_name: item.name,
          mime_type: item.mime,
        }),
        new Response(item.body, { status: 200, headers: { 'content-type': item.mime } }),
      ];
      const target = makeTarget(async () => {
        const response = responses.shift();
        if (!response) throw new Error('unexpected fetch');
        return response;
      });
      const stub = makeBridge();
      const cleanup = installDownloadHooks({ bridge: stub.bridge, target, now: () => 11_000 });

      try {
        await target.fetch(`https://chatgpt.com/backend-api/files/${item.id}/download`);
        const bytesResponse = await target.fetch(
          `https://chatgpt.com/backend-api/estuary/content?id=${item.id}`,
        );
        expect(await bytesResponse.text()).toBe(item.body);
        expect(stub.fileCalls).toHaveLength(1);
        expect(stub.fileCalls[0]?.prefix).toBeUndefined();
        expect(stub.notifications).toEqual([]);
      } finally {
        cleanup();
      }
    }
  });
});

describe('R3-M3: body-tag scan cost is bounded', () => {
  it('scans 1/2/4 MB of brackets without per-byte decoders', () => {
    const timings: Record<number, number> = {};
    for (const megabytes of [1, 2, 4]) {
      const body = new Uint8Array(megabytes * 1024 * 1024).fill(0x5b);
      const started = performance.now();
      const prefix = prefixFromBodyTags(body, 'report.txt', 'text/plain');
      timings[megabytes] = performance.now() - started;
      expect(prefix).toBeUndefined();
    }

    // Before the fix each '[' built a decoder and decoded 256 bytes:
    // ~3.7 s / 7.4 s / 14.4 s for 1/2/4 MB. The byte-level probe is capped at
    // 256 KiB and stays in the low milliseconds.
    expect(timings[1]).toBeLessThan(200);
    expect(timings[2]).toBeLessThan(200);
    expect(timings[4]).toBeLessThan(200);
    expect(timings[4]).toBeLessThan(Math.max(timings[1] ?? 0, 20) * 4);
  });

  it('still finds a tag inside the scanned window', () => {
    const body = new TextEncoder().encode(`${'x'.repeat(1_000)}[[ABCDE_PERSON_1]]`);
    expect(prefixFromBodyTags(body, 'report.txt', 'text/plain')).toBe('ABCDE');
  });
});
