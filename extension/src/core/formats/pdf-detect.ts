/**
 * PDF routing without the engine (M5a).
 *
 * Importing this module must stay cheap: the background service worker uses it
 * to decide whether a request belongs to the PDF runner, while the EmbedPDF
 * adapter (and its ~10 MB WASM assets) is loaded only in an offscreen document
 * or a Safari background page.
 */

export const PDF_MIME = 'application/pdf';

/** PDF-specific page limit (spec §6.4); the byte limit is the shared 25 MB. */
export const MAX_PDF_PAGES = 200;

/** True for `.pdf` names or the PDF MIME type (parameters are ignored). */
export function isPdfFile(name: string, mimeType: string): boolean {
  const mime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return name.toLowerCase().endsWith('.pdf') || mime === PDF_MIME;
}
