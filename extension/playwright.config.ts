import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // Harness contract: exactly one worker shares the persistent profile dir.
  // `playwright test --workers=N` overrides this and would start N Chromium
  // processes against one profile; the e2e job must not pass that flag.
  // `bun run test:e2e` pins `--workers=1` too, and the profile launch lock in
  // extension-context.ts refuses a second concurrent launch (H4).
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
