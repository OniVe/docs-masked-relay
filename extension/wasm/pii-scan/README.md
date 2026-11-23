# pii-scan.wasm

Candidate-region scanner for the structured PII detectors. It is built for
`wasm32-unknown-unknown` as a `cdylib` with a raw C ABI and no wasm-bindgen.

## Why regions, not matches

The JavaScript detector regexes use Unicode lookarounds and are covered by a
large parity suite. Re-implementing their exact matching in Rust would duplicate
that grammar. Instead this module performs the O(n) scan and returns maximal
candidate regions per detector family. `src/core/detect/wasm-scan.ts` then runs
the unchanged JS regex on each small region with real left/right context, so
checksums, priorities, lookarounds and rule ids keep their existing semantics.

## ABI

- `alloc(len: usize) -> *mut u8`
- `dealloc(ptr: *mut u8, len: usize)`
- `scan(text_ptr, text_len, out_ptr, out_cap) -> u32`

`out_cap` is a record count; each record is 12 bytes:
`start:u32, end:u32, label:u8, _pad:u8, rule:u16` (little-endian, UTF-8 byte
offsets). Return values: record count, `0xFFFFFFFF` when `out_cap` is too small,
or `0xFFFFFFFE` when more than 250k candidates were found (caller falls back to
JS).

Region labels: 1 EMAIL, 2 URL, 3 HANDLE, 4 NUMERIC, 5 LICENSE, 6 IBAN.

## Building

```sh
rustup target add wasm32-unknown-unknown
bun run build:wasm
```

The compiled `src/core/detect/pii-scan.wasm` is committed so `bun run build`
does not require Rust. Vite emits it as
`.output/*/assets/pii-scan-*.wasm`; `wasm-unsafe-eval` is already in the MV3 CSP.
