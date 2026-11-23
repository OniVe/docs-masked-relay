import { describe, expect, it } from 'vitest';
import {
  anonymizeXlsx,
  assertPackageValid,
  createVault,
  decodeXml,
  type FileInput,
  restoreXlsx,
  scanXml,
  snapshotPackage,
  unzipPackage,
  type XmlElement,
  type XmlScan,
  xlsxFormatAdapter,
} from '../../src/core';
import {
  buildXlsx,
  EP_NS,
  fullXlsx,
  fullXlsxParts,
  minimalXlsx,
  minimalXlsxParts,
  S_NS,
  VT_NS,
  xmlDeclaration,
} from '../fixtures/xlsx';

const encoder = new TextEncoder();
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const PHONE = '+7 916 123-45-67';
const PII = [PERSON, EMAIL, PHONE];

function fileOf(bytes: Uint8Array, name = 'test.xlsx'): FileInput {
  return { name, mimeType: XLSX_MIME, bytes };
}

function contextFor(text = PERSON) {
  return { vault: createVault(text, { prefix: 'DM7F3' }), maxBytes: 64 * 1024 * 1024 };
}

function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  return unzipPackage(bytes);
}

function xlsxWithNumericCell(value: string, header = 'Код'): Uint8Array {
  const parts = fullXlsxParts();
  const sheetBytes = parts['xl/worksheets/sheet1.xml'];
  if (!sheetBytes) throw new Error('Missing fixture sheet');
  let sheet = decodeXml(sheetBytes).text;
  sheet = sheet.replace(
    '<c r="A5" t="n"><v>1234567</v></c>',
    `<c r="A5" t="n"><v>${value}</v></c>`,
  );
  sheet = sheet.replace(
    '<c r="A4" t="inlineStr"><is><t>Код</t></is></c>',
    `<c r="A4" t="inlineStr"><is><t>${header}</t></is></c>`,
  );
  parts['xl/worksheets/sheet1.xml'] = encoder.encode(sheet);
  return buildXlsx(parts);
}

function xmlText(parts: ReadonlyMap<string, Uint8Array>, name: string): string {
  const bytes = parts.get(name);
  if (!bytes) return '';
  return decodeXml(bytes).text;
}

function scanPart(parts: ReadonlyMap<string, Uint8Array>, name: string): XmlScan {
  const bytes = parts.get(name);
  if (!bytes) throw new Error(`Missing fixture part ${name}`);
  const decoded = decodeXml(bytes);
  return scanXml(decoded.text, decoded.encoding, decoded.bom);
}

function attrOf(element: XmlElement, local: string): string | undefined {
  for (const attr of element.attrs) {
    if (attr.ns === '' && attr.local === local) return attr.value;
  }
  return undefined;
}

function elementText(element: XmlElement): string {
  const chunks: string[] = [];
  const visit = (current: XmlElement): void => {
    for (const node of current.textNodes) chunks.push(node.text);
    for (const child of current.children) visit(child);
  };
  visit(element);
  return chunks.join('');
}

function visibleText(element: XmlElement): string {
  const chunks: string[] = [];
  const visit = (current: XmlElement): void => {
    if (current.local === 'rPh') return;
    if (current.local === 't') {
      for (const node of current.textNodes) chunks.push(node.text);
      return;
    }
    for (const child of current.children) visit(child);
  };
  visit(element);
  return chunks.join('');
}

function findCell(scan: XmlScan, ref: string): XmlElement | undefined {
  return scan.elements.find((element) => element.local === 'c' && attrOf(element, 'r') === ref);
}

function cellValue(scan: XmlScan, ref: string): string {
  const cell = findCell(scan, ref);
  if (!cell) return '';
  const value = cell.children.find((child) => child.local === 'v');
  return value ? elementText(value) : '';
}

function cellInline(scan: XmlScan, ref: string): string {
  const cell = findCell(scan, ref);
  if (!cell) return '';
  const inline = cell.children.find((child) => child.local === 'is');
  return inline ? visibleText(inline) : '';
}

/** Concatenated text of all XML text nodes in the `xl/` tree. */
function contentText(parts: ReadonlyMap<string, Uint8Array>): string {
  const chunks: string[] = [];
  for (const name of [...parts.keys()]
    .filter((part) => part.startsWith('xl/') && part.endsWith('.xml'))
    .sort()) {
    for (const node of scanPart(parts, name).textNodes) {
      // Comment authors and pure formatting whitespace are one-way
      // sanitized/irrelevant to the textual round-trip.
      if (node.element.local === 'author') continue;
      if (node.text.trim().length === 0) continue;
      chunks.push(node.text);
    }
  }
  return chunks.join('');
}

function expectNoPii(parts: ReadonlyMap<string, Uint8Array>): void {
  for (const [name, bytes] of parts) {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    for (const value of PII) {
      expect(raw, `${name} raw bytes`).not.toContain(value);
    }

    let scan: XmlScan;
    try {
      const decoded = decodeXml(bytes);
      scan = scanXml(decoded.text, decoded.encoding, decoded.bom);
    } catch {
      continue;
    }
    for (const node of scan.textNodes) {
      for (const value of PII) {
        expect(node.text, `${name} text node`).not.toContain(value);
      }
    }
    for (const element of scan.elements) {
      for (const attr of element.attrs) {
        for (const value of PII) {
          expect(attr.value, `${name} attribute ${attr.qname}`).not.toContain(value);
        }
      }
    }
  }
}

describe('anonymizeXlsx sharedStrings', () => {
  it('masks plain, rich, unused and phonetic strings without changing indices/count', async () => {
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'shared.xlsx'), ctx);
    const parts = unzip(result.maskedBytes);
    assertPackageValid(parts);

    const sst = scanPart(parts, 'xl/sharedStrings.xml');
    expect(attrOf(sst.root, 'count')).toBe('4');
    expect(attrOf(sst.root, 'uniqueCount')).toBe('4');

    const strings = sst.elements.filter((element) => element.local === 'si');
    expect(strings).toHaveLength(4);
    const [plain, rich, unused, phone] = strings;
    expect(plain).toBeDefined();
    expect(rich).toBeDefined();
    expect(unused).toBeDefined();
    expect(phone).toBeDefined();
    if (!plain || !rich || !unused || !phone) return;

    expect(visibleText(plain)).toBe('[[DM7F3_PERSON_1]]');
    expect(visibleText(rich)).toBe('[[DM7F3_PERSON_1]]');
    expect(visibleText(unused)).toBe('[[DM7F3_EMAIL_1]]');
    expect(visibleText(phone)).toBe('[[DM7F3_PHONE_1]]');

    const runs = rich.children.filter((child) => child.local === 'r');
    expect(runs).toHaveLength(3);
    expect(elementText(runs[0] as XmlElement)).toBe('[[DM7F3_PERSON_1]]');
    expect(elementText(runs[1] as XmlElement)).toBe('');
    expect(elementText(runs[2] as XmlElement)).toBe('');
    expect(runs[0]?.children.some((child) => child.local === 'rPr')).toBe(true);

    const phonetic = rich.children.find((child) => child.local === 'rPh');
    expect(phonetic).toBeDefined();
    if (phonetic) expect(elementText(phonetic)).toBe('[[DM7F3_PERSON_1]]');

    const sheet = scanPart(parts, 'xl/worksheets/sheet1.xml');
    expect(cellValue(sheet, 'A1')).toBe('0');
    expect(cellValue(sheet, 'C1')).toBe('0');
    expect(result.entities.map((entity) => entity.key).sort()).toEqual([
      'EMAIL_1',
      'PERSON_1',
      'PHONE_1',
    ]);
    expect(result.format).toBe('xlsx');
    expect(ctx.vault.files[0]).toMatchObject({
      originalName: 'shared.xlsx',
      maskedName: 'shared.xlsx',
      format: 'xlsx',
      size: fullXlsx().length,
    });
    expect(ctx.vault.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe('anonymizeXlsx cells, formulas and dates', () => {
  it('masks inlineStr, cached t="str", formula literals and worksheet metadata', async () => {
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'cells.xlsx'), ctx);
    const parts = unzip(result.maskedBytes);
    assertPackageValid(parts);

    const sheet = xmlText(parts, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t>[[DM7F3_EMAIL_1]]</t></is></c>');
    expect(sheet).toContain(
      '<c r="B2" t="str"><f>"[[DM7F3_PERSON_1]]"&amp;A1</f><v>[[DM7F3_PERSON_1]]</v></c>',
    );
    expect(sheet).toContain('<c r="A4" t="inlineStr"><is><t>Код</t></is></c>');
    expect(sheet).toContain('<c r="B4" t="inlineStr"><is><t>Сумма</t></is></c>');
    expect(sheet).toContain('<oddHeader>&amp;L[[DM7F3_PERSON_1]]</oddHeader>');
    expect(sheet).toContain('<oddFooter>[[DM7F3_PHONE_1]]</oddFooter>');
    expect(sheet).toContain('promptTitle="[[DM7F3_PERSON_1]]"');
    expect(sheet).toContain('prompt="Тел. [[DM7F3_PHONE_1]]"');
    expect(sheet).toContain('errorTitle="[[DM7F3_EMAIL_1]]"');
    expect(sheet).toContain('error="Ошибка: [[DM7F3_PERSON_1]]"');
    expect(sheet).toContain('<formula1>"[[DM7F3_PERSON_1]]"</formula1>');
    expect(sheet).toContain('<formula>"[[DM7F3_PERSON_1]]"=A1</formula>');
    expect(sheet).toContain('tooltip="[[DM7F3_EMAIL_1]]"');
    expect(sheet).toContain('display="[[DM7F3_PERSON_1]]"');
    expect(result.warnings.some((warning) => /formula string literal/u.test(warning))).toBe(true);
  });

  it('leaves date serials and ordinary numbers byte-identical', async () => {
    const original = fullXlsxParts();
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'numbers.xlsx'), ctx);
    const parts = unzip(result.maskedBytes);
    const sheet = xmlText(parts, 'xl/worksheets/sheet1.xml');

    for (const raw of [
      '<c r="C2" s="1"><v>4081781009991001</v></c>',
      '<c r="D2" s="2"><v>44562</v></c>',
      '<c r="E2" s="3"><v>44562.5</v></c>',
      '<c r="F2" s="4"><v>44562</v></c>',
      '<c r="G2" s="5"><v>44562</v></c>',
      '<c r="A3" t="n"><v>4081781009991001</v></c>',
      '<c r="B3" t="b"><v>1</v></c>',
      '<c r="C3" t="e"><v>#N/A</v></c>',
      '<c r="D3" t="d"><v>2024-01-01T00:00:00Z</v></c>',
      '<c r="A5" t="n"><v>1234567</v></c>',
      '<c r="B5" t="n"><v>45292</v></c>',
    ]) {
      expect(sheet).toContain(raw);
    }
    expect(sheet).not.toContain('_CARD_');
    const workbook = xmlText(parts, 'xl/workbook.xml');
    expect(workbook).toContain('date1904="1"');
    expect(workbook).toContain('workbookPassword="ABCD"');
    expect(workbook).toContain('userName=""');
    expect(workbook).toContain('<definedName name="Клиенты">Лист1!$A$1:$A$2</definedName>');

    expect([...(parts.get('xl/styles.xml') ?? [])]).toEqual([...(original['xl/styles.xml'] ?? [])]);
    // Records are now scanned (EMP-M1); this fixture only has ordinary numbers,
    // so the values survive even though the part is no longer "skip".
    const records = scanPart(parts, 'xl/pivotCache/pivotCacheRecords1.xml');
    expect(records.elements.some((element) => element.local === 'n')).toBe(true);
    expect(xmlText(parts, 'xl/pivotCache/pivotCacheRecords1.xml')).toContain('<n v="10"/>');
    expect([...(parts.get('xl/media/image1.png') ?? [])]).toEqual([
      ...(original['xl/media/image1.png'] ?? []),
    ]);
  });

  it('rewrites formula literals through XML entities and doubled quotes without restructuring', async () => {
    const parts = minimalXlsxParts('plain');
    parts['xl/worksheets/sheet1.xml'] = encoder.encode(
      `${xmlDeclaration()}<worksheet xmlns="${S_NS}"><sheetData><row r="1"><c r="A1" t="str"><f>A1&amp;"ivan@example.ru"&amp;"x""y"</f><v>ivan@example.ru</v></c></row></sheetData></worksheet>`,
    );
    const bytes = buildXlsx(parts);
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(bytes, 'formula.xlsx'), ctx);
    const sheet = xmlText(unzip(result.maskedBytes), 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<f>A1&amp;"[[DM7F3_EMAIL_1]]"&amp;"x""y"</f>');
    expect(sheet).toContain('<v>[[DM7F3_EMAIL_1]]</v>');

    const restored = await restoreXlsx(fileOf(result.maskedBytes, 'formula.xlsx'), ctx.vault);
    const restoredSheet = xmlText(unzip(restored.bytes), 'xl/worksheets/sheet1.xml');
    expect(restoredSheet).toContain('<f>A1&amp;"ivan@example.ru"&amp;"x""y"</f>');
  });

  it('processes hidden and veryHidden sheets', async () => {
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'hidden.xlsx'), ctx);
    const parts = unzip(result.maskedBytes);

    const workbook = scanPart(parts, 'xl/workbook.xml');
    const sheets = workbook.elements.filter((element) => element.local === 'sheet');
    expect(sheets.map((sheet) => attrOf(sheet, 'state') ?? 'visible')).toEqual([
      'visible',
      'hidden',
      'veryHidden',
    ]);
    expect(sheets.map((sheet) => attrOf(sheet, 'name'))).toEqual([
      'Лист1',
      'Скрытый',
      'ОченьСкрытый',
    ]);

    expect(cellInline(scanPart(parts, 'xl/worksheets/sheet2.xml'), 'A1')).toBe('[[DM7F3_EMAIL_1]]');
    const sst = scanPart(parts, 'xl/sharedStrings.xml');
    const strings = sst.elements.filter((element) => element.local === 'si');
    expect(visibleText(strings[3] as XmlElement)).toBe('[[DM7F3_PHONE_1]]');
    expect(cellValue(scanPart(parts, 'xl/worksheets/sheet3.xml'), 'A1')).toBe('3');
  });
});

describe('XLSX numeric PII fail-closed', () => {
  it.each([
    ['7707083893', 'INN'],
    ['11223344595', 'SNILS'],
    ['4111111111111111', 'CARD'],
    ['40817810099910004312', 'ACCOUNT'],
    ['79161234567', 'PHONE'],
  ] as const)('rejects numeric %s as %s', async (value, label) => {
    const ctx = contextFor();
    const before = JSON.stringify(ctx.vault);
    await expect(
      anonymizeXlsx(fileOf(xlsxWithNumericCell(value), 'numeric.xlsx'), ctx),
    ).rejects.toThrow(new RegExp(`numeric ${label} in cell A5`, 'u'));
    expect(JSON.stringify(ctx.vault)).toBe(before);
  });

  it('rejects 9+ digit numbers under a PII-like header', async () => {
    await expect(
      anonymizeXlsx(fileOf(xlsxWithNumericCell('770708389', 'ИНН'), 'header.xlsx'), contextFor()),
    ).rejects.toThrow(/PII-like header/u);
  });

  it('still masks card PII stored as inline text', async () => {
    const result = await anonymizeXlsx(
      fileOf(minimalXlsx('4111 1111 1111 1111'), 'text-card.xlsx'),
      contextFor(),
    );
    const sheet = xmlText(unzip(result.maskedBytes), 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('[[DM7F3_CARD_1]]');
  });
});

describe('anonymizeXlsx comments, charts, pivots and metadata', () => {
  it('sanitizes comments, threaded comments, persons and docProps', async () => {
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'comments.xlsx'), ctx);
    const parts = unzip(result.maskedBytes);

    const comments = xmlText(parts, 'xl/comments1.xml');
    expect(comments).toContain('<author></author>');
    expect(comments).toContain('[[DM7F3_PHONE_1]]');
    expect(comments).toContain('[[DM7F3_EMAIL_1]]');
    expect(comments).not.toContain(PERSON);

    const threaded = xmlText(parts, 'xl/threadedComments/threadedComment1.xml');
    expect(threaded).toContain('<text>[[DM7F3_PERSON_1]]: [[DM7F3_EMAIL_1]]</text>');
    expect(threaded).toContain('dT="1970-01-01T00:00:00Z"');
    expect(threaded).toContain('personId="{11111111-1111-1111-1111-111111111111}"');

    const persons = xmlText(parts, 'xl/persons/person.xml');
    expect(persons).toContain('displayName=""');
    expect(persons).toContain('userId=""');
    expect(persons).toContain('providerId=""');
    expect(persons).toContain('id="{11111111-1111-1111-1111-111111111111}"');

    const core = xmlText(parts, 'docProps/core.xml');
    expect(core).toContain('<dc:title></dc:title>');
    expect(core).toContain('<dc:subject></dc:subject>');
    expect(core).toContain('<dc:creator></dc:creator>');
    expect(core).toContain('<cp:keywords></cp:keywords>');
    expect(core).toContain('<cp:lastModifiedBy></cp:lastModifiedBy>');
    expect(core).toContain('1970-01-01T00:00:00Z');

    const app = xmlText(parts, 'docProps/app.xml');
    expect(app).toContain('<Company></Company>');
    expect(app).toContain('<Manager></Manager>');
    expect(app).toContain('<Template></Template>');
    expect(app).toContain('<HyperlinkBase></HyperlinkBase>');

    expect(parts.has('docProps/custom.xml')).toBe(false);
    expect(result.warnings.some((warning) => /Custom document properties/u.test(warning))).toBe(
      true,
    );
  });

  it('masks chart caches, pivot strings, customXml and external-link caches', async () => {
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'caches.xlsx'), ctx);
    const parts = unzip(result.maskedBytes);

    const chart = xmlText(parts, 'xl/charts/chart1.xml');
    expect(chart).toContain('Доход [[DM7F3_PERSON_1]]');
    expect(chart).toContain('<c:v>[[DM7F3_PERSON_1]]</c:v>');
    expect(chart).toContain('<c:v>[[DM7F3_EMAIL_1]]</c:v>');
    expect(chart).toContain('<c:v>123456789</c:v>');
    expect(chart).toContain('<c:formatCode>General</c:formatCode>');
    expect(chart).toContain('Лист1!$C$1');

    const pivot = xmlText(parts, 'xl/pivotCache/pivotCacheDefinition1.xml');
    expect(pivot).toContain('name="[[DM7F3_PERSON_1]]"');
    expect(pivot).toContain('<s v="[[DM7F3_EMAIL_1]]"/>');
    expect(pivot).toContain('<n v="10"/>');
    expect(pivot).toContain('sheet="Лист1"');

    const custom = xmlText(parts, 'customXml/item1.xml');
    expect(custom).toContain('name="[[DM7F3_PERSON_1]]"');
    expect(custom).toContain('email="[[DM7F3_EMAIL_1]]"');
    expect(custom).toContain('></person>');
    expect(custom).not.toContain(PHONE);

    const itemProps = xmlText(parts, 'customXml/itemProps1.xml');
    expect(itemProps).toContain('ds:itemName=""');

    const external = xmlText(parts, 'xl/externalLinks/externalLink1.xml');
    expect(external).toContain('<sheetName val="[[DM7F3_PERSON_1]]"/>');
    expect(external).toContain('<v>[[DM7F3_EMAIL_1]]</v>');
    expect(external).toContain('<v>123456789</v>');

    const externalRels = xmlText(parts, 'xl/externalLinks/_rels/externalLink1.xml.rels');
    expect(externalRels).toContain('https://example.invalid/redacted');
    expect(externalRels).not.toContain('file:///');
    expect(result.warnings.some((warning) => /external relationship/u.test(warning))).toBe(true);
  });

  it('masks direct pivot record strings and clears refresh metadata', async () => {
    const parts = fullXlsxParts();
    const definition = xmlText(
      new Map(Object.entries(parts)),
      'xl/pivotCache/pivotCacheDefinition1.xml',
    ).replace(
      '<pivotCacheDefinition ',
      `<pivotCacheDefinition refreshedBy="${PERSON}" refreshedDate="2026-11-22T10:00:00Z" `,
    );
    parts['xl/pivotCache/pivotCacheDefinition1.xml'] = encoder.encode(definition);
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><s v="${PERSON}"/><s v="${EMAIL}"/><n v="10"/></r></pivotCacheRecords>`,
    );

    const result = await anonymizeXlsx(fileOf(buildXlsx(parts), 'records.xlsx'), contextFor());
    const out = unzip(result.maskedBytes);
    const records = xmlText(out, 'xl/pivotCache/pivotCacheRecords1.xml');
    expect(records).not.toContain(PERSON);
    expect(records).not.toContain(EMAIL);
    expect(records).toContain('<s v="[[DM7F3_PERSON_1]]"/>');
    expect(records).toContain('<s v="[[DM7F3_EMAIL_1]]"/>');
    expect(records).toContain('<n v="10"/>');

    const refreshed = xmlText(out, 'xl/pivotCache/pivotCacheDefinition1.xml');
    expect(refreshed).toContain('refreshedBy=""');
    expect(refreshed).toContain('refreshedDate=""');
    expect(result.warnings.some((warning) => /record values masked/u.test(warning))).toBe(true);
  });

  it.each([
    ['CARD', '4111111111111111.0'],
    ['CARD', '4.111111111111111E+15'],
    ['PHONE', '7.9161234567E+10'],
  ])('rejects numeric %s in pivot records written as xsd:double (%s)', async (label, value) => {
    const parts = fullXlsxParts();
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><n v="${value}"/></r></pivotCacheRecords>`,
    );
    await expect(
      anonymizeXlsx(fileOf(buildXlsx(parts), 'records-double.xlsx'), contextFor()),
    ).rejects.toThrow(new RegExp(`numeric ${label} in pivot cache record #1`, 'u'));
  });

  it('rejects numeric PII in pivot records (fail-closed)', async () => {
    const parts = fullXlsxParts();
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><n v="4111111111111111"/></r></pivotCacheRecords>`,
    );
    await expect(
      anonymizeXlsx(fileOf(buildXlsx(parts), 'records-numeric.xlsx'), contextFor()),
    ).rejects.toThrow(/numeric CARD in pivot cache record #1/u);
  });

  it.each([
    ['INN', '7707083893'],
    ['SNILS', '11223344595'],
    ['OGRN', '1027700132195'],
    ['CARD', '4111111111111111'],
    ['ACCOUNT', '40817810099910004312'],
    ['PHONE', '79161234567'],
  ])('rejects numeric %s in pivot shared items referenced by <x>', async (label, value) => {
    const parts = fullXlsxParts();
    const definition = xmlText(
      new Map(Object.entries(parts)),
      'xl/pivotCache/pivotCacheDefinition1.xml',
    ).replace(
      '<sharedItems count="1"><s v="ivan@example.ru"/></sharedItems>',
      `<sharedItems count="1"><n v="${value}"/></sharedItems>`,
    );
    parts['xl/pivotCache/pivotCacheDefinition1.xml'] = encoder.encode(definition);
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><x v="0"/><x v="1"/></r></pivotCacheRecords>`,
    );

    await expect(
      anonymizeXlsx(fileOf(buildXlsx(parts), 'shared-numeric.xlsx'), contextFor()),
    ).rejects.toThrow(new RegExp(`numeric ${label} in pivot cache shared items`, 'u'));
  });

  it.each([
    ['CARD', '4111111111111111'],
    ['PHONE', '79161234567'],
    ['ACCOUNT', '40817810099910004312'],
    ['CARD', '4.111111111111111E+15'],
    ['PHONE', '7.9161234567E+10'],
    ['CARD', '4111111111111111.0'],
  ])('rejects numeric %s in sharedItems minValue (%s)', async (label, value) => {
    const parts = fullXlsxParts();
    const definition = xmlText(
      new Map(Object.entries(parts)),
      'xl/pivotCache/pivotCacheDefinition1.xml',
    ).replace(
      '<sharedItems count="1"><s v="ivan@example.ru"/></sharedItems>',
      `<sharedItems count="2" minValue="${value}" maxValue="${value}"/>`,
    );
    parts['xl/pivotCache/pivotCacheDefinition1.xml'] = encoder.encode(definition);
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><x v="0"/><x v="1"/></r></pivotCacheRecords>`,
    );

    await expect(
      anonymizeXlsx(fileOf(buildXlsx(parts), 'shared-minmax.xlsx'), contextFor()),
    ).rejects.toThrow(new RegExp(`numeric ${label} in pivot cache shared items`, 'u'));
  });

  it.each([
    ['CARD', '4111111111111111.0'],
    ['CARD', '4.111111111111111E+15'],
    ['PHONE', '7.9161234567E+10'],
  ])('rejects numeric %s in sharedItems <n> written as xsd:double (%s)', async (label, value) => {
    const parts = fullXlsxParts();
    const definition = xmlText(
      new Map(Object.entries(parts)),
      'xl/pivotCache/pivotCacheDefinition1.xml',
    ).replace(
      '<sharedItems count="1"><s v="ivan@example.ru"/></sharedItems>',
      `<sharedItems count="1"><n v="${value}"/></sharedItems>`,
    );
    parts['xl/pivotCache/pivotCacheDefinition1.xml'] = encoder.encode(definition);
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><x v="0"/></r></pivotCacheRecords>`,
    );

    await expect(
      anonymizeXlsx(fileOf(buildXlsx(parts), 'shared-double.xlsx'), contextFor()),
    ).rejects.toThrow(new RegExp(`numeric ${label} in pivot cache shared items`, 'u'));
  });

  it('keeps <s>/<d> controls and plain <n> while rejecting double-form <n>', async () => {
    const parts = fullXlsxParts();
    const definition = xmlText(
      new Map(Object.entries(parts)),
      'xl/pivotCache/pivotCacheDefinition1.xml',
    ).replace(
      '<sharedItems count="1"><s v="ivan@example.ru"/></sharedItems>',
      `<sharedItems count="3"><s v="${EMAIL}"/><n v="10.5"/><n v="42"/></sharedItems>`,
    );
    parts['xl/pivotCache/pivotCacheDefinition1.xml'] = encoder.encode(definition);
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><d v="2024-01-02T00:00:00"/><s v="${EMAIL}"/><n v="42"/></r></pivotCacheRecords>`,
    );

    const result = await anonymizeXlsx(
      fileOf(buildXlsx(parts), 'shared-controls.xlsx'),
      contextFor(),
    );
    const out = unzip(result.maskedBytes);
    const shared = xmlText(out, 'xl/pivotCache/pivotCacheDefinition1.xml');
    expect(shared).toContain('<s v="[[DM7F3_EMAIL_1]]"/>');
    expect(shared).toContain('<n v="10.5"/>');
    expect(shared).toContain('<n v="42"/>');
    const records = xmlText(out, 'xl/pivotCache/pivotCacheRecords1.xml');
    expect(records).toContain('<d v="2024-01-02T00:00:00"/>');
    expect(records).toContain('<s v="[[DM7F3_EMAIL_1]]"/>');
    expect(records).toContain('<n v="42"/>');
  });

  it('keeps ordinary minValue/maxValue and <n>/<s> shared items working', async () => {
    const parts = fullXlsxParts();
    const definition = xmlText(
      new Map(Object.entries(parts)),
      'xl/pivotCache/pivotCacheDefinition1.xml',
    ).replace(
      '<sharedItems count="1"><s v="ivan@example.ru"/></sharedItems>',
      '<sharedItems count="2" minValue="10.5" maxValue="2.0E+3"><n v="10.5"/><s v="ivan@example.ru"/></sharedItems>',
    );
    parts['xl/pivotCache/pivotCacheDefinition1.xml'] = encoder.encode(definition);
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><x v="0"/><x v="1"/></r></pivotCacheRecords>`,
    );

    const result = await anonymizeXlsx(
      fileOf(buildXlsx(parts), 'shared-control.xlsx'),
      contextFor(),
    );
    const out = xmlText(unzip(result.maskedBytes), 'xl/pivotCache/pivotCacheDefinition1.xml');
    expect(out).toContain('<n v="10.5"/>');
    expect(out).toContain('<s v="[[DM7F3_EMAIL_1]]"/>');
  });

  it('keeps <d> date values intact in pivot records (R2-M4)', async () => {
    const parts = fullXlsxParts();
    parts['xl/pivotCache/pivotCacheRecords1.xml'] = encoder.encode(
      `${xmlDeclaration()}<pivotCacheRecords xmlns="${S_NS}" count="1"><r><d v="2024-01-02T00:00:00"/><s v="${PERSON}"/></r></pivotCacheRecords>`,
    );

    const result = await anonymizeXlsx(fileOf(buildXlsx(parts), 'records-date.xlsx'), {
      ...contextFor(),
      config: { enableDate: true, aggressive: true },
    });
    const records = xmlText(unzip(result.maskedBytes), 'xl/pivotCache/pivotCacheRecords1.xml');
    expect(records).toContain('<d v="2024-01-02T00:00:00"/>');
    expect(records).toContain('<s v="[[DM7F3_PERSON_1]]"/>');
  });

  it('clears TitlesOfParts/HeadingPairs text in docProps/app.xml', async () => {
    const parts = fullXlsxParts();
    parts['docProps/app.xml'] = encoder.encode(
      `${xmlDeclaration()}<Properties xmlns="${EP_NS}" xmlns:vt="${VT_NS}"><Application>DocsMasked Test</Application><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${PERSON}</vt:lpstr></vt:vector></TitlesOfParts><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs></Properties>`,
    );

    const result = await anonymizeXlsx(fileOf(buildXlsx(parts), 'app.xlsx'), contextFor());
    const app = xmlText(unzip(result.maskedBytes), 'docProps/app.xml');
    expect(app).not.toContain(PERSON);
    expect(app).not.toContain('Worksheets');
    expect(app).toContain('<vt:i4>1</vt:i4>');
    expect(app).toContain('<Application>DocsMasked Test</Application>');
  });

  it('removes calcChain, signatures, revision logs, users and thumbnails', async () => {
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'removed.xlsx'), ctx);
    const parts = unzip(result.maskedBytes);
    assertPackageValid(parts);

    expect(parts.has('xl/calcChain.xml')).toBe(false);
    expect(parts.has('_xmlsignatures/origin.xml')).toBe(false);
    expect(parts.has('_xmlsignatures/sig1.xml')).toBe(false);
    expect(parts.has('xl/revisions/revisionHeaders.xml')).toBe(false);
    expect(parts.has('xl/users.xml')).toBe(false);
    expect(parts.has('docProps/thumbnail.jpeg')).toBe(false);

    const rootRels = xmlText(parts, '_rels/.rels');
    expect(rootRels).not.toContain('custom-properties');
    expect(rootRels).not.toContain('thumbnail');
    expect(rootRels).not.toContain('digital-signature');

    const workbookRels = xmlText(parts, 'xl/_rels/workbook.xml.rels');
    expect(workbookRels).not.toContain('calcChain');
    expect(workbookRels).not.toContain('revisions');
    expect(workbookRels).not.toContain('usernames');

    expect(result.warnings.some((warning) => /signatures/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /revision logs/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /user list/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /thumbnail/u.test(warning))).toBe(true);
  });

  it('contains no PII in raw or decoded package parts', async () => {
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'grep.xlsx'), ctx);
    const parts = unzip(result.maskedBytes);
    expectNoPii(parts);
    expect(result.warnings.some((warning) => /image\/media/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /drawing alt-text/u.test(warning))).toBe(true);
  });
});

describe('restoreXlsx', () => {
  it('restores text and attribute tags while metadata stays sanitized', async () => {
    const originalParts = new Map(Object.entries(fullXlsxParts()));
    const originalText = contentText(originalParts);
    const ctx = contextFor();
    const result = await anonymizeXlsx(fileOf(fullXlsx(), 'roundtrip.xlsx'), ctx);
    const restored = await restoreXlsx(fileOf(result.maskedBytes, 'roundtrip.xlsx'), ctx.vault);
    const restoredParts = unzip(restored.bytes);
    assertPackageValid(restoredParts);

    expect(restored.unknownTags).toEqual([]);
    expect(restored.replacements).toBeGreaterThan(0);
    expect(restored.fileName).toBe('roundtrip.xlsx');
    expect(contentText(restoredParts)).toBe(originalText);
    expect(contentText(restoredParts)).toContain(PERSON);
    expect(contentText(restoredParts)).toContain(EMAIL);
    expect(contentText(restoredParts)).toContain(PHONE);

    const pivot = scanPart(restoredParts, 'xl/pivotCache/pivotCacheDefinition1.xml');
    const cacheField = pivot.elements.find((element) => element.local === 'cacheField');
    expect(cacheField).toBeDefined();
    if (cacheField) expect(attrOf(cacheField, 'name')).toBe(PERSON);
    const sharedString = pivot.elements.find((element) => element.local === 's');
    expect(sharedString).toBeDefined();
    if (sharedString) expect(attrOf(sharedString, 'v')).toBe(EMAIL);

    const external = scanPart(restoredParts, 'xl/externalLinks/externalLink1.xml');
    const sheetName = external.elements.find((element) => element.local === 'sheetName');
    expect(sheetName).toBeDefined();
    if (sheetName) expect(attrOf(sheetName, 'val')).toBe(PERSON);

    const restoredSheet = xmlText(restoredParts, 'xl/worksheets/sheet1.xml');
    expect(restoredSheet).toContain('promptTitle="Иванов Иван Иванович"');
    expect(restoredSheet).toContain('tooltip="ivan@example.ru"');
    expect(restoredSheet).toContain('display="Иванов Иван Иванович"');

    const custom = scanPart(restoredParts, 'customXml/item1.xml');
    expect(attrOf(custom.root, 'name')).toBe(PERSON);
    const person = custom.elements.find((element) => element.local === 'person');
    expect(person).toBeDefined();
    if (person) expect(attrOf(person, 'email')).toBe(EMAIL);

    expect(xmlText(restoredParts, 'docProps/core.xml')).toContain('<dc:creator></dc:creator>');
    expect(xmlText(restoredParts, 'docProps/app.xml')).toContain('<Company></Company>');
    expect(restoredParts.has('docProps/custom.xml')).toBe(false);
    expect(xmlText(restoredParts, 'xl/persons/person.xml')).toContain('displayName=""');
  });

  it('leaves unknown tags untouched and reports them', async () => {
    const bytes = minimalXlsx('[[ZZZZZ_PERSON_1]]');
    const vault = createVault('', { prefix: 'DM7F3' });
    const restored = await restoreXlsx(fileOf(bytes, 'unknown.xlsx'), vault);
    const parts = unzip(restored.bytes);

    expect(restored.unknownTags).toEqual(['[[ZZZZZ_PERSON_1]]']);
    expect(restored.warnings.some((warning) => /unknown tag/u.test(warning))).toBe(true);
    expect(xmlText(parts, 'xl/worksheets/sheet1.xml')).toContain('[[ZZZZZ_PERSON_1]]');
  });
});

describe('XLSX rejections and fail-closed structural identifiers', () => {
  it('rejects .xlsm, VBA parts, macro content types, legacy files and corrupt bytes', async () => {
    const ctx = contextFor();
    await expect(anonymizeXlsx(fileOf(fullXlsx(), 'macros.xlsm'), ctx)).rejects.toThrow(
      /macro-enabled/u,
    );
    await expect(anonymizeXlsx(fileOf(fullXlsx(), 'macros.xltm'), ctx)).rejects.toThrow(
      /macro-enabled/u,
    );
    await expect(anonymizeXlsx(fileOf(fullXlsx(), 'old.xls'), ctx)).rejects.toThrow(/only \.xlsx/u);

    const withVba = fullXlsxParts();
    withVba['xl/vbaProject.bin'] = Uint8Array.from([0x01, 0x02, 0x03]);
    await expect(anonymizeXlsx(fileOf(buildXlsx(withVba), 'vba.xlsx'), ctx)).rejects.toThrow(
      /VBA/u,
    );

    const macroType = fullXlsxParts();
    macroType['[Content_Types].xml'] = encoder.encode(
      decodeXml(macroType['[Content_Types].xml'] as Uint8Array).text.replace(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
        'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
      ),
    );
    await expect(anonymizeXlsx(fileOf(buildXlsx(macroType), 'macro.xlsx'), ctx)).rejects.toThrow(
      /macro content/u,
    );

    await expect(
      anonymizeXlsx(fileOf(encoder.encode('not a zip'), 'bad.xlsx'), ctx),
    ).rejects.toThrow(/ZIP/u);

    const broken = fullXlsxParts();
    broken['xl/worksheets/sheet1.xml'] = encoder.encode(
      `${xmlDeclaration()}<worksheet xmlns="${S_NS}"><sheetData></worksheet>`,
    );
    await expect(anonymizeXlsx(fileOf(buildXlsx(broken), 'broken.xlsx'), ctx)).rejects.toThrow();
  });

  it('fails closed on PII in sheet names, defined names and custom number formats', async () => {
    const ctx = contextFor();

    const sheetName = fullXlsxParts();
    sheetName['xl/workbook.xml'] = encoder.encode(
      decodeXml(sheetName['xl/workbook.xml'] as Uint8Array).text.replace(
        'name="Скрытый"',
        'name="ivan@example.ru"',
      ),
    );
    const beforeSheet = JSON.stringify(ctx.vault);
    await expect(
      anonymizeXlsx(fileOf(buildXlsx(sheetName), 'sheet-name.xlsx'), ctx),
    ).rejects.toThrow(/worksheet name contains PII/u);
    expect(JSON.stringify(ctx.vault)).toBe(beforeSheet);

    const definedName = fullXlsxParts();
    definedName['xl/workbook.xml'] = encoder.encode(
      decodeXml(definedName['xl/workbook.xml'] as Uint8Array).text.replace(
        '<definedName name="Клиенты">Лист1!$A$1:$A$2</definedName>',
        '<definedName name="Клиенты">"ivan@example.ru"</definedName>',
      ),
    );
    await expect(
      anonymizeXlsx(fileOf(buildXlsx(definedName), 'defined-name.xlsx'), ctx),
    ).rejects.toThrow(/defined name/u);

    const formatCode = fullXlsxParts();
    formatCode['xl/styles.xml'] = encoder.encode(
      decodeXml(formatCode['xl/styles.xml'] as Uint8Array).text.replace(
        'formatCode="dd.mm.yyyy"',
        'formatCode="dd.mm.yyyy &quot;ivan@example.ru&quot;"',
      ),
    );
    await expect(
      anonymizeXlsx(fileOf(buildXlsx(formatCode), 'format-code.xlsx'), ctx),
    ).rejects.toThrow(/custom number format/u);
  });
});

describe('XLSX package linter', () => {
  it('accepts the fixture and rejects missing content types, dangling rels and bad XML', () => {
    assertPackageValid(new Map(Object.entries(fullXlsxParts())));

    const missingTypes = new Map(Object.entries(fullXlsxParts()));
    missingTypes.delete('[Content_Types].xml');
    expect(() => assertPackageValid(missingTypes)).toThrow(/Content_Types/u);

    const danglingTarget = new Map(Object.entries(fullXlsxParts()));
    danglingTarget.set(
      'xl/_rels/workbook.xml.rels',
      encoder.encode(
        xmlText(danglingTarget, 'xl/_rels/workbook.xml.rels').replace(
          'Target="worksheets/sheet1.xml"',
          'Target="worksheets/missing.xml"',
        ),
      ),
    );
    expect(() => assertPackageValid(danglingTarget)).toThrow(/does not exist/u);

    const badXml = new Map(Object.entries(fullXlsxParts()));
    badXml.set(
      'xl/worksheets/sheet1.xml',
      encoder.encode(`${xmlDeclaration()}<worksheet xmlns="${S_NS}"><sheetData></worksheet>`),
    );
    expect(() => assertPackageValid(badXml)).toThrow(/not well-formed|Mismatched/u);
  });

  it('detects structural rewrites against a baseline', () => {
    const parts = new Map(Object.entries(fullXlsxParts()));
    assertPackageValid(parts);
    const baseline = snapshotPackage(parts);

    const sheet = xmlText(parts, 'xl/worksheets/sheet1.xml');
    parts.set(
      'xl/worksheets/sheet1.xml',
      encoder.encode(sheet.replace('<sheetData>', '<sheetData><row r="99"/>')),
    );
    expect(() => assertPackageValid(parts, { baseline })).toThrow(/structure changed/u);
  });
});

describe('xlsxFormatAdapter', () => {
  it('recognizes .xlsx and the XLSX MIME type, but not macro/legacy formats', () => {
    expect(xlsxFormatAdapter.format).toBe('xlsx');
    expect(
      xlsxFormatAdapter.canHandle({ name: 'A.XLSX', mimeType: 'application/octet-stream' }),
    ).toBe(true);
    expect(xlsxFormatAdapter.canHandle({ name: 'file', mimeType: XLSX_MIME })).toBe(true);
    expect(
      xlsxFormatAdapter.canHandle({ name: 'file', mimeType: `${XLSX_MIME}; charset=binary` }),
    ).toBe(true);
    expect(
      xlsxFormatAdapter.canHandle({ name: 'file.xlsm', mimeType: 'application/octet-stream' }),
    ).toBe(false);
    expect(xlsxFormatAdapter.canHandle({ name: 'file.xls', mimeType: XLSX_MIME })).toBe(false);
    expect(
      xlsxFormatAdapter.canHandle({
        name: 'file.xlsx',
        mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
      }),
    ).toBe(false);
  });
});
