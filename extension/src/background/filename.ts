/**
 * Filename masking for uploads (M3b).
 *
 * Content adapters keep the original name; the interception layer needs a
 * tag-bearing name so `file_name` in metadata never carries PII. Tags reuse
 * the same vault entities, the extension is preserved, and the mapping is
 * stored in `vault.filenameMap` for restore/manual mode.
 */

import { anonymizeText, type DetectionConfig, type Vault } from '../core';

function splitExtension(name: string): { base: string; extension: string } {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return { base: name, extension: '' };
  return { base: name.slice(0, index), extension: name.slice(index) };
}

/**
 * Masks the basename with the existing vault and returns `masked.ext`.
 * Throws the core LeakGuard error rather than leaking a residual PII name.
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
  const nameConfig: DetectionConfig = { ...config, aggressive: true, loneFirstNames: true };
  const result = anonymizeText(base, nameConfig, draft);

  if (result.maskedText === base) {
    vault.filenameMap.push({ original: name, masked: name });
    return name;
  }

  const masked = `${result.maskedText}${extension}`;
  vault.entities = draft.entities;
  vault.personKeys = draft.personKeys;
  vault.filenameMap.push({ original: name, masked });
  return masked;
}
