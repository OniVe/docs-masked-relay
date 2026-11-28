/**
 * R21-N4: CUSTOM-term expansion inside a longer PERSON span.
 *
 * Bun-only (not vitest): `bun tests/perf/custom-expansion.ts`.
 * Env knobs: PERF_COUNTS (default `2000,4000,8000`), PERF_MASK_BUDGET_MS
 * (advisory example budget from the finding, default 500), PERF_INDEX_STRESS
 * (synthetic PERSON/CUSTOM pairs, default 16000).
 *
 * The end-to-end mask includes the whole PERSON detector, whose own cost is
 * superlinear and outside R21-N4; the report keeps it visible instead of
 * hiding it. The expansion index itself is measured on synthetic candidates
 * (P persons, C customs) and must stay near-linear and under budget.
 */

import { anonymizeText, createVault, detectAll } from '../../src/core';
import type { Span } from '../../src/core/detect';
import { expandContainedCustomSpans } from '../../src/core/detect';
import type { EntityLabel } from '../../src/core/types';

const PREFIX = 'DM7F3';
const COUNTS = (process.env.PERF_COUNTS ?? '2000,4000,8000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const MASK_BUDGET_MS = Number(process.env.PERF_MASK_BUDGET_MS ?? 500);
/**
 * Hard gate for a name-dense 8k mask. The full PERSON detector dominates the
 * end-to-end number; a 25 MB name-dense corpus is rejected fail-closed by the
 * PERSON density guard. 1500 ms catches a
 * real regression without turning machine noise into a failure. The 500 ms
 * finding budget stays advisory and is reported, never gated (R22-PERF-1).
 */
const MASK_HARD_BUDGET_MS = Number(process.env.PERF_MASK_HARD_BUDGET_MS ?? 1500);
/** Indexed expansion at 8k names must be negligible next to the detector. */
const EXPANSION_BUDGET_MS = 100;
const INDEX_STRESS = Number(process.env.PERF_INDEX_STRESS ?? 16_000);
const NAME_FORMS = [
  'Иванов Иван Иванович',
  'Иванов Иван Петрович',
  'Иванов Иван Сидорович',
  'Иванов Иван Кузьмич',
] as const;
const CONFIG = {
  customTerms: ['Иванов Иван => CLIENT'],
  labels: new Set<EntityLabel>(['CUSTOM']),
};

interface ExpansionRow {
  case: string;
  names: number;
  chars: number;
  detectMs: number;
  maskMs: number;
  spans: number;
  tags: number;
  syntheticPersons: number;
  syntheticCustoms: number;
  syntheticExpansionMs: number;
  maskWithinExampleBudget: boolean;
  maskWithinHardBudget: boolean;
}

function makeNameDenseText(count: number): string {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = NAME_FORMS[index % NAME_FORMS.length] ?? NAME_FORMS[0];
    parts.push(`${name} (${index})`);
  }
  return parts.join('\n');
}

function countTags(masked: string): number {
  return [...masked.matchAll(/\[\[DM7F3_CLIENT_/gu)].length;
}

/** Synthetic worst case: each CUSTOM span sits inside its own PERSON span. */
function syntheticCandidates(persons: number, customs: number): { text: string; spans: Span[] } {
  const spans: Span[] = [];
  const stride = 32;
  for (let index = 0; index < persons; index += 1) {
    const start = index * stride;
    spans.push({
      label: 'PERSON',
      start,
      end: start + 20,
      text: '',
      priority: 80,
      ruleId: 'perf.person',
    });
    if (index < customs) {
      spans.push({
        label: 'CUSTOM',
        start: start + 2,
        end: start + 14,
        text: '',
        priority: 99,
        ruleId: 'custom',
        tagLabel: 'CLIENT',
      });
    }
  }
  return { text: 'x'.repeat(persons * stride + stride), spans };
}

/**
 * The pre-fix CUSTOM×PERSON loop, kept only as a benchmark reference: the
 * indexed path must beat it at the stress size (a rollback would fail the
 * budget below).
 */
function legacyExpansion(text: string, candidates: readonly Span[]): Span[] {
  const persons = candidates.filter((span) => span.label === 'PERSON');
  if (persons.length === 0) return [...candidates];
  return candidates.map((span) => {
    if (span.label !== 'CUSTOM') return span;
    let best: Span | undefined;
    for (const other of persons) {
      if (other.start > span.start || other.end < span.end) continue;
      if (other.end - other.start <= span.end - span.start) continue;
      if (best === undefined || other.end - other.start > best.end - best.start) best = other;
    }
    if (best === undefined) return span;
    return { ...span, start: best.start, end: best.end, text: text.slice(best.start, best.end) };
  });
}

function measureExpansion(text: string, spans: readonly Span[]): number {
  const started = performance.now();
  const result = expandContainedCustomSpans(text, spans);
  if (result.length !== spans.length) throw new Error('expansion changed the candidate count');
  return performance.now() - started;
}

function runNameDense(count: number): ExpansionRow {
  const text = makeNameDenseText(count);
  const vault = createVault(text, { prefix: PREFIX });

  const detectStarted = performance.now();
  const spans = detectAll(text, CONFIG);
  const detectMs = performance.now() - detectStarted;

  const maskStarted = performance.now();
  const masked = anonymizeText(text, CONFIG, vault);
  const maskMs = performance.now() - maskStarted;

  const synthetic = syntheticCandidates(count, count);
  const syntheticExpansionMs = measureExpansion(synthetic.text, synthetic.spans);

  return {
    case: `names-${count}`,
    names: count,
    chars: text.length,
    detectMs: Math.round(detectMs),
    maskMs: Math.round(maskMs),
    spans: spans.length,
    tags: countTags(masked.maskedText),
    syntheticPersons: count,
    syntheticCustoms: count,
    syntheticExpansionMs: Math.round(syntheticExpansionMs * 100) / 100,
    maskWithinExampleBudget: maskMs <= MASK_BUDGET_MS,
    maskWithinHardBudget: maskMs <= MASK_HARD_BUDGET_MS,
  };
}

function main(): void {
  const rows: ExpansionRow[] = [];
  for (const count of COUNTS) rows.push(runNameDense(count));
  for (const row of rows) console.log(`[perf] ${JSON.stringify(row)}`);

  const names8k = rows.find((row) => row.names === 8000);
  const mask8k = names8k?.maskMs ?? Number.POSITIVE_INFINITY;
  const expansion8k = names8k?.syntheticExpansionMs ?? Number.POSITIVE_INFINITY;

  const stress = syntheticCandidates(INDEX_STRESS, INDEX_STRESS);
  const indexedStressMs = measureExpansion(stress.text, stress.spans);
  const legacyStarted = performance.now();
  legacyExpansion(stress.text, stress.spans);
  const legacyStressMs = performance.now() - legacyStarted;
  console.log(
    `[perf] ${JSON.stringify({
      case: 'index-stress',
      persons: INDEX_STRESS,
      customs: INDEX_STRESS,
      indexedMs: Math.round(indexedStressMs * 100) / 100,
      legacyMs: Math.round(legacyStressMs * 100) / 100,
    })}`,
  );

  const failures: string[] = [];
  if (!(mask8k <= MASK_HARD_BUDGET_MS)) {
    failures.push(`8k mask ${mask8k}ms exceeds the hard ${MASK_HARD_BUDGET_MS}ms cap`);
  }
  if (!(expansion8k <= EXPANSION_BUDGET_MS)) {
    failures.push(`8k indexed expansion ${expansion8k}ms exceeds ${EXPANSION_BUDGET_MS}ms`);
  }
  if (!(indexedStressMs <= EXPANSION_BUDGET_MS)) {
    failures.push(`stress indexed expansion ${indexedStressMs}ms exceeds ${EXPANSION_BUDGET_MS}ms`);
  }
  if (!(indexedStressMs * 5 < legacyStressMs)) {
    failures.push(
      `index is not clearly better than the legacy loop ` +
        `(${indexedStressMs.toFixed(1)}ms vs ${legacyStressMs.toFixed(1)}ms)`,
    );
  }

  if (!(mask8k <= MASK_BUDGET_MS)) {
    console.log(
      `[perf] note: 8k mask ${mask8k}ms > advisory example budget ${MASK_BUDGET_MS}ms; ` +
        `hard gate is ${MASK_HARD_BUDGET_MS}ms. The remainder is the PERSON detector + ` +
        'overlap resolver, not custom expansion ' +
        `(indexed expansion ${expansion8k}ms at 8k, ${indexedStressMs.toFixed(1)}ms at ` +
        `${INDEX_STRESS}).`,
    );
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[perf] FAIL ${failure}`);
    process.exitCode = 1;
  }
}

main();
