import { defineContentScript } from 'wxt/utils/define-content-script';
import { installIsolatedRelay } from '../src/interception/isolated-relay';

/**
 * ISOLATED-world relay/UI host (M3b): validated postMessage bridge to MAIN,
 * background messaging, chat/pending id resolution and the shadow-DOM toast.
 */
export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  runAt: 'document_start',
  world: 'ISOLATED',
  main() {
    installIsolatedRelay();
    document.documentElement.dataset.dmRelay = 'isolated';
  },
});
