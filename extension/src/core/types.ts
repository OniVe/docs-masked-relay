/**
 * Core domain contracts for DocsMasked Relay.
 *
 * M0 only fixes the shapes; detection, vault storage and format handling are
 * implemented in later milestones (M1-M5).
 */

export const VAULT_SCHEMA = 'dmrelay/1' as const;

export type VaultSchema = typeof VAULT_SCHEMA;

export type EntityLabel =
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'SNILS'
  | 'INN'
  | 'OGRN'
  | 'KPP'
  | 'BIK'
  | 'ACCOUNT'
  | 'CARD'
  | 'IBAN'
  | 'PASSPORT'
  | 'ADDRESS'
  | 'ORG'
  | 'DATE'
  | 'BIRTHDATE'
  | 'DOCDATE'
  | 'POLICY'
  | 'LICENSE'
  | 'PLATE'
  | 'IP'
  | 'URL'
  | 'HANDLE'
  | 'DOCNUM'
  | 'SECRET'
  | 'CUSTOM';

/** Every label the vault can hold, in UI order. */
export const ALL_LABELS: readonly EntityLabel[] = [
  'PERSON',
  'EMAIL',
  'PHONE',
  'SNILS',
  'INN',
  'OGRN',
  'KPP',
  'BIK',
  'ACCOUNT',
  'CARD',
  'IBAN',
  'PASSPORT',
  'ADDRESS',
  'ORG',
  'DATE',
  'BIRTHDATE',
  'DOCDATE',
  'POLICY',
  'LICENSE',
  'PLATE',
  'IP',
  'URL',
  'HANDLE',
  'DOCNUM',
  'SECRET',
  'CUSTOM',
];

export type FileFormat =
  | 'docx'
  | 'xlsx'
  | 'txt'
  | 'md'
  | 'pdf'
  | 'doc'
  | 'xls'
  | 'json'
  | 'xml'
  | 'html';

/** Dominant line ending of a text file. */
export type Eol = 'lf' | 'crlf' | 'cr';

/**
 * Detector configuration. Mirrors the docs_masked knobs that M1 needs;
 * ORG/ADDRESS specific options arrive with their detectors.
 */
export interface DetectionConfig {
  /** Allowed labels. Omitted means "all defaults" (everything except DATE/URL). */
  labels?: Set<EntityLabel>;
  /** Enables standalone single-surname PERSON detection (docs_masked). */
  aggressive?: boolean;
  /**
   * Enables detection of a lone known first name (for example a Markdown link
   * label `[Иван](...)` or image alt `![Иван](...)`). Off by default; only
   * the MD adapter opts in for labels/alt text, where a person's name is the
   * expected content.
   */
  loneFirstNames?: boolean;
  /**
   * Literal substrings masked as CUSTOM, case-insensitive. A line may carry
   * `term => LABEL` (or `term -> LABEL`) to override `customLabel`.
   */
  customTerms?: string[];
  /**
   * Default tag label for custom terms: `CLIENT` produces
   * `[[<PREFIX>_CLIENT_1]]`. Only `[A-Z][A-Z0-9]{0,31}`; an invalid value
   * falls back to `CUSTOM` so restore keeps working.
   */
  customLabel?: string;
  /** Exact values (lower-cased after trim) that must never be masked. */
  allowlist?: string[];
  /** Enables plain DATE spans (priority 20). BIRTHDATE/DOCDATE stay on. */
  enableDate?: boolean;
  /** Enables URL detection (priority 40). Off by default. */
  enableUrl?: boolean;
  /** Throw LeakGuardError when residual PII is found. Default true. */
  blockOnLeak?: boolean;
  /**
   * Upper bound on uppercase tokens (candidate name words) in one
   * whole-document PERSON pass. Exceeding it fails closed with
   * `DensityLimitError` (`TOO_MANY_ENTITIES`) instead of spending minutes on
   * a superlinear name-dense document. Defaults to `MAX_PERSON_TOKENS`
   * (50 000); tests lower it to avoid huge fixtures.
   */
  maxPersonTokens?: number;
}

/**
 * A single detector hit inside an extracted text buffer.
 * Offsets are UTF-16 code-unit indexes into the scanned text.
 */
export interface Detection {
  label: EntityLabel;
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Matched source text. Never log this value. */
  text: string;
  /** Stable rule identifier, e.g. `email` or `ru.snils`. */
  ruleId: string;
  /** Optional detector confidence in [0, 1]. */
  confidence?: number;
}

/**
 * One anonymized entity, keyed as `<LABEL>_<N>` inside `Vault.entities`
 * (for example `PERSON_1`). `canonical` is the restore fallback when the
 * occurrence order does not match.
 */
export interface EntityRecord {
  label: EntityLabel;
  canonical: string;
  variants: string[];
  count: number;
  /**
   * Nominative-case hint used by `canonicalOf` for restoration. PERSON
   * detection fills it; structured entities leave it unset and fall back to
   * `canonical`.
   */
  nominative?: string;
}

/** A concrete replacement that preserving restore can replay in order. */
export interface Occurrence {
  tag: string;
  original: string;
}

export interface VaultFile {
  originalName: string;
  maskedName: string;
  format: FileFormat;
  /** Original file size in bytes. */
  size: number;
  /** SHA-256 of the original bytes, lowercase hex. */
  sha256: string;
  /**
   * SHA-256 of the masked bytes this adapter produced, lowercase hex.
   * Restore uses it to identify the record before falling back to the file
   * name, so two files with the same original/masked name stay apart
   * (R16-RESTORE-IDENTITY). Absent in legacy vaults.
   */
  maskedSha256?: string;
  /** Detected source encoding, e.g. `utf-8`, `utf-16le`, `windows-1251`. */
  encoding?: string;
  /** Original XML declaration encoding label, restored verbatim (M8R2-N3). */
  declarationEncoding?: string;
  /** Source file started with a byte-order mark. */
  bom?: boolean;
  /** Dominant source line ending, applied again on restore. */
  eol?: Eol;
  /**
   * Index of this file's first record in `Vault.occurrences`. Adapters that
   * append several files to one vault set this so sequential restore replays
   * only this file's surfaces (R15-RESTORE). Absent in legacy vaults; such
   * records fall back to the global occurrence list.
   */
  occurrenceStart?: number;
  /** Number of this file's records in `Vault.occurrences` (R15-RESTORE). */
  occurrenceCount?: number;
}

export interface FilenameMapEntry {
  original: string;
  masked: string;
}

/**
 * Persisted vault document. Stored encrypted in IndexedDB; this shape is the
 * plaintext contract used by the background/offscreen layer only.
 */
export interface Vault {
  schema: VaultSchema;
  id: string;
  /** Five characters `[A-Z0-9]`; locates this vault from a file's tags. */
  prefix: string;
  createdAt: string;
  chatIds: string[];
  files: VaultFile[];
  /** Key is `<LABEL>_<N>`, e.g. `PERSON_1`. */
  entities: Record<string, EntityRecord>;
  /**
   * PERSON semantic key -> entity key, e.g.
   * `["person","иванов","и","и"]` -> `PERSON_1`. Keeps one person on one tag
   * across separate `anonymizeText` calls sharing this vault.
   */
  personKeys?: Record<string, string>;
  occurrences: Occurrence[];
  filenameMap: FilenameMapEntry[];
}

export interface FileInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface MaskedEntity {
  /** Key inside `Vault.entities`, e.g. `PERSON_1`. */
  key: string;
  tag: string;
  label: EntityLabel;
  canonical: string;
  count: number;
}

/**
 * Result returned by the anonymization pipeline to the relay/content script.
 * Field names follow the interception contract in the specification (§4.2).
 */
export interface AnonymizeResult {
  maskedBytes: Uint8Array;
  maskedName: string;
  /**
   * MIME type of the masked bytes. Legacy DOC/XLS conversions change it
   * (`.doc` -> DOCX, `.xls` -> XLSX); every other adapter keeps the source
   * MIME or its standard value.
   */
  maskedMime?: string;
  format: FileFormat;
  entities: MaskedEntity[];
  occurrences: Occurrence[];
  vaultId: string;
  vaultPrefix: string;
  warnings: string[];
}

export interface RestoreResult {
  bytes: Uint8Array;
  fileName: string;
  replacements: number;
  /** Tags left untouched because their prefix/vault is unknown. */
  unknownTags: string[];
  warnings: string[];
}

export interface AnonymizeContext {
  vault: Vault;
  /** Hard limit in bytes; larger files are rejected before parsing. */
  maxBytes: number;
  /** Detector configuration for this file. */
  config?: DetectionConfig;
  /**
   * Markdown only: leave fenced/indented code blocks and inline code
   * untouched. Off by default: code often carries secrets and PII.
   */
  skipCode?: boolean;
  signal?: AbortSignal;
}

/**
 * A format implementation (TXT/MD/DOCX/XLSX/PDF/DOC/XLS).
 * Implementations must be fail-closed: throw instead of returning partially
 * masked bytes.
 */
export interface FormatAdapter {
  readonly format: FileFormat;
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
  canHandle(file: Pick<FileInput, 'name' | 'mimeType'>): boolean;
  anonymize(file: FileInput, ctx: AnonymizeContext): Promise<AnonymizeResult>;
  restore(file: FileInput, vault: Vault): Promise<RestoreResult>;
}

export interface PlatformCapabilities {
  /** Chrome uses an MV3 service worker; Safari uses a background script. */
  background: 'service-worker' | 'background-page';
  downloadsApi: boolean;
  offscreen: boolean;
  /** Static MAIN world is Safari 18+; earlier versions need dynamic injection. */
  mainWorldContentScript: 'static' | 'dynamic';
}

/** Thin seam around browser/runtime differences (Chrome/Edge vs Safari). */
export interface PlatformAdapter {
  readonly id: 'chromium' | 'safari';
  readonly capabilities: PlatformCapabilities;
  sendMessage<TResponse = unknown>(message: unknown): Promise<TResponse>;
}
