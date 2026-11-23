/**
 * Structured-detector accelerator backed by `wasm/pii-scan`.
 *
 * The wasm module deliberately does not re-implement the detector regexes: it
 * finds small candidate regions (maximal runs that can host one detector
 * family) in one linear byte pass. The unchanged JS regex is then run on each
 * region with one real character of context on both sides, so matching,
 * lookarounds, checksums, priorities and rule ids stay byte-for-byte identical
 * to the pure-JS path.
 *
 * The scanner is optional: if fetch/instantiation fails, callers fall back to
 * the existing whole-text JS path.
 */

export const REGION_EMAIL = 1;
export const REGION_URL = 2;
export const REGION_HANDLE = 3;
export const REGION_NUMERIC = 4;
export const REGION_LICENSE = 5;
export const REGION_IBAN = 6;

export type RegionKind =
  | typeof REGION_EMAIL
  | typeof REGION_URL
  | typeof REGION_HANDLE
  | typeof REGION_NUMERIC
  | typeof REGION_LICENSE
  | typeof REGION_IBAN;

export interface CandidateRegion {
  /** UTF-16 offset, inclusive. */
  start: number;
  /** UTF-16 offset, exclusive. */
  end: number;
  kind: RegionKind;
}

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  scan(textPtr: number, textLen: number, outPtr: number, outCap: number): number;
}

const OUT_TOO_SMALL = 0xffffffff;
const FALLBACK = 0xfffffffe;
const MAX_CANDIDATES = 250_000;
const RECORD_BYTES = 12;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII fast-path probe
const NON_ASCII_RE = /[^\x00-\x7f]/u;

const encoder = new TextEncoder();

export interface StructuredScanner {
  regions(text: string): CandidateRegion[] | null;
}

let ready: StructuredScanner | null = null;
let loading: Promise<StructuredScanner | null> | undefined;

function createScanner(instance: WebAssembly.Instance): StructuredScanner {
  const exports = instance.exports as WasmExports;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.alloc !== 'function' ||
    typeof exports.dealloc !== 'function' ||
    typeof exports.scan !== 'function'
  ) {
    throw new Error('pii-scan.wasm: unexpected exports');
  }

  let inputPtr = 0;
  let inputCap = 0;
  let outPtr = 0;
  let outCap = 0;

  const ensureInput = (len: number): number => {
    if (inputCap >= len) return inputPtr;
    if (inputPtr !== 0) exports.dealloc(inputPtr, inputCap);
    inputPtr = exports.alloc(len);
    inputCap = len;
    return inputPtr;
  };

  const ensureOut = (records: number): number => {
    if (outCap >= records) return outPtr;
    if (outPtr !== 0) exports.dealloc(outPtr, outCap * RECORD_BYTES);
    outPtr = exports.alloc(records * RECORD_BYTES);
    outCap = records;
    return outPtr;
  };

  /** Byte offset -> UTF-16 offset mapper; identity for pure ASCII. */
  const makeMapper = (text: string, bytes: Uint8Array): ((offset: number) => number) => {
    if (bytes.length === text.length && !NON_ASCII_RE.test(text)) {
      return (offset) => Math.min(offset, text.length);
    }

    // Checkpoints every 1024 UTF-8 bytes. One O(n) pass, no per-character
    // array: a 25 MB document costs ~25k entries instead of 25M.
    const CHECKPOINT = 1024;
    const byteStops: number[] = [0];
    const unitStops: number[] = [0];
    let byte = 0;
    let units = 0;
    let nextStop = CHECKPOINT;
    for (let index = 0; index < text.length; ) {
      const codePoint = text.codePointAt(index) ?? 0;
      const unitWidth = codePoint > 0xffff ? 2 : 1;
      const byteWidth = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
      byte += byteWidth;
      units += unitWidth;
      index += unitWidth;
      if (byte >= nextStop) {
        byteStops.push(byte);
        unitStops.push(units);
        nextStop = byte + CHECKPOINT;
      }
    }
    byteStops.push(byte);
    unitStops.push(units);

    return (offset) => {
      if (offset <= 0) return 0;
      if (offset >= byte) return text.length;
      let low = 0;
      let high = byteStops.length - 1;
      while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if ((byteStops[mid] ?? 0) <= offset) low = mid;
        else high = mid;
      }
      let currentByte = byteStops[low] ?? 0;
      let currentUnit = unitStops[low] ?? 0;
      let index = currentUnit;
      while (currentByte < offset && index < text.length) {
        const codePoint = text.codePointAt(index) ?? 0;
        const unitWidth = codePoint > 0xffff ? 2 : 1;
        currentByte += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
        currentUnit += unitWidth;
        index += unitWidth;
      }
      return currentUnit;
    };
  };

  return {
    regions(text: string): CandidateRegion[] | null {
      // TextEncoder replaces lone surrogates; offsets would no longer line up.
      if (typeof text.isWellFormed === 'function' && !text.isWellFormed()) return null;
      if (text.length === 0) return [];

      const bytes = encoder.encode(text);
      const ptr = ensureInput(bytes.length);
      if (ptr === 0) return null;
      new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);

      let records = Math.min(MAX_CANDIDATES, Math.max(64, Math.ceil(bytes.length / 48) + 64));
      let count = OUT_TOO_SMALL;
      while (count === OUT_TOO_SMALL) {
        const target = ensureOut(records);
        if (target === 0) return null;
        count = exports.scan(ptr, bytes.length, target, records);
        if (count === OUT_TOO_SMALL) {
          if (records >= MAX_CANDIDATES) return null;
          records = Math.min(MAX_CANDIDATES, records * 2);
        }
      }
      if (count === FALLBACK) return null;

      const mapOffset = makeMapper(text, bytes);
      const view = new DataView(exports.memory.buffer, outPtr, count * RECORD_BYTES);
      const regions: CandidateRegion[] = [];
      for (let index = 0; index < count; index += 1) {
        const base = index * RECORD_BYTES;
        const start = view.getUint32(base, true);
        const end = view.getUint32(base + 4, true);
        const kind = view.getUint8(base + 8);
        if (kind < REGION_EMAIL || kind > REGION_IBAN || end <= start) continue;
        const utf16Start = mapOffset(start);
        const utf16End = mapOffset(end);
        if (utf16End <= utf16Start) continue;
        regions.push({ start: utf16Start, end: utf16End, kind: kind as RegionKind });
      }
      return regions;
    },
  };
}

async function loadFromAsset(): Promise<StructuredScanner | null> {
  const url = new URL('./pii-scan.wasm', import.meta.url);
  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  const instance = await WebAssembly.instantiate(bytes, {});
  return createScanner(instance.instance);
}

/**
 * Starts loading the singleton scanner. Call once from an async entry point
 * before detection; `detectAll` itself stays synchronous and uses the JS path
 * until the scanner is ready.
 */
export function ensureStructuredScanner(): Promise<StructuredScanner | null> {
  loading ??= loadFromAsset()
    .then((scanner) => {
      ready = scanner;
      return scanner;
    })
    .catch(() => null);
  return loading;
}

/** Scanner for synchronous detectors, or null when wasm is unavailable. */
export function getStructuredScanner(): StructuredScanner | null {
  return ready;
}

/** Test/explicit-bytes hook (also used when an embedding host supplies bytes). */
export async function initStructuredScanner(
  source: BufferSource,
): Promise<StructuredScanner | null> {
  const instance = await WebAssembly.instantiate(source, {});
  ready = createScanner(instance.instance);
  loading = Promise.resolve(ready);
  return ready;
}

/** Clears the singleton (tests only). */
export function resetStructuredScanner(): void {
  ready = null;
  loading = undefined;
}
