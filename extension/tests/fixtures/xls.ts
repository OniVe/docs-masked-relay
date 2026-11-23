/**
 * Legacy BIFF8 `.xls` fixtures (M5b), generated with SheetJS 0.20.3.
 *
 * BIFF8 stores dates as numeric serials with a number format. The fixture
 * deliberately keeps `cellDates: false` so the adapter must preserve the raw
 * serial and the `z` format instead of round-tripping through `Date`.
 */

import * as XLSX from 'xlsx';

export const PERSON = 'Иванов Иван Иванович';
export const EMAIL = 'ivan@example.ru';
export const PHONE = '+7 916 123-45-67';
export const ORG = 'ООО Ромашка';
export const STRING_INN = '7707083893';
export const NUMERIC_INN = 7707083893;
/** Excel serial for 2020-01-01 (1900 date system). */
export const DATE_SERIAL = 43831;

export const XLS_MIME = 'application/vnd.ms-excel';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function writeBiff8(workbook: XLSX.WorkBook): Uint8Array {
  return new Uint8Array(XLSX.write(workbook, { bookType: 'biff8', type: 'array' }));
}

function newWorkbook(): XLSX.WorkBook {
  return XLSX.utils.book_new();
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: unknown[][]): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, name);
  return sheet;
}

/**
 * Visible sheets contain string PII and a date; a hidden and a veryHidden
 * sheet contain more text that must still be masked.
 */
export function legacyXls(): Uint8Array {
  const workbook = newWorkbook();

  const data = appendSheet(workbook, 'Данные', [
    ['ФИО', 'Email', 'Телефон', 'ИНН', 'Организация', 'Дата'],
    [PERSON, EMAIL, PHONE, `ИНН ${STRING_INN}`, ORG, DATE_SERIAL],
  ]);
  data.F2 = { t: 'n', v: DATE_SERIAL, z: 'dd.mm.yyyy' };
  data['!ref'] = 'A1:F2';

  appendSheet(workbook, 'Скрытый', [
    ['ФИО', 'Email'],
    [PERSON, EMAIL],
  ]);
  appendSheet(workbook, 'Очень скрытый', [['Клиент'], [`${PERSON} (${EMAIL})`]]);

  workbook.Workbook = {
    Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 2 }],
  };

  return writeBiff8(workbook);
}

/** A valid 10-digit numeric INN: the adapter must reject, not convert it. */
export function numericInnXls(): Uint8Array {
  const workbook = newWorkbook();
  const sheet = appendSheet(workbook, 'Данные', [
    ['ФИО', 'ИНН'],
    [PERSON, NUMERIC_INN],
  ]);
  sheet.B2 = { t: 'n', v: NUMERIC_INN };
  return writeBiff8(workbook);
}

/** A 20-digit account stored as a double: unsafe, must reject fail-closed. */
export function numericAccountXls(): Uint8Array {
  const workbook = newWorkbook();
  const sheet = appendSheet(workbook, 'Счёт', [['Счёт'], [40817810000000000000]]);
  sheet.A2 = { t: 'n', v: 40817810000000000000 };
  return writeBiff8(workbook);
}

/** Small workbook with one date cell and one numeric non-PII cell. */
export function dateXls(): Uint8Array {
  const workbook = newWorkbook();
  const sheet = appendSheet(workbook, 'Даты', [
    ['Дата', 'Количество'],
    [DATE_SERIAL, 42],
  ]);
  sheet.A2 = { t: 'n', v: DATE_SERIAL, z: 'dd.mm.yyyy' };
  sheet.B2 = { t: 'n', v: 42 };
  return writeBiff8(workbook);
}

export function readXls(bytes: Uint8Array): XLSX.WorkBook {
  return XLSX.read(bytes, { type: 'array', cellNF: true });
}
