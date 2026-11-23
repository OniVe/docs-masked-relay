import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const HOST_PERMISSIONS = [
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://*.oaiusercontent.com/*',
];

/**
 * `decode-named-character-reference` resolves to its DOM build under the
 * `browser` condition, which calls `document.createElement` at module load.
 * That crashes the MV3 service worker before the background router registers.
 * The package's default export is a pure-JS lookup and works in every world.
 */
const PURE_REFERENCE_DECODER = fileURLToPath(
  new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url),
);

/**
 * word-extractor is a Node CJS library: its OLE sector reader extends Node's
 * `stream.Readable`. The bundled legacy `.doc` adapter only needs the tiny
 * `_read()`/`push()` subset, so the browser build aliases `stream` to a shim
 * instead of shipping all of readable-stream. Vitest keeps the real Node
 * module because it has its own config.
 */
const STREAM_SHIM = fileURLToPath(new URL('./src/shims/stream.ts', import.meta.url));

export default defineConfig({
  manifestVersion: 3,
  vite: () => ({
    resolve: {
      alias: {
        'decode-named-character-reference': PURE_REFERENCE_DECODER,
        stream: STREAM_SHIM,
      },
    },
    /**
     * Chrome's `PreventExtensionResourceFetchAcrossIsolatedWorlds` treats
     * `<link rel="modulepreload">` in extension pages as a cross-world
     * mismatch: the resource is fetched in the isolated world but consumed by
     * the extension world, so the preload is rejected and the page logs
     * "preloaded but not used". All chunks are local extension files, so a
     * preload saves nothing anyway. Disable it for every target (Chrome and
     * Safari share this config).
     */
    build: {
      modulePreload: false,
    },
  }),
  manifest: {
    name: 'DocsMasked Relay',
    description:
      'Local PII anonymization for ChatGPT uploads/downloads. Original PII stays on your device.',
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_title: 'DocsMasked Relay',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
      },
    },
    permissions: ['storage', 'unlimitedStorage', 'offscreen'],
    host_permissions: HOST_PERMISSIONS,
    // EmbedPDF/PDFium needs WebAssembly compilation in the offscreen document.
    // The worker is a same-origin emitted asset; Chrome's MV3 manifest CSP
    // rejects `blob:` in worker-src, so `worker-src 'self'` is the strongest
    // value that still loads (verified in the extension e2e).
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
    },
  },
  hooks: {
    /**
     * WXT emits `background.service_worker` for every MV3 target. Safari is
     * shipped as a non-persistent background page instead (spec §3, §10), so
     * rewrite the generated manifest for that build only.
     */
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.browser !== 'safari') return;

      const background = manifest.background;
      const serviceWorker =
        background && 'service_worker' in background ? background.service_worker : undefined;
      if (!serviceWorker) {
        throw new Error('Safari build: background entrypoint was not generated');
      }

      // Classic IIFE background bundle (WXT default), so no `type: module`.
      manifest.background = {
        scripts: [serviceWorker],
        persistent: false,
      } as typeof manifest.background;

      // WXT omits `open_in_tab` for Safari. Safari always shows the options page as
      // a full page; keep the explicit flag so every target declares the same
      // behavior (and reviewers see it in both manifests).
      if (manifest.options_ui) {
        manifest.options_ui = {
          ...manifest.options_ui,
          open_in_tab: true,
        } as typeof manifest.options_ui;
      }

      manifest.permissions = (manifest.permissions ?? []).filter(
        (permission) => permission !== 'downloads' && permission !== 'offscreen',
      );
    },
  },
  webExt: {
    binaries: process.env.DM_CHROMIUM_BINARY
      ? { chrome: process.env.DM_CHROMIUM_BINARY }
      : undefined,
  },
});
