/**
 * Synthetic 25 MB / 4000 PII benchmark for the JSON and XML adapters.
 *
 * Bun-only (not vitest): `bun tests/perf/json-xml-25mb.ts`.
 * Env knobs: BENCH_RECORDS (default 4000), BENCH_TARGET_MB (default 25),
 * BENCH_ONLY=json|xml, BENCH_SKIP_SMALL=1, BENCH_ISOLATE=0 (run every case
 * in the parent process instead of one fresh Bun process per case).
 *
 * Each case reports wall time, RSS/heap after masking and after restore,
 * masked size, tag count, residual PII findings (`findLeaks` on the masked
 * document), exact restore coverage and rejection at the production default
 * 25 MiB limit. Boundary cases additionally check that a payload of exactly
 * `MAX_FILE_BYTES` is accepted and `MAX_FILE_BYTES + 1` is rejected. PII is
 * synthetic (`user<N>@example.ru`, name-dense custom terms).
 */

import {
  anonymizeJson,
  anonymizeXml,
  createVault,
  type DetectionConfig,
  decodeTextBytes,
  type EntityLabel,
  type FileInput,
  findLeaks,
  restoreJson,
  restoreXml,
} from '../../src/core';
import { MAX_FILE_BYTES } from '../../src/interception/protocol';

const RECORDS = Number(process.env.BENCH_RECORDS ?? 4000);
const TARGET_MB = Number(process.env.BENCH_TARGET_MB ?? 25);
const ONLY = process.env.BENCH_ONLY;
const SKIP_SMALL = process.env.BENCH_SKIP_SMALL === '1';
const SKIP_FULL = process.env.BENCH_SKIP_FULL === '1';
const TARGET_BYTES = Math.round(TARGET_MB * 1024 * 1024);
/** Production default upload limit (`MAX_FILE_BYTES`). */
const DEFAULT_MAX_BYTES = MAX_FILE_BYTES;
/** Keep the generated 25 MB payload inside the default limit (whitespace headroom). */
const FULL_BYTES = Math.min(TARGET_BYTES, DEFAULT_MAX_BYTES - 4096);
const RESTORE_TARGET_MS = 2000;
/** LeakGuard budgets at 25 MB (M15-M2); target 10 s, hard budget has headroom. */
const LEAK_TARGET_MS = 10_000;
const LEAK_BUDGET_MS = 12_000;
const LEAK_RSS_BUDGET_MB = 1024;
/** A single 25 MiB JSON string must not exceed the leak budget either. */
const SINGLE_STRING_MASK_BUDGET_MS = 12_000;
/** Name-dense JSON: each name is a small unit, so the cap is only a sanity net. */
const NAME_DENSE_MASK_BUDGET_MS = 10_000;
const NAME_DENSE_COUNTS = [2000, 4000, 8000] as const;
const NAME_DENSE_CONFIG: DetectionConfig = {
  customTerms: ['Иванов Иван => CLIENT'],
  labels: new Set<EntityLabel>(['CUSTOM']),
};
const NAME_FORMS = [
  'Иванов Иван Иванович',
  'Иванов Иван Петрович',
  'Иванов Иван Сидорович',
  'Иванов Иван Кузьмич',
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const FILLER = Array.from(
  { length: 40 },
  () =>
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
    'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis ' +
    'nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat ',
).join('');

interface MaskMetrics {
  kind: 'mask';
  case: string;
  records: number;
  inputBytes: number;
  maskMs: number;
  rssBeforeMb: number;
  rssAfterMb: number;
  rssAfterGcMb: number;
  heapAfterMb: number;
  maskedBytes: number;
  tags: number;
  leakFindings: number;
  leakMs: number;
  restoreMs: number;
  restoreOk: boolean;
  restoredEmails: number;
  rssAfterLeakGcMb: number;
  rssAfterRestoreMb: number;
  rssAfterRestoreGcMb: number;
  heapAfterRestoreMb: number;
  limitRejected: boolean;
  /** False for cases that do not run the oversize probe (name-dense). */
  limitChecked: boolean;
  /** Optional mask wall-time cap for this case. */
  maskBudgetMs?: number;
}

interface LimitMetrics {
  kind: 'limit';
  case: string;
  inputBytes: number;
  maskMs: number;
  accepted: boolean;
  expectAccepted: boolean;
  outputBytes: number;
  error?: string;
}

type Metrics = MaskMetrics | LimitMetrics;

function memory(): { rss: number; heap: number } {
  const usage = process.memoryUsage();
  return { rss: usage.rss, heap: usage.heapUsed };
}

/** Forced full GC when the runtime exposes it, so RSS shows the live set. */
function collectGarbage(): void {
  const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun;
  bun?.gc?.(true);
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function fileOf(name: string, mimeType: string, bytes: Uint8Array): FileInput {
  return { name, mimeType, bytes };
}

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

function emailCount(text: string): number {
  return [...text.matchAll(/user\d+@example\.ru/gu)].length;
}

/**
 * Expected restored XML: CDATA sections are one-way by design and come back
 * as escaped character data; everything else must be byte/text exact.
 */
function expectedXmlRestore(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, (_match, body: string) =>
    body.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;'),
  );
}

interface JsonCaseOptions {
  config?: DetectionConfig;
  maskBudgetMs?: number;
  checkLimit?: boolean;
  records?: number;
}

async function runJsonText(
  text: string,
  label: string,
  options: JsonCaseOptions = {},
): Promise<MaskMetrics> {
  const bytes = encoder.encode(text);
  const vault = createVault(text);
  const before = memory();

  const started = performance.now();
  const result = await anonymizeJson(fileOf('bench.json', 'application/json', bytes), {
    vault,
    maxBytes: DEFAULT_MAX_BYTES,
    config: options.config,
  });
  const maskMs = performance.now() - started;
  const after = memory();
  collectGarbage();
  const afterGc = memory();
  const masked = decoder.decode(result.maskedBytes);

  const leakStarted = performance.now();
  const leaks = findLeaks(masked, options.config ?? {});
  const leakMs = performance.now() - leakStarted;
  collectGarbage();
  const afterLeakGc = memory();

  const restoreStarted = performance.now();
  const restored = await restoreJson(
    fileOf('bench.json', 'application/json', result.maskedBytes),
    vault,
  );
  const restoreMs = performance.now() - restoreStarted;
  const restoredText = decoder.decode(restored.bytes);
  const afterRestore = memory();
  collectGarbage();
  const afterRestoreGc = memory();

  const limitChecked = options.checkLimit ?? true;
  let limitRejected = false;
  if (limitChecked) {
    // Trailing whitespace is valid JSON, so the oversize probe exercises the
    // production default without changing document semantics.
    const oversize = encoder.encode(
      text + ' '.repeat(Math.max(0, DEFAULT_MAX_BYTES + 1 - bytes.byteLength)),
    );
    try {
      await anonymizeJson(fileOf('bench.json', 'application/json', oversize), {
        vault: createVault(''),
        maxBytes: DEFAULT_MAX_BYTES,
        config: options.config,
      });
    } catch {
      limitRejected = true;
    }
  }

  return {
    kind: 'mask',
    case: label,
    records: options.records ?? 0,
    inputBytes: bytes.byteLength,
    maskMs: Math.round(maskMs),
    rssBeforeMb: mb(before.rss),
    rssAfterMb: mb(after.rss),
    rssAfterGcMb: mb(afterGc.rss),
    heapAfterMb: mb(afterGc.heap),
    maskedBytes: result.maskedBytes.byteLength,
    tags: result.occurrences.length,
    leakFindings: leaks.length,
    leakMs: Math.round(leakMs),
    restoreMs: Math.round(restoreMs),
    restoreOk: restoredText === text,
    restoredEmails: emailCount(restoredText),
    rssAfterLeakGcMb: mb(afterLeakGc.rss),
    rssAfterRestoreMb: mb(afterRestore.rss),
    rssAfterRestoreGcMb: mb(afterRestoreGc.rss),
    heapAfterRestoreMb: mb(afterRestoreGc.heap),
    limitRejected,
    limitChecked,
    maskBudgetMs: options.maskBudgetMs,
  };
}

function runJson(records: number, targetBytes: number, label: string): Promise<MaskMetrics> {
  return runJsonText(makeJson(records, targetBytes), label, { records });
}

async function runXml(records: number, targetBytes: number, label: string): Promise<MaskMetrics> {
  const text = makeXml(records, targetBytes);
  const bytes = encoder.encode(text);
  const vault = createVault(text);
  const before = memory();

  const started = performance.now();
  const result = await anonymizeXml(fileOf('bench.xml', 'application/xml', bytes), {
    vault,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const maskMs = performance.now() - started;
  const after = memory();
  collectGarbage();
  const afterGc = memory();
  const masked = decoder.decode(result.maskedBytes);

  const leakStarted = performance.now();
  const leaks = findLeaks(masked, {});
  const leakMs = performance.now() - leakStarted;
  collectGarbage();
  const afterLeakGc = memory();

  const restoreStarted = performance.now();
  const restored = await restoreXml(
    fileOf('bench.xml', 'application/xml', result.maskedBytes),
    vault,
  );
  const restoreMs = performance.now() - restoreStarted;
  const restoredText = decodeTextBytes(restored.bytes, 'utf-8', false);
  const afterRestore = memory();
  collectGarbage();
  const afterRestoreGc = memory();

  // Trailing whitespace is allowed after the document element, so the probe
  // tests the production default limit without changing XML semantics.
  const oversize = encoder.encode(
    text + ' '.repeat(Math.max(0, DEFAULT_MAX_BYTES + 1 - bytes.byteLength)),
  );
  let limitRejected = false;
  try {
    await anonymizeXml(fileOf('bench.xml', 'application/xml', oversize), {
      vault: createVault(''),
      maxBytes: DEFAULT_MAX_BYTES,
    });
  } catch {
    limitRejected = true;
  }

  return {
    kind: 'mask',
    case: label,
    records,
    inputBytes: bytes.byteLength,
    maskMs: Math.round(maskMs),
    rssBeforeMb: mb(before.rss),
    rssAfterMb: mb(after.rss),
    rssAfterGcMb: mb(afterGc.rss),
    heapAfterMb: mb(afterGc.heap),
    maskedBytes: result.maskedBytes.byteLength,
    tags: result.occurrences.length,
    leakFindings: leaks.length,
    leakMs: Math.round(leakMs),
    restoreMs: Math.round(restoreMs),
    restoreOk: restoredText === expectedXmlRestore(text),
    restoredEmails: emailCount(restoredText),
    rssAfterLeakGcMb: mb(afterLeakGc.rss),
    rssAfterRestoreMb: mb(afterRestore.rss),
    rssAfterRestoreGcMb: mb(afterRestoreGc.rss),
    heapAfterRestoreMb: mb(afterRestoreGc.heap),
    limitRejected,
    limitChecked: true,
  };
}

/** Valid JSON padded with spaces to exactly `bytes` UTF-8 bytes. */
function paddedJson(bytes: number): Uint8Array {
  const prefix = '{"limit":true}';
  const size = encoder.encode(prefix).byteLength;
  if (bytes < size) throw new Error(`JSON boundary payload must be at least ${size} bytes`);
  return encoder.encode(prefix + ' '.repeat(bytes - size));
}

/** Valid XML padded with trailing spaces to exactly `bytes` UTF-8 bytes. */
function paddedXml(bytes: number): Uint8Array {
  const prefix = '<root/>';
  const size = encoder.encode(prefix).byteLength;
  if (bytes < size) throw new Error(`XML boundary payload must be at least ${size} bytes`);
  return encoder.encode(prefix + ' '.repeat(bytes - size));
}

async function runJsonLimit(label: string, expectAccepted: boolean): Promise<LimitMetrics> {
  const inputBytes = expectAccepted ? DEFAULT_MAX_BYTES : DEFAULT_MAX_BYTES + 1;
  const bytes = paddedJson(inputBytes);
  const started = performance.now();
  let accepted = false;
  let outputBytes = 0;
  let error: string | undefined;
  try {
    const result = await anonymizeJson(fileOf('limit.json', 'application/json', bytes), {
      vault: createVault(''),
      maxBytes: DEFAULT_MAX_BYTES,
    });
    accepted = true;
    outputBytes = result.maskedBytes.byteLength;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    kind: 'limit',
    case: label,
    inputBytes,
    maskMs: Math.round(performance.now() - started),
    accepted,
    expectAccepted,
    outputBytes,
    error,
  };
}

async function runXmlLimit(label: string, expectAccepted: boolean): Promise<LimitMetrics> {
  const inputBytes = expectAccepted ? DEFAULT_MAX_BYTES : DEFAULT_MAX_BYTES + 1;
  const bytes = paddedXml(inputBytes);
  const started = performance.now();
  let accepted = false;
  let outputBytes = 0;
  let error: string | undefined;
  try {
    const result = await anonymizeXml(fileOf('limit.xml', 'application/xml', bytes), {
      vault: createVault(''),
      maxBytes: DEFAULT_MAX_BYTES,
    });
    accepted = true;
    outputBytes = result.maskedBytes.byteLength;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    kind: 'limit',
    case: label,
    inputBytes,
    maskMs: Math.round(performance.now() - started),
    accepted,
    expectAccepted,
    outputBytes,
    error,
  };
}

/** One JSON string value at the exact production limit. */
function makeSingleStringJson(): string {
  const prefix = '{"note":"user1@example.ru ';
  const suffix = '"}';
  const padding =
    DEFAULT_MAX_BYTES - encoder.encode(prefix).byteLength - encoder.encode(suffix).byteLength;
  if (padding < 0) throw new Error('single-string payload does not fit the limit');
  return (
    prefix +
    'lorem ipsum dolor sit amet '.repeat(Math.ceil(padding / 27)).slice(0, padding) +
    suffix
  );
}

/** `{"people":[{"id":N,"name":"..."}]}` with N detected PERSON + CUSTOM spans. */
function makeNameDenseJson(count: number): string {
  const items: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = NAME_FORMS[index % NAME_FORMS.length] ?? NAME_FORMS[0];
    items.push(`{"id":${index},"name":${JSON.stringify(name)}}`);
  }
  return `{"people":[${items.join(',')}]}`;
}

function report(metrics: Metrics): void {
  console.log(`[bench] ${JSON.stringify(metrics)}`);
}

function caseNames(): string[] {
  const names: string[] = [];
  if (!SKIP_SMALL) {
    if (ONLY !== 'xml') names.push('json-4k-small');
    if (ONLY !== 'json') names.push('xml-4k-small');
  }
  if (!SKIP_FULL) {
    if (ONLY !== 'xml') {
      names.push(
        `${TARGET_MB}mb-json`,
        'json-limit-exact',
        'json-limit-plus-one',
        'json-single-string',
      );
    }
    if (ONLY !== 'json') {
      names.push(`${TARGET_MB}mb-xml`, 'xml-limit-exact', 'xml-limit-plus-one');
    }
  }
  if (ONLY !== 'xml') {
    for (const count of NAME_DENSE_COUNTS) names.push(`json-name-dense-${count}`);
  }
  return names;
}

async function runCase(name: string): Promise<Metrics> {
  if (name === 'json-4k-small') return runJson(RECORDS, 40_000, name);
  if (name === 'xml-4k-small') return runXml(RECORDS, 40_000, name);
  if (name === 'json-limit-exact') return runJsonLimit(name, true);
  if (name === 'json-limit-plus-one') return runJsonLimit(name, false);
  if (name === 'xml-limit-exact') return runXmlLimit(name, true);
  if (name === 'xml-limit-plus-one') return runXmlLimit(name, false);
  if (name === 'json-single-string') {
    return runJsonText(makeSingleStringJson(), name, {
      maskBudgetMs: SINGLE_STRING_MASK_BUDGET_MS,
    });
  }
  if (name.startsWith('json-name-dense-')) {
    const count = Number(name.slice('json-name-dense-'.length));
    return runJsonText(makeNameDenseJson(count), name, {
      config: NAME_DENSE_CONFIG,
      maskBudgetMs: NAME_DENSE_MASK_BUDGET_MS,
      checkLimit: false,
      records: count,
    });
  }
  if (name.endsWith('mb-json')) return runJson(RECORDS, FULL_BYTES, name);
  if (name.endsWith('mb-xml')) return runXml(RECORDS, FULL_BYTES, name);
  throw new Error(`Unknown benchmark case: ${name}`);
}

function verdict(metrics: Metrics): boolean {
  if (metrics.kind === 'limit') {
    return (
      metrics.accepted === metrics.expectAccepted &&
      (!metrics.expectAccepted || metrics.outputBytes > 0)
    );
  }
  const full = !metrics.case.endsWith('4k-small');
  return (
    metrics.leakFindings === 0 &&
    metrics.restoreOk &&
    (!metrics.limitChecked || metrics.limitRejected) &&
    (metrics.maskBudgetMs === undefined || metrics.maskMs <= metrics.maskBudgetMs) &&
    (metrics.restoreMs <= RESTORE_TARGET_MS || !metrics.case.endsWith('4k-small')) &&
    (!full || (metrics.leakMs <= LEAK_BUDGET_MS && metrics.rssAfterLeakGcMb < LEAK_RSS_BUDGET_MB))
  );
}

interface BunRuntime {
  spawnSync?: (
    command: string[],
    options: { env: Record<string, string | undefined>; stdout: 'inherit'; stderr: 'inherit' },
  ) => { exitCode: number };
}

/**
 * One fresh Bun process per case (default): RSS/heap numbers then describe
 * that case alone instead of carrying garbage from the previous payload
 * (R15-N3). BENCH_ISOLATE=0 keeps the old in-process sequence.
 */
function runIsolated(names: string[]): boolean {
  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!bun?.spawnSync || process.env.BENCH_ISOLATE === '0') return false;

  console.log(`[bench] isolated cases=${names.join(',')}`);
  let failed = false;
  for (const name of names) {
    const child = bun.spawnSync([process.execPath, process.argv[1] ?? ''], {
      env: { ...process.env, BENCH_CASE: name, BENCH_ISOLATE: '0' },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (child.exitCode !== 0) failed = true;
  }
  if (failed) process.exitCode = 1;
  return true;
}

async function main(): Promise<void> {
  if (process.env.BENCH_CASE) {
    const metrics = await runCase(process.env.BENCH_CASE);
    report(metrics);
    if (!verdict(metrics)) {
      console.error(`[bench] FAIL case=${metrics.case}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log(
    `[bench] records=${RECORDS} target=${TARGET_MB}MB filler=${FILLER.length} ` +
      `leakTarget=${LEAK_TARGET_MS}ms leakBudget=${LEAK_BUDGET_MS}ms ` +
      `leakRssBudget=${LEAK_RSS_BUDGET_MB}MB runtimes=bun`,
  );
  const names = caseNames();
  if (runIsolated(names)) return;

  const cases: Metrics[] = [];
  for (const name of names) cases.push(await runCase(name));
  for (const metrics of cases) report(metrics);

  const failed = cases.filter((metrics) => !verdict(metrics));
  if (failed.length > 0) {
    console.error(`[bench] FAIL cases=${failed.map((metrics) => metrics.case).join(',')}`);
    process.exitCode = 1;
  }
}

await main();
