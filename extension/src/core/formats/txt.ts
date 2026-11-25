/**
 * TXT format adapter (M1a). Uploads are always UTF-8 without BOM; the original
 * encoding/BOM/EOL are recorded in `vault.files` and reapplied on restore.
 */

import { ensureStructuredScanner } from '../detect/wasm-scan';
import {
  anonymizeText,
  createFileRestoreSession,
  type RestoreTextOptions,
  restoreText,
} from '../masker';
import { AmbiguousVaultFileError, IdentityMismatchVaultFileError } from '../restore-identity';
import { parseTags } from '../tag';
import type {
  AnonymizeContext,
  AnonymizeResult,
  Eol,
  FileInput,
  FormatAdapter,
  RestoreResult,
  Vault,
  VaultFile,
} from '../types';

export type TxtEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251';

export interface DetectedEncoding {
  encoding: TxtEncoding;
  /** Source started with a BOM (UTF-8 or UTF-16). */
  bom: boolean;
  /**
   * The bytes are plausible in more than one encoding (BOM-less UTF-16 tie or
   * valid UTF-8 that also decodes as strong-script UTF-16). The encoding was
   * inferred heuristically; callers surface a warning instead of pretending
   * the choice is certain (EMP-R2/R4-N2).
   */
  ambiguous?: boolean;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * Plausibility check for the BOM-less UTF-16 heuristic: real text consists of
 * Unicode letters, marks, numbers, punctuation, symbols and separators (this
 * includes €, emoji, CJK, Greek and Hebrew). Arbitrary single-byte or binary
 * data decoded as UTF-16 usually produces controls, private-use code points or
 * unassigned garbage.
 */
const PRINTABLE_UNICODE = /[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}]/u;

function decodedLooksLikeText(text: string): boolean {
  if (text.length === 0) return false;
  let good = 0;
  let bad = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d || PRINTABLE_UNICODE.test(char)) {
      good += 1;
    } else {
      bad += 1;
    }
  }
  return good > 0 && bad / (good + bad) <= 0.05;
}

/**
 * Scripts whose letters are strong evidence for the endianness at a tie.
 * Han is included: CJK-only text has no NUL parity signal, and a wrong
 * endianness usually turns most Han pairs into a mix of Han and rare scripts
 * (Tifinagh, Hangul, symbols), which scores lower (EMP-R2).
 */
const STRONG_SCRIPT =
  /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Latin}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Han}]/u;

/** Every code point is a strong-script letter; no digits/punctuation/spaces. */
function isStrongScriptOnly(text: string): boolean {
  if (text.length === 0) return false;
  for (const char of text) {
    if (!STRONG_SCRIPT.test(char)) return false;
  }
  return true;
}

function astralCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0xffff) count += 1;
  }
  return count;
}

/**
 * Language-statistics tie-break for BOM-less UTF-16: both endiannesses can
 * decode to printable text (a BE Cyrillic word reads as CJK in LE), so count
 * strong-script letters and prefer the decode that yields more of them.
 * Astral code points (emoji) decide first: a valid surrogate pair is very
 * unlikely in the wrong endianness. CJK-only text is covered by Han in
 * STRONG_SCRIPT; a remaining exact tie is reported as ambiguous instead of
 * silently assuming LE.
 */
function scriptScore(text: string): number {
  let score = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0xffff) score += 2;
    else if (STRONG_SCRIPT.test(char)) score += 2;
    else if (PRINTABLE_UNICODE.test(char)) score += 1;
  }
  return score;
}

interface Utf16Candidate {
  encoding: 'utf-16le' | 'utf-16be';
  text: string;
}

function decodeUtf16(raw: Uint8Array, encoding: 'utf-16le' | 'utf-16be'): string | undefined {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(raw);
    return decodedLooksLikeText(text) ? text : undefined;
  } catch {
    // Ill-formed surrogate pairs belong to the other endianness.
    return undefined;
  }
}

function utf16Candidates(bytes: Uint8Array): Utf16Candidate[] {
  const candidates: Utf16Candidate[] = [];
  for (const encoding of ['utf-16le', 'utf-16be'] as const) {
    const text = decodeUtf16(bytes, encoding);
    if (text !== undefined) candidates.push({ encoding, text });
  }
  return candidates;
}

function pickUtf16Candidate(candidates: Utf16Candidate[]):
  | {
      encoding: 'utf-16le' | 'utf-16be';
      ambiguous: boolean;
    }
  | undefined {
  if (candidates.length === 0) return undefined;
  // Stable order LE-first, so an exact tie keeps the documented LE default.
  const ranked = [...candidates].sort((left, right) => {
    const astral = astralCount(right.text) - astralCount(left.text);
    if (astral !== 0) return astral;
    return scriptScore(right.text) - scriptScore(left.text);
  });
  const best = ranked[0];
  if (!best) return undefined;
  const second = ranked[1];
  const ambiguous =
    second !== undefined &&
    astralCount(second.text) === astralCount(best.text) &&
    scriptScore(second.text) === scriptScore(best.text);
  return { encoding: best.encoding, ambiguous };
}

/**
 * BOM-less UTF-16: a decode-plausibility heuristic. Returns undefined when
 * neither endianness decodes to text.
 */
function detectUtf16WithoutBom(
  bytes: Uint8Array,
): { encoding: 'utf-16le' | 'utf-16be'; ambiguous: boolean } | undefined {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return undefined;

  // ASCII/Latin code units carry a NUL in the high byte: the second byte of an
  // LE unit or the first byte of a BE unit. Only count a NUL when its partner
  // is ASCII: the low byte of an emoji surrogate (e.g. `00 DE`) is not an
  // endianness signal (EMP-R2-v2). CJK-only text has none.
  let evenZeros = 0; // BE ASCII units: first byte 0, second byte ASCII
  let oddZeros = 0; // LE ASCII units: second byte 0, first byte ASCII
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    if (second < 0x80 && first === 0) evenZeros += 1;
    else if (first < 0x80 && second === 0) oddZeros += 1;
  }

  if (evenZeros !== oddZeros) {
    // One endianness leaves the NULs at the expected parity: that signal wins.
    for (const encoding of evenZeros > oddZeros
      ? (['utf-16be', 'utf-16le'] as const)
      : (['utf-16le', 'utf-16be'] as const)) {
      if (decodeUtf16(bytes, encoding) !== undefined) return { encoding, ambiguous: false };
    }
    return undefined;
  }

  // No NUL signal (e.g. "Договор 😀" where the space and the emoji cancel
  // out): rank both decodes by astral code points, then strong-script score.
  return pickUtf16Candidate(utf16Candidates(bytes));
}

/**
 * UTF-8-first policy (EMP-R2-v2): a valid printable UTF-8 decode is
 * authoritative. Every even-length byte buffer can also be read as UTF-16 and
 * ordinary ASCII text (`ivan@example.ru!`, URLs, code) frequently decodes to
 * CJK under that reading, so a strong-script UTF-16 candidate alone never
 * justifies reinterpreting valid UTF-8. BOM-less UTF-16 is inferred only when
 * UTF-8 is invalid or decodes to controls/non-text (see `detectEncoding`).
 *
 * A remaining alternative reading is reported, not resolved. To keep short
 * buffers free of noise (R5-N2: `a>bc`), the warning requires both a
 * meaningful byte length and a multi-character strong-script phrase. A
 * genuinely short CJK-only BOM-less file whose bytes happen to form printable
 * ASCII is therefore read as UTF-8 without a warning; this accepted NIT is
 * documented in the spec.
 */
const AMBIGUOUS_MIN_BYTES = 16;
const AMBIGUOUS_MIN_STRONG_UNITS = 2;

function strongScriptUnitCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if (STRONG_SCRIPT.test(char)) count += 1;
  }
  return count;
}

/**
 * Even when UTF-8 wins, the same bytes may decode as a strong-script UTF-16
 * phrase. That is a genuine ambiguity (EMP-R2), so the caller warns instead
 * of silently pretending the UTF-8 reading is certain. The threshold keeps
 * short ASCII such as `a>bc` from producing a false warning (R5-N2).
 */
function utf8VsUtf16Ambiguous(bytes: Uint8Array, utf8Text: string): boolean {
  if (bytes.length < AMBIGUOUS_MIN_BYTES || bytes.length % 2 !== 0) return false;
  if (/[\p{Z}\t\r\n]/u.test(utf8Text)) return false;
  if (!/[^\p{L}\p{N}]/u.test(utf8Text)) return false;
  return utf16Candidates(bytes).some(
    (candidate) =>
      isStrongScriptOnly(candidate.text) &&
      strongScriptUnitCount(candidate.text) >= AMBIGUOUS_MIN_STRONG_UNITS,
  );
}

/** BOM sniffing, BOM-less UTF-16 heuristic, fatal UTF-8, then Windows-1251. */
export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (startsWith(bytes, UTF8_BOM)) {
    return { encoding: 'utf-8', bom: true };
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { encoding: 'utf-16le', bom: true };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { encoding: 'utf-16be', bom: true };
  }

  // UTF-16 without a BOM must be distinguished from UTF-8. Plain UTF-8 wins
  // whenever it decodes to plausible text; its bytes may also decode as CJK
  // UTF-16 pairs, but that alternative reading is only reported, never chosen
  // (EMP-R2-v2). A real BOM-less UTF-16 file decodes as UTF-8 to controls/
  // NULs (implausible) or is not valid UTF-8 at all.
  let validUtf8 = false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    validUtf8 = true;
    if (decodedLooksLikeText(text)) {
      if (utf8VsUtf16Ambiguous(bytes, text)) {
        return { encoding: 'utf-8', bom: false, ambiguous: true };
      }
      return { encoding: 'utf-8', bom: false };
    }
  } catch {
    // Not UTF-8; try the UTF-16 heuristic below.
  }

  const bomlessUtf16 = detectUtf16WithoutBom(bytes);
  if (bomlessUtf16) {
    return {
      encoding: bomlessUtf16.encoding,
      bom: false,
      ...(bomlessUtf16.ambiguous ? { ambiguous: true } : {}),
    };
  }

  if (validUtf8) return { encoding: 'utf-8', bom: false };

  // Any byte sequence is valid in a single-byte legacy encoding; 1251 is
  // the target corpus default (docs_masked uses chardet, which is heavier).
  return { encoding: 'windows-1251', bom: false };
}

function bomLength(encoding: TxtEncoding): number {
  return encoding === 'utf-8' ? 3 : 2;
}

/** Decodes bytes with the detected encoding, stripping the BOM if present. */
export function decodeTextBytes(bytes: Uint8Array, encoding: TxtEncoding, bom: boolean): string {
  const body = bom ? bytes.subarray(bomLength(encoding)) : bytes;
  const decoder = new TextDecoder(encoding, {
    fatal: encoding !== 'windows-1251',
  });
  return decoder.decode(body);
}

let cp1251Reverse: Map<string, number> | undefined;

/** Lazily builds a Unicode -> CP1251 byte table using TextDecoder. */
function cp1251Table(): Map<string, number> {
  if (cp1251Reverse) return cp1251Reverse;

  const decoder = new TextDecoder('windows-1251');
  const table = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) {
    const char = decoder.decode(Uint8Array.of(byte));
    if (char.length === 1 && char !== '\uFFFD') table.set(char, byte);
  }
  cp1251Reverse = table;
  return table;
}

function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const offset = i * 2;
    if (littleEndian) {
      out[offset] = code & 0xff;
      out[offset + 1] = code >> 8;
    } else {
      out[offset] = code >> 8;
      out[offset + 1] = code & 0xff;
    }
  }
  return out;
}

/**
 * Encodes text for restore. Throws instead of silently replacing characters
 * that the original single-byte encoding cannot represent (fail-closed).
 */
export function encodeTextBytes(text: string, encoding: TxtEncoding, bom = false): Uint8Array {
  if (encoding === 'utf-8') {
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const out = new Uint8Array(UTF8_BOM.length + body.length);
    out.set(UTF8_BOM, 0);
    out.set(body, UTF8_BOM.length);
    return out;
  }

  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const body = encodeUtf16(text, encoding === 'utf-16le');
    if (!bom) return body;
    const prefix = encoding === 'utf-16le' ? UTF16LE_BOM : UTF16BE_BOM;
    const out = new Uint8Array(prefix.length + body.length);
    out.set(prefix, 0);
    out.set(body, prefix.length);
    return out;
  }

  const table = cp1251Table();
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const byte = table.get(char);
    if (byte === undefined) {
      throw new Error('Text is not representable in windows-1251');
    }
    out.push(byte);
  }
  return Uint8Array.from(out);
}

/** Dominant line ending; ties prefer CRLF, then LF. */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/gu) ?? []).length;
  const withoutCrlf = text.replace(/\r\n/gu, '');
  const lf = (withoutCrlf.match(/\n/gu) ?? []).length;
  const cr = (withoutCrlf.replace(/\n/gu, '').match(/\r/gu) ?? []).length;

  if (crlf === 0 && lf === 0 && cr === 0) return 'lf';
  if (crlf >= lf && crlf >= cr) return 'crlf';
  if (lf >= cr) return 'lf';
  return 'cr';
}

/** Rewrites every line ending to the requested style. */
export function applyEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  if (eol === 'lf') return lf;
  if (eol === 'crlf') return lf.replace(/\n/gu, '\r\n');
  return lf.replace(/\n/gu, '\r');
}

/** SHA-256 through WebCrypto (Node 24, Chromium and Safari all provide it). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Validates a stored encoding name; unknown values fall back to UTF-8. */
export function parseTxtEncoding(value: string | undefined): TxtEncoding | undefined {
  if (
    value === 'utf-8' ||
    value === 'utf-16le' ||
    value === 'utf-16be' ||
    value === 'windows-1251'
  ) {
    return value;
  }
  return undefined;
}

function namedVaultFiles(vault: Vault, name: string): VaultFile[] {
  return vault.files.filter((record) => record.maskedName === name || record.originalName === name);
}

/**
 * Looks up a vault record by masked or original file name. A name shared by
 * several records is ambiguous: legacy selection liked the last record, which
 * silently restored one file's occurrences into another. Returns `undefined`
 * only when no record matches.
 */
export function findVaultFile(vault: Vault, name: string): VaultFile | undefined {
  const matches = namedVaultFiles(vault, name);
  if (matches.length > 1) {
    throw new AmbiguousVaultFileError(
      'several vault files share this name; restore needs the original masked bytes',
    );
  }
  return matches[0];
}

/**
 * A legacy record has no stored masked bytes hash, so its own bytes cannot be
 * verified. A file that carries tags minted by another vault is not a masked
 * output of this one: the name match alone must not unlock the global
 * occurrence list (R18-RESTORE-LEGACY-NEW).
 */
function assertLegacyMaskedContent(vault: Vault, bytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (parseTags(text).some((tag) => tag.prefix !== vault.prefix)) {
    throw new IdentityMismatchVaultFileError(
      "the file carries tags from another vault; legacy restore needs this vault's masked bytes",
    );
  }
}

export type FormatClass = 'text' | 'word' | 'sheet' | 'pdf' | 'unknown';

/**
 * Format families whose masked output can collide byte-for-byte. Text masks
 * are UTF-8 text; DOCX and DOC masks are WordprocessingML OOXML containers
 * (a `.doc` record is stored as DOCX, so both spellings mean the same class);
 * XLSX and XLS masks are SpreadsheetML containers (likewise); PDF redaction is
 * neither. An unhashed legacy record therefore blocks only a hashed download
 * of its own class: a legacy DOCX cannot own XLSX masked bytes, and the
 * earlier single `binary` class over-blocked every DOCX/XLSX pair
 * (R21-FORMAT-CLASS, R21-BINARY-CLASS-OVERBLOCK).
 *
 * Imported vaults validate `files[].format`, but a record from a newer or
 * corrupted vault may still reach runtime: an unrecognized format is
 * `unknown`, not `undefined`, so callers can fail closed (R22-IDENT-1).
 */
export function formatClassOf(format: string): FormatClass {
  switch (format) {
    case 'txt':
    case 'md':
    case 'json':
    case 'xml':
    case 'html':
      return 'text';
    case 'pdf':
      return 'pdf';
    case 'docx':
    case 'doc':
      return 'word';
    case 'xlsx':
    case 'xls':
      return 'sheet';
    default:
      return 'unknown';
  }
}

/**
 * Runtime format class of a vault record. Import validation rejects a missing
 * or unknown `format`, but a corrupted/unmigrated record may still reach
 * restore: a missing value is `unknown` and can never be returned as a match
 * (R2/R23-IDENT-2).
 */
function knownFormatClass(record: Pick<VaultFile, 'format'>): FormatClass {
  const format: unknown = record.format;
  return typeof format === 'string' ? formatClassOf(format) : 'unknown';
}

/**
 * Restore identity: masked bytes hash first, then a unique legacy name.
 * Records written before `maskedSha256` existed fall back to the name; once a
 * vault has hashed records, a name match against one of them without a hash
 * match means the bytes were modified or are foreign, and identical masked
 * bytes under several records cannot be split by name. Both cases fail closed
 * instead of replaying the wrong record's occurrences.
 *
 * A legacy record without a hash can still own bytes that were masked before
 * the hash existed: its bytes could be byte-identical to a hashed record's
 * masked output while its occurrence scope differs (R18-RESTORE-LEGACY-NEW).
 * Such a vault cannot prove which record a download came from, so a unique
 * hash match fails closed while a legacy record of the same format class
 * remains (R21-FORMAT-CLASS). Legacy-only vaults keep the global fallback,
 * but only for a name that matches the record and for bytes that carry no
 * foreign-vault tags.
 */
export async function resolveVaultFile(
  vault: Vault,
  file: Pick<FileInput, 'name' | 'bytes'>,
): Promise<VaultFile | undefined> {
  if (vault.files.length === 0) return undefined;
  // Legacy vaults carry no masked hash; hashing their bytes cannot match.
  if (!vault.files.some((record) => record.maskedSha256 !== undefined)) {
    const legacy = findVaultFile(vault, file.name);
    if (!legacy) {
      throw new IdentityMismatchVaultFileError(
        'no legacy vault record matches the file name; its masked bytes cannot be verified',
      );
    }
    // A record without a known format cannot be classified: returning it
    // would replay an unverifiable occurrence scope (R2/R23-IDENT-2).
    if (knownFormatClass(legacy) === 'unknown') {
      throw new IdentityMismatchVaultFileError(
        'the vault record has an unknown format; its masked bytes cannot be classified',
      );
    }
    assertLegacyMaskedContent(vault, file.bytes);
    return legacy;
  }
  const maskedSha256 = await sha256Hex(file.bytes);
  const byHash = vault.files.filter((record) => record.maskedSha256 === maskedSha256);
  if (byHash.length > 1) {
    throw new AmbiguousVaultFileError(
      'several vault files carry identical masked bytes; the restore target is unclear',
    );
  }
  if (byHash.length === 1) {
    const match = byHash[0];
    if (!match) return undefined;
    const matchClass = knownFormatClass(match);
    // A record whose persisted format is not a known `FileFormat` cannot be
    // classified: returning it would replay an unverifiable occurrence scope
    // into this download (R22-IDENT-1).
    if (matchClass === 'unknown') {
      throw new IdentityMismatchVaultFileError(
        'the vault record has an unknown format; its masked bytes cannot be classified',
      );
    }
    // Only an unhashed record of the same format class can own bytes that are
    // byte-identical to this download. Masked bytes never collide across the
    // text, word, sheet and PDF classes, so a legacy record of another class
    // must not block this restore (R21-FORMAT-CLASS, R21-BINARY-CLASS-OVERBLOCK).
    // An unknown class could be any class, so it blocks every hashed restore.
    if (
      vault.files.some((record) => {
        if (record.maskedSha256 !== undefined) return false;
        const recordClass = knownFormatClass(record);
        return recordClass === 'unknown' || recordClass === matchClass;
      })
    ) {
      throw new AmbiguousVaultFileError(
        'the vault has legacy records of the same format class without masked bytes hashes; their bytes could be identical to this download',
      );
    }
    return match;
  }

  const named = namedVaultFiles(vault, file.name);
  if (named.some((record) => record.maskedSha256 !== undefined)) {
    throw new IdentityMismatchVaultFileError(
      'the file name matches a vault record but the masked bytes differ',
    );
  }
  if (named.length === 1) {
    const legacy = named[0];
    if (!legacy) return undefined;
    // Mixed-byHash0 fallback: a name-only legacy match is still a vault
    // record, so an unknown/missing format fails closed here as well
    // (R2/R23-IDENT-2).
    if (knownFormatClass(legacy) === 'unknown') {
      throw new IdentityMismatchVaultFileError(
        'the vault record has an unknown format; its masked bytes cannot be classified',
      );
    }
    return legacy;
  }
  if (named.length > 1) {
    throw new AmbiguousVaultFileError(
      'several legacy vault files share this name; restore needs the original masked bytes',
    );
  }
  throw new IdentityMismatchVaultFileError(
    'no vault record matches the masked bytes or the file name',
  );
}

export async function anonymizeTxt(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();

  const detected = detectEncoding(file.bytes);
  const text = decodeTextBytes(file.bytes, detected.encoding, detected.bom);
  const eol = detectEol(text);
  const sha256 = await sha256Hex(file.bytes);
  const warnings: string[] = [];
  if (!detected.bom && (detected.encoding === 'utf-16le' || detected.encoding === 'utf-16be')) {
    warnings.push('UTF-16 without BOM detected; the encoding was inferred');
  }
  if (detected.ambiguous) {
    warnings.push('Text encoding is ambiguous; UTF-8/UTF-16 was inferred');
  }

  const occurrenceStart = ctx.vault.occurrences.length;
  const result = anonymizeText(text, ctx.config, ctx.vault);
  const vault = result.vault;

  const maskedBytes = encodeTextBytes(result.maskedText, 'utf-8', false);
  const occurrenceCount = vault.occurrences.length - occurrenceStart;

  vault.files.push({
    originalName: file.name,
    // Filename masking is part of the upload hook (M3); M1a keeps the name.
    maskedName: file.name,
    format: 'txt',
    size: file.bytes.byteLength,
    sha256,
    maskedSha256: await sha256Hex(maskedBytes),
    encoding: detected.encoding,
    bom: detected.bom,
    eol,
    occurrenceStart,
    occurrenceCount,
  });

  return {
    maskedBytes,
    maskedName: file.name,
    format: 'txt',
    entities: result.entities,
    occurrences: vault.occurrences.slice(occurrenceStart),
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings: [...result.warnings, ...warnings],
  };
}

export async function restoreTxt(
  file: FileInput,
  vault: Vault,
  options: RestoreTextOptions = {},
): Promise<RestoreResult> {
  let maskedText: string;
  try {
    // Masked files are produced as UTF-8; TextDecoder strips an optional BOM.
    maskedText = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new Error('Masked TXT file is not valid UTF-8');
  }

  const record = await resolveVaultFile(vault, file);
  const session = options.session ?? createFileRestoreSession(vault, record);
  const restored = restoreText(maskedText, vault, { ...options, session });
  // The masked text already carries the source EOL layout verbatim. Applying
  // the dominant EOL again would rewrite mixed endings (M8-M1-TXT).
  const text = restored.text;

  const encoding = parseTxtEncoding(record?.encoding) ?? 'utf-8';
  const bytes = encodeTextBytes(text, encoding, record?.bom ?? false);
  // Hash matching also finds a record when the download name was changed;
  // in that case keep the caller's name so its tags are restored as before.
  const fileName =
    record && (record.maskedName === file.name || record.originalName === file.name)
      ? record.originalName
      : file.name;

  const warnings: string[] = [];
  if (restored.unknownTags.length > 0) {
    warnings.push(`${restored.unknownTags.length} unknown tag(s) left untouched`);
  }

  return {
    bytes,
    fileName,
    replacements: restored.replacements,
    unknownTags: restored.unknownTags,
    warnings,
  };
}

/** Adapter shape for the future format router; not registered in the UI yet. */
export const txtFormatAdapter: FormatAdapter = {
  format: 'txt',
  extensions: ['.txt'],
  mimeTypes: ['text/plain'],
  canHandle(file) {
    return /\.txt$/iu.test(file.name) || file.mimeType.toLowerCase() === 'text/plain';
  },
  anonymize(file, ctx) {
    return anonymizeTxt(file, ctx);
  },
  restore(file, vault) {
    return restoreTxt(file, vault);
  },
};
