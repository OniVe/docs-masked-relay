/**
 * Case-insensitive stemming for Russian names.
 *
 * Ported from docs_masked `pii_shield/names_ru.py` (norm/stem) —
 * MIT, © 2026 Kirill Pshinnik,
 * commit 905f92362d574351c1f9b22f56685facffa42c54.
 *
 * The stemmer is deliberately coarse: Russian inflection is suffixal, so
 * trimming up to three trailing "inflectional" letters merges case forms
 * without merging unrelated surnames (guide §3).
 */

const FLEX = new Set('аяуюеёиыоьймх');
const MIN_STEM = 3;
const MAX_STRIP = 3;

/** Lower-cases and normalises `ё` to `е`, exactly like docs_masked `norm`. */
export function norm(word: string): string {
  return word.toLowerCase().replaceAll('ё', 'е');
}

/** Case-form-invariant stem of a word. */
export function stem(word: string): string {
  let value = norm(word);
  for (let strip = 0; strip < MAX_STRIP; strip += 1) {
    if (value.length <= MIN_STEM) break;
    const last = value.at(-1);
    if (last === undefined || !FLEX.has(last)) break;
    value = value.slice(0, -1);
  }
  return value;
}
