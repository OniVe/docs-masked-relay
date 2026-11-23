import { browser } from 'wxt/browser';
import { parseTags } from '../../src/core/tag';
import { base64ToBytes, bytesToBase64 } from '../../src/shared/base64';
import {
  type AnonymizeFileResult,
  type AppSettings,
  type RestoreFileResult,
  readSettingsChangedEnabled,
  type VaultStatus,
  type VaultSummary,
} from '../../src/shared/messages';
import {
  ERROR_TEXT,
  failureText,
  formatDate,
  mimeForName,
  pluralRu,
  resetFileInput,
  saveBytes,
  sendRelay,
  setStatus,
} from '../../src/ui/api';
import './style.css';

const LAST_ACTION_KEY = 'dmrelay:last-action';

const versionEl = document.querySelector<HTMLSpanElement>('#version');
if (versionEl) {
  versionEl.textContent = `v${browser.runtime.getManifest().version}`;
}

const enabledToggle = document.querySelector<HTMLInputElement>('#enabled-toggle');
const protectionDot = document.querySelector<HTMLSpanElement>('#protection-dot');
const protectionState = document.querySelector<HTMLSpanElement>('#protection-state');
const protectionStateText = document.querySelector<HTMLSpanElement>('#protection-state-text');
const protectionMessage = document.querySelector<HTMLParagraphElement>('#protection-message');
const nextStep = document.querySelector<HTMLParagraphElement>('#next-step');
const vaultState = document.querySelector<HTMLSpanElement>('#vault-state');
const vaultSummary = document.querySelector<HTMLParagraphElement>('#vault-summary');
const currentChatEl = document.querySelector<HTMLElement>('#current-chat');
const currentPrefixEl = document.querySelector<HTMLElement>('#current-prefix');
const unlockForm = document.querySelector<HTMLFormElement>('#unlock-form');
const unlockPassphrase = document.querySelector<HTMLInputElement>('#unlock-passphrase');
const unlockHint = document.querySelector<HTMLParagraphElement>('#unlock-hint');
const unlockButton = document.querySelector<HTMLButtonElement>('#unlock-button');
const unlockDeviceButton = document.querySelector<HTMLButtonElement>('#unlock-device-button');
const vaultMessage = document.querySelector<HTMLParagraphElement>('#vault-message');
const vaultList = document.querySelector<HTMLUListElement>('#vault-list');
const vaultEmpty = document.querySelector<HTMLParagraphElement>('#vault-empty');
const lockButton = document.querySelector<HTMLButtonElement>('#lock-button');
const manualPanel = document.querySelector<HTMLElement>('#manual-panel');
const manualHint = document.querySelector<HTMLParagraphElement>('#manual-hint');
const anonymizeInput = document.querySelector<HTMLInputElement>('#anonymize-file');
const anonymizeButton = document.querySelector<HTMLButtonElement>('#anonymize-button');
const restoreInput = document.querySelector<HTMLInputElement>('#restore-file');
const restoreButton = document.querySelector<HTMLButtonElement>('#restore-button');
const manualStatus = document.querySelector<HTMLParagraphElement>('#manual-status');
const lastActionEl = document.querySelector<HTMLElement>('#last-action');
const optionsButton = document.querySelector<HTMLButtonElement>('#options-button');

let settings: AppSettings | undefined;
let settingsError = false;
let vaultStatus: VaultStatus | undefined;
let vaultStatusError = false;
let currentChatId: string | undefined;
let vaults: VaultSummary[] = [];
let vaultsState: 'loading' | 'ready' | 'error' = 'loading';
let busy = false;

function maxBytes(): number {
  return settings?.maxBytes ?? 25 * 1024 * 1024;
}

function renderManualHint(): void {
  if (!manualHint) return;
  if (settingsError) {
    manualHint.textContent =
      'Настройки не загрузились. Обновите popup или перезагрузите расширение.';
    return;
  }
  if (!settings) {
    manualHint.textContent = 'Проверяем настройки…';
    return;
  }
  if (!settings.enabled) {
    manualHint.textContent =
      'Ручной режим недоступен: перехват выключен. Включите его выше или в настройках.';
    return;
  }
  if (vaultStatusError) {
    manualHint.textContent =
      'Состояние хранилища неизвестно. Если обработка не запустится, разблокируйте хранилище.';
    return;
  }
  if (!vaultStatus) {
    manualHint.textContent = 'Проверяем состояние хранилища…';
    return;
  }
  if (vaultStatus.locked) {
    manualHint.textContent =
      'Ручной режим недоступен: хранилище заблокировано. Разблокируйте его выше.';
    return;
  }
  manualHint.textContent = 'Если автоматический перехват не сработал, обработайте файл вручную.';
}

function updateManualAvailability(): void {
  const disabled =
    busy || settingsError || settings?.enabled === false || vaultStatus?.locked === true;
  if (anonymizeButton) anonymizeButton.disabled = disabled;
  if (restoreButton) restoreButton.disabled = disabled;
  renderManualHint();
}

function renderSummary(): void {
  if (nextStep) {
    if (settingsError) {
      nextStep.textContent =
        'Не удалось загрузить настройки. Откройте настройки или перезагрузите расширение.';
    } else if (!settings) {
      nextStep.textContent = 'Загружаем настройки…';
    } else if (!settings.enabled) {
      nextStep.textContent =
        'Перехват выключен. Включите его, чтобы файлы обрабатывались, или используйте ручной режим ниже.';
    } else if (vaultStatusError) {
      nextStep.textContent =
        'Не удалось проверить хранилище. Автоматическая отправка может быть остановлена; откройте настройки.';
    } else if (!vaultStatus) {
      nextStep.textContent = 'Проверяем хранилище…';
    } else if (vaultStatus.locked) {
      nextStep.textContent =
        'Хранилище заблокировано. Разблокируйте его ниже — иначе отправка файлов будет остановлена.';
    } else if (vaultsState === 'error') {
      nextStep.textContent =
        'Защита работает, но список хранилищ не загрузился. Откройте настройки, чтобы проверить хранилище.';
    } else if (vaultsState === 'ready' && vaults.length === 0) {
      nextStep.textContent = 'Защита включена. Хранилище появится после первой анонимизации файла.';
    } else {
      nextStep.textContent = 'Защита включена. Загружайте файлы в ChatGPT как обычно.';
    }
  }

  if (vaultSummary) {
    if (vaultStatusError) {
      vaultSummary.textContent =
        'Не удалось проверить состояние хранилища. Обновите popup или откройте настройки.';
    } else if (!vaultStatus) {
      vaultSummary.textContent = 'Проверяем состояние хранилища…';
    } else if (vaultStatus.locked) {
      vaultSummary.textContent =
        'Ключи закрыты. Автоматическая отправка файлов остановится, пока хранилище не разблокировано.';
    } else if (vaultsState === 'loading') {
      vaultSummary.textContent = 'Ключи доступны. Загружаем список хранилищ…';
    } else if (vaultsState === 'error') {
      vaultSummary.textContent = 'Ключи доступны, но список хранилищ не загрузился.';
    } else if (vaults.length === 0) {
      vaultSummary.textContent =
        'Ключи доступны. Хранилищ пока нет — первое появится после анонимизации.';
    } else {
      vaultSummary.textContent = `Ключи доступны. Хранилищ: ${vaults.length}.`;
    }
  }
}

function renderProtection(): void {
  if (settingsError) {
    if (enabledToggle) enabledToggle.disabled = true;
    if (protectionState) protectionState.dataset.kind = 'error';
    if (protectionStateText) protectionStateText.textContent = 'Недоступна';
    setStatus(
      protectionMessage,
      'Настройки не загрузились. Обновите popup или перезагрузите расширение.',
      'error',
    );
    updateManualAvailability();
    renderSummary();
    return;
  }

  const enabled = settings?.enabled !== false;
  if (enabledToggle) {
    enabledToggle.disabled = false;
    enabledToggle.checked = enabled;
  }
  if (protectionDot) protectionDot.dataset.on = enabled ? 'true' : 'false';
  if (protectionState) protectionState.dataset.kind = enabled ? 'on' : 'off';
  if (protectionStateText) protectionStateText.textContent = enabled ? 'Включена' : 'Выключена';
  setStatus(
    protectionMessage,
    enabled
      ? 'Перехват включён. Файл обрабатывается на этом устройстве перед отправкой.'
      : 'Перехват выключен. Файлы уходят в ChatGPT без обработки.',
    enabled ? 'idle' : 'warning',
  );
  updateManualAvailability();
  renderSummary();
}

function renderVaultStatus(): void {
  if (!vaultState) return;
  if (!vaultStatus) {
    vaultState.textContent = vaultStatusError ? 'Недоступен' : '…';
    vaultState.dataset.kind = vaultStatusError ? 'error' : '';
    if (unlockForm) unlockForm.hidden = true;
    if (unlockHint) unlockHint.hidden = true;
    if (unlockDeviceButton) unlockDeviceButton.hidden = true;
    if (lockButton) lockButton.hidden = true;
    renderSummary();
    updateManualAvailability();
    return;
  }

  vaultState.textContent = vaultStatus.locked ? 'Заблокирован' : 'Разблокирован';
  vaultState.dataset.kind = vaultStatus.locked ? 'locked' : 'unlocked';
  const showPassphraseForm = vaultStatus.locked && vaultStatus.passphraseEnabled;
  if (unlockForm) unlockForm.hidden = !showPassphraseForm;
  if (unlockHint) unlockHint.hidden = !showPassphraseForm;
  if (unlockDeviceButton) {
    unlockDeviceButton.hidden = !vaultStatus.locked || vaultStatus.passphraseEnabled;
  }
  if (lockButton) lockButton.hidden = vaultStatus.locked;
  renderSummary();
  updateManualAvailability();
}

function renderChatContext(): void {
  if (currentChatEl) {
    currentChatEl.textContent = currentChatId ? `${currentChatId.slice(0, 12)}…` : '—';
    currentChatEl.title = currentChatId ?? '';
  }
  if (currentPrefixEl) {
    const vault = currentChatId
      ? vaults.find((candidate) => candidate.chatIds.includes(currentChatId as string))
      : undefined;
    currentPrefixEl.textContent = vault?.prefix ?? '—';
  }
}

function renderVaults(): void {
  if (vaultList) {
    vaultList.replaceChildren();
    for (const vault of vaults) {
      const item = document.createElement('li');
      const prefix = document.createElement('span');
      prefix.className = 'vault-prefix';
      prefix.textContent = vault.prefix;
      const meta = document.createElement('span');
      meta.className = 'muted';
      const chats = vault.chatIds.length;
      meta.textContent = `${chats} ${pluralRu(chats, ['чат', 'чата', 'чатов'])} · обновлён ${formatDate(vault.updatedAt)}`;
      item.append(prefix, meta);
      vaultList.append(item);
    }
  }
  if (vaultEmpty) vaultEmpty.hidden = vaultsState !== 'ready' || vaults.length > 0;
  renderChatContext();
  renderSummary();
}

async function loadSettings(): Promise<void> {
  const response = await sendRelay('dm:settings-get', undefined);
  if (response?.ok === true) {
    settings = response.result;
    settingsError = false;
    renderProtection();
    return;
  }
  settingsError = true;
  setStatus(protectionMessage, failureText(response), 'error');
  renderSummary();
  updateManualAvailability();
}

async function loadVaultStatus(): Promise<void> {
  const response = await sendRelay('dm:vault-status', undefined);
  if (response?.ok === true) {
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    return;
  }
  vaultStatusError = true;
  setStatus(vaultMessage, `Состояние хранилища не загрузилось. ${failureText(response)}`, 'error');
  renderVaultStatus();
}

async function loadVaults(): Promise<void> {
  vaultsState = 'loading';
  if (vaultEmpty) vaultEmpty.hidden = true;
  renderSummary();
  const response = await sendRelay('dm:vault-list', undefined);
  if (response?.ok === true) {
    vaults = response.result.vaults;
    vaultsState = 'ready';
    renderVaults();
    return;
  }
  vaultsState = 'error';
  vaults = [];
  setStatus(vaultMessage, `Список хранилищ не загрузился. ${failureText(response)}`, 'error');
  renderVaults();
}

async function activeChatId(): Promise<string | undefined> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const raw = tabs[0]?.url;
    if (!raw) return undefined;

    const url = new URL(raw);
    if (url.hostname !== 'chatgpt.com' && url.hostname !== 'chat.openai.com') return undefined;

    const match = url.pathname.match(/^\/c\/([^/?#]+)/u);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function recordAction(text: string): Promise<void> {
  const action = { text, at: new Date().toISOString() };
  if (lastActionEl) lastActionEl.textContent = `${text} · ${formatDate(action.at)}`;
  try {
    await browser.storage.local.set({ [LAST_ACTION_KEY]: action });
  } catch {
    // Last-action display is cosmetic; never fail an operation for it.
  }
}

async function loadLastAction(): Promise<void> {
  try {
    const stored = await browser.storage.local.get(LAST_ACTION_KEY);
    const action = stored[LAST_ACTION_KEY] as { text?: unknown; at?: unknown } | undefined;
    if (
      action &&
      typeof action.text === 'string' &&
      action.text.length <= 200 &&
      typeof action.at === 'string'
    ) {
      if (lastActionEl) lastActionEl.textContent = `${action.text} · ${formatDate(action.at)}`;
    }
  } catch {
    // Keep the placeholder.
  }
}

function decodeBytes(value: Uint8Array | string): Uint8Array | undefined {
  if (typeof value !== 'string') return value;
  return base64ToBytes(value);
}

function warningText(warnings: readonly string[]): string {
  return warnings.length > 0 ? `\n${warnings.join('\n')}` : '';
}

function setManualBusy(value: boolean): void {
  busy = value;
  if (manualPanel) manualPanel.setAttribute('aria-busy', value ? 'true' : 'false');
  updateManualAvailability();
}

async function runAnonymize(): Promise<void> {
  const file = anonymizeInput?.files?.[0];
  if (!file) {
    setStatus(manualStatus, 'Файл не выбран. Выберите файл и повторите.', 'error');
    return;
  }
  if (settings?.enabled === false) {
    setStatus(manualStatus, ERROR_TEXT.DISABLED, 'error');
    return;
  }
  if (vaultStatus?.locked) {
    setStatus(manualStatus, ERROR_TEXT.LOCKED, 'error');
    return;
  }
  if (file.size > maxBytes()) {
    setStatus(manualStatus, ERROR_TEXT.LIMIT, 'error');
    return;
  }

  setManualBusy(true);
  setStatus(manualStatus, 'Обрабатываем файл…', 'idle');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const prefix = parseTags(file.name)[0]?.prefix;

    const response = await sendRelay('dm:anonymize-file', {
      bytes: bytesToBase64(bytes),
      name: file.name,
      mime: file.type || 'application/octet-stream',
      chatId: currentChatId,
      prefix,
    });

    if (response?.ok !== true) {
      setStatus(manualStatus, failureText(response), 'error');
      if (!response || response.error.code === 'LOCKED') void loadVaultStatus();
      return;
    }

    const result: AnonymizeFileResult = response.result;
    const masked = decodeBytes(result.maskedBytes);
    if (!masked) {
      setStatus(manualStatus, ERROR_TEXT.INTERNAL, 'error');
      return;
    }

    saveBytes(
      masked,
      result.maskedName,
      result.maskedMime ?? mimeForName(result.maskedName, file.type),
    );
    const total = result.entities.reduce((sum, entity) => sum + Math.max(0, entity.count), 0);
    const text = `Анонимизировано: ${total}. Маскированный файл скачан.`;
    setStatus(manualStatus, `${text}${warningText(result.warnings)}`, 'success');
    void recordAction(`Анонимизировано: ${total}`);
    void loadVaults();
  } catch {
    setStatus(manualStatus, ERROR_TEXT.NO_RESPONSE, 'error');
  } finally {
    setManualBusy(false);
    resetFileInput(anonymizeInput);
  }
}

async function runRestore(): Promise<void> {
  const file = restoreInput?.files?.[0];
  if (!file) {
    setStatus(manualStatus, 'Файл не выбран. Выберите файл и повторите.', 'error');
    return;
  }
  if (settings?.enabled === false) {
    setStatus(manualStatus, ERROR_TEXT.DISABLED, 'error');
    return;
  }
  if (vaultStatus?.locked) {
    setStatus(manualStatus, ERROR_TEXT.LOCKED, 'error');
    return;
  }
  if (file.size > maxBytes()) {
    setStatus(manualStatus, ERROR_TEXT.LIMIT, 'error');
    return;
  }

  setManualBusy(true);
  setStatus(manualStatus, 'Восстанавливаем файл…', 'idle');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const prefix = parseTags(file.name)[0]?.prefix;

    const response = await sendRelay('dm:restore-file', {
      bytes: bytesToBase64(bytes),
      name: file.name,
      mime: file.type || 'application/octet-stream',
      chatId: currentChatId,
      prefix,
    });

    if (response?.ok !== true) {
      setStatus(manualStatus, failureText(response), 'error');
      if (!response || response.error.code === 'LOCKED') void loadVaultStatus();
      return;
    }

    const result: RestoreFileResult = response.result;
    const restored = decodeBytes(result.bytes);
    if (!restored) {
      setStatus(manualStatus, ERROR_TEXT.INTERNAL, 'error');
      return;
    }

    saveBytes(restored, result.fileName, mimeForName(result.fileName, file.type));
    const tagCount = `${result.replacements} ${pluralRu(result.replacements, ['тег', 'тега', 'тегов'])}`;
    const text = `Восстановлено: ${tagCount}. Файл скачан.`;
    setStatus(manualStatus, `${text}${warningText(result.warnings)}`, 'success');
    void recordAction(`Восстановлено: ${tagCount}`);
  } catch {
    setStatus(manualStatus, ERROR_TEXT.NO_RESPONSE, 'error');
  } finally {
    setManualBusy(false);
    resetFileInput(restoreInput);
  }
}

function setPassphraseInvalid(invalid: boolean): void {
  if (!unlockPassphrase) return;
  if (invalid) {
    unlockPassphrase.setAttribute('aria-invalid', 'true');
  } else {
    unlockPassphrase.removeAttribute('aria-invalid');
  }
}

enabledToggle?.addEventListener('change', () => {
  void (async () => {
    const next = enabledToggle.checked;
    enabledToggle.disabled = true;
    const response = await sendRelay('dm:settings-set', { enabled: next });
    enabledToggle.disabled = false;
    if (response?.ok !== true) {
      enabledToggle.checked = !next;
      setStatus(protectionMessage, failureText(response), 'error');
      return;
    }
    settings = response.result;
    settingsError = false;
    renderProtection();
    setStatus(
      manualStatus,
      next
        ? 'Перехват включён. Перезагрузка вкладки не нужна.'
        : 'Перехват выключен. Перезагрузка вкладки не нужна.',
      next ? 'success' : 'warning',
    );
  })();
});

unlockForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    const passphrase = unlockPassphrase?.value ?? '';
    if (passphrase.length === 0) {
      setPassphraseInvalid(true);
      setStatus(vaultMessage, 'Введите парольную фразу. Поле не заполнено.', 'error');
      unlockPassphrase?.focus();
      return;
    }
    if (unlockButton) unlockButton.disabled = true;
    const response = await sendRelay('dm:vault-unlock', { passphrase });
    if (unlockButton) unlockButton.disabled = false;
    if (response?.ok !== true) {
      setStatus(vaultMessage, failureText(response), 'error');
      if (response && response.error.code === 'BAD_PASSPHRASE') {
        setPassphraseInvalid(true);
        unlockPassphrase?.focus();
      }
      return;
    }
    setPassphraseInvalid(false);
    if (unlockPassphrase) unlockPassphrase.value = '';
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    setStatus(vaultMessage, 'Хранилище разблокировано. Доступ к маппингу восстановлен.', 'success');
    lockButton?.focus();
    void loadVaults();
  })();
});

unlockDeviceButton?.addEventListener('click', () => {
  void (async () => {
    unlockDeviceButton.disabled = true;
    const response = await sendRelay('dm:vault-unlock', undefined);
    unlockDeviceButton.disabled = false;
    if (response?.ok !== true) {
      setStatus(vaultMessage, failureText(response), 'error');
      return;
    }
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    setStatus(vaultMessage, 'Хранилище разблокировано ключом устройства.', 'success');
    lockButton?.focus();
    void loadVaults();
  })();
});

lockButton?.addEventListener('click', () => {
  void (async () => {
    const response = await sendRelay('dm:vault-lock', undefined);
    if (response?.ok !== true) {
      setStatus(vaultMessage, failureText(response), 'error');
      return;
    }
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    setStatus(
      vaultMessage,
      'Хранилище заблокировано. Новые файлы не будут обрабатываться до разблокировки.',
      'warning',
    );
    if (vaultStatus.passphraseEnabled) {
      unlockPassphrase?.focus();
    } else {
      unlockDeviceButton?.focus();
    }
  })();
});

anonymizeButton?.addEventListener('click', () => {
  void runAnonymize();
});
restoreButton?.addEventListener('click', () => {
  void runRestore();
});

optionsButton?.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

browser.runtime.onMessage.addListener((message: unknown) => {
  if (readSettingsChangedEnabled(message) === undefined) return;
  void loadSettings();
});

void (async () => {
  currentChatId = await activeChatId();
  renderChatContext();
  await Promise.all([loadSettings(), loadVaultStatus(), loadVaults(), loadLastAction()]);
  renderProtection();
  renderVaultStatus();
  renderVaults();
})();
