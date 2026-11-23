/**
 * ISOLATED-world settings sync (M6b).
 *
 * Loads `enabled` + `maxBytes` at document_start (`dm:settings-get`) and
 * follows the background broadcast (`dm:settings-changed`) after every save.
 * The callback pushes the state into MAIN through the postMessage bridge and
 * marks the document for the e2e harness. Failures keep the last known value;
 * MAIN itself defaults to enabled.
 */

import { browser } from 'wxt/browser';
import { readSettingsChangedState } from '../shared/messages';

interface SettingsResponse {
  ok?: boolean;
  result?: { enabled?: unknown; maxBytes?: unknown };
}

export interface ProtectionState {
  enabled: boolean;
  maxBytes?: number;
}

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

async function loadState(): Promise<ProtectionState | undefined> {
  try {
    const response = (await browser.runtime.sendMessage({
      type: 'dm:settings-get',
      requestId: newRequestId(),
      payload: undefined,
    })) as SettingsResponse | undefined;
    if (response?.ok !== true) return undefined;
    const enabled = response.result?.enabled;
    if (typeof enabled !== 'boolean') return undefined;
    const maxBytes = response.result?.maxBytes;
    if (
      typeof maxBytes === 'number' &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes >= 1024 &&
      maxBytes <= 100 * 1024 * 1024
    ) {
      return { enabled, maxBytes };
    }
    return { enabled };
  } catch {
    // Background not ready: keep the fail-safe state.
    return undefined;
  }
}

/**
 * Subscribes to settings changes. Returns a cleanup for tests/dev tooling.
 * `onChange` is invoked only with a validated state.
 */
export function installSettingsSync(onChange: (state: ProtectionState) => void): () => void {
  let disposed = false;
  let last: string | undefined;

  const apply = (state: ProtectionState | undefined): void => {
    if (disposed || state === undefined) return;
    const key = `${state.enabled}:${state.maxBytes ?? ''}`;
    if (key === last) return;
    last = key;
    onChange(state);
  };

  void loadState().then(apply);

  const listener = (message: unknown): void => {
    apply(readSettingsChangedState(message));
  };

  try {
    browser.runtime.onMessage.addListener(listener);
  } catch {
    return () => {};
  }

  return () => {
    disposed = true;
    try {
      browser.runtime.onMessage.removeListener(listener);
    } catch {
      // The context may already be gone.
    }
  };
}
