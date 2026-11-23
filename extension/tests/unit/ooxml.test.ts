import 'fake-indexeddb/auto';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../src/background/db';
import { processAnonymize } from '../../src/background/process';
import { closeVaultStore, initVaultStore, listVaults } from '../../src/background/vault-store';
import {
  applyXmlEdits,
  DEFAULT_ZIP_LIMITS,
  decodeXml,
  encodeXml,
  inspectZip,
  rawOffsetInTextNode,
  replaceTextNodes,
  scanXml,
  unzipPackage,
  validateXml,
  xmlSkeleton,
  ZipError,
  zipPackage,
} from '../../src/core';
import { minimalDocx } from '../fixtures/docx';

const encoder = new TextEncoder();

function utf16Bytes(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = littleEndian ? 0xff : 0xfe;
  out[1] = littleEndian ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const offset = 2 + i * 2;
    if (littleEndian) {
      out[offset] = code & 0xff;
      out[offset + 1] = code >>> 8;
    } else {
      out[offset] = code >>> 8;
      out[offset + 1] = code & 0xff;
    }
  }
  return out;
}

function findForward(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
}

function findEocd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function makeZip(parts: Record<string, string | Uint8Array>): Uint8Array {
  const zippable: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(parts)) {
    zippable[name] = typeof value === 'string' ? encoder.encode(value) : value;
  }
  return zipSync(zippable, { level: 6 });
}

describe('ZIP kernel', () => {
  it('round-trips payloads byte-for-byte and is deterministic', () => {
    const parts = new Map<string, Uint8Array>([
      ['[Content_Types].xml', encoder.encode('<Types/>')],
      ['word/document.xml', encoder.encode('<w:document/>')],
      ['word/media/image1.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])],
    ]);

    const first = zipPackage(parts);
    const second = zipPackage(parts);
    expect([...first]).toEqual([...second]);

    const inspection = inspectZip(first);
    expect(inspection.commentLength).toBe(0);
    expect(inspection.entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      'word/document.xml',
      'word/media/image1.png',
    ]);

    const unpacked = unzipPackage(first);
    for (const [name, value] of parts) {
      expect([...(unpacked.get(name) ?? [])]).toEqual([...value]);
    }
  });

  it('rejects encrypted entries, ZIP64 markers and implausible ratios', () => {
    const base = makeZip({ 'a.txt': 'hello', 'b.txt': 'world' });

    const encrypted = new Uint8Array(base);
    const central = findForward(encrypted, 0x02014b50);
    const centralView = new DataView(encrypted.buffer);
    centralView.setUint16(central + 8, centralView.getUint16(central + 8, true) | 0x0001, true);
    expect(() => unzipPackage(encrypted)).toThrow(/Encrypted/u);

    const zip64 = new Uint8Array(base);
    const eocd = findEocd(zip64);
    const eocdView = new DataView(zip64.buffer);
    eocdView.setUint16(eocd + 8, 0xffff, true);
    eocdView.setUint16(eocd + 10, 0xffff, true);
    expect(() => unzipPackage(zip64)).toThrow(/ZIP64|Multi-disk/u);

    const bomb = zipSync(
      { 'zeros.bin': new Uint8Array(DEFAULT_ZIP_LIMITS.ratioFloorBytes + 1024 * 1024) },
      { level: 9 },
    );
    expect(() => unzipPackage(bomb)).toThrow(/ratio/u);
  });

  it('honours entry-count limits and rejects invalid names/duplicates', () => {
    const zip = makeZip({ 'a.txt': 'a', 'b.txt': 'b' });
    expect(() => unzipPackage(zip, { ...DEFAULT_ZIP_LIMITS, maxEntries: 1 })).toThrow(
      /too many entries/u,
    );

    expect(() =>
      zipPackage(
        new Map([
          ['word/a.xml', encoder.encode('<a/>')],
          ['word/A.XML', encoder.encode('<a/>')],
        ]),
      ),
    ).toThrow(/Duplicate/u);

    expect(() => zipPackage(new Map([['../escape.xml', encoder.encode('<a/>')]]))).toThrow(
      /traversal/u,
    );

    expect(() => unzipPackage(encoder.encode('not a zip'))).toThrow(/ZIP/u);

    // Rename the second entry (local + central headers) to collide with the
    // first one; duplicates must be rejected before decompression.
    const duplicate = makeZip({ 'a.txt': 'aaa', 'b.txt': 'bbb' });
    const view = new DataView(duplicate.buffer);
    const oldName = encoder.encode('b.txt');
    const newName = encoder.encode('a.txt');
    for (let offset = 0; offset + 4 <= duplicate.length; offset += 1) {
      const signature = view.getUint32(offset, true);
      const nameOffset =
        signature === 0x02014b50 ? offset + 46 : signature === 0x04034b50 ? offset + 30 : -1;
      if (nameOffset < 0) continue;
      if (oldName.every((byte, index) => duplicate[nameOffset + index] === byte)) {
        duplicate.set(newName, nameOffset);
      }
    }
    expect(() => unzipPackage(duplicate)).toThrow(/Duplicate/u);
  });
});

describe('XML decoder/scanner', () => {
  it('decodes UTF-8 with BOM and UTF-16LE/BE, re-encoding identically', () => {
    const utf8 = new Uint8Array(3 + encoder.encode('<x>тест</x>').length);
    utf8.set([0xef, 0xbb, 0xbf], 0);
    utf8.set(encoder.encode('<x>тест</x>'), 3);
    const utf8Decoded = decodeXml(utf8);
    expect(utf8Decoded).toMatchObject({ encoding: 'utf-8', bom: true, text: '<x>тест</x>' });
    expect([...encodeXml(utf8Decoded.text, utf8Decoded.encoding, utf8Decoded.bom)]).toEqual([
      ...utf8,
    ]);

    const source = '<?xml version="1.0" encoding="UTF-16"?><x>тест</x>';
    for (const littleEndian of [true, false]) {
      const bytes = utf16Bytes(source, littleEndian);
      const decoded = decodeXml(bytes);
      expect(decoded.text).toBe(source);
      expect(decoded.bom).toBe(true);
      expect(decoded.encoding).toBe(littleEndian ? 'utf-16le' : 'utf-16be');
      expect([...encodeXml(decoded.text, decoded.encoding, decoded.bom)]).toEqual([...bytes]);

      const noBom = utf16Bytes(source, littleEndian).subarray(2);
      const noBomDecoded = decodeXml(noBom);
      expect(noBomDecoded).toMatchObject({
        text: source,
        bom: false,
        encoding: littleEndian ? 'utf-16le' : 'utf-16be',
      });
      expect([...encodeXml(noBomDecoded.text, noBomDecoded.encoding, false)]).toEqual([...noBom]);
    }
  });

  it('rejects a declaration that disagrees with the byte encoding', () => {
    const bytes = utf16Bytes('<?xml version="1.0" encoding="UTF-8"?><x/>', true);
    expect(() => decodeXml(bytes)).toThrow(/unsupported encoding/u);
  });

  it('resolves namespaces and maps decoded text offsets through entities', () => {
    const xml =
      '<?xml version="1.0"?><root xmlns="urn:def" xmlns:x="urn:x"><x:t a="1">Ива &amp; нов</x:t><t>plain</t></root>';
    const scan = scanXml(xml);

    expect(scan.elements.map((element) => [element.local, element.ns])).toEqual([
      ['root', 'urn:def'],
      ['t', 'urn:x'],
      ['t', 'urn:def'],
    ]);

    const first = scan.textNodes[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.text).toBe('Ива & нов');
    expect(first.raw).toBe('Ива &amp; нов');
    expect(first.attrs.a).toBe('1');
    expect(first.path).toContain('x:t');

    const ampersandOffset = first.text.indexOf('&');
    const rawStart = rawOffsetInTextNode(first, ampersandOffset);
    const rawEnd = rawOffsetInTextNode(first, ampersandOffset + 1);
    expect(rawStart).toBe(4);
    expect(rawEnd).toBe(9);

    const replaced = replaceTextNodes(xml, [
      { start: first.start + rawStart, end: first.start + rawEnd, text: '&' },
    ]);
    expect(replaced).toContain('Ива &amp; нов');
    expect(() => validateXml(encoder.encode(replaced))).not.toThrow();
  });

  it('rejects DTDs, unknown entities and malformed tags', () => {
    expect(() => scanXml('<!DOCTYPE x><x/>')).toThrow(/DOCTYPE/u);
    expect(() => scanXml('<x>&custom;</x>')).toThrow(/Unknown entity/u);
    expect(() => scanXml('<x><y></x>')).toThrow(/Mismatched/u);
    expect(() => validateXml(encoder.encode('<x><y></x>'))).toThrow(/not well-formed|Mismatched/u);
    expect(() => scanXml('<x><![CDATA[ ok ]]></x>')).not.toThrow();
  });

  it('escapes replacements and rejects overlapping edits', () => {
    const xml = '<x>&lt;tag&gt;</x>';
    const scan = scanXml(xml);
    const node = scan.textNodes[0];
    expect(node?.text).toBe('<tag>');
    const replaced = replaceTextNodes(xml, [
      { start: node?.start ?? 0, end: node?.end ?? 0, text: '<new & value>' },
    ]);
    expect(replaced).toBe('<x>&lt;new &amp; value&gt;</x>');
    expect(() =>
      applyXmlEdits('<x>abc</x>', [
        { start: 3, end: 5, text: 'X' },
        { start: 4, end: 6, text: 'Y' },
      ]),
    ).toThrow(/Overlapping/u);
  });

  it('keeps the skeleton stable for text/value edits but detects tag rewrites', () => {
    const before = '<x a="1" b="2"><y>text</y><z xml:space="preserve"> more </z></x>';
    const textChanged = '<x a="9" b="2"><y></y><z xml:space="preserve">more</z></x>';
    expect(xmlSkeleton(before)).toBe(xmlSkeleton(textChanged));

    const tagChanged = '<x a="1" b="2"><y>text</y></x>';
    expect(xmlSkeleton(before)).not.toBe(xmlSkeleton(tagChanged));
  });
});

interface StoredOptions {
  flags?: number;
  localFlags?: number;
  centralExtra?: Uint8Array;
  compressedSize?: number;
  uncompressedSize?: number;
  localOffset?: number;
}

/** Minimal stored ZIP whose header fields can be rewritten per test. */
function storedZip(
  name: string,
  data: Uint8Array,
  options: StoredOptions = {},
  tail: { eocd64Locator?: boolean; eocdEntries?: number } = {},
): Uint8Array {
  const nameBytes = encoder.encode(name);
  const extra = options.centralExtra ?? new Uint8Array(0);
  const flags = options.flags ?? 0;
  const localFlags = options.localFlags ?? flags;

  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(6, localFlags, true);
  localView.setUint16(8, 0, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length + extra.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(8, flags, true);
  centralView.setUint16(10, 0, true);
  centralView.setUint32(20, options.compressedSize ?? data.length, true);
  centralView.setUint32(24, options.uncompressedSize ?? data.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint16(30, extra.length, true);
  centralView.setUint32(42, options.localOffset ?? 0, true);
  central.set(nameBytes, 46);
  central.set(extra, 46 + nameBytes.length);

  const locator = tail.eocd64Locator ? 20 : 0;
  const out = new Uint8Array(local.length + central.length + locator + 22);
  out.set(local, 0);
  out.set(central, local.length);
  const outView = new DataView(out.buffer);
  if (tail.eocd64Locator) {
    outView.setUint32(local.length + central.length, 0x07064b50, true);
  }
  const eocd = local.length + central.length + locator;
  const entries = tail.eocdEntries ?? 1;
  outView.setUint32(eocd, 0x06054b50, true);
  outView.setUint16(eocd + 8, entries, true);
  outView.setUint16(eocd + 10, entries, true);
  outView.setUint32(eocd + 12, central.length, true);
  outView.setUint32(eocd + 16, local.length, true);
  return out;
}

function expectZipFailure(bytes: Uint8Array, reason: 'zip64' | 'encrypted', pattern: RegExp): void {
  let caught: unknown;
  try {
    inspectZip(bytes);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ZipError);
  const zipError = caught as ZipError;
  expect(zipError.reason).toBe(reason);
  expect(zipError.message).toMatch(pattern);
}

describe('P1-ZIP64-ENCRYPTED: archive rejection carries a machine-readable reason', () => {
  const data = encoder.encode('payload');
  const zip64Extra = Uint8Array.from([0x01, 0x00, 0x00, 0x00]);

  it('rejects encryption flagged in the central directory', () => {
    expectZipFailure(storedZip('a.xml', data, { flags: 0x0001 }), 'encrypted', /Encrypted/u);
    expectZipFailure(storedZip('a.xml', data, { flags: 0x2000 }), 'encrypted', /Encrypted/u);
  });

  it('rejects encryption flagged only in the local header', () => {
    expectZipFailure(
      storedZip('a.xml', data, { flags: 0, localFlags: 0x0001 }),
      'encrypted',
      /Encrypted/u,
    );
  });

  it('rejects a ZIP64 extra field in the central directory', () => {
    expectZipFailure(storedZip('a.xml', data, { centralExtra: zip64Extra }), 'zip64', /ZIP64/u);
  });

  it('rejects an EOCD64 locator', () => {
    expectZipFailure(storedZip('a.xml', data, {}, { eocd64Locator: true }), 'zip64', /ZIP64/u);
  });

  it('rejects ZIP64 size sentinels', () => {
    expectZipFailure(storedZip('a.xml', data, { compressedSize: 0xffffffff }), 'zip64', /ZIP64/u);
    expectZipFailure(storedZip('a.xml', data, { uncompressedSize: 0xffffffff }), 'zip64', /ZIP64/u);
    expectZipFailure(storedZip('a.xml', data, { localOffset: 0xffffffff }), 'zip64', /ZIP64/u);
    expectZipFailure(storedZip('a.xml', data, {}, { eocdEntries: 0xffff }), 'zip64', /ZIP64/u);
  });

  it('never returns a partial part map for a rejected archive', () => {
    const rejected = [
      storedZip('a.xml', data, { flags: 0x0001 }),
      storedZip('a.xml', data, { centralExtra: zip64Extra }),
      storedZip('a.xml', data, {}, { eocd64Locator: true }),
    ];
    for (const bytes of rejected) {
      let parts: Map<string, Uint8Array> | undefined;
      try {
        parts = unzipPackage(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(ZipError);
      }
      expect(parts).toBeUndefined();
    }
  });
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function withCentralFlag(bytes: Uint8Array, mask: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const central = findForward(copy, 0x02014b50);
  expect(central).toBeGreaterThanOrEqual(0);
  view.setUint16(central + 8, view.getUint16(central + 8, true) | mask, true);
  return copy;
}

function withZip64EocdCounts(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  const eocd = findEocd(copy);
  expect(eocd).toBeGreaterThanOrEqual(0);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setUint16(eocd + 8, 0xffff, true);
  view.setUint16(eocd + 10, 0xffff, true);
  return copy;
}

describe('P1-ZIP64-ENCRYPTED: the background maps the cause and writes nothing', () => {
  beforeEach(async () => {
    await closeVaultStore();
    await resetDb();
    await initVaultStore();
  });

  afterEach(async () => {
    await closeVaultStore();
  });

  it('surfaces an encrypted DOCX as UNSUPPORTED_ARCHIVE without a vault record', async () => {
    const encrypted = withCentralFlag(
      minimalDocx('<w:p><w:r><w:t>Иванов</w:t></w:r></w:p>'),
      0x0001,
    );
    let caught: unknown;
    try {
      await processAnonymize({ bytes: encrypted, name: 'secret.docx', mime: DOCX_MIME });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: 'RelayError',
      code: 'UNSUPPORTED_ARCHIVE',
      message: 'Зашифрованный ZIP не поддерживается',
    });
    await expect(listVaults()).resolves.toEqual([]);
  });

  it('surfaces a ZIP64 DOCX as UNSUPPORTED_ARCHIVE without a vault record', async () => {
    const zip64 = withZip64EocdCounts(minimalDocx('<w:p><w:r><w:t>Иванов</w:t></w:r></w:p>'));
    let caught: unknown;
    try {
      await processAnonymize({ bytes: zip64, name: 'secret.docx', mime: DOCX_MIME });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: 'RelayError',
      code: 'UNSUPPORTED_ARCHIVE',
      message: 'Архив ZIP64 не поддерживается',
    });
    await expect(listVaults()).resolves.toEqual([]);
  });
});
