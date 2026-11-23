/**
 * OPC ZIP container I/O.
 *
 * fflate performs the actual DEFLATE work, but the central directory is
 * inspected first: encrypted entries, ZIP64 markers, duplicate/invalid names,
 * name-case collisions and implausible compression ratios are rejected before
 * any bytes are expanded (ZIP-bomb / polyglot guard).
 *
 * Re-zipping uses a fixed DOS timestamp, no entry comments and no extra fields,
 * so equal part maps produce equal bytes. Payloads of untouched parts are
 * passed through unchanged; only the ZIP stream is recompressed.
 */

import { unzipSync, type Zippable, zipSync } from 'fflate';
import { getCodecScanner, MAX_CODEC_UNCOMPRESSED } from './codec-wasm';

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  maxEntryBytes: number;
  /** Total uncompressed/compressed ratio, applied above `ratioFloorBytes`. */
  maxRatio: number;
  /** Per-entry ratio for entries above `ratioFloorBytes`. */
  maxEntryRatio: number;
  ratioFloorBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxRatio: 500,
  maxEntryRatio: 800,
  ratioFloorBytes: 8 * 1024 * 1024,
};

/**
 * Fixed DOS timestamp used for every entry. Constructed from local fields on
 * purpose: fflate writes `getFullYear()`/`getMonth()`/... so this yields the
 * same date bytes in every time zone. 1980-01-01 is the ZIP epoch.
 */
const FIXED_ZIP_DATE = new Date(1980, 0, 1, 0, 0, 0, 0);
const ZIP64_LIMIT = 0xffffffff;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Machine-readable cause for the two archive shapes the product rejects
 * outright. The message stays constant and never names an entry; callers map
 * the cause to a user-facing code instead of collapsing it into `INTERNAL`.
 */
export type ZipErrorReason = 'zip64' | 'encrypted' | 'other';

export class ZipError extends Error {
  readonly reason: ZipErrorReason;

  constructor(message: string, reason: ZipErrorReason = 'other') {
    super(message);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

export interface ZipEntryInfo {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export interface ZipInspection {
  entries: ZipEntryInfo[];
  commentLength: number;
  totalCompressedSize: number;
  totalUncompressedSize: number;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** OPC part names are URI paths: ASCII, relative, no traversal segments. */
export function validatePartName(name: string): void {
  if (name.length === 0) throw new ZipError('ZIP entry has an empty name');
  if (name.startsWith('/')) throw new ZipError(`ZIP entry is absolute: ${name}`);
  if (name.endsWith('/')) throw new ZipError(`ZIP entry is a directory: ${name}`);
  if (name.includes('\\')) throw new ZipError(`ZIP entry contains a backslash: ${name}`);
  if (name.includes('#') || name.includes('?')) {
    throw new ZipError(`ZIP entry contains a URI delimiter: ${name}`);
  }
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new ZipError(`ZIP entry uses a reserved object key: ${name}`);
  }
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code > 0x7e) {
      throw new ZipError(`ZIP entry name is not OPC-safe ASCII: ${name}`);
    }
  }
  for (const segment of name.split('/')) {
    if (segment.length === 0) throw new ZipError(`ZIP entry has an empty path segment: ${name}`);
    if (segment === '.' || segment === '..') {
      throw new ZipError(`ZIP entry contains a traversal segment: ${name}`);
    }
  }
}

function decodeName(bytes: Uint8Array, flags: number, offset: number): string {
  let name: string;
  if ((flags & 0x0800) !== 0) {
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ZipError(`ZIP entry name is not valid UTF-8 at offset ${offset}`);
    }
  } else {
    // OPC names are ASCII; decoding as UTF-8 is safe and stricter than CP437.
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ZipError(`ZIP entry name is not valid UTF-8/ASCII at offset ${offset}`);
    }
  }
  return name;
}

/** Finds the end-of-central-directory record and rejects ZIP64/multi-disk. */
function findEocd(bytes: Uint8Array): { offset: number; commentLength: number } {
  const view = viewOf(bytes);
  const minimum = 22;
  if (bytes.length < minimum) throw new ZipError('Not a ZIP archive: too short');

  const lowest = Math.max(0, bytes.length - minimum - MAX_COMMENT);
  for (let offset = bytes.length - minimum; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;

    const commentLength = view.getUint16(offset + 20, true);
    if (offset + minimum + commentLength !== bytes.length) continue;

    const diskNumber = view.getUint16(offset + 4, true);
    const centralDisk = view.getUint16(offset + 6, true);
    const entriesOnDisk = view.getUint16(offset + 8, true);
    const totalEntries = view.getUint16(offset + 10, true);
    const centralSize = view.getUint32(offset + 12, true);
    const centralOffset = view.getUint32(offset + 16, true);

    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new ZipError('Multi-disk ZIP archives are not supported');
    }
    if (totalEntries === 0xffff || centralSize === ZIP64_LIMIT || centralOffset === ZIP64_LIMIT) {
      throw new ZipError('ZIP64 archives are not supported', 'zip64');
    }
    if (offset >= 20 && view.getUint32(offset - 20, true) === EOCD64_LOCATOR_SIGNATURE) {
      throw new ZipError('ZIP64 archives are not supported', 'zip64');
    }
    if (centralOffset + centralSize > offset) {
      throw new ZipError('ZIP central directory is out of bounds');
    }

    return { offset, commentLength };
  }

  throw new ZipError('Not a ZIP archive: end-of-central-directory record not found');
}

/** Reads and validates the central directory without expanding entries. */
export function inspectZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ZipInspection {
  if (bytes.length > ZIP64_LIMIT) throw new ZipError('ZIP exceeds the 4 GiB limit');

  const view = viewOf(bytes);
  const eocd = findEocd(bytes);
  const totalEntries = view.getUint16(eocd.offset + 10, true);
  const centralSize = view.getUint32(eocd.offset + 12, true);
  const centralOffset = view.getUint32(eocd.offset + 16, true);

  if (totalEntries === 0) throw new ZipError('ZIP archive is empty');
  if (totalEntries > limits.maxEntries) {
    throw new ZipError(`ZIP archive has too many entries (${totalEntries})`);
  }

  const entries: ZipEntryInfo[] = [];
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  let cursor = centralOffset;
  let totalCompressedSize = 0;
  let totalUncompressedSize = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd.offset) throw new ZipError('Truncated ZIP central directory');
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`Bad ZIP central directory entry at offset ${cursor}`);
    }

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
      throw new ZipError('Encrypted ZIP entries are not supported', 'encrypted');
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError(`Unsupported ZIP compression method ${method}`);
    }
    if (
      compressedSize === ZIP64_LIMIT ||
      uncompressedSize === ZIP64_LIMIT ||
      localOffset === ZIP64_LIMIT
    ) {
      throw new ZipError('ZIP64 archives are not supported', 'zip64');
    }

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    const extraEnd = nameEnd + extraLength;
    const entryEnd = extraEnd + commentLength;
    if (entryEnd > eocd.offset) throw new ZipError('Truncated ZIP central directory entry');

    const name = decodeName(bytes.subarray(nameStart, nameEnd), flags, nameStart);
    validatePartName(name);
    if (names.has(name)) throw new ZipError(`Duplicate ZIP entry: ${name}`);
    const folded = name.toLowerCase();
    if (foldedNames.has(folded)) {
      throw new ZipError(`ZIP entries differ only by case: ${name}`);
    }
    names.add(name);
    foldedNames.add(folded);

    // Reject a ZIP64 extra field even when the 32-bit sizes are populated.
    let extraCursor = nameEnd;
    while (extraCursor + 4 <= extraEnd) {
      const headerId = view.getUint16(extraCursor, true);
      const headerSize = view.getUint16(extraCursor + 2, true);
      if (headerId === 0x0001) throw new ZipError('ZIP64 archives are not supported', 'zip64');
      extraCursor += 4 + headerSize;
      if (extraCursor > extraEnd) throw new ZipError('Malformed ZIP extra field');
    }

    if (uncompressedSize > limits.maxEntryBytes) {
      throw new ZipError(`ZIP entry is too large: ${name}`);
    }

    // Check the local header as well; it is what fflate consumes.
    if (localOffset + 30 > centralOffset) throw new ZipError(`Bad local header offset for ${name}`);
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new ZipError(`Bad ZIP local file header for ${name}`);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if ((localFlags & 0x0001) !== 0 || (localFlags & 0x0040) !== 0 || (localFlags & 0x2000) !== 0) {
      throw new ZipError('Encrypted ZIP entries are not supported', 'encrypted');
    }
    if (localMethod !== method) throw new ZipError(`ZIP method mismatch for ${name}`);
    if (localOffset + 30 + localNameLength > centralOffset) {
      throw new ZipError(`Truncated ZIP local file header for ${name}`);
    }
    const localName = decodeName(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      localFlags,
      localOffset + 30,
    );
    if (localName !== name) throw new ZipError(`ZIP entry name mismatch for ${name}`);
    if (localOffset + 30 + localNameLength + localExtraLength > centralOffset) {
      throw new ZipError(`Truncated ZIP local extra field for ${name}`);
    }

    entries.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    totalCompressedSize += compressedSize;
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > limits.maxUncompressedBytes) {
      throw new ZipError('ZIP expands beyond the uncompressed size limit');
    }

    cursor = entryEnd;
  }

  if (cursor !== centralOffset + centralSize) {
    throw new ZipError('ZIP central directory size mismatch');
  }

  for (const entry of entries) {
    if (
      entry.uncompressedSize >= limits.ratioFloorBytes &&
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > limits.maxEntryRatio
    ) {
      throw new ZipError(`Suspicious ZIP compression ratio for ${entry.name}`);
    }
  }
  if (
    totalUncompressedSize >= limits.ratioFloorBytes &&
    totalCompressedSize > 0 &&
    totalUncompressedSize / totalCompressedSize > limits.maxRatio
  ) {
    throw new ZipError('Suspicious ZIP compression ratio');
  }

  return {
    entries,
    commentLength: eocd.commentLength,
    totalCompressedSize,
    totalUncompressedSize,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII fast-path probe
const NON_ASCII_RE = /[^\x00-\x7f]/u;

/**
 * The wasm parser is intentionally conservative. Data-descriptor entries,
 * non-ASCII names without the UTF-8 flag, ZIP64, encryption and oversized
 * packages keep the fflate path. `inspectZip` has already rejected the latter
 * two before this point, but the remaining checks are cheap and local.
 */
function canUseWasmCodec(inspection: ZipInspection): boolean {
  if (inspection.totalUncompressedSize > MAX_CODEC_UNCOMPRESSED) return false;
  for (const entry of inspection.entries) {
    if ((entry.flags & 0x0008) !== 0) return false;
    if ((entry.flags & 0x0800) === 0 && NON_ASCII_RE.test(entry.name)) return false;
    if (entry.method !== 0 && entry.method !== 8) return false;
    if (entry.compressedSize === 0 && entry.uncompressedSize > 0) return false;
  }
  return true;
}

function assertUnzippedParts(
  parts: ReadonlyMap<string, Uint8Array>,
  inspection: ZipInspection,
): void {
  if (parts.size !== inspection.entries.length) {
    throw new ZipError('ZIP entry count mismatch after decompression');
  }
  for (const entry of inspection.entries) {
    const data = parts.get(entry.name);
    if (data === undefined) {
      throw new ZipError(`ZIP entry missing after decompression: ${entry.name}`);
    }
    if (data.length !== entry.uncompressedSize) {
      throw new ZipError(`ZIP entry size mismatch: ${entry.name}`);
    }
    if (crc32(data) !== entry.crc) {
      throw new ZipError(`ZIP entry CRC mismatch: ${entry.name}`);
    }
  }
}

/** Returns null on any wasm failure so the caller can retry with fflate. */
function unzipWithWasm(
  bytes: Uint8Array,
  inspection: ZipInspection,
): Map<string, Uint8Array> | null {
  const scanner = getCodecScanner();
  if (!scanner || !canUseWasmCodec(inspection)) return null;
  try {
    const parts = scanner.unzip(bytes, inspection.entries);
    if (!parts) return null;
    assertUnzippedParts(parts, inspection);
    return parts;
  } catch {
    return null;
  }
}

function unzipWithFflate(bytes: Uint8Array, inspection: ZipInspection): Map<string, Uint8Array> {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ZipError(`ZIP decompression failed: ${message}`);
  }

  if (Object.keys(unzipped).length !== inspection.entries.length) {
    throw new ZipError('ZIP entry count mismatch after decompression');
  }

  const parts = new Map<string, Uint8Array>();
  for (const entry of inspection.entries) {
    if (!Object.hasOwn(unzipped, entry.name)) {
      throw new ZipError(`ZIP entry missing after decompression: ${entry.name}`);
    }
    const data = unzipped[entry.name];
    if (data === undefined) {
      throw new ZipError(`ZIP entry missing after decompression: ${entry.name}`);
    }
    // Copy so callers cannot mutate the decompressor's buffers.
    parts.set(entry.name, new Uint8Array(data));
  }
  assertUnzippedParts(parts, inspection);
  return parts;
}

/** Unzips an OPC package into an ordered, duplicate-free part map. */
export function unzipPackage(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Map<string, Uint8Array> {
  const inspection = inspectZip(bytes, limits);
  const wasmParts = unzipWithWasm(bytes, inspection);
  if (wasmParts) return wasmParts;
  return unzipWithFflate(bytes, inspection);
}

/** Validates a part map that is about to be written. */
export function validatePartsForZip(
  parts: ReadonlyMap<string, Uint8Array>,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): void {
  if (parts.size === 0) throw new ZipError('Cannot write an empty ZIP archive');
  if (parts.size > limits.maxEntries) {
    throw new ZipError(`Too many ZIP parts (${parts.size})`);
  }

  const folded = new Set<string>();
  let total = 0;
  for (const [name, data] of parts) {
    validatePartName(name);
    if (!(data instanceof Uint8Array)) throw new ZipError(`Part ${name} is not a byte array`);
    if (data.length > limits.maxEntryBytes) throw new ZipError(`Part is too large: ${name}`);
    const lower = name.toLowerCase();
    if (folded.has(lower)) throw new ZipError(`Duplicate ZIP part: ${name}`);
    folded.add(lower);
    total += data.length;
    if (total > limits.maxUncompressedBytes) {
      throw new ZipError('ZIP parts exceed the uncompressed size limit');
    }
  }
}

/**
 * Writes an OPC package. `[Content_Types].xml` is placed first; remaining
 * names are sorted for deterministic output.
 */
export function zipPackage(
  parts: ReadonlyMap<string, Uint8Array>,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Uint8Array {
  validatePartsForZip(parts, limits);

  const names = [...parts.keys()].sort((a, b) => {
    if (a === '[Content_Types].xml') return -1;
    if (b === '[Content_Types].xml') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const zippable: Zippable = {};
  for (const name of names) {
    const data = parts.get(name);
    if (!data) throw new ZipError(`Part disappeared during ZIP write: ${name}`);
    zippable[name] = data;
  }

  try {
    return zipSync(zippable, { level: 6, mtime: FIXED_ZIP_DATE, os: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ZipError(`ZIP creation failed: ${message}`);
  }
}
