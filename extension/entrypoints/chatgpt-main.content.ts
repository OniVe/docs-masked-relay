import { defineContentScript } from 'wxt/utils/define-content-script';
import { createMainBridge } from '../src/interception/bridge-main';
import { installDownloadHooks } from '../src/interception/download-hook';
import { CapturedFileQueue, installFileCapture } from '../src/interception/file-capture';
import { installUploadHooks } from '../src/interception/upload-hook';

declare global {
  interface Window {
    __DM_RELAY_MAIN__?: boolean;
  }
}

/**
 * MAIN-world host for upload/download interception (M3b/M4): file capture,
 * fetch/XHR hooks and the shared postMessage bridge to ISOLATED. Upload hooks
 * install first so the download wrapper observes already-classified traffic.
 * No extension API is reachable from this world.
 */
export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const queue = new CapturedFileQueue();
    const bridge = createMainBridge();
    const isEnabled = () => bridge.isEnabled();
    const maxBytes = () => bridge.maxBytes();
    installFileCapture(queue, window, isEnabled);
    installUploadHooks({ queue, bridge, isEnabled, maxBytes });
    installDownloadHooks({ bridge, isEnabled, maxBytes });
    window.__DM_RELAY_MAIN__ = true;
  },
});
