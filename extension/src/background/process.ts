/**
 * Background file pipeline (M3a).
 *
 * No interception hooks live here: the router/content script supplies bytes,
 * this module selects a vault + format adapter, runs the core engine and
 * persists the encrypted vault. Everything is fail-closed: on an unsupported
 * format, limit or adapter error no vault is saved and no partial bytes are
 * returned.
 */

import {
  AmbiguousVaultFileError,
  createVault,
  DENSITY_LIMIT_MESSAGE,
  DensityLimitError,
  type DetectionConfig,
  DOCX_MIME,
  docFormatAdapter,
  docxFormatAdapter,
  type FileFormat,
  type FormatAdapter,
  IdentityMismatchVaultFileError,
  jsonFormatAdapter,
  type MaskedEntity,
  mdFormatAdapter,
  parseTags,
  resolveVaultFile,
  restoreText,
  sha256Hex,
  txtFormatAdapter,
  type Vault,
  XLSX_MIME,
  xlsFormatAdapter,
  xlsxFormatAdapter,
  xmlFormatAdapter,
  ZipError,
} from '../core';
import { isPdfFile } from '../core/formats/pdf-detect';
import { isPdfRedactionError, PDF_IRREVERSIBLE_MESSAGE } from '../core/formats/pdf-errors';
import type {
  AnonymizeFileResult,
  AppSettings,
  ProcessedEntity,
  RestoreFileResult,
  RestoreNameResult,
} from '../shared/messages';
import { RelayError } from './errors';
import { maskFileName } from './filename';
import { runPdfAnonymize } from './pdf-runner';
import { detectionConfigFromSettings, getSettings } from './settings';
import {
  boundChatIdsFor,
  deleteVaultIfEmpty,
  getVault,
  getVaultByChat,
  getVaultByPrefix,
  getVaultEpoch,
  listVaultIds,
  saveVault,
  withVaultLock,
} from './vault-store';

/** Default upload limit (spec §3); settings can raise/lower it in M6. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * In-flight PDF runs per vault id. A failed run only removes the empty vault
 * it created when no other run still shares it (R3-M1).
 */
const activePdfRuns = new Map<string, number>();

function acquirePdfRun(vaultId: string): void {
  activePdfRuns.set(vaultId, (activePdfRuns.get(vaultId) ?? 0) + 1);
}

function releasePdfRun(vaultId: string): number {
  const remaining = (activePdfRuns.get(vaultId) ?? 1) - 1;
  if (remaining > 0) activePdfRuns.set(vaultId, remaining);
  else activePdfRuns.delete(vaultId);
  return remaining;
}

// Adapter order breaks ties for an unknown extension; extension matching is
// tried first (a `.xml` file sent as `application/json` is XML, not JSON).
const FORMAT_ADAPTERS: readonly FormatAdapter[] = [
  docFormatAdapter,
  docxFormatAdapter,
  xlsFormatAdapter,
  xlsxFormatAdapter,
  mdFormatAdapter,
  jsonFormatAdapter,
  xmlFormatAdapter,
  txtFormatAdapter,
];

const STANDARD_MIME: Partial<Record<FileFormat, string>> = {
  docx: DOCX_MIME,
  xlsx: XLSX_MIME,
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
};

/**
 * Legacy conversions change the MIME; all other formats keep the source MIME
 * when it is meaningful and fall back to the standard value otherwise.
 */
function maskedMimeFor(
  declared: string | undefined,
  format: FileFormat,
  sourceMime: string,
): string {
  if (declared && declared.trim().length > 0) return declared.trim();

  const source = sourceMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (source.length > 0 && source !== 'application/octet-stream') return sourceMime.trim();
  return STANDARD_MIME[format] ?? 'application/octet-stream';
}

/**
 * Extension/MIME routing for the in-worker adapters. PDF is deliberately not
 * listed: it is routed through `pdf-runner` (offscreen/background page) so the
 * service worker never imports EmbedPDF. Returns undefined for PDF and other
 * unsupported formats.
 */
export function selectFormatAdapter(name: string, mime: string): FormatAdapter | undefined {
  // The extension is authoritative when it is known (M8-R1): server-declared
  // MIME is often stale or generic (`application/json`, `text/plain`,
  // `text/markdown`), and a mismatch must not pick the wrong adapter.
  const lowerName = name.toLowerCase();
  const byExtension = FORMAT_ADAPTERS.find((adapter) =>
    adapter.extensions.some((extension) => lowerName.endsWith(extension.toLowerCase())),
  );
  if (byExtension) return byExtension;

  // Unknown extension: MIME is the only signal left.
  const probe = { name, mimeType: mime };
  return FORMAT_ADAPTERS.find((adapter) => adapter.canHandle(probe));
}

/**
 * PDF routing before adapter selection (M8-R1): the `.pdf` extension is
 * authoritative, and a PDF MIME only routes to the PDF path when the
 * extension is unknown to every in-worker adapter. `.json`/`.txt` sent as
 * `application/pdf` stay with their extension adapter.
 */
export function isPdfRoute(name: string, mime: string): boolean {
  if (isPdfFile(name, '')) return true;
  if (!isPdfFile('', mime)) return false;
  return selectFormatAdapter(name, mime) === undefined;
}

function assertWithinLimit(byteLength: number, maxBytes: number = MAX_FILE_BYTES): void {
  if (byteLength > maxBytes) {
    throw new RelayError('LIMIT', 'File exceeds the configured size limit');
  }
}

function adapterFor(name: string, mime: string): FormatAdapter {
  const adapter = selectFormatAdapter(name, mime);
  if (!adapter) throw new RelayError('UNSUPPORTED', 'File format is not supported');
  return adapter;
}

/**
 * ZIP64 and encrypted OOXML containers are rejected before decompression.
 * The cause must stay explicit instead of collapsing into the generic
 * `INTERNAL` text: the user needs to know the archive shape is unsupported.
 * Messages are constant and never interpolate an entry name or path from the
 * processed file (P1-ZIP64-ENCRYPTED).
 */
function archiveRelayError(error: unknown): RelayError | undefined {
  if (!(error instanceof ZipError)) return undefined;
  if (error.reason === 'zip64') {
    return new RelayError('UNSUPPORTED_ARCHIVE', 'Архив ZIP64 не поддерживается');
  }
  if (error.reason === 'encrypted') {
    return new RelayError('UNSUPPORTED_ARCHIVE', 'Зашифрованный ZIP не поддерживается');
  }
  return undefined;
}

/**
 * A document with too many candidate names must reach the UI as its own code
 * and constant Russian text, never as `INTERNAL`: the user has to split the
 * file. The message is fixed and carries no document content.
 */
function densityRelayError(error: unknown): RelayError | undefined {
  if (!(error instanceof DensityLimitError)) return undefined;
  return new RelayError('TOO_MANY_ENTITIES', DENSITY_LIMIT_MESSAGE);
}

export interface AnonymizeFileInput {
  bytes: Uint8Array;
  name: string;
  mime: string;
  chatId?: string;
  prefix?: string;
  /** Detector override; persisted settings apply when omitted. */
  config?: DetectionConfig;
}

/** In-process output always carries raw bytes; the router base64-encodes it. */
export type AnonymizeFileOutput = Omit<AnonymizeFileResult, 'maskedBytes'> & {
  maskedBytes: Uint8Array;
};

function safeEntities(result: readonly MaskedEntity[]): ProcessedEntity[] {
  // Drop canonical/variant values: only tags and counters may cross the
  // background boundary.
  return result.map(({ key, tag, label, count }) => ({ key, tag, label, count }));
}

/**
 * Resolves the vault for an upload: existing chat vault, then an explicitly
 * requested prefix, otherwise a fresh vault bound to the chat.
 */
async function resolveUploadVault(input: { chatId?: string; prefix?: string }): Promise<Vault> {
  const aliases = input.chatId ? boundChatIdsFor(input.chatId) : [];

  let vault = input.chatId ? await getVaultByChat(input.chatId) : undefined;
  for (const alias of aliases) {
    if (vault) break;
    vault = await getVaultByChat(alias);
  }
  if (!vault && input.prefix) {
    vault = await getVaultByPrefix(input.prefix);
  }
  if (!vault) {
    vault = createVault('', { prefix: input.prefix });
  }
  for (const chatId of [input.chatId, ...aliases]) {
    if (chatId && !vault.chatIds.includes(chatId)) vault.chatIds.push(chatId);
  }
  return vault;
}

/**
 * Maps typed PDF failures to the stable relay codes. Messages for locate/
 * apply/residual/metadata are replaced with a constant: only scanned pages,
 * limits, encryption, invalid files and runtime availability may reach the UI.
 */
function relayErrorFromPdf(error: unknown): RelayError {
  if (isPdfRedactionError(error)) {
    switch (error.code) {
      case 'PDF_SIZE':
      case 'PDF_PAGES':
        return new RelayError('LIMIT', error.message);
      case 'PDF_SCANNED':
      case 'PDF_ENCRYPTED':
      case 'PDF_INVALID':
      case 'PDF_RUNTIME':
      case 'PDF_IRREVERSIBLE':
        return new RelayError('UNSUPPORTED', error.message);
      case 'PDF_LOCATE':
      case 'PDF_APPLY':
      case 'PDF_RESIDUAL':
      case 'PDF_METADATA':
        return new RelayError('INTERNAL', 'PDF redaction failed; the file was not sent');
    }
  }
  return new RelayError('INTERNAL', 'PDF processing failed; the file was not sent');
}

/**
 * PDF path: redaction happens in the offscreen document (Chrome) or background
 * page (Safari). Only the masked bytes and one file record cross back; the
 * vault itself never leaves the background. PDFs are one-way, so no entities
 * or occurrences are added to the vault (filename masking still can).
 *
 * The vault lock is held only for identity resolution and the final merge:
 * the PDF engine can take up to 45 s and must not block restore/upload
 * (R2-M3). A newly created vault is persisted during resolution, so a second
 * PDF or TXT upload in the same chat joins it instead of creating a duplicate
 * (R3-M1). After the run the vault is re-read by id under the lock; a vault
 * deleted meanwhile is a tombstone, never recreated from the stale reference.
 */
async function processAnonymizePdf(
  input: AnonymizeFileInput,
  settings: AppSettings,
  config: DetectionConfig,
  epoch: number,
): Promise<AnonymizeFileOutput> {
  let created = false;
  const reference = await withVaultLock(async () => {
    const resolved = await resolveUploadVault(input);
    created = !(await getVault(resolved.id));
    if (created) {
      await saveVault(resolved, epoch);
    }
    return resolved;
  });
  acquirePdfRun(reference.id);

  let run: Awaited<ReturnType<typeof runPdfAnonymize>>;
  try {
    run = await runPdfAnonymize({
      bytes: input.bytes,
      name: input.name,
      mime: input.mime,
      vaultId: reference.id,
      vaultPrefix: reference.prefix,
      config,
      maxBytes: settings.maxBytes,
    });
  } catch (error) {
    const remaining = releasePdfRun(reference.id);
    // The last failed run removes the vault if no other run shares it, even
    // when this run joined a vault persisted by a concurrent PDF (R4-N1).
    if (remaining === 0) {
      try {
        await deleteVaultIfEmpty(reference.id, epoch);
      } catch {
        // Best-effort cleanup; report the original PDF failure.
      }
    }
    throw relayErrorFromPdf(error);
  }

  try {
    return await withVaultLock(async () => {
      if (epoch !== getVaultEpoch()) {
        throw new RelayError('INTERNAL', 'Vault generation changed; save rejected');
      }

      // Re-read the vault: another writer may have added entities/files while
      // the engine was running. It was persisted at resolution, so a missing
      // record means delete/clear — never resurrect the stale reference.
      const vault = await getVault(reference.id);
      if (!vault) {
        throw new RelayError('INTERNAL', 'Vault was deleted; the file was not saved');
      }
      for (const chatId of reference.chatIds) {
        if (!vault.chatIds.includes(chatId)) vault.chatIds.push(chatId);
      }

      const maskedName = settings.maskFilenames
        ? maskFileName(vault, input.name, config)
        : input.name;
      vault.files.push({ ...run.file, maskedName });
      await saveVault(vault, epoch);

      return {
        maskedBytes: run.maskedBytes,
        maskedName,
        maskedMime: maskedMimeFor(undefined, 'pdf', input.mime),
        format: 'pdf',
        // True redaction leaves no restore mapping in the document body.
        entities: [],
        warnings: run.warnings,
        vaultId: vault.id,
        vaultPrefix: vault.prefix,
      };
    });
  } finally {
    releasePdfRun(reference.id);
  }
}

function assertEnabled(settings: AppSettings): void {
  // Enforced in the background too: content scripts check the flag first, but
  // a stale page or a direct caller must never anonymize/restore while off.
  if (!settings.enabled) {
    throw new RelayError('DISABLED', 'Protection is disabled');
  }
}

export async function processAnonymize(input: AnonymizeFileInput): Promise<AnonymizeFileOutput> {
  // Captured before any await: "clear data" bumps the generation and a save
  // from this run must then fail instead of resurrecting the vault.
  const epoch = getVaultEpoch();

  if (isPdfRoute(input.name, input.mime)) {
    const settings = await getSettings();
    assertEnabled(settings);
    assertWithinLimit(input.bytes.byteLength, settings.maxBytes);

    const settingsConfig = detectionConfigFromSettings(settings.detection);
    const config: DetectionConfig = input.config
      ? { ...settingsConfig, ...input.config }
      : settingsConfig;

    // PDF runs outside the vault lock; only identity resolution and the final
    // save take it (R2-M3).
    return processAnonymizePdf(input, settings, config, epoch);
  }

  return withVaultLock(async () => {
    const settings = await getSettings();
    assertEnabled(settings);
    assertWithinLimit(input.bytes.byteLength, settings.maxBytes);

    const settingsConfig = detectionConfigFromSettings(settings.detection);
    const config: DetectionConfig = input.config
      ? { ...settingsConfig, ...input.config }
      : settingsConfig;

    const adapter = adapterFor(input.name, input.mime);
    const vault = await resolveUploadVault(input);

    let result: Awaited<ReturnType<FormatAdapter['anonymize']>>;
    try {
      result = await adapter.anonymize(
        { name: input.name, mimeType: input.mime, bytes: input.bytes },
        {
          vault,
          maxBytes: settings.maxBytes,
          config,
          skipCode: settings.detection.skipCode,
        },
      );
    } catch (error) {
      // Fail closed: the vault was not saved yet, so no partial record or
      // output survives a rejected archive (P1-ZIP64-ENCRYPTED) or a
      // name-dense document (TOO_MANY_ENTITIES).
      throw archiveRelayError(error) ?? densityRelayError(error) ?? error;
    }

    // The adapter recorded the original name; mask it before persisting so the
    // metadata hook never sends PII in `file_name`. Legacy adapters return the
    // converted name (`.doc` -> `.docx`, `.xls` -> `.xlsx`), so the unmasked name
    // keeps the new extension when filename masking is disabled.
    const unmaskedName = result.maskedName;
    const maskSource = unmaskedName !== input.name ? unmaskedName : input.name;
    const maskedName = settings.maskFilenames
      ? maskFileName(vault, maskSource, config)
      : unmaskedName;
    const fileRecord = vault.files[vault.files.length - 1];
    if (fileRecord && fileRecord.originalName === input.name) {
      fileRecord.maskedName = maskedName;
    }

    // The adapter mutates the vault in place; persist only a completed run.
    await saveVault(vault, epoch);

    return {
      maskedBytes: result.maskedBytes,
      maskedName,
      maskedMime: maskedMimeFor(result.maskedMime, result.format, input.mime),
      format: result.format,
      entities: safeEntities(result.entities),
      warnings: result.warnings,
      vaultId: vault.id,
      vaultPrefix: vault.prefix,
    };
  });
}

export interface RestoreFileInput {
  bytes: Uint8Array;
  name: string;
  mime: string;
  chatId?: string;
  /** Pending id used on `/` before the SPA navigated to `/c/<id>`. */
  pendingChatId?: string;
  prefix?: string;
}

/** In-process output always carries raw bytes; the router base64-encodes it. */
export type RestoreFileOutput = Omit<RestoreFileResult, 'bytes'> & { bytes: Uint8Array };

/**
 * Manual restore outside ChatGPT has neither a vault prefix in the name nor a
 * chat id. Identity is then the hash of the masked bytes saved by this device:
 * the download must match exactly one unlocked vault. A vault that contains
 * the hash but cannot separate its own records, and several matching vaults,
 * both fail closed instead of guessing which occurrence list to replay.
 */
async function resolveVaultByMaskedBytes(
  name: string,
  bytes: Uint8Array,
): Promise<Vault | undefined> {
  const maskedSha256 = await sha256Hex(bytes);
  const matches: Vault[] = [];

  for (const id of await listVaultIds()) {
    // Decryption ("unlocked" + integrity) is enforced by `getVault`; a vault
    // that cannot be read never becomes a restore candidate.
    const vault = await getVault(id);
    if (!vault?.files.some((file) => file.maskedSha256 === maskedSha256)) continue;

    try {
      const record = await resolveVaultFile(vault, { name, bytes });
      // A legacy name-only match is not an identity proof; only the stored
      // masked hash selects a vault here.
      if (record?.maskedSha256 !== maskedSha256) continue;
      matches.push(vault);
    } catch (error) {
      if (error instanceof IdentityMismatchVaultFileError) continue;
      if (error instanceof AmbiguousVaultFileError) {
        // The bytes are in this vault but its records cannot prove which file
        // produced them; another vault would be a guess, not a resolution.
        throw new RelayError('NO_VAULT', 'Masked bytes match more than one vault record');
      }
      throw error;
    }
  }

  if (matches.length > 1) {
    throw new RelayError('NO_VAULT', 'Masked bytes match several vaults');
  }
  return matches[0];
}

async function resolveRestoreVault(input: {
  name: string;
  bytes?: Uint8Array;
  chatId?: string;
  pendingChatId?: string;
  prefix?: string;
}): Promise<Vault> {
  // The tag prefix is the primary download lookup (spec §8.1); a prefix in the
  // masked file name is used when the caller did not extract one itself.
  const explicitPrefix = input.prefix?.toUpperCase();
  const namePrefix = parseTags(input.name)[0]?.prefix;
  const prefix = explicitPrefix ?? namePrefix;

  if (prefix) {
    const vault = await getVaultByPrefix(prefix);
    if (!vault) throw new RelayError('NO_VAULT', 'No vault matches the file prefix');
    return vault;
  }

  for (const chatId of [input.chatId, input.pendingChatId]) {
    if (!chatId) continue;
    const vault = await getVaultByChat(chatId);
    if (vault) return vault;
  }

  // Manual mode outside ChatGPT: the popup sends no prefix (a clean masked
  // name has no tags) and no chat id, so resolve by masked bytes alone.
  if (input.bytes !== undefined) {
    const vault = await resolveVaultByMaskedBytes(input.name, input.bytes);
    if (vault) return vault;
  }

  throw new RelayError('NO_VAULT', 'No vault matches the file identity');
}

/** Restores a tagged name even when no matching `VaultFile` record exists. */
function restoreFileName(fileName: string, vault: Vault): string {
  const mapped = vault.filenameMap.find((entry) => entry.masked === fileName);
  if (mapped) return mapped.original;
  if (parseTags(fileName).length === 0) return fileName;
  return restoreText(fileName, vault, { mode: 'canonical' }).text;
}

function restoreWarnings(unknownTags: readonly string[]): string[] {
  return unknownTags.length > 0 ? [`${unknownTags.length} unknown tag(s) left untouched`] : [];
}

export async function processRestore(input: RestoreFileInput): Promise<RestoreFileOutput> {
  return withVaultLock(async () => {
    const settings = await getSettings();
    assertEnabled(settings);
    // PDF redaction is one-way; the download hook passes PDF bytes through.
    if (isPdfRoute(input.name, input.mime)) {
      throw new RelayError('UNSUPPORTED', PDF_IRREVERSIBLE_MESSAGE);
    }
    assertWithinLimit(input.bytes.byteLength, settings.maxBytes);
    const adapter = adapterFor(input.name, input.mime);
    const vault = await resolveRestoreVault(input);

    let result: Awaited<ReturnType<FormatAdapter['restore']>>;
    try {
      result = await adapter.restore(
        { name: input.name, mimeType: input.mime, bytes: input.bytes },
        vault,
      );
    } catch (error) {
      const archive = archiveRelayError(error);
      if (archive) throw archive;
      if (
        error instanceof AmbiguousVaultFileError ||
        error instanceof IdentityMismatchVaultFileError
      ) {
        // Fail closed without leaking file names: the download stays masked.
        throw new RelayError(
          'INTERNAL',
          'Vault file identity does not match; the file was left unchanged',
        );
      }
      throw error;
    }

    return {
      bytes: result.bytes,
      fileName: restoreFileName(result.fileName, vault),
      replacements: result.replacements,
      unknownTags: result.unknownTags,
      warnings: result.warnings,
    };
  });
}

export interface RestoreNameInput {
  name: string;
  chatId?: string;
  pendingChatId?: string;
  prefix?: string;
}

/**
 * Restores tags in a download metadata `file_name` (spec §5.1 step 2). Canonical
 * mode is deliberate: a filename has no reliable occurrence order and the JSON
 * step must not depend on the body parse.
 */
export async function processRestoreName(input: RestoreNameInput): Promise<RestoreNameResult> {
  return withVaultLock(async () => {
    assertEnabled(await getSettings());
    const vault = await resolveRestoreVault(input);
    const restored = restoreText(input.name, vault, { mode: 'canonical' });

    return {
      fileName: restored.text,
      replacements: restored.replacements,
      unknownTags: restored.unknownTags,
      warnings: restoreWarnings(restored.unknownTags),
    };
  });
}
