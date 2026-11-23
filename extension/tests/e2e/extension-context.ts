import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium } from '@playwright/test';

export const testDir = path.dirname(fileURLToPath(import.meta.url));
export const extensionPath = path.resolve(testDir, '../../.output/chrome-mv3');
export const manifestPath = path.join(extensionPath, 'manifest.json');

const DEFAULT_PROFILE_DIR = path.join(os.tmpdir(), 'dmrelay-playwright-profile');
export const LAUNCH_LOCK_FILE = 'dmrelay-launch.lock';

/**
 * Never pass an empty `userDataDir` to launchPersistentContext: on Windows
 * Chromium then creates a brand-new temporary profile for every test, and the
 * repeated credential calls can lock the OS account (Security 4625/4740).
 * Use one stable directory instead; override with DM_PLAYWRIGHT_USER_DATA_DIR.
 * An empty/whitespace override is rejected at runtime instead of silently
 * falling back to a throwaway profile (H2).
 */
export function persistentProfileDir(): string {
  const configured = process.env.DM_PLAYWRIGHT_USER_DATA_DIR;
  const dir = (configured === undefined ? DEFAULT_PROFILE_DIR : configured).trim();
  if (dir.length === 0) {
    throw new Error(
      'DM_PLAYWRIGHT_USER_DATA_DIR must not be empty: an empty userDataDir creates a throwaway Chromium profile and can lock the Windows account',
    );
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * One Chromium launch per worker. `fixtures.ts` already declares the worker
 * fixture; a second successful launch would start another persistent profile
 * process and reintroduce the account-lockout burst this harness fixed (H2).
 */
let launched = false;

const LOCK_ATTEMPTS = 5;
const LOCK_RETRY_DELAY_MS = 20;

function retryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
}

/** Lock content, or `undefined` when the lock disappeared (released). */
function readLockFile(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch (error) {
    // Any other read error is treated like an unparseable lock (busy).
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : '';
  }
}

/**
 * Owner PID from `<pid>:<token>` (plain legacy `<pid>` is accepted). A
 * missing/invalid PID means an empty or unparseable lock, which is treated as
 * busy rather than stale: only a confirmed dead PID may be cleaned up.
 *
 * Known limitation (test-only): the token guards against content swaps during
 * cleanup, not against the OS reusing a dead PID for an unrelated process.
 */
function lockOwnerPid(raw: string): number | undefined {
  const head = raw.trim().split(/[\s:]/u, 1)[0] ?? '';
  const pid = Number.parseInt(head, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Cross-worker guard: two Playwright workers pointed at the same profile dir
 * would start two Chromium processes against one profile. The lock file
 * records `<pid>:<token>` so a lock left by a crashed run is cleaned up
 * instead of blocking every later launch. Acquired once per
 * `launchExtensionContext` so fallback attempts reuse it.
 *
 * Stale cleanup is TOCTOU-safe: the content is re-read before and after the
 * rename, and if another worker replaced the lock in between, the fresh lock
 * is restored and never deleted. Empty/unparseable locks are busy, retried a
 * bounded number of times, then reported instead of being removed.
 */
async function acquireLaunchLock(dir: string): Promise<string> {
  const lockPath = path.join(dir, LAUNCH_LOCK_FILE);
  const token = `${process.pid}:${randomBytes(8).toString('hex')}\n`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return lockPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const snapshot = readLockFile(lockPath);
      if (snapshot === undefined) continue; // Released between open and read.
      const owner = lockOwnerPid(snapshot);
      if (owner === undefined) {
        // Empty/unparseable: treat as busy, never as stale.
        await retryDelay();
        continue;
      }
      if (processIsAlive(owner)) {
        throw new Error(
          `Another Playwright worker (pid ${owner}) holds ${lockPath}; refusing a concurrent Chromium launch`,
        );
      }

      // Confirm the same stale content right before touching the file.
      const confirmed = readLockFile(lockPath);
      if (confirmed !== snapshot) {
        await retryDelay();
        continue;
      }

      const stalePath = `${lockPath}.stale-${process.pid}-${attempt}`;
      try {
        renameSync(lockPath, stalePath);
      } catch (renameError) {
        // Another worker claimed the stale lock first; retry the open.
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw renameError;
      }

      // Re-read what was actually moved: a fresh lock may have been created
      // between the confirmation read and the rename.
      const moved = readLockFile(stalePath);
      if (moved !== snapshot) {
        try {
          renameSync(stalePath, lockPath);
        } catch {
          throw new Error(
            `Launch lock at ${lockPath} changed during stale-lock cleanup; refusing to continue`,
          );
        }
        await retryDelay();
        continue;
      }

      try {
        unlinkSync(stalePath);
      } catch {
        // Best-effort cleanup of the renamed stale file.
      }
    }
  }
  throw new Error(
    `Could not acquire the Playwright launch lock at ${lockPath} (live, unreadable or contended lock; remove it only if the owner crashed)`,
  );
}

function releaseLaunchLock(lockPath: string | undefined): void {
  if (!lockPath) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already released or removed by a stale-lock cleanup.
  }
}

export type LaunchPersistentContextOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

function browsersCacheRoot(): string | undefined {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'ms-playwright',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

/** Other Playwright Chromium revisions already present in the local cache. */
function cachedChromiumExecutables(): string[] {
  const root = browsersCacheRoot();
  if (!root || !existsSync(root)) return [];

  const relativePaths =
    process.platform === 'win32'
      ? [path.join('chrome-win64', 'chrome.exe')]
      : process.platform === 'darwin'
        ? [
            path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
            path.join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          ]
        : [path.join('chrome-linux', 'chrome')];

  return (
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
      // Prefer the known-good 1255 build when the bundled revision cannot start.
      .sort(
        (a, b) =>
          (a.name === 'chromium-1255' ? 0 : 1) - (b.name === 'chromium-1255' ? 0 : 1) ||
          b.name.localeCompare(a.name, undefined, { numeric: true }),
      )
      .flatMap((entry) => relativePaths.map((relative) => path.join(root, entry.name, relative)))
      .filter((candidate) => existsSync(candidate))
  );
}

/**
 * The bundled Playwright revision may fail to start on this machine (missing
 * DLL). Fall back to another cached Chromium rather than skipping the harness.
 * Set DM_CHROMIUM_EXECUTABLE to force a binary.
 */
export async function launchExtensionContext(args: string[]): Promise<BrowserContext> {
  if (launched) {
    throw new Error(
      'launchExtensionContext already launched a browser in this worker; reuse the worker-scoped extensionContext fixture',
    );
  }

  const profileDir = persistentProfileDir();

  const attempts: Array<{
    label: string;
    options: LaunchPersistentContextOptions;
  }> = [];

  const override = process.env.DM_CHROMIUM_EXECUTABLE;
  if (override) {
    attempts.push({
      label: `DM_CHROMIUM_EXECUTABLE=${override}`,
      options: { executablePath: override },
    });
  }

  attempts.push({ label: 'Playwright default Chromium', options: { channel: 'chromium' } });

  for (const executablePath of cachedChromiumExecutables()) {
    if (executablePath === override) continue;
    attempts.push({ label: executablePath, options: { executablePath } });
  }

  // One lock for the whole fallback chain: a failed executable attempt must
  // not open a window for another worker to grab the same profile.
  const lockPath = await acquireLaunchLock(profileDir);
  const failures: string[] = [];
  try {
    for (const attempt of attempts) {
      try {
        const context = await chromium.launchPersistentContext(persistentProfileDir(), {
          ...attempt.options,
          headless: true,
          args,
        });
        launched = true;
        // Release the cross-worker lock only when this worker's browser is
        // gone; a failed run releases it in the catch below.
        context.on('close', () => releaseLaunchLock(lockPath));
        return context;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${attempt.label}: ${message.split('\n')[0]}`);
      }
    }

    throw new Error(`No usable Chromium with extension support.\n${failures.join('\n')}`);
  } catch (error) {
    releaseLaunchLock(lockPath);
    throw error;
  }
}
