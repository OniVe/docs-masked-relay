# P1 — WASM codecs benchmark (XML + ZIP/DEFLATE)

Status: **benchmark and ROI study only. No product code changed.**
Worktree: `perf/p1-codec`, base `e86a700` (P0 wasm scanner included).

Integration follow-up: **[`perf-p1-integration.md`](./perf-p1-integration.md)** (ZIP
integrated with fallback). XML is **accepted/documented, not integrated**:
`saxes` remains production, `quick-xml` is benchmark-only; integration requires
a namespace-parity suite, a fallback to `saxes` for anything unproven, and a
separate feature scope (round 22 decision, not a defect).

## Question

Before integrating Rust/WASM into the OOXML and XML paths, measure whether
`quick-xml` and `miniz_oxide` beat the current `saxes` / `fflate` JavaScript
paths by at least 25–30 % median without more than 20 % memory growth.

## Harness

- Rust crate: [`extension/wasm/codec-bench`](../wasm/codec-bench/README.md)
  (`quick-xml 0.38`, `miniz_oxide 0.8`; raw ABI, no wasm-bindgen).
- Bun benchmark: [`extension/tests/perf/codec-wasm.ts`](../tests/perf/codec-wasm.ts).
- Build + run:
  `cd extension && bun tests/perf/codec-wasm.ts`
  (the benchmark runs `cargo build --release --target wasm32-unknown-unknown`
  when the artifact is missing; `CODEC_BENCH_WASM` overrides the path).
- Each case runs in a fresh Bun process per implementation; both children read
  the same fixture bytes (generated once by the parent), so generated DOCX/XLSX/
  PDF metadata cannot make the two sides diverge.
- 3 timed runs, median; one warm-up run; no Playwright/Chromium.

Environment: AMD Ryzen 5 3600, 32 GB, Windows 10.0.26300, Bun 1.4.2,
Rust 1.99.0. Numbers are Bun-side; browser JIT/WASM may differ.

## Corpus

| case           | producer                                                                              | input              | decompressed / output |
| -------------- | ------------------------------------------------------------------------------------- | ------------------ | --------------------- |
| `xml-25mb`     | same shape as `tests/perf/json-xml-25mb.ts`: 4000 records, email + CDATA + attributes | 24.9 MB UTF-8      | 24.9 MB text          |
| `docx`         | `docx 9.16.0`, 4000 deterministic paragraphs                                          | 0.5 MB ZIP         | 6.2 MB, 17 entries    |
| `xlsx`         | SheetJS `xlsx 0.20.3`, 4000 rows, compression on                                      | 2.8 MB ZIP         | 6.4 MB, 10 entries    |
| `pdf-stream`   | `pdf-lib 1.17.1`, 20 000 text lines, real `/FlateDecode` streams                      | 0.7 MB, 3 streams  | 6.7 MB                |
| `inflate-25mb` | `fflate.deflateSync` level 6 over the XML corpus                                      | 0.1 MB raw DEFLATE | 24.9 MB               |

Synthetic PII only (`user<N>@example.ru`). DOCX/XLSX are produced by real
producers, not hand-written ZIPs.

## Results (median of 3)

| case              | JS path                                |                                                    WASM path |        win |                                RSS JS → WASM | wasm memory |
| ----------------- | -------------------------------------- | -----------------------------------------------------------: | ---------: | -------------------------------------------: | ----------: |
| XML parse         | `saxes` 137.8 ms                       |             `quick-xml` 21.5 ms + 1.44 ms copy = **22.9 ms** | **83.4 %** | 159.6 → 169.4 MB / 160.5 → 171.4 MB (+1.2 %) |     25.9 MB |
| DOCX unzip        | `fflate.unzipSync` + copy-out 81.1 ms  |  `miniz_oxide` unzip 9.5 ms + 0.87 ms copy-out = **10.3 ms** | **87.3 %** |       73.7 → 98.8 / 73.4 → 107.6 MB (+8.9 %) |      7.9 MB |
| XLSX unzip        | `fflate.unzipSync` + copy-out 124.8 ms | `miniz_oxide` unzip 29.3 ms + 1.00 ms copy-out = **30.3 ms** | **75.8 %** |      77.3 → 112.9 / 76.2 → 113.0 MB (+0.1 %) |     10.4 MB |
| PDF zlib streams  | `fflate.unzlibSync` 104.3 ms           |                                `miniz_oxide` inflate 13.4 ms | **87.2 %** |      86.7 → 114.9 / 87.1 → 99.2 MB (−13.7 %) |      7.9 MB |
| raw inflate 25 MB | `fflate.inflateSync` 287.9 ms          |                                 `miniz_oxide` inflate 9.3 ms | **96.8 %** |   129.9 → 336.6 / 108.6 → 124.0 MB (−63.2 %) |     26.1 MB |

The JS ZIP timings include the same per-entry copy that production
`unzipPackage` performs (`new Uint8Array(data)`); otherwise the comparison
would favour fflate. The WASM ZIP timings include copying compressed input in
and decompressed entries out. XML WASM includes one input copy per file.

Memory caveat: RSS is process-wide and noisy; the `wasm memory` column is the
deterministic `WebAssembly.Memory` high-water mark. The WASM instance adds a
one-time module/JIT cost; the per-file incremental cost is the input copy plus
the output buffer (for ZIP, also the JS copy-out). All cases stayed below the
20 % gate in the final run; DOCX was the highest at +8.9 %.

## Correctness gates

All gates passed (`identity ... ok` in the log):

- XML: identical counters `starts=9334`, `attrs=5334`, `texts=8002`,
  `cdata=1333`, `units=25 823 251`, FNV-1a hash `1 190 947 273`.
- DOCX: 17 entries, 6.2 MB; per-entry name hash, size and content hash match.
- XLSX: 10 entries, 6.4 MB; same per-entry checks.
- PDF: 3 streams, 6.7 MB; concatenated decompressed bytes hash equal.
- Raw inflate: 24.9 MB; output hash equal.

## Decision

Benchmark: **GO for XML and GO for ZIP/DEFLATE**, with the integration risks
below. Every measured case clears the 25–30 % CPU gate by a wide margin; memory
stays at or below the 20 % gate in this run.

Production (round 22): **ZIP/DEFLATE integrated**; **XML not integrated**.
`quick-xml` is benchmark-only. The measured win is not sufficient to accept the
namespace-parity risk: `saxes` runs with `xmlns: true`, and a `quick-xml`
fast-accept path must first pass a parity suite (undeclared prefixes, duplicate
expanded names, UTF-16/BOM, DTD/entity handling, malformed tags) plus a
`saxes` fallback and its own feature scope. This is accepted/documented, not an
r22 defect.

### XML integration point

- `extension/src/core/ooxml/xml.ts` — `validateXmlText()` (line ~731) is the
  only `saxes` consumer. `validateXml()` (line ~743) calls `scanXml()` and then
  `validateXmlText()`.
- Call sites: `extension/src/core/formats/xml.ts` `scanAndValidate()` (~1108)
  and masked-output validation (~1164); `extension/src/core/ooxml/package.ts`
  (~620) validates every decoded OOXML part.
- Proposed shape: keep the existing `scanXml()` offset scanner and replace
  only the well-formedness check with `xml_scan` from WASM. Pass UTF-8 bytes
  (`encodeTextBytes(text, 'utf-8')` or the original `file.bytes` when the
  source is UTF-8); keep `assertValidXmlChars` in JS.
- The WASM validator must return a status plus byte offset so `XmlError` can
  keep a useful message. For UTF-16LE/BE sources, either transcode first or
  keep the `saxes` path; that choice is not covered by this benchmark.

**XML risks**

1. **Namespace parity.** `saxes` runs with `xmlns: true`; `quick-xml` in this
   benchmark does not resolve namespaces. Undeclared prefixes, duplicate
   expanded names and namespace-scope errors must be tested against saxes
   before shipping. If quick-xml cannot match saxes exactly, use it only as a
   fast accept path and keep saxes for rejects (this loses part of the win).
2. **Encoding.** The crate takes UTF-8; UTF-16 OOXML parts need transcoding or
   a separate decoder. The benchmark only covers UTF-8.
3. **Entity semantics.** Predefined and numeric character references are
   resolved; custom entities are rejected (OPC forbids DTDs). Error text and
   offsets will differ from saxes.
4. **Bun vs browser.** Re-measure in the extension's Chrome/Safari runtime
   before committing to the numbers.

### ZIP integration point

- `extension/src/core/ooxml/zip.ts` — `unzipPackage()` (~340) is the only
  `unzipSync` call. `inspectZip()` (~182) already validates the central
  directory, rejects encrypted/ZIP64/duplicate/oversize entries and exposes
  `entries` and `totalUncompressedSize`.
- Proposed shape: after `inspectZip()`, allocate one WASM output buffer of
  `inspection.totalUncompressedSize`, call `unzip`, copy each entry into the
  `Map`, then run the existing size + `crc32` checks. Keep `zipSync()` on
  fflate; re-compression was not benchmarked and is not part of this win.
- The ZIP parser here is deliberately benchmark-scoped: stored/deflated entries,
  central-directory sizes, no ZIP64/encryption. Production must rely on the
  existing `inspectZip` guards and must add a fallback for anything the WASM
  parser does not support.
- `unzipPackage()` is synchronous. The WASM module must be instantiated ahead
  of time (the existing `wasm-scan.ts` pattern is async), or the call must
  become async. That API change is the largest integration cost.

**ZIP risks**

1. **ZIP64 / data descriptors / encryption.** Current guards reject ZIP64 and
   encryption before decompression; keep that ordering. Data-descriptor entries
   need a parity test (the parser uses central-directory sizes).
2. **Memory cap.** `DEFAULT_ZIP_LIMITS.maxUncompressedBytes` is 512 MB, beyond
   comfortable wasm32 handling. Add a WASM-specific cap (or fall back to
   fflate above it) before allocating the output buffer.
3. **Ownership.** Returned `Uint8Array`s must not alias WASM memory after the
   next call/memory growth. Copy-out is measured and cheap (~0.9–1.0 ms), but
   it must be explicit.
4. **Bundle/startup.** Artifact is ~84 KB; production needs a committed artifact
   or a build step, and the module must be compiled/instantiated once.
5. **Robustness.** The Rust parser is benchmark code, not fuzzed. It needs
   malformed-archive tests and a `panic = "abort"` trap strategy before it sees
   untrusted uploads.

### PDF

The product PDF adapter uses EmbedPDF/PDFium
(`extension/src/core/formats/pdf.ts`), not `fflate`. The PDF row here measures
zlib stream throughput only; there is **no direct integration point today**.
It is useful evidence if a future PDF path exposes raw `FlateDecode` streams,
but no change is proposed.

## Non-goals / guardrails

- No product code, audit reports or state files were changed.
- The crate is not imported by `bun run build`; `wasm/pii-scan` is untouched.
- `target/` stays gitignored; the benchmark builds on demand.
- Playwright/Chromium was not run (per P1 constraints).

## Reproduce

```bash
cd extension
bun tests/perf/codec-wasm.ts
# focused:
BENCH_ONLY=xml BENCH_RUNS=3 bun tests/perf/codec-wasm.ts
BENCH_ONLY=docx,xlsx BENCH_RECORDS=4000 bun tests/perf/codec-wasm.ts
```

The final run log is the source of the table above; reruns can move medians by
a few percent and change the generated DOCX/XLSX/PDF metadata hashes, while the
JS/WASM identity check stays exact within a run.
