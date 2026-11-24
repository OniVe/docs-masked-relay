import { describe, expect, it } from 'vitest';
import { maskFileName } from '../../src/background/filename';
import { createVault } from '../../src/core';
import { CapturedFileQueue } from '../../src/interception/file-capture';
import {
  BRIDGE_VERSION,
  bridgeResultKind,
  ISOLATED_SOURCE,
  MAIN_SOURCE,
  MAX_BRIDGE_BYTES,
  parseBridgeRequest,
  parseBridgeResponse,
  parseSettingsPush,
  toExactArrayBuffer,
} from '../../src/interception/protocol';
import { base64ToBytes, bytesToBase64 } from '../../src/shared/base64';
import { readSettingsChangedEnabled, readSettingsChangedState } from '../../src/shared/messages';

function fakeFile(name: string, size: number): File {
  return {
    name,
    size,
    type: 'text/plain',
    lastModified: 1,
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as File;
}

describe('CapturedFileQueue', () => {
  it('matches by name+size in FIFO order and removes the match', () => {
    const queue = new CapturedFileQueue({ now: () => 1_000 });
    queue.add(fakeFile('a.txt', 10));
    queue.add(fakeFile('b.txt', 20));
    queue.add(fakeFile('a.txt', 10));

    expect(queue.take('a.txt', 10)?.file).toBeDefined();
    expect(queue.take('a.txt', 10)?.file).toBeDefined();
    expect(queue.take('a.txt', 10)).toBeUndefined();
    expect(queue.take('b.txt', 20)).toBeDefined();
    expect(queue.size).toBe(0);
  });

  it('expires entries after five minutes and keeps at most 20', () => {
    let now = 0;
    const queue = new CapturedFileQueue({ now: () => now });
    for (let i = 0; i < 25; i += 1) queue.add(fakeFile(`f${i}.txt`, i));
    expect(queue.size).toBe(20);
    expect(queue.take('f0.txt', 0)).toBeUndefined();
    expect(queue.take('f24.txt', 24)).toBeDefined();

    now = 5 * 60_000 + 1;
    expect(queue.size).toBe(0);
    expect(queue.take('f23.txt', 23)).toBeUndefined();
  });
});

describe('bridge protocol validation', () => {
  it('accepts a well-formed anonymize request and rejects foreign shapes', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const request = {
      source: MAIN_SOURCE,
      v: BRIDGE_VERSION,
      id: 'req-1',
      type: 'anonymize-file',
      payload: { bytes, name: 'a.txt', mime: 'text/plain' },
    };

    const parsed = parseBridgeRequest(request);
    expect(parsed?.type).toBe('anonymize-file');
    if (parsed?.type === 'anonymize-file') {
      expect(parsed.payload.name).toBe('a.txt');
      expect(parsed.payload.bytes.byteLength).toBe(3);
    }

    expect(parseBridgeRequest({ ...request, source: 'other' })).toBeUndefined();
    expect(parseBridgeRequest({ ...request, v: 2 })).toBeUndefined();
    expect(
      parseBridgeRequest({ ...request, payload: { ...request.payload, name: '' } }),
    ).toBeUndefined();
    expect(
      parseBridgeRequest({
        ...request,
        payload: { ...request.payload, bytes: new ArrayBuffer(0) },
      }),
    ).toBeUndefined();
    expect(
      parseBridgeRequest({
        ...request,
        payload: { ...request.payload, bytes: new ArrayBuffer(MAX_BRIDGE_BYTES + 1) },
      }),
    ).toBeUndefined();
  });

  it('validates notify reasons and bridge responses', () => {
    const notify = {
      source: MAIN_SOURCE,
      v: BRIDGE_VERSION,
      id: 'n1',
      type: 'notify',
      payload: { reason: 'NO_FILE' },
    };
    expect(parseBridgeRequest(notify)?.type).toBe('notify');
    expect(parseBridgeRequest({ ...notify, payload: { reason: 'NOT_A_REASON' } })).toBeUndefined();

    const masked = new Uint8Array([9, 8]).buffer;
    const response = {
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id: 'req-1',
      ok: true,
      result: {
        maskedBytes: masked,
        maskedName: '[[ABCDE_PERSON_1]].txt',
        entities: [{ label: 'PERSON', count: 1 }],
        warnings: [],
      },
    };
    const parsed = parseBridgeResponse(response);
    expect(parsed?.ok).toBe(true);
    expect(parsed?.ok === true ? bridgeResultKind(parsed.result) : undefined).toBe(
      'anonymize-file',
    );
    if (parsed?.ok === true && 'maskedBytes' in parsed.result) {
      expect(parsed.result.maskedName).toContain('PERSON_1');
      expect(parsed.result.entities[0]?.count).toBe(1);
    }

    expect(
      parseBridgeResponse({
        ...response,
        ok: false,
        error: { code: 'UNSUPPORTED', message: 'File format is not supported' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
    expect(parseBridgeResponse({ ...response, source: MAIN_SOURCE })).toBeUndefined();
    expect(
      parseBridgeResponse({ ...response, result: { ...response.result, entities: [{}] } }),
    ).toBeUndefined();
  });

  it('validates download restore requests and results', () => {
    const bytes = new Uint8Array([7, 6, 5]).buffer;
    const fileRequest = {
      source: MAIN_SOURCE,
      v: BRIDGE_VERSION,
      id: 'restore-1',
      type: 'restore-file',
      payload: { bytes, name: '[[ABCDE_PERSON_1]]_a.txt', mime: 'text/plain', prefix: 'abcde' },
    };
    const parsedFile = parseBridgeRequest(fileRequest);
    expect(parsedFile?.type).toBe('restore-file');
    if (parsedFile?.type === 'restore-file') {
      expect(parsedFile.payload.prefix).toBe('ABCDE');
      expect(parsedFile.payload.bytes.byteLength).toBe(3);
    }
    expect(
      parseBridgeRequest({ ...fileRequest, payload: { ...fileRequest.payload, prefix: 'no' } }),
    ).toBeUndefined();
    expect(
      parseBridgeRequest({
        ...fileRequest,
        payload: { ...fileRequest.payload, bytes: new ArrayBuffer(0) },
      }),
    ).toBeUndefined();

    const nameRequest = {
      source: MAIN_SOURCE,
      v: BRIDGE_VERSION,
      id: 'restore-2',
      type: 'restore-name',
      payload: { name: '[[ABCDE_PERSON_1]]_a.txt', chatId: 'chat-1' },
    };
    const parsedName = parseBridgeRequest(nameRequest);
    expect(parsedName?.type).toBe('restore-name');
    if (parsedName?.type === 'restore-name') {
      expect(parsedName.payload.chatId).toBe('chat-1');
    }

    const fileResponse = {
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id: 'restore-1',
      ok: true,
      result: {
        bytes: new Uint8Array([1, 2, 3]).buffer,
        fileName: 'a.txt',
        replacements: 1,
        unknownTags: [],
        warnings: [],
      },
    };
    const parsedFileResponse = parseBridgeResponse(fileResponse);
    expect(
      parsedFileResponse?.ok === true ? bridgeResultKind(parsedFileResponse.result) : undefined,
    ).toBe('restore-file');

    const nameResponse = {
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id: 'restore-2',
      ok: true,
      result: { fileName: 'Иванов.txt', replacements: 1, unknownTags: [], warnings: [] },
    };
    const parsedNameResponse = parseBridgeResponse(nameResponse);
    expect(
      parsedNameResponse?.ok === true ? bridgeResultKind(parsedNameResponse.result) : undefined,
    ).toBe('restore-name');
    expect(
      parseBridgeResponse({
        ...nameResponse,
        result: { ...nameResponse.result, replacements: -1 },
      }),
    ).toBeUndefined();
  });

  it('accepts LOCKED/DISABLED failures and rejects unknown codes', () => {
    const response = {
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      id: 'locked-1',
      ok: false,
      error: { code: 'LOCKED', message: 'Vault is locked' },
    };
    expect(parseBridgeResponse(response)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    expect(
      parseBridgeResponse({ ...response, error: { code: 'DISABLED', message: 'Off' } }),
    ).toMatchObject({ ok: false, error: { code: 'DISABLED' } });
    expect(
      parseBridgeResponse({ ...response, error: { code: 'BAD_PASSPHRASE', message: 'No' } }),
    ).toBeUndefined();
  });

  it('parses the ISOLATED protection-state push and settings broadcasts', () => {
    const push = {
      source: ISOLATED_SOURCE,
      v: BRIDGE_VERSION,
      type: 'settings',
      enabled: false,
    };
    expect(parseSettingsPush(push)).toEqual({ enabled: false });
    expect(parseSettingsPush({ ...push, enabled: true, maxBytes: 4096 })).toEqual({
      enabled: true,
      maxBytes: 4096,
    });
    expect(parseSettingsPush({ ...push, source: MAIN_SOURCE })).toBeUndefined();
    expect(parseSettingsPush({ ...push, enabled: 'no' })).toBeUndefined();
    expect(parseSettingsPush({ ...push, type: 'notify' })).toBeUndefined();
    expect(parseSettingsPush({ ...push, maxBytes: 0 })).toBeUndefined();

    const broadcast = {
      type: 'dm:settings-changed',
      payload: { settings: { enabled: false } },
    };
    expect(readSettingsChangedEnabled(broadcast)).toBe(false);
    expect(readSettingsChangedEnabled({ type: 'dm:ping' })).toBeUndefined();
    expect(readSettingsChangedEnabled({ ...broadcast, payload: {} })).toBeUndefined();
    expect(
      readSettingsChangedState({
        type: 'dm:settings-changed',
        payload: { settings: { enabled: true, maxBytes: 4096 } },
      }),
    ).toEqual({ enabled: true, maxBytes: 4096 });
    expect(
      readSettingsChangedState({
        type: 'dm:settings-changed',
        payload: { settings: { enabled: false, maxBytes: -1 } },
      }),
    ).toEqual({ enabled: false });
  });

  it('copies typed-array views to an exact transferable buffer', () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4]);
    const view = backing.subarray(1, 4);
    const exact = toExactArrayBuffer(view);
    expect(exact.byteLength).toBe(3);
    expect([...new Uint8Array(exact)]).toEqual([1, 2, 3]);
  });
});

describe('base64 runtime transport', () => {
  it('round-trips binary bytes and rejects malformed input', () => {
    const bytes = new Uint8Array(200_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;

    const encoded = bytesToBase64(bytes);
    const decoded = base64ToBytes(encoded);
    expect(decoded?.byteLength).toBe(bytes.byteLength);
    expect(decoded?.subarray(0, 8)).toEqual(bytes.subarray(0, 8));
    expect(decoded?.subarray(-8)).toEqual(bytes.subarray(-8));

    expect(base64ToBytes('not base64!')).toBeUndefined();
  });
});

describe('filename masking', () => {
  it('masks a lone surname aggressively and keeps the extension', () => {
    const vault = createVault('');
    const masked = maskFileName(vault, 'Иванов договор.txt');
    expect(masked).toContain(`[[${vault.prefix}_PERSON_1]]`);
    expect(masked.endsWith('.txt')).toBe(true);
    expect(masked).not.toContain('Иванов');
    expect(vault.filenameMap).toContainEqual({
      original: 'Иванов договор.txt',
      masked,
    });
  });

  it('returns a cached mapping without creating a new entity', () => {
    const vault = createVault('');
    const first = maskFileName(vault, 'Иванов договор.txt');
    const entities = { ...vault.entities };
    const second = maskFileName(vault, 'Иванов договор.txt');
    expect(second).toBe(first);
    expect(vault.entities).toEqual(entities);
  });

  it('masks a name with long numeric tokens instead of failing', () => {
    const vault = createVault('');
    const original = 'Результаты исследований_Беляев Игорь Сергеевич_45001287619_202607081234.pdf';
    const masked = maskFileName(vault, original);
    expect(masked).not.toContain('Беляев');
    expect(masked).not.toMatch(/\d{7,}/);
    expect(masked.endsWith('.pdf')).toBe(true);
    expect(vault.filenameMap).toContainEqual({ original, masked });
  });

  it('replaces a bare long numeric stem with number', () => {
    const vault = createVault('');
    const masked = maskFileName(vault, 'test_45001287619.pdf');
    expect(masked).toBe('test_number.pdf');
    expect(masked).not.toMatch(/\d{7,}/);
  });
});
