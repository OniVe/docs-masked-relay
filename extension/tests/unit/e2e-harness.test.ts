import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the e2e harness against the Windows account-lockout regression:
 * every test used to launch its own persistent Chromium context. The suite
 * must share one worker-scoped context and reset state through the extension.
 *
 * The scan covers every test file (`tests/**`), not only `tests/e2e`, because
 * a helper outside the e2e directory could otherwise import Playwright or
 * launch a browser unnoticed. `@playwright/test` is allowed only in the two
 * harness files; browser launches only in `extension-context.ts`; a fixture
 * may only call the single named `launchExtensionContext` helper (H2).
 *
 * Runtime checks below exercise the empty-profile, one-launch and profile-lock
 * guards with a mocked Playwright launcher; no browser is started.
 */

const unitDir = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(unitDir, '..');
const e2eDir = path.join(testsDir, 'e2e');
const projectDir = path.resolve(testsDir, '..');
const playwrightConfigPath = path.join(projectDir, 'playwright.config.ts');
const packageJsonPath = path.join(projectDir, 'package.json');
const selfPath = path.join(unitDir, 'e2e-harness.test.ts');

const FIXTURES_FILE = path.join(e2eDir, 'fixtures.ts');
const EXTENSION_CONTEXT_FILE = path.join(e2eDir, 'extension-context.ts');
const HARNESS_FILES = new Set([FIXTURES_FILE, EXTENSION_CONTEXT_FILE]);
/**
 * The Playwright config legitimately imports `defineConfig`; it is not a test
 * file, but it is still scanned for launches and shared-context lifecycle.
 */
const PLAYWRIGHT_IMPORT_ALLOWED = new Set([...HARNESS_FILES, playwrightConfigPath]);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
/** Generated/vendored trees only; dot directories are intentionally scanned. */
const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', '.output', '.wxt']);

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function relative(file: string): string {
  return path.relative(projectDir, file);
}

function isDirectoryEntry(full: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function isFileEntry(full: string, entry: Dirent): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
}

/**
 * Every code file in the extension except generated/vendored trees and this
 * scanner itself. Test support outside `tests/**` (for example a helper at
 * the project root) is scanned too, so a Playwright import or browser launch
 * cannot hide there. Symlinked directories are followed and deduplicated by
 * real path; dot directories other than the generated/vendored ones are not
 * skipped.
 */
function scannedFiles(dir = projectDir, seen = new Set<string>()): string[] {
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return [];
  }
  if (seen.has(realDir)) return [];
  seen.add(realDir);

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (isDirectoryEntry(full, entry)) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      files.push(...scannedFiles(full, seen));
    } else if (
      isFileEntry(full, entry) &&
      full !== selfPath &&
      SCAN_EXTENSIONS.has(path.extname(entry.name))
    ) {
      files.push(full);
    }
  }
  return files.sort();
}

/** True for static, namespace, aliased, require, computed and split module references. */
function referencesPlaywrightModule(source: string): boolean {
  // Direct `@playwright` catches normal/namespace/aliased/require imports and
  // `[...].join`-style specifiers. Collapsing quotes, whitespace, `+`,
  // backslashes and `${}` also catches a specifier split into literals, e.g.
  // `import('@play' + 'wright/test')`.
  if (source.includes('@playwright')) return true;
  return source.replace(/[\s'"`+\\${}]/gu, '').includes('@playwright');
}

function isSpecFile(file: string): boolean {
  return /\.spec\.[jt]sx?$/u.test(file);
}

/** Skip/fixme/fail/todo in direct, namespace, computed and aliased forms. */
function hasForbiddenSkipCall(source: string): boolean {
  return (
    /\btest\s*\.\s*(?:describe\s*\.\s*)?(?:skip|fixme|fail|todo)\s*\(/u.test(source) ||
    /\b(?:describe|it)\s*\.\s*(?:skip|fixme|fail|todo)\s*\(/u.test(source) ||
    /\btest\s*(?:\.\s*describe)?\s*\[\s*['"`](?:skip|fixme|fail|todo)['"`]\s*\]\s*\(/u.test(
      source,
    ) ||
    // Aliased helper: `const t = test; t.skip(...)`.
    /\b[A-Za-z_$][\w$]*\s*\.\s*(?:skip|fixme|fail)\s*\(/u.test(source) ||
    // Bare alias: `const skip = test.skip; skip(...)`.
    /(?<![.\w$])(?:skip|fixme|fail)\s*\(/u.test(source)
  );
}

/** Comments must not create false positives for calls/literals. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
}

/** Identifier names of launch-like calls, e.g. `launchPersistentContext(`. */
function launchCalls(source: string): string[] {
  return [...stripComments(source).matchAll(/\b(launch[A-Za-z0-9_$]*)\s*\(/gu)].map(
    (match) => match[1] ?? '',
  );
}

/** `context.close()`/`browser.close()` plus the page-context factory variant. */
function sharedContextCloseCalls(source: string): number {
  const code = stripComments(source);
  const direct = code.match(/\b(?:browser|context)\s*(?:\?\.|\.)\s*close\s*\(/gu)?.length ?? 0;
  const fromFactory = code.match(/\bcontext\s*\(\s*\)\s*(?:\?\.|\.)\s*close\s*\(/gu)?.length ?? 0;
  return direct + fromFactory;
}

describe('e2e harness reuses one Chromium context per worker', () => {
  it('scans tests/** and test support outside it, not generated trees', () => {
    const files = scannedFiles().map(relative);

    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.startsWith(`tests${path.sep}unit${path.sep}`))).toBe(true);
    expect(files.some((file) => file.startsWith(`tests${path.sep}e2e${path.sep}`))).toBe(true);
    expect(files.some((file) => file.startsWith(`tests${path.sep}fixtures${path.sep}`))).toBe(true);
    expect(files.some((file) => file.startsWith(`src${path.sep}`))).toBe(true);
    expect(files.some((file) => file === 'wxt.config.ts')).toBe(true);
    expect(files.some((file) => file.startsWith('node_modules'))).toBe(false);
    expect(files.some((file) => file.startsWith('.output'))).toBe(false);
    expect(files.some((file) => file.startsWith('.wxt'))).toBe(false);
    expect(files).not.toContain(relative(selfPath));
  });

  it('finds helpers outside tests/**, including dot and symlinked directories', () => {
    const root = tempProfileRoot();
    mkdirSync(path.join(root, '.support'), { recursive: true });
    writeFileSync(
      path.join(root, '.support', 'dot-helper.ts'),
      "import { test } from '@playwright/test';\n",
    );
    writeFileSync(path.join(root, 'zz-helper.ts'), "import('@pl' + 'aywright/test');\n");
    writeFileSync(
      path.join(root, 'probe.spec.tsx'),
      "import { test } from '@playwright/test';\ntest('probe', () => {});\n",
    );

    const outside = path.join(tempProfileRoot(), 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'linked-helper.ts'), "import('@playwright/test');\n");
    symlinkSync(
      outside,
      path.join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const files = scannedFiles(root).map((file) => path.relative(root, file));
    expect(files).toEqual(
      expect.arrayContaining([
        path.join('.support', 'dot-helper.ts'),
        'zz-helper.ts',
        path.join('linked', 'linked-helper.ts'),
        'probe.spec.tsx',
      ]),
    );
    const specs = scannedFiles(root)
      .filter(isSpecFile)
      .map((file) => path.basename(file));
    expect(specs).toContain('probe.spec.tsx');
  });

  it('declares the worker-scoped extension context fixture', () => {
    const fixtures = read(FIXTURES_FILE);

    expect(fixtures).toMatch(/scope:\s*'worker'/u);
    expect(fixtures).toMatch(/auto:\s*true/u);
    expect(
      launchCalls(fixtures),
      'fixtures.ts must call launchExtensionContext exactly once',
    ).toEqual(['launchExtensionContext']);
    expect(fixtures, 'fixtures.ts must not import chromium directly').not.toMatch(/\bchromium\b/u);
    expect(fixtures, 'fixtures.ts must not call launchPersistentContext').not.toMatch(
      /launchPersistentContext/u,
    );
  });

  it('references @playwright only in the harness files and the Playwright config', () => {
    const offenders = scannedFiles()
      .filter(
        (file) => !PLAYWRIGHT_IMPORT_ALLOWED.has(file) && referencesPlaywrightModule(read(file)),
      )
      .map(relative);

    expect(offenders, 'use ./fixtures instead of importing Playwright').toEqual([]);
  });

  it('detects namespace, require, computed and split Playwright imports', () => {
    const samples = [
      "import * as pw from '@playwright/test';",
      "const { test } = require('@playwright/test');",
      "await import('@playwright/' + 'test');",
      "await import('@playwright/'.concat('test'));",
      "const specifier = ['@playwright', 'test'].join('/');",
      "const pw = await import('@play' + 'wright/test');",
    ];

    for (const sample of samples) {
      expect(referencesPlaywrightModule(sample), sample).toBe(true);
    }
    expect(referencesPlaywrightModule("import { test } from './fixtures';")).toBe(false);
    expect(referencesPlaywrightModule("import('@play' + 'ground/test');")).toBe(false);
  });

  it('forbids browser launches outside extension-context', () => {
    for (const file of scannedFiles()) {
      if (file === EXTENSION_CONTEXT_FILE) continue;
      const source = read(file);
      const calls = launchCalls(source);
      expect(stripComments(source), `${relative(file)} must not launch a browser API`).not.toMatch(
        /\bchromium\s*(?:\?\.|\.)/u,
      );
      if (file === FIXTURES_FILE) {
        expect(calls, `${relative(file)} may only call launchExtensionContext`).toEqual([
          'launchExtensionContext',
        ]);
      } else {
        expect(calls, `${relative(file)} must not launch a browser`).toEqual([]);
      }
    }
  });

  it('forbids shared-context lifecycle in specs and helpers', () => {
    for (const file of scannedFiles()) {
      const source = read(file);
      expect(source, `${relative(file)} must not call browser.newContext`).not.toMatch(
        /\bnewContext\s*\(/u,
      );
      if (file === FIXTURES_FILE) {
        expect(
          sharedContextCloseCalls(source),
          `${relative(file)} may close the worker context exactly once`,
        ).toBe(1);
      } else if (file !== EXTENSION_CONTEXT_FILE) {
        expect(
          sharedContextCloseCalls(source),
          `${relative(file)} must not close a shared context`,
        ).toBe(0);
      }
    }
  });

  it('keeps per-test launches and runner imports out of specs', () => {
    const specFiles = scannedFiles().filter(isSpecFile);
    expect(specFiles.length).toBeGreaterThan(0);

    for (const file of specFiles) {
      const source = read(file);
      expect(source, `${relative(file)} must use the shared fixture`).toMatch(
        /import \{[^}]*\btest\b[^}]*\} from '\.\/fixtures'/u,
      );
      expect(source, `${relative(file)} must not import Playwright`).not.toMatch(/@playwright/u);
    }
  });

  it('launches only through persistentProfileDir()', () => {
    const source = read(EXTENSION_CONTEXT_FILE);
    const launches = source.match(/launchPersistentContext\s*\(/gu) ?? [];

    expect(launches, 'one launchPersistentContext call site').toHaveLength(1);
    expect(source).toMatch(/launchPersistentContext\(\s*persistentProfileDir\(\s*\)\s*,/u);
    expect(source, 'an empty userDataDir must be impossible').not.toMatch(
      /launchPersistentContext\(\s*(['"`])\s*\1/u,
    );
    expect(source, 'persistentProfileDir must reject an empty path').toMatch(/dir\.length === 0/u);
  });

  it('fails instead of skipping when the build or launch is broken', () => {
    const fixtures = read(FIXTURES_FILE);
    expect(fixtures).toMatch(/existsSync\(manifestPath\)/u);
    expect(fixtures).toMatch(/throw new Error\(`Run "bun run build" first/u);

    for (const file of scannedFiles().filter(isSpecFile)) {
      expect(read(file), `${relative(file)} must fail, not skip`).not.toMatch(
        /\btest\.(?:skip|fixme)\s*\(/u,
      );
      expect(hasForbiddenSkipCall(read(file)), `${relative(file)} must fail, not skip`).toBe(false);
    }
  });

  it('detects skip/fixme/fail in direct, namespace, computed and aliased forms', () => {
    const samples = [
      'test.describe.skip("x", () => {});',
      'test.describe.fixme("x", () => {});',
      'test.skip("x", () => {});',
      'test.fixme("x", () => {});',
      'test.fail("x", () => {});',
      'test["skip"]("x", () => {});',
      'test.describe["fixme"]("x", () => {});',
      'const t = test; t.skip("x", () => {});',
      'const skip = test.skip; skip("x", () => {});',
      'it.skip("x", () => {});',
    ];

    for (const sample of samples) {
      expect(hasForbiddenSkipCall(sample), sample).toBe(true);
    }
    expect(hasForbiddenSkipCall('test("x", () => {});')).toBe(false);
    expect(hasForbiddenSkipCall('await context.close();')).toBe(false);
  });

  it('runs one worker and pins it in the e2e script', () => {
    expect(read(playwrightConfigPath)).toMatch(/workers:\s*1\b/u);

    const packageJson = JSON.parse(read(packageJsonPath)) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['test:e2e']).toContain('playwright test --workers=1');
  });

  it('resets vaults, settings, storage, cookies and the HTTP cache between tests', () => {
    const fixtures = read(FIXTURES_FILE);
    expect(fixtures).toContain('dm:clear-data');
    expect(fixtures).toContain('clearCookies');
    expect(fixtures).toContain('clearBrowserCache');
    expect(fixtures).toContain('storage.local.clear');
    expect(fixtures).toContain('storage.session');
    expect(fixtures).toContain('dm:vault-list');
    expect(fixtures).toContain('defaultSettings');
  });
});

const playwrightMock = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock('@playwright/test', () => ({
  chromium: { launchPersistentContext: playwrightMock.launchPersistentContext },
}));

const fsRenameHook = vi.hoisted(() => ({
  beforeRename: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      const hook = fsRenameHook.beforeRename;
      if (hook) {
        // One-shot side effect: simulate another worker replacing the lock
        // between the confirmation read and the stale-lock rename.
        fsRenameHook.beforeRename = undefined;
        hook();
      }
      actual.renameSync(from, to);
    },
  };
});

interface FakeContext {
  on(event: string, listener: () => void): void;
  close(): Promise<void>;
}

function fakeContext(): FakeContext {
  let onClose: (() => void) | undefined;
  return {
    on(event, listener) {
      if (event === 'close') onClose = listener;
    },
    async close() {
      onClose?.();
    },
  };
}

let tempDirs: string[] = [];

function tempProfileRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dmrelay-e2e-guard-'));
  tempDirs.push(dir);
  return dir;
}

async function importHarness(): Promise<typeof import('../e2e/extension-context')> {
  vi.resetModules();
  return import('../e2e/extension-context');
}

afterEach(() => {
  delete process.env.DM_PLAYWRIGHT_USER_DATA_DIR;
  delete process.env.DM_CHROMIUM_EXECUTABLE;
  playwrightMock.launchPersistentContext.mockReset();
  fsRenameHook.beforeRename = undefined;
  vi.resetModules();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('e2e harness runtime guards', () => {
  it('persistentProfileDir rejects an empty override instead of using a throwaway profile', async () => {
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = '   ';
    const harness = await importHarness();

    expect(() => harness.persistentProfileDir()).toThrow(/must not be empty/iu);
    await expect(harness.launchExtensionContext([])).rejects.toThrow(/must not be empty/iu);
    expect(playwrightMock.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('persistentProfileDir creates and reuses one stable directory', async () => {
    const dir = path.join(tempProfileRoot(), 'nested', 'profile');
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = dir;
    const harness = await importHarness();

    expect(harness.persistentProfileDir()).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(harness.persistentProfileDir()).toBe(dir);
  });

  it('records the owner pid and a per-acquisition token in the profile lock', async () => {
    const dir = tempProfileRoot();
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = dir;
    playwrightMock.launchPersistentContext.mockResolvedValue(fakeContext());
    const harness = await importHarness();

    const context = await harness.launchExtensionContext([]);
    const lockPath = path.join(dir, harness.LAUNCH_LOCK_FILE);

    expect(readFileSync(lockPath, 'utf8').trim()).toMatch(
      new RegExp(`^${process.pid}:[0-9a-f]{16}$`, 'u'),
    );
    await context.close();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('rejects a second successful launch in the same worker', async () => {
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = tempProfileRoot();
    playwrightMock.launchPersistentContext.mockResolvedValue(fakeContext());
    const harness = await importHarness();

    await harness.launchExtensionContext([]);

    await expect(harness.launchExtensionContext([])).rejects.toThrow(/already launched/iu);
    expect(playwrightMock.launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  it('releases the profile lock when every launch attempt fails', async () => {
    const dir = tempProfileRoot();
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = dir;
    playwrightMock.launchPersistentContext.mockRejectedValue(new Error('spawn failed'));
    const harness = await importHarness();

    await expect(harness.launchExtensionContext([])).rejects.toThrow(/No usable Chromium/u);
    expect(existsSync(path.join(dir, harness.LAUNCH_LOCK_FILE))).toBe(false);
  });

  it('keeps one lock across fallback attempts', async () => {
    const dir = tempProfileRoot();
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = dir;
    // Force a two-attempt chain (override, then Playwright default) below the
    // cached-Chromium scan, so the fallback path runs on every OS even when CI
    // has no cached Chromium and the default would be the only attempt.
    process.env.DM_CHROMIUM_EXECUTABLE = path.join(dir, 'fake-chrome');
    const fallback = fakeContext();
    playwrightMock.launchPersistentContext
      .mockRejectedValueOnce(new Error('bundled Chromium failed'))
      .mockResolvedValue(fallback);
    const harness = await importHarness();

    const context = await harness.launchExtensionContext([]);

    expect(context).toBe(fallback);
    expect(playwrightMock.launchPersistentContext.mock.calls.length).toBeGreaterThan(1);
    expect(existsSync(path.join(dir, harness.LAUNCH_LOCK_FILE))).toBe(true);
    await context.close();
  });

  it('rejects a concurrent worker targeting the same profile directory', async () => {
    const dir = tempProfileRoot();
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = dir;
    const firstContext = fakeContext();
    playwrightMock.launchPersistentContext.mockResolvedValue(firstContext);

    const first = await importHarness();
    const launched = await first.launchExtensionContext([]);

    const second = await importHarness();
    await expect(second.launchExtensionContext([])).rejects.toThrow(
      /holds .*refusing a concurrent/iu,
    );

    await launched.close();

    const thirdContext = fakeContext();
    playwrightMock.launchPersistentContext.mockResolvedValue(thirdContext);
    const third = await importHarness();
    await expect(third.launchExtensionContext([])).resolves.toBe(thirdContext);
  });

  it('cleans a stale lock left by a dead worker', async () => {
    const dir = tempProfileRoot();
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = dir;
    const harness = await importHarness();
    const lockPath = path.join(dir, harness.LAUNCH_LOCK_FILE);
    // A PID that cannot be alive on a normal machine.
    writeFileSync(lockPath, '999999999\n');
    playwrightMock.launchPersistentContext.mockResolvedValue(fakeContext());

    const context = await harness.launchExtensionContext([]);

    expect(readFileSync(lockPath, 'utf8').trim()).toMatch(
      new RegExp(`^${process.pid}:[0-9a-f]{16}$`, 'u'),
    );
    await context.close();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('restores a fresh lock created between the stale check and the rename', async () => {
    const dir = tempProfileRoot();
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = dir;
    const harness = await importHarness();
    const lockPath = path.join(dir, harness.LAUNCH_LOCK_FILE);
    writeFileSync(lockPath, '999999999:deadbeefdeadbeef\n');
    const fresh = `${process.pid}:0123456789abcdef\n`;
    fsRenameHook.beforeRename = () => writeFileSync(lockPath, fresh);
    playwrightMock.launchPersistentContext.mockResolvedValue(fakeContext());

    await expect(harness.launchExtensionContext([])).rejects.toThrow(
      /holds .*refusing a concurrent/iu,
    );

    // The fresh lock must survive the stale-lock cleanup untouched, and no
    // browser may have been launched meanwhile.
    expect(readFileSync(lockPath, 'utf8')).toBe(fresh);
    expect(playwrightMock.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('treats an empty/unparseable lock as busy and never deletes it', async () => {
    const dir = tempProfileRoot();
    process.env.DM_PLAYWRIGHT_USER_DATA_DIR = dir;
    const harness = await importHarness();
    const lockPath = path.join(dir, harness.LAUNCH_LOCK_FILE);
    writeFileSync(lockPath, '');

    await expect(harness.launchExtensionContext([])).rejects.toThrow(/Could not acquire/u);

    expect(readFileSync(lockPath, 'utf8')).toBe('');
    expect(playwrightMock.launchPersistentContext).not.toHaveBeenCalled();
  });
});
