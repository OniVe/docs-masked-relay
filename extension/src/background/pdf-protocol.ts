/**
 * Background <-> offscreen PDF protocol (M5a).
 *
 * Chrome runtime messages are JSON-serialized, so bytes travel as base64. The
 * vault never crosses this boundary: the offscreen document receives only the
 * vault id/prefix, runs the adapter against a stub vault, and returns the
 * single `VaultFile` record for the background to persist. No PII entity,
 * canonical value or occurrence leaves the background.
 */

import { isCustomTagLabel } from '../core/detect/custom';
import { isPdfFile, PDF_MIME } from '../core/formats/pdf-detect';
import { isPdfRedactionError, type PdfErrorCode } from '../core/formats/pdf-errors';
import type { DetectionConfig, EntityLabel, Vault, VaultFile } from '../core/types';
import { ALL_LABELS, VAULT_SCHEMA } from '../core/types';
import { base64ToBytes } from '../shared/base64';

export const PDF_ANONYMIZE_MESSAGE = 'dm:pdf-anonymize' as const;
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
export const PDF_MAX_RESULT_BYTES = 2 * PDF_MAX_BYTES;

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 255;
const MAX_VAULT_ID_LENGTH = 128;
const MAX_WARNINGS = 64;
const MAX_WARNING_LENGTH = 400;
const MAX_BASE64_LENGTH = Math.ceil((PDF_MAX_BYTES * 4) / 3) + 8;
const MAX_RESULT_BASE64_LENGTH = Math.ceil((PDF_MAX_RESULT_BYTES * 4) / 3) + 8;
const PREFIX_RE = /^[A-Z0-9]{5}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface PdfConfigWire {
  labels?: EntityLabel[];
  aggressive?: boolean;
  loneFirstNames?: boolean;
  customTerms?: string[];
  customLabel?: string;
  allowlist?: string[];
  enableDate?: boolean;
  enableUrl?: boolean;
  blockOnLeak?: boolean;
}

export interface PdfAnonymizeWirePayload {
  /** Base64 original PDF bytes. */
  bytes: string;
  name: string;
  mime: string;
  vaultId: string;
  vaultPrefix: string;
  config?: PdfConfigWire;
}

export interface PdfAnonymizeWireMessage {
  type: typeof PDF_ANONYMIZE_MESSAGE;
  requestId: string;
  payload: PdfAnonymizeWirePayload;
}

export interface PdfAnonymizeWireResult {
  /** Base64 redacted PDF bytes. */
  maskedBytes: string;
  file: VaultFile;
  warnings: string[];
}

export type PdfAnonymizeWireResponse =
  | { ok: true; result: PdfAnonymizeWireResult }
  | { ok: false; error: { code: PdfErrorCode | 'PDF_UNKNOWN'; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maxLength;
}

function isStringArray(value: unknown, maxItems = 256): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isString(item, MAX_WARNING_LENGTH))
  );
}

function isLabel(value: unknown): value is EntityLabel {
  return typeof value === 'string' && (ALL_LABELS as readonly string[]).includes(value);
}

/** Serializes a `DetectionConfig` for a runtime message (Set -> array). */
export function encodePdfConfig(config: DetectionConfig | undefined): PdfConfigWire | undefined {
  if (!config) return undefined;
  const wire: PdfConfigWire = {};
  if (config.labels) wire.labels = [...config.labels];
  if (config.aggressive !== undefined) wire.aggressive = config.aggressive;
  if (config.loneFirstNames !== undefined) wire.loneFirstNames = config.loneFirstNames;
  if (config.customTerms) wire.customTerms = [...config.customTerms];
  if (config.customLabel) wire.customLabel = config.customLabel;
  if (config.allowlist) wire.allowlist = [...config.allowlist];
  if (config.enableDate !== undefined) wire.enableDate = config.enableDate;
  if (config.enableUrl !== undefined) wire.enableUrl = config.enableUrl;
  if (config.blockOnLeak !== undefined) wire.blockOnLeak = config.blockOnLeak;
  return wire;
}

function parseConfig(value: unknown): PdfConfigWire | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return undefined;

  const config: PdfConfigWire = {};
  if (value.labels !== undefined) {
    if (!Array.isArray(value.labels) || value.labels.length > ALL_LABELS.length) return undefined;
    const labels: EntityLabel[] = [];
    for (const label of value.labels) {
      if (!isLabel(label)) return undefined;
      labels.push(label);
    }
    config.labels = labels;
  }

  for (const key of [
    'aggressive',
    'loneFirstNames',
    'enableDate',
    'enableUrl',
    'blockOnLeak',
  ] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') return undefined;
    config[key] = raw;
  }
  for (const key of ['customTerms', 'allowlist'] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.length > 512) return undefined;
    if (!raw.every((item) => isString(item, 1024))) return undefined;
    config[key] = [...raw];
  }
  if (value.customLabel !== undefined) {
    if (typeof value.customLabel !== 'string' || !isCustomTagLabel(value.customLabel)) {
      return undefined;
    }
    config.customLabel = value.customLabel;
  }

  return config;
}

/** Reconstructs a detector config inside the offscreen document. */
export function decodePdfConfig(wire: PdfConfigWire | undefined): DetectionConfig {
  if (!wire) return {};
  const config: DetectionConfig = {};
  if (wire.labels) config.labels = new Set(wire.labels);
  if (wire.aggressive !== undefined) config.aggressive = wire.aggressive;
  if (wire.loneFirstNames !== undefined) config.loneFirstNames = wire.loneFirstNames;
  if (wire.customTerms) config.customTerms = [...wire.customTerms];
  if (wire.customLabel) config.customLabel = wire.customLabel;
  if (wire.allowlist) config.allowlist = [...wire.allowlist];
  if (wire.enableDate !== undefined) config.enableDate = wire.enableDate;
  if (wire.enableUrl !== undefined) config.enableUrl = wire.enableUrl;
  if (wire.blockOnLeak !== undefined) config.blockOnLeak = wire.blockOnLeak;
  return config;
}

/**
 * The PDF adapter only needs the vault identity and a place to push the file
 * record. A full vault (with canonical PII values) must not cross to offscreen.
 */
export function createPdfVaultStub(vaultId: string, vaultPrefix: string): Vault {
  return {
    schema: VAULT_SCHEMA,
    id: vaultId,
    prefix: vaultPrefix,
    createdAt: new Date(0).toISOString(),
    chatIds: [],
    files: [],
    entities: {},
    occurrences: [],
    filenameMap: [],
  };
}

export interface ParsedPdfAnonymizeRequest {
  requestId: string;
  bytes: Uint8Array;
  name: string;
  mime: string;
  vaultId: string;
  vaultPrefix: string;
  config?: PdfConfigWire;
}

/** Validates an offscreen request; `undefined` means "not ours/malformed". */
export function parsePdfAnonymizeRequest(value: unknown): ParsedPdfAnonymizeRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== PDF_ANONYMIZE_MESSAGE) return undefined;
  if (!isString(value.requestId, MAX_REQUEST_ID_LENGTH)) return undefined;
  if (!isRecord(value.payload)) return undefined;

  const payload = value.payload;
  if (!isString(payload.bytes, MAX_BASE64_LENGTH)) return undefined;
  if (!isString(payload.name, MAX_NAME_LENGTH)) return undefined;
  if (!isString(payload.mime, MAX_NAME_LENGTH, true)) return undefined;
  if (!isPdfFile(payload.name, payload.mime)) return undefined;
  if (!isString(payload.vaultId, MAX_VAULT_ID_LENGTH)) return undefined;
  if (!isString(payload.vaultPrefix, 5) || !PREFIX_RE.test(payload.vaultPrefix)) return undefined;

  const config = parseConfig(payload.config);
  if (payload.config !== undefined && config === undefined) return undefined;

  const bytes = base64ToBytes(payload.bytes);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > PDF_MAX_BYTES) return undefined;

  return {
    requestId: value.requestId,
    bytes,
    name: payload.name,
    mime: payload.mime || PDF_MIME,
    vaultId: payload.vaultId,
    vaultPrefix: payload.vaultPrefix,
    config,
  };
}

function parseVaultFile(value: unknown): VaultFile | undefined {
  if (!isRecord(value)) return undefined;
  if (!isString(value.originalName, MAX_NAME_LENGTH)) return undefined;
  if (!isString(value.maskedName, MAX_NAME_LENGTH)) return undefined;
  if (value.format !== 'pdf') return undefined;
  if (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0) {
    return undefined;
  }
  if (!isString(value.sha256, 64) || !SHA256_RE.test(value.sha256)) return undefined;
  return {
    originalName: value.originalName,
    maskedName: value.maskedName,
    format: 'pdf',
    size: Math.trunc(value.size),
    sha256: value.sha256,
  };
}

function parseWarnings(value: unknown): string[] | undefined {
  if (!isStringArray(value, MAX_WARNINGS)) return undefined;
  return value.every((warning) => warning.length <= MAX_WARNING_LENGTH) ? [...value] : undefined;
}

/** Validates an offscreen response. */
export function parsePdfAnonymizeResponse(value: unknown): PdfAnonymizeWireResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (value.ok === true) {
    if (!isRecord(value.result)) return undefined;
    if (!isString(value.result.maskedBytes, MAX_RESULT_BASE64_LENGTH)) return undefined;
    const file = parseVaultFile(value.result.file);
    const warnings = parseWarnings(value.result.warnings);
    if (!file || !warnings) return undefined;
    return {
      ok: true,
      result: { maskedBytes: value.result.maskedBytes, file, warnings },
    };
  }

  if (value.ok === false && isRecord(value.error)) {
    const code = value.error.code;
    const message = value.error.message;
    if (typeof code !== 'string') return undefined;
    if (!isString(message, MAX_WARNING_LENGTH, true)) return undefined;
    const validCodes = new Set<PdfErrorCode | 'PDF_UNKNOWN'>([
      'PDF_SIZE',
      'PDF_PAGES',
      'PDF_SCANNED',
      'PDF_ENCRYPTED',
      'PDF_INVALID',
      'PDF_LOCATE',
      'PDF_APPLY',
      'PDF_RESIDUAL',
      'PDF_METADATA',
      'PDF_RUNTIME',
      'PDF_IRREVERSIBLE',
      'PDF_UNKNOWN',
    ]);
    if (!validCodes.has(code as PdfErrorCode)) return undefined;
    return {
      ok: false,
      error: { code: code as PdfErrorCode | 'PDF_UNKNOWN', message },
    };
  }

  return undefined;
}

/** Converts any adapter failure into a wire-safe error without leaking values. */
export function pdfFailure(error: unknown): PdfAnonymizeWireResponse {
  if (isPdfRedactionError(error)) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  return {
    ok: false,
    error: { code: 'PDF_RUNTIME', message: 'PDF processing failed; the file was not sent' },
  };
}
