import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { registerRouter } from '../src/background/router';

/**
 * M0: background liveness marker. M3: file/vault message router (vault,
 * formats, limits). No PII may ever be written to logs (spec §8).
 */
export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    console.info(`[dm-relay] installed (${details.reason})`);
  });

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'dm:ping'
      ) {
        sendResponse({
          ok: true,
          version: browser.runtime.getManifest().version,
        });
      }
      return undefined;
    },
  );

  registerRouter();
});
