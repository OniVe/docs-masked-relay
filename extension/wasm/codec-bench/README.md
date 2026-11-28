# codec-bench (benchmark-only)

P1 codec ROI crate. It is **not** linked into the extension and is not part of
`bun run build`. It exists only to compare two candidate Rust/WASM codecs with
the current JavaScript paths:

- `quick-xml` against `saxes` for XML tokenization;
- `miniz_oxide` against `fflate` for ZIP/DEFLATE and zlib streams.

The measured results and the integration decision are kept in the benchmark history.

## Build

```bash
cargo build --release --target wasm32-unknown-unknown \
  --manifest-path extension/wasm/codec-bench/Cargo.toml
```

The artifact is `target/wasm32-unknown-unknown/release/codec_bench.wasm`
(about 84 KB). `target/` is gitignored; the benchmark builds it on demand with
`cargo` and fails clearly if the Rust toolchain is unavailable.

## ABI (raw, no wasm-bindgen)

```text
alloc(len) -> ptr
dealloc(ptr, len)

xml_scan(text_ptr, text_len, out_ptr, want_hash) -> status
inflate_stream(ptr, len, out_ptr, out_cap, zlib) -> bytes_written | u32::MAX
unzip(ptr, len, out_ptr, out_cap, meta_ptr, meta_cap) -> entry_count | error
```

### `xml_scan`

Input is UTF-8. `out_ptr` receives seven little-endian `u64` values (56 bytes):

```text
starts, ends, attrs, text_events, cdata_events, utf16_units, hash
```

`hash` is FNV-1a 32 over UTF-16 code units, with markers matching the JS side;
it is zero when `want_hash` is 0. Status: `0` ok, `1` invalid UTF-8, `2`
malformed XML. Predefined and numeric character references are resolved;
custom entities are rejected (OPC forbids DTDs).

The scanner does **not** resolve namespaces or reproduce saxes' namespace
well-formedness checks. That is the main parity risk documented in the study.

### `inflate_stream`

`zlib=0` expects raw DEFLATE (ZIP entries); `zlib=1` expects a zlib wrapper
(PDF `FlateDecode`). Returns the number of bytes written, or `u32::MAX` on a
stream/size error. The output buffer must be large enough for the whole stream.

### `unzip`

Supports stored and deflated entries, reads sizes from the central directory,
and inflates every entry into `out_ptr` in central-directory order. It is a
benchmark parser: ZIP64, encryption, data descriptors without central-directory
sizes, and multi-disk archives are out of scope. The production
`inspectZip` guards must run before any future integration.

`meta_ptr` receives 16 bytes per entry:

```text
name_hash:u32, out_offset:u32, out_size:u32, method:u32
```

`name_hash` is FNV-1a 32 over the raw central-directory name bytes. Error
returns: `u32::MAX` malformed/unsupported, `u32::MAX - 1` output or metadata
too small, `u32::MAX - 2` inflate failure.

## Notes

- `thread_local!` keeps one reusable `InflateState`; wasm is single-threaded.
- `panic = "abort"`, `lto = true`, `opt-level = 3` match `wasm/pii-scan`.
- The crate is deliberately isolated from `wasm/pii-scan`; it must never ship
  unless a later task promotes it with fuzzing and product tests.
