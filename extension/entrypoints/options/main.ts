import { browser } from 'wxt/browser';
import { ALL_LABELS } from '../../src/core/detect';
import { isCustomTagLabel, parseCustomTermLines } from '../../src/core/detect/custom';
import type { EntityLabel } from '../../src/core/types';
import {
  type AppSettings,
  type EncryptedVaultBackup,
  readSettingsChangedEnabled,
  type SettingsPatch,
  type VaultImportResult,
  type VaultStatus,
  type VaultSummary,
} from '../../src/shared/messages';
import {
  failureText,
  formatDate,
  pluralRu,
  resetFileInput,
  saveBytes,
  sendRelay,
  setStatus,
} from '../../src/ui/api';
import './style.css';

const ONBOARDING_KEY = 'dmrelay:onboarding-done';
const LAST_ACTION_KEY = 'dmrelay:last-action';
const MB = 1024 * 1024;
const MAX_IMPORT_BYTES = 140 * MB;

const LABEL_TEXT: Record<EntityLabel, string> = {
  PERSON: 'ФИО',
  EMAIL: 'E-mail',
  PHONE: 'Телефон',
  SNILS: 'СНИЛС',
  INN: 'ИНН',
  OGRN: 'ОГРН',
  KPP: 'КПП',
  BIK: 'БИК',
  ACCOUNT: 'Счёт',
  CARD: 'Банковская карта',
  IBAN: 'IBAN',
  PASSPORT: 'Паспорт',
  ADDRESS: 'Адрес',
  ORG: 'Организация',
  DATE: 'Даты',
  BIRTHDATE: 'Дата рождения',
  DOCDATE: 'Дата документа',
  POLICY: 'Полис',
  LICENSE: 'Лицензия',
  PLATE: 'Автономер',
  IP: 'IP-адрес',
  URL: 'URL',
  HANDLE: 'Никнейм',
  DOCNUM: 'Номер документа',
  SECRET: 'Секреты и ключи',
  CUSTOM: 'Свои термины',
};

const versionEl = document.querySelector<HTMLSpanElement>('#version');
if (versionEl) {
  versionEl.textContent = `v${browser.runtime.getManifest().version}`;
}

const onboarding = document.querySelector<HTMLElement>('#onboarding');
const onboardingDismiss = document.querySelector<HTMLButtonElement>('#onboarding-dismiss');

const summaryProtection = document.querySelector<HTMLElement>('#summary-protection');
const summaryVault = document.querySelector<HTMLElement>('#summary-vault');
const summaryVaults = document.querySelector<HTMLElement>('#summary-vaults');
const summaryNext = document.querySelector<HTMLParagraphElement>('#summary-next');

const enabledInput = document.querySelector<HTMLInputElement>('#enabled');
const maxBytesInput = document.querySelector<HTMLInputElement>('#max-bytes');
const lockMinutesInput = document.querySelector<HTMLInputElement>('#vault-lock-minutes');
const maskFilenamesInput = document.querySelector<HTMLInputElement>('#mask-filenames');
const stripMetadataInput = document.querySelector<HTMLInputElement>('#strip-metadata');
const aggressiveInput = document.querySelector<HTMLInputElement>('#aggressive');
const enableDateInput = document.querySelector<HTMLInputElement>('#enable-date');
const enableUrlInput = document.querySelector<HTMLInputElement>('#enable-url');
const skipCodeInput = document.querySelector<HTMLInputElement>('#skip-code');
const blockOnLeakInput = document.querySelector<HTMLInputElement>('#block-on-leak');
const customLabelInput = document.querySelector<HTMLInputElement>('#custom-label');
const customLabelError = document.querySelector<HTMLSpanElement>('#custom-label-error');
const customTermsInput = document.querySelector<HTMLTextAreaElement>('#custom-terms');
const customTermsError = document.querySelector<HTMLSpanElement>('#custom-terms-error');
const allowlistInput = document.querySelector<HTMLTextAreaElement>('#allowlist');
const labelsContainer = document.querySelector<HTMLElement>('#labels');
const labelsSummary = document.querySelector<HTMLElement>('#labels-summary');
const saveButton = document.querySelector<HTMLButtonElement>('#save-button');
const saveStatus = document.querySelector<HTMLSpanElement>('#save-status');

const vaultState = document.querySelector<HTMLSpanElement>('#vault-state');
const vaultMode = document.querySelector<HTMLSpanElement>('#vault-mode');
const vaultTitle = document.querySelector<HTMLElement>('#vault-title');
const vaultCount = document.querySelector<HTMLElement>('#vault-count');
const lockNow = document.querySelector<HTMLButtonElement>('#lock-now');
const optionsUnlockForm = document.querySelector<HTMLFormElement>('#options-unlock-form');
const optionsUnlockPassphrase = document.querySelector<HTMLInputElement>(
  '#options-unlock-passphrase',
);
const optionsUnlockButton = document.querySelector<HTMLButtonElement>('#options-unlock-button');
const optionsUnlockDevice = document.querySelector<HTMLButtonElement>('#options-unlock-device');
const passphraseEnableForm = document.querySelector<HTMLElement>('#passphrase-enable-form');
const passphraseNew = document.querySelector<HTMLInputElement>('#passphrase-new');
const passphraseNewConfirm = document.querySelector<HTMLInputElement>('#passphrase-new-confirm');
const passphraseEnableButton = document.querySelector<HTMLButtonElement>(
  '#passphrase-enable-button',
);
const passphraseChangeForm = document.querySelector<HTMLElement>('#passphrase-change-form');
const passphraseCurrent = document.querySelector<HTMLInputElement>('#passphrase-current');
const passphraseNext = document.querySelector<HTMLInputElement>('#passphrase-next');
const passphraseChangeButton = document.querySelector<HTMLButtonElement>(
  '#passphrase-change-button',
);
const passphraseRemoveForm = document.querySelector<HTMLElement>('#passphrase-remove-form');
const passphraseRemoveCurrent = document.querySelector<HTMLInputElement>(
  '#passphrase-remove-current',
);
const passphraseRemoveButton = document.querySelector<HTMLButtonElement>(
  '#passphrase-remove-button',
);
const securityMessage = document.querySelector<HTMLParagraphElement>('#security-message');

const vaultList = document.querySelector<HTMLUListElement>('#vault-list');
const vaultEmpty = document.querySelector<HTMLParagraphElement>('#vault-empty');
const exportPassphrase = document.querySelector<HTMLInputElement>('#export-passphrase');
const exportButton = document.querySelector<HTMLButtonElement>('#export-button');
const exportMessage = document.querySelector<HTMLParagraphElement>('#export-message');
const importFile = document.querySelector<HTMLInputElement>('#import-file');
const importPassphrase = document.querySelector<HTMLInputElement>('#import-passphrase');
const importButton = document.querySelector<HTMLButtonElement>('#import-button');
const importMessage = document.querySelector<HTMLParagraphElement>('#import-message');
const clearDataButton = document.querySelector<HTMLButtonElement>('#clear-data-button');
const clearDataPanel = document.querySelector<HTMLElement>('#clear-data-panel');
const clearDataCancel = document.querySelector<HTMLButtonElement>('#clear-data-cancel');
const clearDataConfirm = document.querySelector<HTMLButtonElement>('#clear-data-confirm');
const dataTitle = document.querySelector<HTMLElement>('#data-title');
const dataMessage = document.querySelector<HTMLParagraphElement>('#data-message');

let settings: AppSettings | undefined;
let settingsError = false;
let vaultStatus: VaultStatus | undefined;
let vaultStatusError = false;
let vaults: VaultSummary[] = [];
let vaultsState: 'loading' | 'ready' | 'error' = 'loading';
const labelInputs = new Map<EntityLabel, HTMLInputElement>();

/** DATE and URL have their own toggles and live outside the grid. */
const GRID_LABELS = ALL_LABELS.filter((label) => label !== 'DATE' && label !== 'URL');

function buildLabelGrid(): void {
  if (!labelsContainer) return;
  labelsContainer.replaceChildren();
  for (const label of GRID_LABELS) {
    const row = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.label = label;
    const text = document.createElement('span');
    text.textContent = LABEL_TEXT[label];
    row.append(input, text);
    labelsContainer.append(row);
    labelInputs.set(label, input);
  }
}

function activeLabelCount(): number {
  if (!settings) return 0;
  const configured = settings.detection.labels;
  const selected = configured === null ? new Set(GRID_LABELS) : new Set(configured);
  let count = 0;
  for (const label of GRID_LABELS) {
    if (selected.has(label)) count += 1;
  }
  const dateEnabled =
    configured === null ? settings.detection.enableDate : configured.includes('DATE');
  const urlEnabled =
    configured === null ? settings.detection.enableUrl : configured.includes('URL');
  if (dateEnabled) count += 1;
  if (urlEnabled) count += 1;
  return count;
}

function vaultWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'хранилище';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'хранилища';
  return 'хранилищ';
}

function setPill(
  element: HTMLElement | null,
  kind: 'good' | 'warn' | 'bad' | 'loading' | 'neutral',
  text: string,
): void {
  if (!element) return;
  element.dataset.kind = kind;
  element.textContent = text;
}

function renderSummary(): void {
  if (settingsError) {
    setPill(summaryProtection, 'bad', 'Нет данных');
  } else if (!settings) {
    setPill(summaryProtection, 'loading', 'Загрузка…');
  } else {
    setPill(
      summaryProtection,
      settings.enabled ? 'good' : 'warn',
      settings.enabled ? 'Включена' : 'Выключена',
    );
  }

  if (vaultStatusError) {
    setPill(summaryVault, 'bad', 'Нет данных');
  } else if (!vaultStatus) {
    setPill(summaryVault, 'loading', 'Загрузка…');
  } else {
    setPill(
      summaryVault,
      vaultStatus.locked ? 'warn' : 'good',
      vaultStatus.locked ? 'Заблокирован' : 'Разблокирован',
    );
  }

  if (vaultsState === 'error') {
    setPill(summaryVaults, 'bad', 'Не загрузились');
  } else if (vaultsState === 'loading') {
    setPill(summaryVaults, 'loading', 'Загрузка…');
  } else if (vaults.length === 0) {
    setPill(summaryVaults, 'neutral', 'Пока нет');
  } else {
    setPill(summaryVaults, 'good', `${vaults.length} ${vaultWord(vaults.length)}`);
  }

  if (!summaryNext) return;
  if (settingsError) {
    summaryNext.textContent =
      'Настройки не загрузились. Обновите страницу или перезагрузите расширение.';
  } else if (!settings) {
    summaryNext.textContent = 'Загружаем состояние…';
  } else if (!settings.enabled) {
    summaryNext.textContent =
      'Перехват выключен. Включите его и сохраните настройки, чтобы файлы обрабатывались.';
  } else if (vaultStatusError) {
    summaryNext.textContent =
      'Состояние хранилища не загрузилось. Проверьте раздел «Парольная фраза и блокировка».';
  } else if (!vaultStatus) {
    summaryNext.textContent = 'Проверяем состояние хранилища…';
  } else if (vaultStatus.locked) {
    summaryNext.textContent =
      'Хранилище заблокировано. Разблокируйте его ниже, иначе отправка файлов будет остановлена.';
  } else if (vaultsState === 'loading') {
    summaryNext.textContent = 'Защита работает. Загружаем список хранилищ…';
  } else if (vaultsState === 'error') {
    summaryNext.textContent =
      'Защита работает, но список хранилищ не загрузился. Обновите страницу.';
  } else if (vaults.length === 0) {
    summaryNext.textContent =
      'Защита работает. Хранилище пока не создано — оно появится после первой анонимизации в popup.';
  } else {
    summaryNext.textContent = 'Защита работает. Файлы обрабатываются автоматически.';
  }
}

function renderSettings(): void {
  if (!settings) return;
  if (enabledInput) enabledInput.checked = settings.enabled;
  if (maxBytesInput) {
    const megabytes = settings.maxBytes / MB;
    maxBytesInput.value = String(Math.max(1, Math.round(megabytes)));
  }
  if (lockMinutesInput) lockMinutesInput.value = String(settings.vaultLockMinutes);
  if (maskFilenamesInput) maskFilenamesInput.checked = settings.maskFilenames;
  if (stripMetadataInput) stripMetadataInput.checked = true; // product invariant
  if (aggressiveInput) aggressiveInput.checked = settings.detection.aggressive;
  if (skipCodeInput) skipCodeInput.checked = settings.detection.skipCode;
  if (blockOnLeakInput) blockOnLeakInput.checked = settings.detection.blockOnLeak;

  const configured = settings.detection.labels;
  const selected = configured === null ? new Set(GRID_LABELS) : new Set(configured);
  for (const [label, input] of labelInputs) input.checked = selected.has(label);

  const dateEnabled =
    configured === null ? settings.detection.enableDate : configured.includes('DATE');
  const urlEnabled =
    configured === null ? settings.detection.enableUrl : configured.includes('URL');
  if (enableDateInput) enableDateInput.checked = dateEnabled;
  if (enableUrlInput) enableUrlInput.checked = urlEnabled;

  if (customLabelInput) customLabelInput.value = settings.detection.customLabel;
  if (customTermsInput) customTermsInput.value = settings.detection.customTerms.join('\n');
  if (allowlistInput) allowlistInput.value = settings.detection.allowlist.join('\n');
  if (labelsSummary) {
    labelsSummary.textContent = `Включено ${activeLabelCount()} из ${ALL_LABELS.length}`;
  }
  updateCustomLabelError();
  updateCustomTermErrors();
  renderSummary();
}

function parseLines(value: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of value.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= 500) break;
  }
  return lines;
}

function clearInvalid(...inputs: (HTMLInputElement | HTMLTextAreaElement | null)[]): void {
  for (const input of inputs) input?.removeAttribute('aria-invalid');
}

function markInvalid(input: HTMLInputElement | HTMLTextAreaElement | null): void {
  input?.setAttribute('aria-invalid', 'true');
  input?.focus();
}

/**
 * Live inline explanation for the global custom tag label. An invalid value
 * is not stored; save sends `CUSTOM` and reports the fallback in the status.
 */
function updateCustomLabelError(): void {
  const value = customLabelInput?.value.trim() ?? '';
  if (value.length === 0 || isCustomTagLabel(value)) {
    customLabelInput?.removeAttribute('aria-invalid');
    setStatus(customLabelError, '');
    return;
  }
  customLabelInput?.setAttribute('aria-invalid', 'true');
  setStatus(
    customLabelError,
    'Метка не подходит: только заглавные латинские буквы и цифры, первый символ — буква, до 32 символов. При сохранении будет использована CUSTOM.',
    'error',
  );
}

/** Explains per-line labels that the engine would fall back to `CUSTOM`. */
function updateCustomTermErrors(): void {
  const rules = parseCustomTermLines(parseLines(customTermsInput?.value ?? ''), 'CUSTOM');
  const invalid = rules.filter((rule) => rule.invalidLabel !== undefined);
  if (invalid.length === 0) {
    customTermsInput?.removeAttribute('aria-invalid');
    setStatus(customTermsError, '');
    return;
  }
  customTermsInput?.setAttribute('aria-invalid', 'true');
  const labels = invalid
    .slice(0, 3)
    .map((rule) => (rule.invalidLabel === '' ? 'пустая метка' : `«${rule.invalidLabel}»`))
    .join(', ');
  const suffix = invalid.length > 3 ? ` и ещё ${invalid.length - 3}` : '';
  setStatus(
    customTermsError,
    `Метка ${labels}${suffix} не подходит: только заглавные латинские буквы и цифры, первый символ — буква, до 32 символов. Для этих строк будет использована CUSTOM.`,
    'warning',
  );
}

interface CollectedPatch {
  patch: SettingsPatch;
  warnings: string[];
}

function collectPatch(): CollectedPatch | undefined {
  clearInvalid(maxBytesInput, lockMinutesInput);
  const megabytes = Number(maxBytesInput?.value ?? '');
  if (!Number.isFinite(megabytes) || megabytes < 1 || megabytes > 100) {
    markInvalid(maxBytesInput);
    setStatus(saveStatus, 'Лимит файла: от 1 до 100 МБ. Введите целое число.', 'error');
    return undefined;
  }
  const lockMinutes = Number(lockMinutesInput?.value ?? '');
  if (!Number.isInteger(lockMinutes) || lockMinutes < 1 || lockMinutes > 240) {
    markInvalid(lockMinutesInput);
    setStatus(saveStatus, 'Автоблокировка: от 1 до 240 минут. Введите целое число.', 'error');
    return undefined;
  }

  const labels: EntityLabel[] = [];
  for (const [label, input] of labelInputs) {
    if (input.checked) labels.push(label);
  }
  if (enableDateInput?.checked) labels.push('DATE');
  if (enableUrlInput?.checked) labels.push('URL');

  // The engine always falls back to CUSTOM for an invalid label, so the
  // stored value must be valid too; the user sees why in the inline error and
  // in the save status instead of silently losing the whole patch.
  const warnings: string[] = [];
  const rawLabel = customLabelInput?.value.trim() ?? '';
  const customLabel = isCustomTagLabel(rawLabel) ? rawLabel : 'CUSTOM';
  if (rawLabel.length > 0 && customLabel === 'CUSTOM' && rawLabel !== 'CUSTOM') {
    warnings.push(
      'Метка замены не соответствовала формату, поэтому сохранена как CUSTOM (только заглавные латинские буквы и цифры, первый символ — буква, до 32 символов).',
    );
  }
  const customTerms = parseLines(customTermsInput?.value ?? '');
  const invalidTermLabels = parseCustomTermLines(customTerms, 'CUSTOM').filter(
    (rule) => rule.invalidLabel !== undefined,
  );
  if (invalidTermLabels.length > 0) {
    warnings.push(
      `В ${invalidTermLabels.length} строк(ах) метка не подошла — для них используется CUSTOM.`,
    );
  }

  return {
    patch: {
      enabled: enabledInput?.checked ?? true,
      maxBytes: Math.round(megabytes * MB),
      vaultLockMinutes: lockMinutes,
      maskFilenames: maskFilenamesInput?.checked ?? true,
      stripMetadata: true,
      detection: {
        labels,
        aggressive: aggressiveInput?.checked ?? false,
        enableDate: enableDateInput?.checked ?? false,
        enableUrl: enableUrlInput?.checked ?? false,
        skipCode: skipCodeInput?.checked ?? false,
        blockOnLeak: blockOnLeakInput?.checked ?? true,
        customTerms,
        customLabel,
        allowlist: parseLines(allowlistInput?.value ?? ''),
      },
    },
    warnings,
  };
}

async function saveSettings(): Promise<void> {
  const collected = collectPatch();
  if (!collected) return;
  if (saveButton) saveButton.disabled = true;
  setStatus(saveStatus, 'Сохраняем настройки…');
  try {
    const response = await sendRelay('dm:settings-set', collected.patch);
    if (response?.ok !== true) {
      setStatus(saveStatus, failureText(response), 'error');
      return;
    }
    settings = response.result;
    settingsError = false;
    renderSettings();
    if (collected.warnings.length > 0) {
      setStatus(saveStatus, `Настройки сохранены. ${collected.warnings.join(' ')}`, 'warning');
    } else {
      setStatus(saveStatus, 'Настройки сохранены. Изменения уже применяются.', 'success');
    }
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function renderVaultStatus(): void {
  const status = vaultStatus;
  if (vaultState) {
    if (!status) {
      vaultState.textContent = vaultStatusError ? 'Недоступен' : '…';
      vaultState.dataset.kind = vaultStatusError ? 'error' : '';
    } else {
      vaultState.textContent = status.locked ? 'Заблокирован' : 'Разблокирован';
      vaultState.dataset.kind = status.locked ? 'locked' : 'unlocked';
    }
  }

  if (vaultMode) {
    if (!status) {
      vaultMode.textContent = vaultStatusError
        ? 'Состояние хранилища не загрузилось.'
        : 'Проверяем состояние хранилища…';
    } else {
      vaultMode.textContent = status.passphraseEnabled
        ? 'Режим: парольная фраза'
        : 'Режим: ключ устройства';
    }
  }

  if (lockNow) lockNow.hidden = !status || status.locked;
  if (optionsUnlockForm) {
    optionsUnlockForm.hidden = status?.locked !== true || status.passphraseEnabled !== true;
  }
  if (optionsUnlockDevice) {
    optionsUnlockDevice.hidden = status?.locked !== true || status.passphraseEnabled === true;
  }
  if (passphraseEnableForm) {
    passphraseEnableForm.hidden = status === undefined || status.locked || status.passphraseEnabled;
  }
  if (passphraseChangeForm) passphraseChangeForm.hidden = status?.passphraseEnabled !== true;
  if (passphraseRemoveForm) passphraseRemoveForm.hidden = status?.passphraseEnabled !== true;
  if (exportButton) exportButton.disabled = status === undefined || status.locked;
  renderSummary();
}

function renderVaults(): void {
  if (vaultList) {
    vaultList.replaceChildren();
    for (const vault of vaults) {
      const item = document.createElement('li');

      const row = document.createElement('div');
      row.className = 'vault-row';
      const info = document.createElement('div');
      info.className = 'vault-info';
      const prefix = document.createElement('span');
      prefix.className = 'vault-prefix';
      prefix.textContent = vault.prefix;
      const meta = document.createElement('span');
      meta.className = 'muted';
      const chats = vault.chatIds.length;
      meta.textContent = `${chats} ${pluralRu(chats, ['чат', 'чата', 'чатов'])} · обновлён ${formatDate(vault.updatedAt)}`;
      info.append(prefix, meta);

      const actions = document.createElement('div');
      actions.className = 'vault-actions';
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'secondary small';
      trigger.textContent = 'Удалить хранилище';
      actions.append(trigger);
      row.append(info, actions);

      const confirm = document.createElement('div');
      confirm.className = 'vault-confirm';
      confirm.hidden = true;
      const question = document.createElement('p');
      question.textContent = `Удалить хранилище ${vault.prefix}? Без backup его не восстановить.`;
      const confirmActions = document.createElement('div');
      confirmActions.className = 'confirm-actions';
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.className = 'secondary small';
      keep.textContent = 'Оставить хранилище';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger small';
      remove.textContent = `Удалить хранилище ${vault.prefix}`;
      confirmActions.append(keep, remove);
      confirm.append(question, confirmActions);

      trigger.addEventListener('click', () => {
        actions.hidden = true;
        confirm.hidden = false;
        keep.focus();
      });
      keep.addEventListener('click', () => {
        confirm.hidden = true;
        actions.hidden = false;
        trigger.focus();
      });
      remove.addEventListener('click', () => {
        void (async () => {
          keep.disabled = true;
          remove.disabled = true;
          const response = await sendRelay('dm:vault-delete', { id: vault.id });
          if (response?.ok !== true) {
            keep.disabled = false;
            remove.disabled = false;
            setStatus(securityMessage, failureText(response), 'error');
            return;
          }
          setStatus(
            securityMessage,
            `Хранилище ${vault.prefix} удалено. Файлы с его тегами больше не восстановить.`,
            'warning',
          );
          await loadVaults();
          vaultTitle?.focus();
        })();
      });

      item.append(row, confirm);
      vaultList.append(item);
    }
  }

  if (vaultEmpty) vaultEmpty.hidden = vaultsState !== 'ready' || vaults.length > 0;
  if (vaultCount) {
    if (vaultsState === 'error') {
      vaultCount.textContent = 'Не загрузились';
    } else if (vaultsState === 'loading') {
      vaultCount.textContent = 'Загрузка…';
    } else {
      vaultCount.textContent =
        vaults.length === 0 ? 'Пока нет' : `${vaults.length} ${vaultWord(vaults.length)}`;
    }
  }
  renderSummary();
}

async function loadSettings(): Promise<void> {
  const response = await sendRelay('dm:settings-get', undefined);
  if (response?.ok === true) {
    settings = response.result;
    settingsError = false;
    renderSettings();
    return;
  }
  settingsError = true;
  if (labelsSummary) labelsSummary.textContent = 'Нет данных';
  setStatus(saveStatus, failureText(response), 'error');
  renderSummary();
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
  setStatus(
    securityMessage,
    `Состояние хранилища не загрузилось. ${failureText(response)}`,
    'error',
  );
  renderVaultStatus();
}

async function loadVaults(): Promise<void> {
  vaultsState = 'loading';
  if (vaultEmpty) vaultEmpty.hidden = true;
  if (vaultCount) vaultCount.textContent = 'Загрузка…';
  renderSummary();
  const response = await sendRelay('dm:vault-list', undefined);
  if (response?.ok === true) {
    vaults = response.result.vaults;
    vaultsState = 'ready';
    renderVaults();
    return;
  }
  vaults = [];
  vaultsState = 'error';
  setStatus(securityMessage, `Список хранилищ не загрузился. ${failureText(response)}`, 'error');
  renderVaults();
}

async function loadOnboarding(): Promise<void> {
  try {
    const stored = await browser.storage.local.get(ONBOARDING_KEY);
    if (onboarding) onboarding.hidden = stored[ONBOARDING_KEY] === true;
  } catch {
    if (onboarding) onboarding.hidden = false;
  }
}

onboardingDismiss?.addEventListener('click', () => {
  if (onboarding) onboarding.hidden = true;
  void browser.storage.local.set({ [ONBOARDING_KEY]: true }).catch(() => {});
  enabledInput?.focus();
});

saveButton?.addEventListener('click', () => {
  void saveSettings();
});

customLabelInput?.addEventListener('input', updateCustomLabelError);
customTermsInput?.addEventListener('input', updateCustomTermErrors);

optionsUnlockForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    const passphrase = optionsUnlockPassphrase?.value ?? '';
    if (passphrase.length === 0) {
      markInvalid(optionsUnlockPassphrase);
      setStatus(securityMessage, 'Введите парольную фразу. Поле не заполнено.', 'error');
      return;
    }
    if (optionsUnlockButton) optionsUnlockButton.disabled = true;
    const response = await sendRelay('dm:vault-unlock', { passphrase });
    if (optionsUnlockButton) optionsUnlockButton.disabled = false;
    if (response?.ok !== true) {
      setStatus(securityMessage, failureText(response), 'error');
      if (response && response.error.code === 'BAD_PASSPHRASE') {
        markInvalid(optionsUnlockPassphrase);
      }
      return;
    }
    optionsUnlockPassphrase?.removeAttribute('aria-invalid');
    if (optionsUnlockPassphrase) optionsUnlockPassphrase.value = '';
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    setStatus(
      securityMessage,
      'Хранилище разблокировано. Доступ к маппингу восстановлен.',
      'success',
    );
    lockNow?.focus();
  })();
});

optionsUnlockDevice?.addEventListener('click', () => {
  void (async () => {
    optionsUnlockDevice.disabled = true;
    const response = await sendRelay('dm:vault-unlock', undefined);
    optionsUnlockDevice.disabled = false;
    if (response?.ok !== true) {
      setStatus(securityMessage, failureText(response), 'error');
      return;
    }
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    setStatus(securityMessage, 'Хранилище разблокировано ключом устройства.', 'success');
    lockNow?.focus();
  })();
});

lockNow?.addEventListener('click', () => {
  void (async () => {
    const response = await sendRelay('dm:vault-lock', undefined);
    if (response?.ok !== true) {
      setStatus(securityMessage, failureText(response), 'error');
      return;
    }
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    setStatus(
      securityMessage,
      'Хранилище заблокировано. Отправка файлов остановится до разблокировки.',
      'warning',
    );
    if (vaultStatus.passphraseEnabled) {
      optionsUnlockPassphrase?.focus();
    } else {
      optionsUnlockDevice?.focus();
    }
  })();
});

passphraseEnableButton?.addEventListener('click', () => {
  void (async () => {
    const next = passphraseNew?.value ?? '';
    if (next.length === 0) {
      markInvalid(passphraseNew);
      setStatus(securityMessage, 'Введите новую парольную фразу. Поле не заполнено.', 'error');
      return;
    }
    if (next !== (passphraseNewConfirm?.value ?? '')) {
      markInvalid(passphraseNewConfirm);
      setStatus(
        securityMessage,
        'Парольные фразы не совпадают. Введите одинаковую фразу в оба поля.',
        'error',
      );
      return;
    }
    clearInvalid(passphraseNew, passphraseNewConfirm);
    passphraseEnableButton.disabled = true;
    const response = await sendRelay('dm:vault-set-passphrase', { passphrase: next });
    passphraseEnableButton.disabled = false;
    if (response?.ok !== true) {
      setStatus(securityMessage, failureText(response), 'error');
      return;
    }
    if (passphraseNew) passphraseNew.value = '';
    if (passphraseNewConfirm) passphraseNewConfirm.value = '';
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    await loadSettings();
    setStatus(
      securityMessage,
      'Парольная фраза включена. Хранилище закрыто после перезапуска браузера и по таймауту.',
      'success',
    );
  })();
});

passphraseChangeButton?.addEventListener('click', () => {
  void (async () => {
    const current = passphraseCurrent?.value ?? '';
    const next = passphraseNext?.value ?? '';
    if (current.length === 0 || next.length === 0) {
      markInvalid(current.length === 0 ? passphraseCurrent : passphraseNext);
      setStatus(
        securityMessage,
        'Введите текущую и новую парольные фразы. Оба поля обязательны.',
        'error',
      );
      return;
    }
    clearInvalid(passphraseCurrent, passphraseNext);
    passphraseChangeButton.disabled = true;
    const response = await sendRelay('dm:vault-change-passphrase', {
      currentPassphrase: current,
      newPassphrase: next,
    });
    passphraseChangeButton.disabled = false;
    if (response?.ok !== true) {
      setStatus(securityMessage, failureText(response), 'error');
      return;
    }
    if (passphraseCurrent) passphraseCurrent.value = '';
    if (passphraseNext) passphraseNext.value = '';
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    setStatus(
      securityMessage,
      'Парольная фраза изменена. Старая фраза больше не подходит.',
      'success',
    );
  })();
});

passphraseRemoveButton?.addEventListener('click', () => {
  void (async () => {
    const current = passphraseRemoveCurrent?.value ?? '';
    if (current.length === 0) {
      markInvalid(passphraseRemoveCurrent);
      setStatus(securityMessage, 'Введите текущую парольную фразу. Поле не заполнено.', 'error');
      return;
    }
    passphraseRemoveCurrent?.removeAttribute('aria-invalid');
    passphraseRemoveButton.disabled = true;
    const response = await sendRelay('dm:vault-remove-passphrase', { passphrase: current });
    passphraseRemoveButton.disabled = false;
    if (response?.ok !== true) {
      setStatus(securityMessage, failureText(response), 'error');
      return;
    }
    if (passphraseRemoveCurrent) passphraseRemoveCurrent.value = '';
    vaultStatus = response.result;
    vaultStatusError = false;
    renderVaultStatus();
    await loadSettings();
    setStatus(
      securityMessage,
      'Парольная фраза снята. Хранилище снова открывается ключом устройства.',
      'warning',
    );
  })();
});

exportButton?.addEventListener('click', () => {
  void (async () => {
    const passphrase = exportPassphrase?.value ?? '';
    if (passphrase.length === 0) {
      markInvalid(exportPassphrase);
      setStatus(exportMessage, 'Введите пароль для экспорта. Поле не заполнено.', 'error');
      return;
    }
    exportPassphrase?.removeAttribute('aria-invalid');
    exportButton.disabled = true;
    const response = await sendRelay('dm:vault-export', { passphrase });
    exportButton.disabled = false;
    if (response?.ok !== true) {
      setStatus(exportMessage, failureText(response), 'error');
      return;
    }
    const backup: EncryptedVaultBackup = response.result;
    const date = new Date().toISOString().slice(0, 10);
    saveBytes(
      JSON.stringify(backup, null, 2),
      `docs-masked-vaults-${date}.json`,
      'application/json',
    );
    if (exportPassphrase) exportPassphrase.value = '';
    setStatus(
      exportMessage,
      'Зашифрованный backup скачан. Пароль не сохранён — запишите его отдельно.',
      'success',
    );
  })();
});

importButton?.addEventListener('click', () => {
  void (async () => {
    const file = importFile?.files?.[0];
    if (!file) {
      setStatus(importMessage, 'Файл backup не выбран. Выберите .json и повторите.', 'error');
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setStatus(
        importMessage,
        'Файл backup больше 140 МБ. Импорт остановлен; выберите backup меньше.',
        'error',
      );
      return;
    }
    const passphrase = importPassphrase?.value ?? '';
    if (passphrase.length === 0) {
      markInvalid(importPassphrase);
      setStatus(importMessage, 'Введите пароль от backup. Поле не заполнено.', 'error');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setStatus(
        importMessage,
        'Файл backup повреждён: это не JSON. Выберите файл, созданный экспортом расширения.',
        'error',
      );
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      setStatus(importMessage, 'Файл backup повреждён: внутри нет данных хранилища.', 'error');
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.salt !== 'string' ||
      typeof record.iv !== 'string' ||
      typeof record.ciphertext !== 'string'
    ) {
      setStatus(
        importMessage,
        'Файл backup повреждён: нет salt, iv или ciphertext. Импорт остановлен.',
        'error',
      );
      return;
    }

    importPassphrase?.removeAttribute('aria-invalid');
    if (importButton) importButton.disabled = true;
    const response = await sendRelay('dm:vault-import', {
      salt: record.salt,
      iv: record.iv,
      ciphertext: record.ciphertext,
      passphrase,
    });
    if (importButton) importButton.disabled = false;
    if (response?.ok !== true) {
      setStatus(importMessage, failureText(response), 'error');
      return;
    }
    const result: VaultImportResult = response.result;
    if (importPassphrase) importPassphrase.value = '';
    resetFileInput(importFile);
    setStatus(
      importMessage,
      `Импортировано: ${result.imported} ${vaultWord(result.imported)}, ${result.files} ${pluralRu(result.files, ['файл', 'файла', 'файлов'])}.`,
      'success',
    );
    await loadVaults();
  })();
});

function openClearConfirm(): void {
  if (clearDataPanel) clearDataPanel.hidden = false;
  if (clearDataButton) clearDataButton.hidden = true;
  setStatus(dataMessage, 'Подтвердите удаление. Это действие необратимо.', 'warning');
  clearDataCancel?.focus();
}

function closeClearConfirm(): void {
  if (clearDataPanel) clearDataPanel.hidden = true;
  if (clearDataButton) clearDataButton.hidden = false;
}

clearDataButton?.addEventListener('click', openClearConfirm);

clearDataCancel?.addEventListener('click', () => {
  closeClearConfirm();
  setStatus(dataMessage, 'Данные не удалены. Ничего не изменилось.', 'idle');
  clearDataButton?.focus();
});

clearDataConfirm?.addEventListener('click', () => {
  void (async () => {
    clearDataConfirm.disabled = true;
    if (clearDataCancel) clearDataCancel.disabled = true;
    const response = await sendRelay('dm:clear-data', undefined);
    clearDataConfirm.disabled = false;
    if (clearDataCancel) clearDataCancel.disabled = false;
    if (response?.ok !== true) {
      setStatus(dataMessage, failureText(response), 'error');
      clearDataConfirm.focus();
      return;
    }
    try {
      await browser.storage.local.remove([ONBOARDING_KEY, LAST_ACTION_KEY]);
    } catch {
      // IndexedDB data is already gone; storage.local is cosmetic.
    }
    closeClearConfirm();
    setStatus(
      dataMessage,
      'Все данные удалены с этого устройства: хранилища, ключи и настройки.',
      'warning',
    );
    await Promise.all([loadSettings(), loadVaultStatus(), loadVaults(), loadOnboarding()]);
    dataTitle?.focus();
  })();
});

browser.runtime.onMessage.addListener((message: unknown) => {
  const enabled = readSettingsChangedEnabled(message);
  if (enabled === undefined) return;
  if (settings) settings.enabled = enabled;
  if (enabledInput) enabledInput.checked = enabled;
  renderSummary();
});

buildLabelGrid();
void (async () => {
  await Promise.all([loadOnboarding(), loadSettings(), loadVaultStatus(), loadVaults()]);
})();
