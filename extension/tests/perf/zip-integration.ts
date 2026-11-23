/**
 * Production-path ZIP benchmark: `unzipPackage` with the committed codec wasm
 * versus the fflate fallback.
 *
 * Bun-only: `bun tests/perf/zip-integration.ts`.
 * This includes `inspectZip` guards and CRC checks, unlike the raw codec
 * benchmark, so it measures the integration cost the adapters actually pay.
 */

import { readFileSync } from 'node:fs';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import * as XLSX from 'xlsx';
import { initCodecScanner, resetCodecScanner } from '../../src/core/ooxml/codec-wasm';
import { unzipPackage } from '../../src/core/ooxml/zip';

const RUNS = Math.max(1, Number(process.env.BENCH_RUNS ?? 3));
const RECORDS = Math.max(1, Number(process.env.BENCH_RECORDS ?? 4000));
const wasm = readFileSync(new URL('../../src/core/ooxml/codec.wasm', import.meta.url));

const WORDS =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(
    ' ',
  );

function prose(seed: number, words: number): string {
  let state = seed >>> 0;
  const out: string[] = [];
  for (let index = 0; index < words; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    out.push(WORDS[state % WORDS.length] ?? 'lorem');
  }
  return out.join(' ');
}

async function makeDocx(records: number): Promise<Uint8Array> {
  const paragraphs: Paragraph[] = [];
  for (let index = 1; index <= records; index += 1) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: `user${index}@example.ru ${prose(index, 300)}` })],
      }),
    );
  }
  return new Uint8Array(
    await Packer.toBuffer(new Document({ sections: [{ properties: {}, children: paragraphs }] })),
  );
}

function makeXlsx(records: number): Uint8Array {
  const rows: unknown[][] = [['id', 'email', 'note']];
  for (let index = 1; index <= records; index += 1) {
    rows.push([index, `user${index}@example.ru`, prose(index + 999, 300)]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Data');
  return new Uint8Array(
    XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
      compression: true,
    }) as Uint8Array,
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function timeRuns(fn: () => unknown): number[] {
  fn();
  const runs: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const started = performance.now();
    fn();
    runs.push(performance.now() - started);
  }
  return runs;
}

function sameParts(left: ReadonlyMap<string, Uint8Array>, right: ReadonlyMap<string, Uint8Array>) {
  if (left.size !== right.size) return false;
  for (const [name, data] of left) {
    const other = right.get(name);
    if (!other || other.length !== data.length) return false;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== other[index]) return false;
    }
  }
  return true;
}

async function bench(name: string, bytes: Uint8Array): Promise<void> {
  resetCodecScanner();
  const fallback = unzipPackage(bytes);
  const jsRuns = timeRuns(() => unzipPackage(bytes));

  const scanner = await initCodecScanner(wasm);
  if (!scanner) throw new Error('codec wasm did not initialize');
  const wasmParts = unzipPackage(bytes);
  const wasmRuns = timeRuns(() => unzipPackage(bytes));

  const jsMedian = Math.round(median(jsRuns) * 100) / 100;
  const wasmMedian = Math.round(median(wasmRuns) * 100) / 100;
  console.log(
    `[bench] ${JSON.stringify({
      case: name,
      inputBytes: bytes.length,
      entries: fallback.size,
      jsRuns: jsRuns.map((value) => Math.round(value * 100) / 100),
      wasmRuns: wasmRuns.map((value) => Math.round(value * 100) / 100),
      jsMedian,
      wasmMedian,
      win: Math.round(((jsMedian - wasmMedian) / jsMedian) * 1000) / 10,
      identical: sameParts(fallback, wasmParts),
    })}`,
  );
  if (!sameParts(fallback, wasmParts)) process.exitCode = 1;
}

const docx = await makeDocx(RECORDS);
const xlsx = makeXlsx(RECORDS);
console.log(`[bench] zip-integration runs=${RUNS} records=${RECORDS}`);
await bench('docx', docx);
await bench('xlsx', xlsx);
