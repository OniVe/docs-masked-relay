import { existsSync } from 'node:fs';
import { type BrowserContext, test as base, expect, type Page } from '@playwright/test';
import { defaultSettings } from '../../src/background/settings';
import { extensionPath, launchExtensionContext, manifestPath } from './extension-context';

export type { BrowserContext, Page, Request } from '@playwright/test';

/**
 * One Chromium process per worker. Launching a fresh persistent context per
 * test (or worse, with an empty `userDataDir`) spawns many credential calls on
 * Windows and can lock the OS account (Security 4625/4740). The worker fixture
 * below launches the unpacked extension exactly once; `resetExtension` wipes
 * per-test state through the extension's own `dm:clear-data` route.
 */

const EXTENSION_ARGS = [
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
];

interface RelayResponse {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<RelayResponse | undefined>;
  };
  storage: {
    local: { clear(): Promise<void> };
    session?: { clear(): Promise<void> };
  };
};

async function extensionId(context: BrowserContext): Promise<string> {
  const worker =
    context
      .serviceWorkers()
      .find((candidate) => candidate.url().startsWith('chrome-extension://')) ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return new URL(worker.url()).host;
}

async function sendRelay(page: Page, type: string): Promise<RelayResponse | undefined> {
  return page.evaluate(
    (messageType) =>
      chrome.runtime.sendMessage({
        type: messageType,
        requestId: crypto.randomUUID(),
        payload: undefined,
      }),
    type,
  );
}

/**
 * Between tests: close leftover pages, drop cookies, clear `chrome.storage`
 * and delete the IndexedDB database via `dm:clear-data` (vaults, wrapped keys
 * and settings). The route re-initializes an empty store, so the next test
 * starts with default settings and no vaults.
 */
async function resetExtensionState(context: BrowserContext): Promise<void> {
  await Promise.all(context.pages().map((page) => page.close().catch(() => undefined)));
  await context.clearCookies();

  const id = await extensionId(context);
  const page = await context.newPage();
  try {
    // Playwright routes bypass the HTTP cache, but real uploads/downloads can
    // seed it. Clear Chromium's browser cache through CDP (H5); service-worker
    // state is intentionally not stopped here because killing the extension
    // worker would race with the `dm:clear-data` assertions below. Tests must
    // not rely on in-memory service-worker state surviving a reset.
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Network.clearBrowserCache');
    } finally {
      await cdp.detach();
    }

    await page.goto(`chrome-extension://${id}/options.html`);
    await page.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session?.clear();
    });

    const cleared = await sendRelay(page, 'dm:clear-data');
    expect(cleared?.ok, JSON.stringify(cleared)).toBe(true);

    const settings = await sendRelay(page, 'dm:settings-get');
    expect(settings?.result).toEqual(defaultSettings());

    const vaults = await sendRelay(page, 'dm:vault-list');
    expect(vaults?.result).toEqual({ vaults: [] });
  } finally {
    await page.close().catch(() => undefined);
  }
}

export const test = base.extend<
  { resetExtension: undefined },
  { extensionContext: BrowserContext }
>({
  extensionContext: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture arguments to be object patterns.
    async ({}, use) => {
      if (!existsSync(manifestPath)) {
        // Fail instead of skip: a skipped harness after a build/launch failure
        // would be a false green (H3). The e2e job must fail loudly.
        throw new Error(`Run "bun run build" first; missing ${manifestPath}`);
      }
      const context = await launchExtensionContext(EXTENSION_ARGS);
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  // Automatic per-test reset so the shared worker context cannot leak vaults
  // or settings from one test into the next.
  resetExtension: [
    async ({ extensionContext: context }, use) => {
      await resetExtensionState(context);
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
