/**
 * Shared popup/options helpers (M6b).
 *
 * Only constant, PII-free text lives here. Every background call is typed by
 * the message map and every failure is rendered from `ERROR_TEXT`, never from
 * an unknown error object.
 */

import { browser } from 'wxt/browser';
import type {
  RelayFailureCode,
  RelayMessageType,
  RelayPayloads,
  RelayResponse,
  RelayResults,
} from '../shared/messages';

export type StatusKind = 'idle' | 'success' | 'warning' | 'error';

/**
 * Russian plural form for a count: `1 чат`, `2 чата`, `5 чатов`. Forms are
 * `[one, few, many]`; 11-14 take `many` (R22-UI-1).
 */
export function pluralRu(count: number, forms: readonly [string, string, string]): string {
  const mod10 = Math.abs(count) % 10;
  const mod100 = Math.abs(count) % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export const ERROR_TEXT: Record<RelayFailureCode | 'NO_RESPONSE', string> = {
  LIMIT:
    'Файл больше лимита. Увеличьте лимит в настройках или выберите файл меньше — файл не отправлен.',
  UNSUPPORTED:
    'Формат не поддерживается. Сохраните файл как DOCX, XLSX, TXT, MD, JSON, XML или PDF.',
  UNSUPPORTED_ARCHIVE:
    'Архив ZIP64 или зашифрованный ZIP не поддерживается. Пересохраните файл как обычный DOCX или XLSX.',
  TOO_MANY_ENTITIES:
    'Файл содержит слишком много имён или сущностей для обработки. Разбейте его на части.',
  NO_VAULT:
    'Хранилище не найдено для этого файла. Восстановить можно только файл, анонимизированный на этом устройстве.',
  INTERNAL: 'Ошибка обработки. Файл не изменён; попробуйте ещё раз или выберите другой файл.',
  DISABLED: 'Перехват выключен. Включите его в окне расширения, чтобы обработать файл.',
  LOCKED: 'Хранилище заблокировано. Разблокируйте его в окне расширения и повторите.',
  BAD_PASSPHRASE: 'Неверная парольная фраза. Проверьте раскладку и попробуйте снова.',
  CONFLICT:
    'Хранилище с таким id или кодом хранилища уже существует. Импорт остановлен; существующие данные не изменены.',
  NO_RESPONSE:
    'Фоновая служба расширения не ответила. Перезагрузите расширение или вкладку и повторите.',
};

export function errorText(code: unknown): string {
  if (typeof code === 'string' && Object.hasOwn(ERROR_TEXT, code)) {
    return ERROR_TEXT[code as keyof typeof ERROR_TEXT];
  }
  return ERROR_TEXT.INTERNAL;
}

/** Returns `undefined` when the extension context is gone or silent. */
export async function sendRelay<T extends RelayMessageType>(
  type: T,
  payload: RelayPayloads[T],
): Promise<RelayResponse<RelayResults[T], RelayFailureCode> | undefined> {
  try {
    return (await browser.runtime.sendMessage({
      type,
      requestId: newRequestId(),
      payload,
    })) as RelayResponse<RelayResults[T], RelayFailureCode> | undefined;
  } catch {
    return undefined;
  }
}

export function failureText(
  response: RelayResponse<unknown, RelayFailureCode> | undefined,
): string {
  if (!response) return ERROR_TEXT.NO_RESPONSE;
  if (!response.ok) return errorText(response.error.code);
  return ERROR_TEXT.INTERNAL;
}

export function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function setStatus(element: Element | null, text: string, kind: StatusKind = 'idle'): void {
  if (!element) return;
  element.textContent = text;
  if (element instanceof HTMLElement) element.dataset.kind = kind;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function sanitizeFileName(name: string): string {
  const replaced = name.replace(/[\\/:*?"<>|]/gu, '_');
  const cleaned = [...replaced]
    .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20)
    .join('')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : 'file';
}

/** Saves through a blob anchor: no `downloads` permission is requested. */
export function saveBytes(bytes: Uint8Array | string, name: string, mime: string): void {
  const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const blob = new Blob([body as unknown as BlobPart], {
    type: mime || 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeFileName(name);
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** MIME fallback for manual mode when the File has no useful type. */
export function mimeForName(name: string, fallback: string): string {
  if (fallback && fallback !== 'application/octet-stream') return fallback;
  if (/\.txt$/iu.test(name)) return 'text/plain';
  if (/\.md$/iu.test(name)) return 'text/markdown';
  if (/\.(?:jsonl|ndjson)$/iu.test(name)) return 'application/x-ndjson';
  if (/\.json$/iu.test(name)) return 'application/json';
  if (/\.xml$/iu.test(name)) return 'application/xml';
  if (/\.docx$/iu.test(name)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (/\.xlsx$/iu.test(name)) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (/\.pdf$/iu.test(name)) return 'application/pdf';
  return fallback || 'application/octet-stream';
}

/** Restores a `<input type=file>` element for repeated use. */
export function resetFileInput(input: HTMLInputElement | null): void {
  if (input) input.value = '';
}
