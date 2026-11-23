import { registerOffscreenPdfHandler } from '../../src/offscreen/pdf-worker';

/**
 * Chrome offscreen document: created on the first PDF upload, reused for 30 s,
 * then closed by the background. It is the only Chromium context that loads
 * EmbedPDF/PDFium (a service worker cannot start the engine's Worker).
 */
registerOffscreenPdfHandler();
