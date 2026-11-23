/**
 * Offscreen PDF handler (Chrome, M5a).
 *
 * The offscreen page imports the heavy adapter lazily, runs it against a stub
 * vault, and returns only the redacted bytes plus one `VaultFile`. The real
 * vault (and every canonical PII value) stays in the background.
 */

import { browser } from 'wxt/browser';
import {
  createPdfVaultStub,
  decodePdfConfig,
  type ParsedPdfAnonymizeRequest,
  PDF_MAX_BYTES,
  type PdfAnonymizeWireResponse,
  parsePdfAnonymizeRequest,
  pdfFailure,
} from '../background/pdf-protocol';
import { bytesToBase64 } from '../shared/base64';

async function handle(request: ParsedPdfAnonymizeRequest): Promise<PdfAnonymizeWireResponse> {
  try {
    const { anonymizePdf } = await import('../core/formats/pdf');
    const vault = createPdfVaultStub(request.vaultId, request.vaultPrefix);
    const result = await anonymizePdf(
      { name: request.name, mimeType: request.mime, bytes: request.bytes },
      {
        vault,
        maxBytes: PDF_MAX_BYTES,
        config: decodePdfConfig(request.config),
      },
    );

    const file = vault.files[0];
    if (!file || result.format !== 'pdf') {
      return {
        ok: false,
        error: {
          code: 'PDF_RUNTIME',
          message: 'PDF: redaction returned no file record; the file was not sent',
        },
      };
    }

    return {
      ok: true,
      result: {
        maskedBytes: bytesToBase64(result.maskedBytes),
        file,
        warnings: result.warnings,
      },
    };
  } catch (error) {
    return pdfFailure(error);
  }
}

/** Registers the offscreen listener; called once from the offscreen page. */
export function registerOffscreenPdfHandler(): void {
  if (typeof browser === 'undefined') return;

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
      const request = parsePdfAnonymizeRequest(message);
      if (!request) return undefined;

      void handle(request).then(
        (response) => sendResponse(response),
        () =>
          sendResponse({
            ok: false,
            error: {
              code: 'PDF_RUNTIME',
              message: 'PDF processing failed; the file was not sent',
            },
          }),
      );
      return true;
    },
  );
}
