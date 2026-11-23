/**
 * MAIN-world end of the window.postMessage bridge.
 *
 * The page world has no extension APIs; it can only ask ISOLATED to
 * anonymize/restore a file, restore a tagged name, or show a toast. Original
 * bytes travel to ISOLATED, masked/restored bytes travel back, and every
 * request has an id + timeout. Responses with a foreign source/id or a result
 * of the wrong kind are rejected.
 */

import {
  type AnonymizeBridgeResult,
  BRIDGE_VERSION,
  BridgeError,
  type BridgeErrorCode,
  type BridgeRequestType,
  type BridgeResult,
  type BridgeResultKind,
  bridgeResultKind,
  MAIN_SOURCE,
  MAX_FILE_BYTES,
  parseBridgeResponse,
  parseSettingsPush,
  RELAY_TIMEOUT_MS,
  RESTORE_TIMEOUT_MS,
  type RestoreFileBridgeResult,
  type RestoreNameBridgeResult,
  type ToastReason,
} from './protocol';

export interface MainBridge {
  /** Protection state pushed by ISOLATED; defaults to enabled (fail-safe). */
  isEnabled(): boolean;
  /** Configured per-file limit; defaults to the base 25 MB until settings load. */
  maxBytes(): number;
  anonymizeFile(input: {
    bytes: ArrayBuffer;
    name: string;
    mime: string;
    chatId?: string;
  }): Promise<AnonymizeBridgeResult>;
  restoreFile(input: {
    bytes: ArrayBuffer;
    name: string;
    mime: string;
    chatId?: string;
    pendingChatId?: string;
    prefix?: string;
  }): Promise<RestoreFileBridgeResult>;
  restoreName(input: {
    name: string;
    chatId?: string;
    pendingChatId?: string;
    prefix?: string;
  }): Promise<RestoreNameBridgeResult>;
  notify(reason: ToastReason): void;
}

type RequestType = Exclude<BridgeRequestType, 'notify'>;

interface PendingRequest {
  expected: BridgeResultKind;
  resolve: (result: BridgeResult) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function errorFromCode(code: BridgeErrorCode, message: string): BridgeError {
  return new BridgeError(code, message);
}

/**
 * Installs the response listener once per window and returns the request API.
 * Safe to call at document_start: only `message` events are observed.
 */
export function createMainBridge(target: Window = window): MainBridge {
  const pending = new Map<string, PendingRequest>();
  let listening = false;
  // Unknown state must keep protection on: never silently pass PII through.
  let enabled = true;
  let configuredMaxBytes = MAX_FILE_BYTES;

  const applySettings = (next: { enabled: boolean; maxBytes?: number }): void => {
    enabled = next.enabled;
    if (next.maxBytes !== undefined) configuredMaxBytes = next.maxBytes;
    const marked = target as Window & { __DM_RELAY_ENABLED__?: boolean };
    marked.__DM_RELAY_ENABLED__ = enabled;
    try {
      target.document.documentElement.dataset.dmProtection = enabled ? 'on' : 'off';
    } catch {
      // A non-DOM test target has no document.
    }
  };

  const settle = (id: string): PendingRequest | undefined => {
    const request = pending.get(id);
    if (request) {
      pending.delete(id);
      clearTimeout(request.timer);
    }
    return request;
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== target) return;
    if (event.origin !== target.location.origin) return;

    const pushed = parseSettingsPush(event.data);
    if (pushed !== undefined) {
      applySettings(pushed);
      return;
    }

    const response = parseBridgeResponse(event.data);
    if (!response) return;
    if (!pending.has(response.id)) return;

    const request = settle(response.id);
    if (!request) return;

    if (response.ok) {
      if (bridgeResultKind(response.result) !== request.expected) {
        request.reject(errorFromCode('BRIDGE', 'Malformed extension response'));
        return;
      }
      request.resolve(response.result);
    } else {
      request.reject(errorFromCode(response.error.code, response.error.message));
    }
  };

  const ensureListener = (): void => {
    if (listening) return;
    listening = true;
    target.addEventListener('message', onMessage);
  };

  const post = (message: unknown, transfer: Transferable[] = []): void => {
    target.postMessage(message, target.location.origin, transfer);
  };

  const request = <T extends BridgeResult>(
    type: RequestType,
    expected: BridgeResultKind,
    payload: unknown,
    transfer: Transferable[],
    timeoutMs: number,
  ): Promise<T> => {
    ensureListener();

    return new Promise<T>((resolve, reject) => {
      const id = newRequestId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(errorFromCode('TIMEOUT', 'Extension processing timed out'));
      }, timeoutMs);

      pending.set(id, {
        expected,
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      });

      const message = {
        source: MAIN_SOURCE,
        v: BRIDGE_VERSION,
        id,
        type,
        payload,
      };

      try {
        post(message, transfer);
      } catch {
        settle(id);
        reject(errorFromCode('BRIDGE', 'Could not reach the extension'));
      }
    });
  };

  // Listen immediately: the ISOLATED relay pushes settings at document_start,
  // possibly before the first upload/download request.
  ensureListener();
  applySettings({ enabled });

  return {
    isEnabled() {
      return enabled;
    },

    maxBytes() {
      return configuredMaxBytes;
    },

    anonymizeFile(input) {
      return request<AnonymizeBridgeResult>(
        'anonymize-file',
        'anonymize-file',
        input,
        [input.bytes],
        RELAY_TIMEOUT_MS,
      );
    },

    restoreFile(input) {
      return request<RestoreFileBridgeResult>(
        'restore-file',
        'restore-file',
        input,
        [input.bytes],
        RESTORE_TIMEOUT_MS,
      );
    },

    restoreName(input) {
      return request<RestoreNameBridgeResult>(
        'restore-name',
        'restore-name',
        input,
        [],
        RESTORE_TIMEOUT_MS,
      );
    },

    notify(reason) {
      try {
        post({
          source: MAIN_SOURCE,
          v: BRIDGE_VERSION,
          id: newRequestId(),
          type: 'notify' as const,
          payload: { reason },
        });
      } catch {
        // A toast is best-effort; never break the page request.
      }
    },
  };
}
