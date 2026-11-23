/**
 * PDF redaction errors (M5a).
 *
 * The PDF path is fail-closed: every failure is a typed, constant message that
 * never includes document text, values or file paths. Codes are stable so the
 * background can map them to relay error codes without inspecting messages.
 */

export type PdfErrorCode =
  | 'PDF_SIZE'
  | 'PDF_PAGES'
  | 'PDF_SCANNED'
  | 'PDF_ENCRYPTED'
  | 'PDF_INVALID'
  | 'PDF_LOCATE'
  | 'PDF_APPLY'
  | 'PDF_RESIDUAL'
  | 'PDF_METADATA'
  | 'PDF_RUNTIME'
  | 'PDF_IRREVERSIBLE';

export class PdfRedactionError extends Error {
  readonly code: PdfErrorCode;

  constructor(code: PdfErrorCode, message: string) {
    super(message);
    this.name = 'PdfRedactionError';
    this.code = code;
  }
}

export function isPdfRedactionError(value: unknown): value is PdfRedactionError {
  return value instanceof PdfRedactionError;
}

/** The one-way restore message shared by the adapter and the router. */
export const PDF_IRREVERSIBLE_MESSAGE =
  'PDF: redaction is irreversible; keep/use the original file';
