/**
 * Legacy Excel `.xls` adapter (M5b).
 *
 * SheetJS CE 0.20.3 reads BIFF8 (including hidden/veryHidden sheets) and
 * writes a fresh `.xlsx`. Values, formulas and dates are kept as values;
 * layout, charts, styles and macros may be lost. Numeric PII that cannot be
 * converted safely fails closed with the same checksum rules as XLSX.
 *
 * Privacy policy:
 * - every string cell, comment text and sheet name is scanned; text cells and
 *   comments are anonymized through the normal masker/LeakGuard;
 * - numeric cells are never converted: recognized INN/SNILS/OGRN/CARD/
 *   ACCOUNT/PHONE values (or long numbers under a PII-like header) reject the
 *   file instead of being shipped silently;
 * - formulas are scanned: PII in a formula string literal rejects the file;
 * - workbook/author/company/custom metadata is blanked one-way;
 * - `.xlsm`/`.xlsb` are rejected; macros are never carried over.
 *
 * SheetJS is imported lazily so the background service worker does not
 * evaluate the multi-hundred-kilobyte parser at startup.
 */

import { inn10Valid, inn12Valid, luhnCheck, ogrnValid, snilsValid } from '../checksums';
import { detectAll } from '../detect';
import { ensureStructuredScanner } from '../detect/wasm-scan';
import { anonymizeText } from '../masker';
import type {
  AnonymizeContext,
  AnonymizeResult,
  FileInput,
  FormatAdapter,
  MaskedEntity,
  RestoreResult,
  Vault,
} from '../types';
import { sha256Hex } from './txt';
import { restoreXlsx } from './xlsx';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const XLS_MIME = 'application/vnd.ms-excel';

export const XLS_LOSS_WARNING =
  'Вёрстка, стили и графики .xls могут быть утрачены; отправляется XLSX';
export const XLS_RESTORE_WARNING =
  'Исходный бинарный .xls не восстанавливается; выходной файл — XLSX';

const PII_HEADER_RE =
  /инн|снилс|телефон|тел\.|сч[её]т|карт|паспорт|полис|огрн|кпп|бик|лицев|account|phone|card|iban|policy|passport/iu;

const SAFE_TEXT_PROPS = [
  'Title',
  'Subject',
  'Author',
  'LastAuthor',
  'Manager',
  'Company',
  'Category',
  'Keywords',
  'Comments',
  'Description',
  'Status',
  'HyperlinkBase',
  'ContentStatus',
] as const;

type SheetJsModule = typeof import('xlsx');
type Workbook = import('xlsx').WorkBook;
type Cell = import('xlsx').CellObject;

function assertSupportedXlsName(name: string): void {
  const lower = name.toLowerCase();
  if (/\.(?:xlsm|xlsb|xlsx|xltm|xlt|xlam|xla)$/u.test(lower)) {
    throw new Error('XLS: this adapter only accepts legacy .xls files');
  }
  if (!lower.endsWith('.xls')) {
    throw new Error('XLS: only .xls files are supported by this adapter');
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index) : '';
}

function xlsxNameFor(name: string): string {
  const extension = extensionOf(name);
  const base = extension ? name.slice(0, -extension.length) : name;
  return `${base}.xlsx`;
}

function commitVault(target: Vault, draft: Vault): void {
  target.prefix = draft.prefix;
  target.createdAt = draft.createdAt;
  target.chatIds = draft.chatIds;
  target.files = draft.files;
  target.entities = draft.entities;
  target.personKeys = draft.personKeys;
  target.occurrences = draft.occurrences;
  target.filenameMap = draft.filenameMap;
}

async function loadSheetJs(): Promise<SheetJsModule> {
  const module = (await import('xlsx')) as unknown as SheetJsModule & {
    default?: SheetJsModule;
  };
  return module.default ?? module;
}

function columnOf(address: string): number | undefined {
  const match = /^([A-Z]+)\d+$/u.exec(address);
  if (!match?.[1]) return undefined;
  let column = 0;
  for (const char of match[1]) column = column * 26 + (char.charCodeAt(0) - 64);
  return column - 1;
}

function isDateCell(XLSX: SheetJsModule, cell: Cell): boolean {
  if (cell.t === 'd') return true;
  if (typeof cell.z !== 'string' || cell.z.length === 0) return false;
  try {
    return XLSX.SSF?.is_date(cell.z) === true;
  } catch {
    return false;
  }
}

function numericDigits(cell: Cell): string | undefined {
  const value = cell.v;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value)) return undefined;

  const text = String(Math.abs(value));
  if (!/e\+/iu.test(text)) return /^\d+$/u.test(text) ? text : undefined;

  // BIFF8 stores 15+ digit identifiers as doubles. The formatted lexeme is
  // the closest available representation; reject when it is not digits.
  const formatted = (cell.w ?? '').replace(/[^\d]/gu, '');
  return formatted.length > 0 ? formatted : undefined;
}

function cellText(cell: Cell): string | undefined {
  const type = cell.t as string;
  if (type === 's' || type === 'str' || type === 'inlineStr') {
    return typeof cell.v === 'string' ? cell.v : undefined;
  }
  return typeof cell.v === 'string' ? cell.v : undefined;
}

function numericPiiError(label: string, sheet: string, address: string): Error {
  return new Error(
    `XLS: numeric ${label} in ${sheet}!${address}; format the column as text or remove the value`,
  );
}

/**
 * Same fail-closed contract as XLSX: dates and ordinary numbers stay
 * untouched; high-confidence identifiers cannot be rewritten safely and
 * therefore reject the whole file.
 */
function assertNumericCellsSafe(
  XLSX: SheetJsModule,
  workbook: Workbook,
  config: AnonymizeContext['config'],
): void {
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const headerColumns = new Set<number>();
    for (const address of Object.keys(sheet)) {
      if (!/^[A-Z]+\d+$/u.test(address)) continue;
      const cell = sheet[address] as Cell | undefined;
      if (!cell) continue;
      const text = cellText(cell);
      if (text && PII_HEADER_RE.test(text)) {
        const column = columnOf(address);
        if (column !== undefined) headerColumns.add(column);
      }
    }

    for (const address of Object.keys(sheet)) {
      if (!/^[A-Z]+\d+$/u.test(address)) continue;
      const cell = sheet[address] as Cell | undefined;
      if (!cell) continue;
      if (cell.t !== 'n' && cell.t !== 'd') continue;
      if (isDateCell(XLSX, cell)) continue;

      const rawNumber = typeof cell.v === 'number' ? Math.abs(cell.v) : 0;
      // BIFF8 stores 15+ digit identifiers as doubles. Checksums cannot be
      // evaluated on a rounded value, so large unsafe integers reject.
      if (!Number.isSafeInteger(rawNumber) && rawNumber >= 1e13) {
        throw numericPiiError('ACCOUNT/CARD', sheetName, address);
      }

      const value = numericDigits(cell);
      if (!value) continue;

      const column = columnOf(address);
      const length = value.length;

      if (length === 10 && inn10Valid(value)) {
        throw numericPiiError('INN', sheetName, address);
      }
      if (length === 12 && inn12Valid(value)) {
        throw numericPiiError('INN', sheetName, address);
      }
      if (length === 11 && snilsValid(value)) {
        throw numericPiiError('SNILS', sheetName, address);
      }
      if ((length === 13 || length === 15) && ogrnValid(value)) {
        throw numericPiiError('OGRN', sheetName, address);
      }
      if (length >= 13 && length <= 19 && luhnCheck(value)) {
        throw numericPiiError('CARD', sheetName, address);
      }
      if (length === 20) throw numericPiiError('ACCOUNT', sheetName, address);
      if (length === 11 && /^[78]\d{10}$/u.test(value)) {
        throw numericPiiError('PHONE', sheetName, address);
      }
      if (column !== undefined && headerColumns.has(column) && (length >= 9 || rawNumber >= 1e9)) {
        throw new Error(
          `XLS: numeric value in ${sheetName}!${address} under a PII-like header; ` +
            'format the column as text or remove the value',
        );
      }
    }

    // Formulas may carry PII in string literals; a recalculation would bring
    // it back. Rewriting formula syntax is out of scope, so reject.
    for (const address of Object.keys(sheet)) {
      if (!/^[A-Z]+\d+$/u.test(address)) continue;
      const cell = sheet[address] as Cell | undefined;
      if (!cell || typeof cell.f !== 'string' || cell.f.length === 0) continue;
      if (detectAll(cell.f, config ?? {}).length > 0) {
        throw new Error(
          `XLS: PII in formula ${sheetName}!${address}; remove it from the formula and try again`,
        );
      }
    }
  }
}

function sanitizeMetadata(workbook: Workbook, warnings: string[]): void {
  let edited = 0;
  const props = workbook.Props as Record<string, unknown> | undefined;
  if (props) {
    for (const key of SAFE_TEXT_PROPS) {
      const value = props[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        props[key] = '';
        edited += 1;
      }
    }
  }
  if (workbook.Custprops && Object.keys(workbook.Custprops).length > 0) {
    workbook.Custprops = {};
    edited += 1;
  }
  if (edited > 0) {
    warnings.push('Метаданные и пользовательские свойства .xls очищены');
  }
}

function assertSheetNamesSafe(workbook: Workbook, config: AnonymizeContext['config']): void {
  for (const name of workbook.SheetNames) {
    if (detectAll(name, config ?? {}).length > 0) {
      throw new Error('XLS: имя листа содержит персональные данные; переименуйте лист');
    }
  }
}

function maskWorkbook(
  workbook: Workbook,
  config: AnonymizeContext['config'],
  draft: Vault,
  touched: Map<string, MaskedEntity>,
): number {
  let formulasDropped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    for (const address of Object.keys(sheet)) {
      if (!/^[A-Z]+\d+$/u.test(address)) continue;
      const cell = sheet[address] as Cell | undefined;
      if (!cell) continue;

      const text = cellText(cell);
      if (text !== undefined) {
        const result = anonymizeText(text, config ?? {}, draft);
        for (const entity of result.entities) touched.set(entity.key, entity);
        if (result.maskedText !== text) {
          // A cached formula string would be recomputed into the original
          // value (or into a different tag) on open. Freeze the masked text as
          // a static cell and drop the formula with a warning.
          if (cell.f !== undefined || cell.F !== undefined || cell.D !== undefined) {
            cell.f = undefined;
            cell.F = undefined;
            cell.D = undefined;
            formulasDropped += 1;
          }
          cell.v = result.maskedText;
          cell.t = 's';
          cell.r = undefined;
          cell.h = undefined;
        }
      }

      if (Array.isArray(cell.c)) {
        for (const comment of cell.c) {
          if (typeof comment.t === 'string' && comment.t.length > 0) {
            const result = anonymizeText(comment.t, config ?? {}, draft);
            for (const entity of result.entities) touched.set(entity.key, entity);
            comment.t = result.maskedText;
          }
          // Authors are one-way metadata; comment authors are not restored.
          if (typeof comment.a === 'string' && comment.a.length > 0) comment.a = '';
        }
      }
    }
  }

  return formulasDropped;
}

function readWorkbook(XLSX: SheetJsModule, bytes: Uint8Array, warnings: string[]): Workbook {
  let workbook: Workbook;
  try {
    workbook = XLSX.read(bytes, {
      type: 'array',
      cellNF: true,
      cellStyles: true,
      cellDates: false,
      bookVBA: true,
      dense: false,
    });
  } catch {
    throw new Error('XLS: не удалось прочитать BIFF8-файл; файл не отправлен');
  }

  if (workbook.vbaraw) {
    // `.xls` macros are never carried into the generated `.xlsx`.
    delete workbook.vbaraw;
    warnings.push('Макросы .xls удалены; отправляется XLSX без макросов');
  }
  return workbook;
}

function writeWorkbook(XLSX: SheetJsModule, workbook: Workbook): Uint8Array {
  try {
    const output = XLSX.write(workbook, {
      bookType: 'xlsx',
      type: 'array',
      bookSST: true,
      compression: true,
      cellStyles: true,
    }) as ArrayBuffer | Uint8Array;

    const bytes = output instanceof Uint8Array ? output : new Uint8Array(output);
    if (bytes.byteLength === 0) throw new Error('empty writer output');

    // A quick re-read catches a broken writer before bytes leave the adapter.
    const check = XLSX.read(bytes, { type: 'array' });
    if (check.SheetNames.length !== workbook.SheetNames.length) {
      throw new Error('sheet count mismatch');
    }
    return bytes;
  } catch {
    throw new Error('XLS: не удалось создать XLSX; файл не отправлен');
  }
}

export async function anonymizeXls(
  file: FileInput,
  ctx: AnonymizeContext,
): Promise<AnonymizeResult> {
  if (file.bytes.byteLength > ctx.maxBytes) {
    throw new Error(`File exceeds the ${ctx.maxBytes}-byte limit`);
  }
  await ensureStructuredScanner();
  assertSupportedXlsName(file.name);

  const XLSX = await loadSheetJs();
  const config = ctx.config ?? {};
  const warnings: string[] = [];
  const workbook = readWorkbook(XLSX, file.bytes, warnings);

  const sha256 = await sha256Hex(file.bytes);
  const draft = structuredClone(ctx.vault);
  const occurrenceStart = draft.occurrences.length;
  const touched = new Map<string, MaskedEntity>();

  assertSheetNamesSafe(workbook, config);
  sanitizeMetadata(workbook, warnings);
  assertNumericCellsSafe(XLSX, workbook, config);
  const formulasDropped = maskWorkbook(workbook, config, draft, touched);
  if (formulasDropped > 0) {
    warnings.push(
      `Формулы, затронутые маскированием (${formulasDropped}), заменены статическим текстом`,
    );
  }

  const maskedBytes = writeWorkbook(XLSX, workbook);
  const maskedName = xlsxNameFor(file.name);

  commitVault(ctx.vault, draft);
  const vault = ctx.vault;
  vault.files.push({
    originalName: file.name,
    maskedName,
    format: 'xlsx',
    size: file.bytes.byteLength,
    sha256,
    maskedSha256: await sha256Hex(maskedBytes),
    occurrenceStart,
    occurrenceCount: vault.occurrences.length - occurrenceStart,
  });

  return {
    maskedBytes,
    maskedName,
    maskedMime: XLSX_MIME,
    format: 'xlsx',
    entities: [...touched.values()],
    occurrences: vault.occurrences.slice(occurrenceStart),
    vaultId: vault.id,
    vaultPrefix: vault.prefix,
    warnings: [XLS_LOSS_WARNING, ...warnings],
  };
}

/** Restore input is always the generated `.xlsx`; `.xls` is never recreated. */
export async function restoreXls(file: FileInput, vault: Vault): Promise<RestoreResult> {
  const result = await restoreXlsx(file, vault);
  // restoreXlsx already resolved the record by masked-byte hash and returns the
  // stored `.xlsx` (masked) name for legacy `.xls` records.
  const original = result.fileName;
  const fileName = /\.xls$/iu.test(original) ? xlsxNameFor(original) : original;

  return {
    ...result,
    fileName,
    warnings: [XLS_RESTORE_WARNING, ...result.warnings],
  };
}

export const xlsFormatAdapter: FormatAdapter = {
  format: 'xls',
  extensions: ['.xls'],
  mimeTypes: [XLS_MIME],
  canHandle(file): boolean {
    const name = file.name.toLowerCase();
    if (/\.(?:xlsm|xlsb|xlsx|xltm|xlt|xlam|xla)$/u.test(name)) return false;
    // The extension is authoritative; `application/vnd.ms-excel` alone on a
    // random file name must not route here.
    return name.endsWith('.xls');
  },
  anonymize(file, ctx) {
    return anonymizeXls(file, ctx);
  },
  restore(file, vault) {
    return restoreXls(file, vault);
  },
};

export { xlsxNameFor };
