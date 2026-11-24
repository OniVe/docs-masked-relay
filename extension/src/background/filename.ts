/**
 * Filename masking for uploads (M3b).
 *
 * Content adapters keep the original name; the interception layer needs a
 * tag-bearing name so `file_name` in metadata never carries PII. Tags reuse
 * the same vault entities, the extension is preserved, and the mapping is
 * stored in `vault.filenameMap` for restore/manual mode.
 */

import { anonymizeText, type DetectionConfig, findLeaks, type Vault } from '../core';

/** Neutral basename used when a residual finding cannot be classified away. */
const FALLBACK_BASE = 'document';
/** Replacement for unclassified long numeric token runs (IDs, dates, ...). */
const NUMBER_TOKEN = 'number';

function splitExtension(name: string): { base: string; extension: string } {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return { base: name, extension: '' };
  return { base: name.slice(0, index), extension: name.slice(index) };
}

function replaceLiteral(text: string, value: string, replacement: string): string {
  if (value.length === 0) return text;
  return text.split(value).join(replacement);
}

/**
 * Long numeric runs in a basename are common upload noise (IDs, timestamps)
 * yet are not classified PII. Replace them with a stable word rather than
 * letting LeakGuard fail the whole upload.
 */
function replaceDigitFindings(
  text: string,
  findings: readonly { kind: string; value: string }[],
): string {
  let result = text;
  for (const finding of findings) {
    if (finding.kind !== 'paranoid:digits') continue;
    result = replaceLiteral(result, finding.value, NUMBER_TOKEN);
  }
  return result;
}

/**
 * Masks the basename with the existing vault and returns `masked.ext`.
 * Unclassified long numeric tokens become `number`; any other residual
 * finding falls back to a neutral basename so no PII can ship. LeakGuard
 * itself is not weakened: this call opts out of blocking and re-checks.
 */
export function maskFileName(vault: Vault, name: string, config?: DetectionConfig): string {
  vault.filenameMap ??= [];

  const existing = vault.filenameMap.find((entry) => entry.original === name);
  if (existing) return existing.masked;

  const { base, extension } = splitExtension(name);
  if (base.length === 0) return name;

  // Mask against a draft: entity counters are merged, but filename
  // occurrences must not disturb the per-file occurrence queues used to
  // restore body variants. Filenames get aggressive person detection so a
  // lone surname or first name does not leak into `file_name`.
  const draft = structuredClone(vault);
  const nameConfig: DetectionConfig = {
    ...config,
    aggressive: true,
    loneFirstNames: true,
    blockOnLeak: false,
  };
  const result = anonymizeText(base, nameConfig, draft);

  let maskedBase = replaceDigitFindings(result.maskedText, result.leakFindings);
  if (findLeaks(maskedBase, nameConfig).length > 0) maskedBase = FALLBACK_BASE;

  // The extension is normally plain (`pdf`, `docx`), but a numeric extension
  // would still ship a long digit run.
  const safeExtension = replaceDigitFindings(extension, findLeaks(extension, nameConfig));

  const masked = `${maskedBase}${safeExtension}`;
  if (masked === name) {
    vault.filenameMap.push({ original: name, masked: name });
    return name;
  }

  vault.entities = draft.entities;
  vault.personKeys = draft.personKeys;
  vault.filenameMap.push({ original: name, masked });
  return masked;
}
