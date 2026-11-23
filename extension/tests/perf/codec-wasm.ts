/**
 * P1 codec ROI benchmark: current JS codecs vs benchmark-only Rust/WASM.
 *
 * Bun-only: `bun tests/perf/codec-wasm.ts`.
 * Env knobs:
 *   BENCH_RUNS=3          timed runs per implementation (median reported)
 *   BENCH_RECORDS=4000    XML/DOCX/XLSX synthetic record count
 *   BENCH_TARGET_MB=25    XML and raw-deflate payload target
 *   BENCH_ONLY=xml,docx   comma-separated case filter
 *   CODEC_BENCH_WASM=...  explicit path to codec_bench.wasm
 *   CODEC_BENCH_REBUILD=1 force `cargo build` before the run
 *
 * Each case runs in a fresh Bun process per implementation, so RSS numbers
 * describe one codec rather than garbage left by the previous one. The wasm
 * artifact is built on demand from `wasm/codec-bench` (benchmark-only crate).
 *
 * Nothing here is production code: the benchmark compares
 *   - saxes vs quick-xml for a 25 MB XML document,
 *   - fflate unzipSync vs miniz_oxide for real DOCX/XLSX packages,
 *   - fflate unzlibSync vs miniz_oxide for real PDF FlateDecode streams,
 *   - fflate inflateSync vs miniz_oxide for one 25 MB raw DEFLATE stream.
 *
 * Correctness gates (counts/hash and decompressed bytes) must match before any
 * timing is reported.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { deflateSync, inflateSync, unzipSync, unzlibSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SaxesParser } from 'saxes';
import * as XLSX from 'xlsx';

const RUNS = Math.max(1, Number(process.env.BENCH_RUNS ?? 3));
const RECORDS = Math.max(1, Number(process.env.BENCH_RECORDS ?? 4000));
const TARGET_MB = Number(process.env.BENCH_TARGET_MB ?? 25);
const TARGET_BYTES = Math.round(TARGET_MB * 1024 * 1024) - 4096;
const ONLY = process.env.BENCH_ONLY?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const CASE = process.env.BENCH_CASE;
const IMPL = process.env.BENCH_IMPL;
const FIXTURE_DIR = process.env.BENCH_FIXTURE_DIR;

const MB = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FILLER = Array.from(
  { length: 40 },
  () =>
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
    'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis ' +
    'nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat ',
).join('');

const WORDS =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(
    ' ',
  );

// ---------------------------------------------------------------------------
// Input generation (deterministic, synthetic PII only)
// ---------------------------------------------------------------------------

/** Same 4000-record / email+CDATA+attrs shape as tests/perf/json-xml-25mb.ts. */
function makeXml(records: number, targetBytes: number): string {
  const fillerLength = Math.max(16, Math.floor(targetBytes / records) - 110);
  const filler = FILLER.repeat(Math.ceil(fillerLength / FILLER.length)).slice(0, fillerLength);
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n<data>\n'];
  for (let index = 1; index <= records; index += 1) {
    const email = `user${index}@example.ru`;
    const kind = index % 3;
    if (kind === 0) {
      parts.push(`<record id="${index}"><email>${email}</email><note>${filler}</note></record>\n`);
    } else if (kind === 1) {
      parts.push(`<record id="${index}" contact="${email}"><note>${filler}</note></record>\n`);
    } else {
      parts.push(`<record id="${index}"><note><![CDATA[${email} ${filler}]]></note></record>\n`);
    }
  }
  parts.push('</data>');
  return parts.join('');
}

/** Deterministic pseudo-random prose so DEFLATE cannot collapse the payload. */
function prose(seed: number, words: number): string {
  let state = seed >>> 0;
  const out: string[] = [];
  for (let index = 0; index < words; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    out.push(WORDS[state % WORDS.length] ?? 'lorem');
  }
  return out.join(' ');
}

/** Builds a real OOXML DOCX with the `docx` package. */
async function makeDocx(records: number): Promise<Uint8Array> {
  const paragraphs: Paragraph[] = [];
  for (let index = 1; index <= records; index += 1) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: `user${index}@example.ru ${prose(index, 300)}` })],
      }),
    );
  }
  const document = new Document({ sections: [{ properties: {}, children: paragraphs }] });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** Builds a real OOXML XLSX with SheetJS (compression on). */
function makeXlsx(records: number): Uint8Array {
  const rows: unknown[][] = [['id', 'email', 'note']];
  for (let index = 1; index <= records; index += 1) {
    rows.push([index, `user${index}@example.ru`, prose(index + 999, 300)]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Data');
  const out = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  }) as Uint8Array;
  return new Uint8Array(out);
}

const PDF_LINES = 20_000;

/** Builds a real PDF with pdf-lib; its content streams are FlateDecode/zlib. */
async function makePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < PDF_LINES; index += 1) {
    page.drawText(`line ${index} user${index}@example.ru ${prose(index + 7, 18)}`, {
      x: 20,
      y: 780 - (index % 60) * 12,
      size: 8,
      font,
    });
  }
  return new Uint8Array(await document.save());
}

function fixture(name: string): Uint8Array {
  if (!FIXTURE_DIR) {
    throw new Error('BENCH_FIXTURE_DIR is required in child mode; run the parent benchmark');
  }
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

/** Extracts `/Filter /FlateDecode` stream payloads using byte-preserving latin1. */
function pdfFlateStreams(pdf: Uint8Array): Uint8Array[] {
  const source = Buffer.from(pdf).toString('latin1');
  const streams: Uint8Array[] = [];
  const dictionary = /<<([\s\S]{0,4096}?)>>\s*stream\r?\n/g;
  let match = dictionary.exec(source);
  while (match) {
    const body = match[1] ?? '';
    const length = /\/Length\s+(\d+)/.exec(body);
    if (body.includes('/FlateDecode') && length) {
      const start = match.index + match[0].length;
      const end = start + Number(length[1]);
      streams.push(pdf.subarray(start, end));
    }
    match = dictionary.exec(source);
  }
  if (streams.length === 0) throw new Error('PDF fixture has no FlateDecode streams');
  return streams;
}

// ---------------------------------------------------------------------------
// Hashing (FNV-1a 32; same algorithm on both sides)
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x0100_0193;

function hashStep(hash: number, value: number): number {
  return Math.imul(hash ^ value, FNV_PRIME) >>> 0;
}

function hashBytes(bytes: Uint8Array, hash = FNV_OFFSET): number {
  let state = hash;
  for (let index = 0; index < bytes.length; index += 1) {
    state = Math.imul(state ^ (bytes[index] ?? 0), FNV_PRIME) >>> 0;
  }
  return state;
}

function combineEntryDigests(items: EntryDigest[]): number {
  const sorted = [...items].sort((left, right) => left.nameHash - right.nameHash);
  let hash = FNV_OFFSET;
  for (const item of sorted) {
    hash = hashStep(hash, item.nameHash);
    hash = hashStep(hash, item.size);
    hash = hashStep(hash, item.contentHash);
  }
  return hash;
}

interface EntryDigest {
  nameHash: number;
  size: number;
  contentHash: number;
}

// ---------------------------------------------------------------------------
// WASM ABI (see wasm/codec-bench/src/lib.rs)
// ---------------------------------------------------------------------------

interface CodecWasm extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  xml_scan(ptr: number, len: number, outPtr: number, wantHash: number): number;
  inflate_stream(ptr: number, len: number, outPtr: number, outCap: number, zlib: number): number;
  unzip(
    ptr: number,
    len: number,
    outPtr: number,
    outCap: number,
    metaPtr: number,
    metaCap: number,
  ): number;
}

const HERE = dirname(fileURLToPath(import.meta.url));

function crateRoot(): string {
  return join(HERE, '..', '..', 'wasm', 'codec-bench');
}

function wasmPath(): string {
  if (process.env.CODEC_BENCH_WASM) return process.env.CODEC_BENCH_WASM;
  return join(crateRoot(), 'target', 'wasm32-unknown-unknown', 'release', 'codec_bench.wasm');
}

function ensureWasm(): string {
  const path = wasmPath();
  if (existsSync(path) && process.env.CODEC_BENCH_REBUILD !== '1') return path;
  console.log('[bench] building wasm/codec-bench (cargo build --release)');
  const result = spawnSync(
    'cargo',
    [
      'build',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--manifest-path',
      join(crateRoot(), 'Cargo.toml'),
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`cargo build failed with status ${result.status}`);
  if (!existsSync(path)) throw new Error(`wasm artifact not found: ${path}`);
  return path;
}

async function loadCodec(): Promise<CodecWasm> {
  const bytes = readFileSync(ensureWasm());
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as CodecWasm;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.alloc !== 'function' ||
    typeof exports.xml_scan !== 'function' ||
    typeof exports.inflate_stream !== 'function' ||
    typeof exports.unzip !== 'function'
  ) {
    throw new Error('codec_bench.wasm: unexpected exports');
  }
  return exports;
}

function allocBytes(wasm: CodecWasm, length: number): number {
  const ptr = wasm.alloc(length);
  if (ptr === 0) throw new Error(`wasm alloc(${length}) failed`);
  return ptr;
}

interface XmlCounts {
  starts: number;
  ends: number;
  attrs: number;
  texts: number;
  cdatas: number;
  units: number;
  hash: number;
}

function readXmlCounts(wasm: CodecWasm, ptr: number): XmlCounts {
  const view = new DataView(wasm.memory.buffer, ptr, 56);
  return {
    starts: Number(view.getBigUint64(0, true)),
    ends: Number(view.getBigUint64(8, true)),
    attrs: Number(view.getBigUint64(16, true)),
    texts: Number(view.getBigUint64(24, true)),
    cdatas: Number(view.getBigUint64(32, true)),
    units: Number(view.getBigUint64(40, true)),
    hash: Number(view.getBigUint64(48, true)) >>> 0,
  };
}

// ---------------------------------------------------------------------------
// saxes parse (current JS path)
// ---------------------------------------------------------------------------

function saxesParse(text: string, withHash: boolean): XmlCounts {
  let starts = 0;
  let ends = 0;
  let attrs = 0;
  let texts = 0;
  let cdatas = 0;
  let units = 0;
  let hash = FNV_OFFSET;
  const add = (value: number): void => {
    if (withHash) hash = hashStep(hash, value);
  };
  const addString = (value: string): void => {
    if (!withHash) return;
    for (let index = 0; index < value.length; index += 1) {
      hash = hashStep(hash, value.charCodeAt(index));
    }
  };

  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on('opentag', (tag) => {
    starts += 1;
    add(1);
    addString(tag.name);
    const entries = Object.entries(tag.attributes).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    attrs += entries.length;
    for (const [key, attribute] of entries) {
      add(2);
      addString(key);
      add(3);
      addString(typeof attribute === 'string' ? attribute : attribute.value);
    }
  });
  parser.on('closetag', (tag) => {
    ends += 1;
    add(4);
    addString(tag.name);
  });
  parser.on('text', (value) => {
    texts += 1;
    units += value.length;
    add(5);
    addString(value);
  });
  parser.on('cdata', (value) => {
    cdatas += 1;
    units += value.length;
    add(6);
    addString(value);
  });
  parser.write(text).close();
  return { starts, ends, attrs, texts, cdatas, units, hash };
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function timeRuns(fn: () => unknown): number[] {
  fn(); // warm-up, not reported
  const runs: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const started = performance.now();
    fn();
    runs.push(performance.now() - started);
  }
  return runs;
}

function gc(): void {
  const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun;
  bun?.gc?.(true);
}

function rssMb(): number {
  return Math.round((process.memoryUsage().rss / MB) * 10) / 10;
}

interface BenchResult {
  case: string;
  impl: 'js' | 'wasm';
  runs: number[];
  medianMs: number;
  rssBeforeMb: number;
  rssMb: number;
  rssCleanMb: number;
  wasmMb: number;
  inputBytes: number;
  outputBytes: number;
  entries?: number;
  streams?: number;
  counts?: XmlCounts;
  contentHash?: number;
  copyMs?: number;
  copyOutMs?: number;
}

function resultOf(
  caseName: string,
  impl: 'js' | 'wasm',
  runs: number[],
  extra: Omit<BenchResult, 'case' | 'impl' | 'runs' | 'medianMs'>,
): BenchResult {
  return {
    case: caseName,
    impl,
    runs,
    medianMs: Math.round(median(runs) * 100) / 100,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function runXml(impl: 'js' | 'wasm'): Promise<BenchResult> {
  const caseName = 'xml-25mb';
  const bytes = fixture('xml.bin');
  const text = decoder.decode(bytes);

  let runs: number[];
  let verified: XmlCounts;
  let wasm: CodecWasm | undefined;
  let inputPtr = 0;
  let outPtr = 0;
  let copyRuns: number[] | undefined;

  gc();
  const before = rssMb();
  if (impl === 'js') {
    runs = timeRuns(() => saxesParse(text, false));
    verified = saxesParse(text, true);
  } else {
    wasm = await loadCodec();
    inputPtr = allocBytes(wasm, bytes.length);
    outPtr = allocBytes(wasm, 56);
    copyTo(wasm, inputPtr, bytes);
    runs = timeRuns(() => {
      const status = wasm?.xml_scan(inputPtr, bytes.length, outPtr, 0) ?? 1;
      if (status !== 0) throw new Error(`xml_scan status ${status}`);
    });
    const status = wasm.xml_scan(inputPtr, bytes.length, outPtr, 1);
    if (status !== 0) throw new Error(`xml_scan verify status ${status}`);
    verified = readXmlCounts(wasm, outPtr);
    copyRuns = timeRuns(() => copyTo(wasm as CodecWasm, inputPtr, bytes));
  }

  gc();
  const after = rssMb();
  if (wasm) {
    wasm.dealloc(inputPtr, bytes.length);
    wasm.dealloc(outPtr, 56);
  }
  gc();
  const clean = rssMb();
  return resultOf(caseName, impl, runs, {
    rssBeforeMb: before,
    rssMb: after,
    rssCleanMb: clean,
    wasmMb: wasm ? Math.round((wasm.memory.buffer.byteLength / MB) * 10) / 10 : 0,
    inputBytes: bytes.length,
    outputBytes: bytes.length,
    counts: verified,
    copyMs: copyRuns ? Math.round(median(copyRuns) * 100) / 100 : undefined,
  });
}

function copyTo(wasm: CodecWasm, ptr: number, bytes: Uint8Array): void {
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
}

async function runZip(impl: 'js' | 'wasm', format: 'docx' | 'xlsx'): Promise<BenchResult> {
  const caseName = format;
  const bytes = fixture(`${format}.bin`);
  const reference = unzipSync(bytes);
  const names = Object.keys(reference);
  const total = names.reduce((sum, name) => sum + (reference[name]?.length ?? 0), 0);

  const jsDigest = (): number =>
    combineEntryDigests(
      names.map((name) => {
        const data = reference[name] ?? new Uint8Array();
        return {
          nameHash: hashBytes(encoder.encode(name)),
          size: data.length,
          contentHash: hashBytes(data),
        };
      }),
    );

  gc();
  const before = rssMb();
  let runs: number[];
  let contentHash: number;
  let wasm: CodecWasm | undefined;
  let inputPtr = 0;
  let outPtr = 0;
  let metaPtr = 0;
  let copyOutRuns: number[] | undefined;
  let entryCount = names.length;

  if (impl === 'js') {
    runs = timeRuns(() => {
      const entries = unzipSync(bytes);
      let sum = 0;
      // The production `unzipPackage` copies every entry so callers cannot
      // mutate the decompressor's buffers; include the same work here.
      for (const data of Object.values(entries)) sum += new Uint8Array(data).length;
      return sum;
    });
    contentHash = jsDigest();
  } else {
    wasm = await loadCodec();
    inputPtr = allocBytes(wasm, bytes.length);
    outPtr = allocBytes(wasm, Math.max(1, total));
    metaPtr = allocBytes(wasm, Math.max(16, names.length * 16));
    copyTo(wasm, inputPtr, bytes);
    const call = (): number => {
      const count = wasm?.unzip(inputPtr, bytes.length, outPtr, total, metaPtr, names.length) ?? 0;
      if (count !== names.length)
        throw new Error(`unzip returned ${count}, expected ${names.length}`);
      return count;
    };
    runs = timeRuns(call);
    entryCount = call();
    copyOutRuns = timeRuns(() => {
      let sum = 0;
      for (let index = 0; index < entryCount; index += 1) {
        const view = new DataView(
          wasm?.memory.buffer ?? new ArrayBuffer(0),
          metaPtr + index * 16,
          16,
        );
        const offset = view.getUint32(4, true);
        const size = view.getUint32(8, true);
        sum += new Uint8Array(
          wasm?.memory.buffer ?? new ArrayBuffer(0),
          outPtr + offset,
          size,
        ).slice().length;
      }
      return sum;
    });
    contentHash = wasmZipDigest(wasm, metaPtr, outPtr, entryCount);
  }

  gc();
  const after = rssMb();
  if (wasm) {
    wasm.dealloc(inputPtr, bytes.length);
    wasm.dealloc(outPtr, Math.max(1, total));
    wasm.dealloc(metaPtr, Math.max(16, names.length * 16));
  }
  gc();
  const clean = rssMb();
  return resultOf(caseName, impl, runs, {
    rssBeforeMb: before,
    rssMb: after,
    rssCleanMb: clean,
    wasmMb: wasm ? Math.round((wasm.memory.buffer.byteLength / MB) * 10) / 10 : 0,
    inputBytes: bytes.length,
    outputBytes: total,
    entries: entryCount,
    contentHash,
    copyOutMs: copyOutRuns ? Math.round(median(copyOutRuns) * 100) / 100 : undefined,
  });
}

function wasmZipDigest(wasm: CodecWasm, metaPtr: number, outPtr: number, count: number): number {
  const items: EntryDigest[] = [];
  for (let index = 0; index < count; index += 1) {
    const view = new DataView(wasm.memory.buffer, metaPtr + index * 16, 16);
    const nameHash = view.getUint32(0, true);
    const offset = view.getUint32(4, true);
    const size = view.getUint32(8, true);
    const data = new Uint8Array(wasm.memory.buffer, outPtr + offset, size);
    items.push({ nameHash, size, contentHash: hashBytes(data) });
  }
  return combineEntryDigests(items);
}

async function runPdf(impl: 'js' | 'wasm'): Promise<BenchResult> {
  const caseName = 'pdf-stream';
  const streams = pdfFlateStreams(fixture('pdf.bin'));
  const expected = streams.map((stream) => unzlibSync(stream));
  const total = expected.reduce((sum, data) => sum + data.length, 0);

  gc();
  const before = rssMb();
  let runs: number[];
  let contentHash: number;
  let wasm: CodecWasm | undefined;
  let inputPtr = 0;
  let outPtr = 0;
  const maxCompressed = Math.max(...streams.map((stream) => stream.length));
  const maxOut = Math.max(...expected.map((data) => data.length));

  if (impl === 'js') {
    runs = timeRuns(() => {
      let sum = 0;
      for (const stream of streams) sum += unzlibSync(stream).length;
      return sum;
    });
    contentHash = FNV_OFFSET;
    for (const data of expected) {
      for (let index = 0; index < data.length; index += 1) {
        contentHash = Math.imul(contentHash ^ (data[index] ?? 0), FNV_PRIME) >>> 0;
      }
    }
  } else {
    wasm = await loadCodec();
    inputPtr = allocBytes(wasm, maxCompressed);
    outPtr = allocBytes(wasm, maxOut);
    runs = timeRuns(() => {
      let sum = 0;
      for (const stream of streams) {
        copyTo(wasm as CodecWasm, inputPtr, stream);
        const written =
          wasm?.inflate_stream(inputPtr, stream.length, outPtr, maxOut, 1) ?? 0xffffffff;
        if (written === 0xffffffff) throw new Error('inflate_stream failed');
        sum += written;
      }
      return sum;
    });
    contentHash = FNV_OFFSET;
    for (const stream of streams) {
      copyTo(wasm, inputPtr, stream);
      const written = wasm.inflate_stream(inputPtr, stream.length, outPtr, maxOut, 1);
      if (written === 0xffffffff) throw new Error('inflate_stream verify failed');
      const data = new Uint8Array(wasm.memory.buffer, outPtr, written);
      contentHash = hashBytes(data, contentHash);
    }
  }

  gc();
  const after = rssMb();
  if (wasm) {
    wasm.dealloc(inputPtr, maxCompressed);
    wasm.dealloc(outPtr, maxOut);
  }
  gc();
  const clean = rssMb();
  return resultOf(caseName, impl, runs, {
    rssBeforeMb: before,
    rssMb: after,
    rssCleanMb: clean,
    wasmMb: wasm ? Math.round((wasm.memory.buffer.byteLength / MB) * 10) / 10 : 0,
    inputBytes: streams.reduce((sum, stream) => sum + stream.length, 0),
    outputBytes: total,
    streams: streams.length,
    contentHash,
  });
}

async function runInflate(impl: 'js' | 'wasm'): Promise<BenchResult> {
  const caseName = 'inflate-25mb';
  const raw = fixture('raw.bin');
  const compressed = fixture('raw.deflate');

  gc();
  const before = rssMb();
  let runs: number[];
  let contentHash: number;
  let wasm: CodecWasm | undefined;
  let inputPtr = 0;
  let outPtr = 0;

  if (impl === 'js') {
    runs = timeRuns(() => inflateSync(compressed).length);
    contentHash = hashBytes(inflateSync(compressed));
  } else {
    wasm = await loadCodec();
    inputPtr = allocBytes(wasm, compressed.length);
    outPtr = allocBytes(wasm, raw.length);
    copyTo(wasm, inputPtr, compressed);
    runs = timeRuns(() => {
      copyTo(wasm as CodecWasm, inputPtr, compressed);
      const written =
        wasm?.inflate_stream(inputPtr, compressed.length, outPtr, raw.length, 0) ?? 0xffffffff;
      if (written !== raw.length)
        throw new Error(`inflate wrote ${written}, expected ${raw.length}`);
      return written;
    });
    copyTo(wasm, inputPtr, compressed);
    const written = wasm.inflate_stream(inputPtr, compressed.length, outPtr, raw.length, 0);
    if (written !== raw.length) throw new Error('inflate verify failed');
    contentHash = hashBytes(new Uint8Array(wasm.memory.buffer, outPtr, raw.length));
  }

  gc();
  const after = rssMb();
  if (wasm) {
    wasm.dealloc(inputPtr, compressed.length);
    wasm.dealloc(outPtr, raw.length);
  }
  gc();
  const clean = rssMb();
  return resultOf(caseName, impl, runs, {
    rssBeforeMb: before,
    rssMb: after,
    rssCleanMb: clean,
    wasmMb: wasm ? Math.round((wasm.memory.buffer.byteLength / MB) * 10) / 10 : 0,
    inputBytes: compressed.length,
    outputBytes: raw.length,
    contentHash,
  });
}

// ---------------------------------------------------------------------------
// Child / parent orchestration
// ---------------------------------------------------------------------------

const CASES = ['xml', 'docx', 'xlsx', 'pdf', 'inflate'] as const;

async function runChild(caseName: string, impl: 'js' | 'wasm'): Promise<BenchResult> {
  if (caseName === 'xml') return runXml(impl);
  if (caseName === 'docx' || caseName === 'xlsx') return runZip(impl, caseName);
  if (caseName === 'pdf') return runPdf(impl);
  if (caseName === 'inflate') return runInflate(impl);
  throw new Error(`unknown case ${caseName}`);
}

function spawnChild(caseName: string, impl: 'js' | 'wasm', directory: string): BenchResult {
  const script = process.argv[1];
  if (!script) throw new Error('cannot locate benchmark entrypoint');
  const child = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      BENCH_CASE: caseName,
      BENCH_IMPL: impl,
      BENCH_FIXTURE_DIR: directory,
    },
    encoding: 'utf8',
    maxBuffer: 16 * MB,
  });
  if (child.status !== 0) {
    process.stderr.write(child.stdout ?? '');
    process.stderr.write(child.stderr ?? '');
    throw new Error(`${caseName}/${impl} child exited with ${child.status}`);
  }
  const line = (child.stdout ?? '')
    .split(/\r?\n/u)
    .find((value) => value.startsWith('[bench-result] '));
  if (!line) throw new Error(`${caseName}/${impl} child printed no result`);
  return JSON.parse(line.slice('[bench-result] '.length)) as BenchResult;
}

function fmt(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function mb(value: number): string {
  return fmt(value / MB);
}

function printResult(result: BenchResult): void {
  const label = result.impl === 'js' ? 'js    ' : 'wasm  ';
  const extra = result.counts
    ? `in=${mb(result.inputBytes)}MB out=${mb(result.outputBytes)}MB ` +
      `starts=${result.counts.starts} attrs=${result.counts.attrs} texts=${result.counts.texts} ` +
      `cdata=${result.counts.cdatas} units=${result.counts.units} hash=${result.counts.hash}`
    : `in=${mb(result.inputBytes)}MB out=${mb(result.outputBytes)}MB ` +
      `entries=${result.entries ?? '-'} streams=${result.streams ?? '-'} hash=${result.contentHash ?? '-'}`;
  console.log(
    `[bench]   ${label} median=${fmt(result.medianMs)}ms runs=[${result.runs.map((run) => fmt(run)).join(', ')}] ` +
      `rss=${fmt(result.rssBeforeMb)}->${fmt(result.rssMb)}->${fmt(result.rssCleanMb)}MB ` +
      `(delta=${fmt(result.rssMb - result.rssBeforeMb)}) wasm=${fmt(result.wasmMb)}MB ` +
      `copy=${fmt(result.copyMs ?? 0, 2)}ms copyOut=${fmt(result.copyOutMs ?? 0, 2)}ms ${extra}`,
  );
}

function decision(caseResults: Map<string, { js: BenchResult; wasm: BenchResult }>): string[] {
  const lines: string[] = [];
  const check = (
    name: string,
    js: BenchResult,
    wasm: BenchResult,
    copies: { copyIn?: boolean; copyOut?: boolean } = {},
  ): void => {
    const wasmTotal =
      wasm.medianMs +
      (copies.copyIn ? (wasm.copyMs ?? 0) : 0) +
      (copies.copyOut ? (wasm.copyOutMs ?? 0) : 0);
    const win = ((js.medianMs - wasmTotal) / js.medianMs) * 100;
    const memory = ((wasm.rssMb - js.rssMb) / js.rssMb) * 100;
    const jsDelta = js.rssMb - js.rssBeforeMb;
    const wasmDelta = wasm.rssMb - wasm.rssBeforeMb;
    const verdict = win >= 25 && memory <= 20 ? 'GO' : 'no-go';
    lines.push(
      `${name}: js=${fmt(js.medianMs)}ms wasm=${fmt(wasmTotal)}ms win=${fmt(win)}% ` +
        `rss=${fmt(js.rssBeforeMb)}->${fmt(js.rssMb)}/${fmt(wasm.rssBeforeMb)}->${fmt(wasm.rssMb)}MB ` +
        `(abs ${fmt(memory)}%, delta ${fmt(jsDelta)}/${fmt(wasmDelta)}MB) -> ${verdict}`,
    );
  };

  const xml = caseResults.get('xml');
  if (xml) check('xml parse', xml.js, xml.wasm, { copyIn: true });
  for (const name of ['docx', 'xlsx']) {
    const zip = caseResults.get(name);
    if (zip) check(`${name} unzip`, zip.js, zip.wasm, { copyOut: true });
  }
  const pdf = caseResults.get('pdf');
  if (pdf) check('pdf inflate', pdf.js, pdf.wasm);
  const inflate = caseResults.get('inflate');
  if (inflate) check('raw inflate', inflate.js, inflate.wasm, { copyIn: true });
  return lines;
}

/** Builds every selected input once so both child processes see identical bytes. */
async function prepareFixtures(cases: readonly string[], directory: string): Promise<void> {
  if (cases.includes('xml') || cases.includes('inflate')) {
    const xml = makeXml(RECORDS, TARGET_BYTES);
    writeFileSync(join(directory, 'xml.bin'), xml);
    if (cases.includes('inflate')) {
      const raw = encoder.encode(xml);
      writeFileSync(join(directory, 'raw.bin'), raw);
      writeFileSync(join(directory, 'raw.deflate'), deflateSync(raw, { level: 6 }));
    }
  }
  if (cases.includes('docx')) writeFileSync(join(directory, 'docx.bin'), await makeDocx(RECORDS));
  if (cases.includes('xlsx')) writeFileSync(join(directory, 'xlsx.bin'), makeXlsx(RECORDS));
  if (cases.includes('pdf')) writeFileSync(join(directory, 'pdf.bin'), await makePdf());
}

async function main(): Promise<void> {
  if (CASE) {
    if (IMPL !== 'js' && IMPL !== 'wasm')
      throw new Error(`BENCH_IMPL must be js|wasm, got ${IMPL}`);
    const result = await runChild(CASE, IMPL);
    console.log(`[bench-result] ${JSON.stringify(result)}`);
    return;
  }

  const cases = ONLY ? CASES.filter((name) => ONLY.includes(name)) : [...CASES];
  console.log(
    `[bench] codec-wasm runs=${RUNS} records=${RECORDS} target=${TARGET_MB}MB cases=${cases.join(',')}`,
  );
  ensureWasm();

  const directory = mkdtempSync(join(tmpdir(), 'codec-wasm-'));
  const results = new Map<string, { js: BenchResult; wasm: BenchResult }>();
  try {
    await prepareFixtures(cases, directory);
    for (const caseName of cases) {
      console.log(`[bench] case=${caseName}`);
      const js = spawnChild(caseName, 'js', directory);
      const wasm = spawnChild(caseName, 'wasm', directory);
      printResult(js);
      printResult(wasm);
      results.set(caseName, { js, wasm });

      if (js.counts && wasm.counts) {
        const same = JSON.stringify(js.counts) === JSON.stringify(wasm.counts);
        console.log(`[bench]   identity counts/hash: ${same ? 'ok' : 'MISMATCH'}`);
        if (!same) process.exitCode = 1;
      } else if (js.contentHash !== undefined && wasm.contentHash !== undefined) {
        const same =
          js.contentHash === wasm.contentHash &&
          js.outputBytes === wasm.outputBytes &&
          (js.entries ?? 0) === (wasm.entries ?? 0);
        console.log(`[bench]   identity bytes/hash: ${same ? 'ok' : 'MISMATCH'}`);
        if (!same) process.exitCode = 1;
      }
    }
  } finally {
    if (process.env.BENCH_KEEP_FIXTURES !== '1') {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  console.log('[bench] summary');
  for (const line of decision(results)) console.log(`[bench]   ${line}`);
}

await main();
