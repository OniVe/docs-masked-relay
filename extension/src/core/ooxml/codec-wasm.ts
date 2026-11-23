/**
 * ZIP/DEFLATE codec backed by `wasm/codec` (miniz_oxide).
 *
 * The scanner is optional and fail-safe: when the module is unavailable, the
 * call traps, or its output does not match the central directory, `zip.ts`
 * falls back to `fflate`. The module is loaded once from the emitted asset,
 * compiled once, and then instantiated synchronously from the cached
 * `WebAssembly.Module`.
 *
 * ABI (see `wasm/codec/src/lib.rs`):
 *   alloc(len) -> ptr
 *   dealloc(ptr, len)
 *   unzip(ptr, len, out_ptr, out_cap) -> entry_count | u32::MAX-family
 *   inflate_stream(ptr, len, out_ptr, out_cap, zlib) -> bytes_written | error
 */

/** Hard cap for a single wasm32 output buffer; larger packages use fflate. */
export const MAX_CODEC_UNCOMPRESSED = 128 * 1024 * 1024;

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  unzip(ptr: number, len: number, outPtr: number, outCap: number): number;
  inflate_stream(ptr: number, len: number, outPtr: number, outCap: number, zlib: number): number;
}

const ERROR_BASE = 0xffff_ffff;
const ERROR_TOO_SMALL = ERROR_BASE - 1;
const ERROR_INFLATE = ERROR_BASE - 2;

export interface CodecZipEntry {
  name: string;
  uncompressedSize: number;
}

export interface CodecScanner {
  /**
   * Decompresses entries in central-directory order. Returns copies (never
   * views into wasm memory), or null when the module rejects the archive.
   */
  unzip(bytes: Uint8Array, entries: readonly CodecZipEntry[]): Map<string, Uint8Array> | null;
  /** One raw/zlib DEFLATE stream; returns a detached copy or null. */
  inflate(input: Uint8Array, outputSize: number, zlib?: boolean): Uint8Array | null;
}

let ready: CodecScanner | null = null;
let loading: Promise<CodecScanner | null> | undefined;

function createScanner(instance: WebAssembly.Instance): CodecScanner {
  const exports = instance.exports as WasmExports;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.alloc !== 'function' ||
    typeof exports.dealloc !== 'function' ||
    typeof exports.unzip !== 'function' ||
    typeof exports.inflate_stream !== 'function'
  ) {
    throw new Error('codec.wasm: unexpected exports');
  }

  const copyIn = (bytes: Uint8Array): { ptr: number; len: number } | null => {
    const ptr = exports.alloc(bytes.length);
    if (ptr === 0) return null;
    new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  };

  const release = (buffer: { ptr: number; len: number } | null): void => {
    if (!buffer) return;
    try {
      exports.dealloc(buffer.ptr, buffer.len);
    } catch {
      // A trapped instance is unusable; the caller falls back to fflate.
    }
  };

  return {
    unzip(bytes: Uint8Array, entries: readonly CodecZipEntry[]): Map<string, Uint8Array> | null {
      if (entries.length === 0 || bytes.length === 0) return null;
      const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
      if (!Number.isSafeInteger(total) || total < 0 || total > MAX_CODEC_UNCOMPRESSED) return null;
      if (total === 0) {
        return new Map(entries.map((entry) => [entry.name, new Uint8Array()]));
      }

      const input = copyIn(bytes);
      if (!input) return null;
      const outPtr = exports.alloc(total);
      if (outPtr === 0) {
        release(input);
        return null;
      }

      try {
        const count = exports.unzip(input.ptr, input.len, outPtr, total);
        if (count !== entries.length) return null;
        const memory = new Uint8Array(exports.memory.buffer);
        const parts = new Map<string, Uint8Array>();
        let offset = 0;
        for (const entry of entries) {
          const size = entry.uncompressedSize;
          if (offset + size > total) return null;
          parts.set(entry.name, memory.slice(outPtr + offset, outPtr + offset + size));
          offset += size;
        }
        return offset === total ? parts : null;
      } catch {
        return null;
      } finally {
        release(input);
        try {
          exports.dealloc(outPtr, total);
        } catch {
          // See release().
        }
      }
    },

    inflate(inputBytes: Uint8Array, outputSize: number, zlib = false): Uint8Array | null {
      if (inputBytes.length === 0 || outputSize <= 0 || outputSize > MAX_CODEC_UNCOMPRESSED) {
        return null;
      }
      const input = copyIn(inputBytes);
      if (!input) return null;
      const outPtr = exports.alloc(outputSize);
      if (outPtr === 0) {
        release(input);
        return null;
      }
      try {
        const written = exports.inflate_stream(
          input.ptr,
          input.len,
          outPtr,
          outputSize,
          zlib ? 1 : 0,
        );
        if (written === ERROR_BASE || written === ERROR_TOO_SMALL || written === ERROR_INFLATE) {
          return null;
        }
        if (written <= 0 || written > outputSize) return null;
        return new Uint8Array(exports.memory.buffer).slice(outPtr, outPtr + written);
      } catch {
        return null;
      } finally {
        release(input);
        try {
          exports.dealloc(outPtr, outputSize);
        } catch {
          // See release().
        }
      }
    },
  };
}

async function loadModule(): Promise<WebAssembly.Module | null> {
  try {
    // `?no-inline` keeps the artifact in `assets/` instead of a base64 data
    // URL; the service-worker bundle must not grow by the wasm payload and
    // Safari's background page fetches extension assets normally.
    const response = await fetch(new URL('./codec.wasm?url&no-inline', import.meta.url));
    if (!response.ok) return null;
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Starts loading the singleton. Call once from an async adapter entry point
 * before the synchronous `unzipPackage`; until then it uses fflate.
 */
export function ensureCodecScanner(): Promise<CodecScanner | null> {
  loading ??= loadModule()
    .then((module) => {
      if (!module) return null;
      try {
        ready = createScanner(new WebAssembly.Instance(module, {}));
        return ready;
      } catch {
        return null;
      }
    })
    .catch(() => null);
  return loading;
}

/** Scanner for synchronous `unzipPackage`, or null when wasm is unavailable. */
export function getCodecScanner(): CodecScanner | null {
  return ready;
}

/** Test/explicit-bytes hook. Returns null when the bytes are not a codec module. */
export async function initCodecScanner(source: BufferSource): Promise<CodecScanner | null> {
  try {
    const module = await WebAssembly.compile(source);
    ready = createScanner(new WebAssembly.Instance(module, {}));
    loading = Promise.resolve(ready);
    return ready;
  } catch {
    ready = null;
    loading = Promise.resolve(null);
    return null;
  }
}

/** Clears the singleton (tests only). */
export function resetCodecScanner(): void {
  ready = null;
  loading = undefined;
}
