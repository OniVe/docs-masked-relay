import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extensionPath, manifestPath } from './extension-context';
import { expect, test } from './fixtures';

// A missing build or browser startup fails the test instead of skipping it:
// the M0 harness must never report a green skip on a broken environment (H3).

const MOCK_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Mock ChatGPT</title></head>
  <body><h1>Mock ChatGPT</h1></body>
</html>`;

test.describe('M0 Chrome build', () => {
  test('contains a valid MV3 manifest and all entrypoints', async () => {
    expect(existsSync(manifestPath), `Run "bun run build" first; missing ${manifestPath}`).toBe(
      true,
    );

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'unlimitedStorage']));
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        'https://chatgpt.com/*',
        'https://chat.openai.com/*',
        'https://*.oaiusercontent.com/*',
      ]),
    );
    expect(manifest.background?.service_worker).toBeTruthy();
    expect(manifest.action?.default_popup).toBe('popup.html');
    expect(manifest.options_ui?.page).toBe('options.html');

    for (const file of ['popup.html', 'options.html', 'background.js']) {
      expect(existsSync(path.join(extensionPath, file)), file).toBe(true);
    }

    const scripts: Array<{ js: string[]; world?: string }> = manifest.content_scripts ?? [];
    const main = scripts.find((script) => script.world === 'MAIN');
    expect(main, 'MAIN-world content script is missing').toBeTruthy();
    expect(main?.js.some((file) => file.includes('chatgpt-main'))).toBe(true);

    const isolated = scripts.find(
      (script) => script.js.some((file) => file.includes('chatgpt')) && script.world !== 'MAIN',
    );
    expect(isolated, 'ISOLATED-world content script is missing').toBeTruthy();
  });
});

test.describe('ChatGPT injection (unpacked extension)', () => {
  test('background service worker is running', async ({ extensionContext: context }) => {
    const serviceWorker =
      context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://')) ??
      (await context.waitForEvent('serviceworker', { timeout: 15_000 }));

    expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\//);
  });

  test('isolated and MAIN world scripts inject on chatgpt.com', async ({
    extensionContext: context,
  }) => {
    const page = await context.newPage();

    await page.route(/^https:\/\/chatgpt\.com\//, async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: MOCK_HTML,
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{}',
        });
      }
    });

    await page.goto('https://chatgpt.com/');

    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.dmRelay))
      .toBe('isolated');

    await expect.poll(() => page.evaluate(() => window.__DM_RELAY_MAIN__ === true)).toBe(true);

    await page.close();
  });
});
