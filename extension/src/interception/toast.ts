/**
 * In-page toast (ISOLATED world).
 *
 * Shadow DOM keeps ChatGPT styles out and the host attribute gives the e2e
 * harness a stable probe. Only textContent is used: no HTML and no PII values,
 * only labels/counters supplied by the background.
 */

const HOST_ATTRIBUTE = 'data-dm-relay-toast';
const AUTO_HIDE_MS = 8_000;

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

let host: HTMLElement | undefined;
let box: HTMLElement | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const STYLE = `
  :host { all: initial; }
  .box {
    box-sizing: border-box;
    max-width: 380px;
    padding: 10px 14px;
    border-radius: 8px;
    background: #111827;
    color: #f9fafb;
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    opacity: 0;
    transform: translateY(-4px);
    transition: opacity 120ms ease, transform 120ms ease;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .box.visible { opacity: 1; transform: translateY(0); }
  .box.success { background: #064e3b; }
  .box.warning { background: #78350f; }
  .box.error { background: #7f1d1d; }
`;

function ensureHost(): HTMLElement | undefined {
  if (host?.isConnected) return host;

  const root = document.documentElement ?? document.body;
  if (!root) return undefined;

  host = document.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, '');
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  box = document.createElement('div');
  box.className = 'box';
  shadow.append(style, box);

  root.appendChild(host);
  return host;
}

export function showToast(message: string, kind: ToastKind = 'info'): void {
  try {
    const element = ensureHost();
    if (!element || !box) return;

    box.className = `box ${kind}`;
    box.textContent = message;

    // Start the transition on the next frame without delaying the test probe.
    box.classList.add('visible');

    if (hideTimer !== undefined) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      box?.classList.remove('visible');
      hideTimer = undefined;
    }, AUTO_HIDE_MS);
  } catch {
    // UI must never break the relay.
  }
}

/** Test/debug helper: current toast text, if any. */
export function currentToastText(): string | undefined {
  return box?.textContent ?? undefined;
}
