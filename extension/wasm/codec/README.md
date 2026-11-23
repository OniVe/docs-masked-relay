# codec (production)

ZIP/DEFLATE codec used by `src/core/ooxml/zip.ts` for OPC packages. It is
compiled to `src/core/ooxml/codec.wasm` and committed; `bun run build` does not
need a Rust toolchain.

## XML: `quick-xml` is benchmark-only

`quick-xml` is used only by the separate `wasm/codec-bench` crate. It is not a
dependency of this production crate and is not imported by `bun run build`.
Production XML validation stays on `saxes` (`xmlns: true`). Integrating
`quick-xml` requires an `NsReader` namespace-parity suite against `saxes`
(undeclared prefixes, duplicate expanded names, UTF-16/BOM, DTD/entity
handling, malformed tags), a `saxes` fallback for anything unproven, and a
separate feature scope. Accepted/documented in round 22; not a defect.

```bash
cargo build --release --target wasm32-unknown-unknown \
  --manifest-path extension/wasm/codec/Cargo.toml
```

`bun run build:wasm` builds both this crate and `wasm/pii-scan` and copies the
artifacts into `src/`.

## ABI (raw, no wasm-bindgen)

```text
alloc(len) -> ptr
dealloc(ptr, len)
unzip(ptr, len, out_ptr, out_cap) -> entry_count | error
inflate(ptr, len, out_ptr, out_cap, zlib) -> bytes_written | error
```

`unzip` writes every entry consecutively in central-directory order. The JS
caller already ran `inspectZip` and knows each entry's uncompressed size, so it
copies the slices out and validates size + CRC. The wasm parser supports stored
and deflated entries, rejects ZIP64/encryption, and never decides package
policy.

Error returns: `u32::MAX` malformed/unsupported, `u32::MAX - 1` output too
small, `u32::MAX - 2` inflate failure. Any error makes `zip.ts` retry with
`fflate`; no partial result is returned.

## Fallback policy

The codec is used only when all of these hold:

- the lazy loader fetched/compiled the artifact;
- `inspectZip` accepted the archive;
- total uncompressed size is at most 128 MiB;
- no entry uses a data descriptor (central flag bit 3);
- non-ASCII names carry the UTF-8 flag;
- every entry is method 0/8 with a plausible compressed size.

Otherwise, or on any trap/size/CRC mismatch, `unzipPackage` uses `fflate` with
the existing errors. `zipSync`/re-compression stays on `fflate`.

The crate is intentionally small and side-effect free. It switches to
`panic = "abort"` so a malformed input becomes a wasm trap that the JS wrapper
catches; malformed archives should still be rejected by `inspectZip` first.
