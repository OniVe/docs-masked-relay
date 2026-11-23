import { readFileSync } from 'node:fs';
import { deflateSync, unzipSync, zipSync, zlibSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCodecScanner,
  initCodecScanner,
  resetCodecScanner,
} from '../../src/core/ooxml/codec-wasm';
import { inspectZip, unzipPackage } from '../../src/core/ooxml/zip';
import { fullDocx } from '../fixtures/docx';
import { fullXlsx } from '../fixtures/xlsx';

const encoder = new TextEncoder();
const codec = readFileSync(new URL('../../src/core/ooxml/codec.wasm', import.meta.url));

function partsOf(bytes: Uint8Array): Map<string, Uint8Array> {
  return unzipPackage(bytes);
}

function expectSameParts(
  left: ReadonlyMap<string, Uint8Array>,
  right: ReadonlyMap<string, Uint8Array>,
) {
  expect([...right.keys()]).toEqual([...left.keys()]);
  for (const [name, data] of left) {
    expect([...(right.get(name) ?? [])]).toEqual([...data]);
  }
}

interface CentralLayout {
  view: DataView;
  centralOffset: number;
  count: number;
}

function centralLayout(bytes: Uint8Array): CentralLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('test fixture has no EOCD');
  return {
    view,
    centralOffset: view.getUint32(eocd + 16, true),
    count: view.getUint16(eocd + 10, true),
  };
}

function forEachCentral(bytes: Uint8Array, visit: (offset: number, view: DataView) => void): void {
  const { view, centralOffset, count } = centralLayout(bytes);
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    visit(cursor, view);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

/** Marks data-descriptor entries in both the central and local headers. */
function markDataDescriptors(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  forEachCentral(copy, (offset, view) => {
    view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 0x0008, true);
    const local = view.getUint32(offset + 42, true);
    view.setUint16(local + 6, view.getUint16(local + 6, true) | 0x0008, true);
  });
  return copy;
}

function clearUtf8Flag(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  forEachCentral(copy, (offset, view) => {
    view.setUint16(offset + 8, view.getUint16(offset + 8, true) & ~0x0800, true);
    const local = view.getUint32(offset + 42, true);
    view.setUint16(local + 6, view.getUint16(local + 6, true) & ~0x0800, true);
  });
  return copy;
}

afterEach(() => {
  resetCodecScanner();
});

describe('wasm ZIP codec', () => {
  it('is byte-identical to fflate for DOCX and XLSX parts', async () => {
    for (const make of [fullDocx, fullXlsx]) {
      resetCodecScanner();
      const fallback = partsOf(make());

      const scanner = await initCodecScanner(codec);
      expect(scanner).not.toBeNull();
      expect(getCodecScanner()).not.toBeNull();

      const wasmParts = partsOf(make());
      expectSameParts(fallback, wasmParts);

      const inspection = inspectZip(make());
      const direct = scanner?.unzip(make(), inspection.entries) ?? null;
      expect(direct).not.toBeNull();
      if (direct) expectSameParts(fallback, direct);
    }
  });

  it('is byte-identical for a small XML-only package', async () => {
    const zip = zipSync({
      '[Content_Types].xml': encoder.encode(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      ),
      'word/document.xml': encoder.encode(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    resetCodecScanner();
    const fallback = partsOf(zip);
    await initCodecScanner(codec);
    expectSameParts(fallback, partsOf(zip));
  });

  it('falls back for data-descriptor entries', async () => {
    const zip = markDataDescriptors(
      zipSync({ 'a.txt': encoder.encode('hello'), 'b.txt': encoder.encode('world') }),
    );
    resetCodecScanner();
    const fallback = partsOf(zip);
    await initCodecScanner(codec);
    expect(getCodecScanner()).not.toBeNull();
    expectSameParts(fallback, partsOf(zip));
  });

  it('rejects non-ASCII entry names before codec selection', async () => {
    const zip = clearUtf8Flag(zipSync({ 'ä.txt': encoder.encode('hello') }));
    await initCodecScanner(codec);
    // OPC part names are ASCII, so inspectZip is the gate even when the
    // UTF-8 flag is absent; the codec never sees this archive.
    expect(() => partsOf(zip)).toThrow(/OPC-safe ASCII/u);
  });

  it('falls back when the wasm module is unavailable', async () => {
    const zip = zipSync({ 'a.txt': encoder.encode('hello') });
    resetCodecScanner();
    const fallback = partsOf(zip);
    expect(await initCodecScanner(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(getCodecScanner()).toBeNull();
    expectSameParts(fallback, partsOf(zip));
  });

  it('keeps malformed-archive errors on the fflate path', () => {
    expect(() => unzipPackage(encoder.encode('not a zip'))).toThrow(/Not a ZIP archive/u);
  });

  it('does not return a wasm result whose CRC does not match the directory', async () => {
    const zip = zipSync({ 'a.txt': encoder.encode('hello') });
    forEachCentral(zip, (offset, view) => {
      view.setUint32(offset + 16, (view.getUint32(offset + 16, true) ^ 0xffff_ffff) >>> 0, true);
    });
    await initCodecScanner(codec);
    expect(() => partsOf(zip)).toThrow(/CRC mismatch/u);
  });

  it('inflates raw and zlib streams identically to fflate', async () => {
    const scanner = await initCodecScanner(codec);
    expect(scanner).not.toBeNull();
    const raw = encoder.encode('DocsMasked codec benchmark '.repeat(1000));
    const deflated = deflateSync(raw, { level: 6 });
    const zlibbed = zlibSync(raw, { level: 6 });

    const rawOut = scanner?.inflate(deflated, raw.length) ?? null;
    expect(rawOut ? [...rawOut] : null).toEqual([...raw]);
    const zlibOut = scanner?.inflate(zlibbed, raw.length, true) ?? null;
    expect(zlibOut ? [...zlibOut] : null).toEqual([...raw]);
    const roundTrip = unzipSync(zipSync({ 'a.txt': raw }));
    expect(roundTrip['a.txt'] ? [...roundTrip['a.txt']] : null).toEqual([...raw]);
  });
});
