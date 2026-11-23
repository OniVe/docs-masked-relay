/**
 * Compares the pure-JS structured detector path with the wasm candidate-region
 * path on the 25 MB JSON fixture.
 *
 * Bun-only: `bun tests/perf/structured-wasm.ts`.
 * Env knobs: BENCH_RECORDS (default 4000), BENCH_TARGET_MB (default 25).
 *
 * The wasm scanner is only consulted for texts >= 1 MB, so this measures the
 * whole-document path used by TXT/PDF and large single values. Per-node JSON/XML
 * adapters stay on the JS path (their strings are small by design).
 */

import { readFileSync } from 'node:fs';
import { detectAll } from '../../src/core/detect';
import { detectStructured } from '../../src/core/detect/structured';
import {
  getStructuredScanner,
  initStructuredScanner,
  resetStructuredScanner,
} from '../../src/core/detect/wasm-scan';

const RECORDS = Number(process.env.BENCH_RECORDS ?? 4000);
const TARGET_MB = Number(process.env.BENCH_TARGET_MB ?? 25);
const TARGET_BYTES = Math.round(TARGET_MB * 1024 * 1024) - 4096;

const FILLER = Array.from(
  { length: 40 },
  () =>
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
    'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis ' +
    'nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat ',
).join('');

function makeJson(records: number, targetBytes: number): string {
  const fillerLength = Math.max(16, Math.floor(targetBytes / records) - 90);
  const filler = FILLER.repeat(Math.ceil(fillerLength / FILLER.length)).slice(0, fillerLength);
  const parts: string[] = ['['];
  for (let index = 1; index <= records; index += 1) {
    if (index > 1) parts.push(',');
    parts.push(`{"id":${index},"email":"user${index}@example.ru","note":"${filler}"}`);
  }
  parts.push(']');
  return parts.join('');
}

const wasm = readFileSync(new URL('../../src/core/detect/pii-scan.wasm', import.meta.url));

function measure(label: string, fn: () => unknown[]): number {
  const started = performance.now();
  const spans = fn();
  const ms = Math.round(performance.now() - started);
  console.log(`[bench] ${JSON.stringify({ label, ms, spans: spans.length })}`);
  return ms;
}

const text = makeJson(RECORDS, TARGET_BYTES);
console.log(
  `[bench] structured-wasm records=${RECORDS} chars=${text.length} target=${TARGET_MB}MB`,
);

resetStructuredScanner();
measure('js.detectStructured', () => detectStructured(text));
measure('js.detectAll', () => detectAll(text));
measure('js.detectStructured.warm', () => detectStructured(text));
measure('js.detectAll.warm', () => detectAll(text));

await initStructuredScanner(wasm);
if (getStructuredScanner() === null) throw new Error('wasm scanner did not initialize');
measure('wasm.detectStructured', () => detectStructured(text));
measure('wasm.detectAll', () => detectAll(text));
measure('wasm.detectStructured.warm', () => detectStructured(text));
measure('wasm.detectAll.warm', () => detectAll(text));
resetStructuredScanner();
