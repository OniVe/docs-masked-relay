import { describe, expect, it } from 'vitest';
import {
  anonymizeDocx,
  assertPackageValid,
  createVault,
  decodeXml,
  docxFormatAdapter,
  type FileInput,
  parseContentTypes,
  restoreDocx,
  scanXml,
  snapshotPackage,
  unzipPackage,
  type XmlScan,
  zipPackage,
} from '../../src/core';
import {
  A_NS,
  buildDocx,
  C_NS,
  EP_NS,
  fullDocx,
  fullDocxParts,
  fullImage,
  minimalDocx,
  minimalDocxParts,
  VT_NS,
  W_NS,
  xmlDeclaration,
} from '../fixtures/docx';

const encoder = new TextEncoder();
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PERSON = 'Иванов Иван Иванович';
const EMAIL = 'ivan@example.ru';
const PHONE = '+7 916 123-45-67';
const PII = [PERSON, EMAIL, PHONE];
const W_TEXT_LOCALS = new Set(['t', 'delText']);

function fileOf(bytes: Uint8Array, name = 'test.docx'): FileInput {
  return { name, mimeType: DOCX_MIME, bytes };
}

function contextFor(text = PERSON) {
  return { vault: createVault(text, { prefix: 'DM7F3' }), maxBytes: 64 * 1024 * 1024 };
}

function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  return unzipPackage(bytes);
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

function hasAncestor(scan: XmlScan, nodeIndex: number, local: string): boolean {
  let element = scan.textNodes[nodeIndex]?.element ?? null;
  while (element) {
    if (element.local === local) return true;
    element = element.parent;
  }
  return false;
}

/** Concatenated text of text-bearing Word/DrawingML/Chart elements. */
function contentText(parts: ReadonlyMap<string, Uint8Array>): string {
  // Field instructions are deliberately one-way sanitized, so they are not
  // part of the restore round-trip.
  const chunks: string[] = [];
  for (const name of [...parts.keys()]
    .filter((part) => part.startsWith('word/') && part.endsWith('.xml'))
    .sort()) {
    const scan = scanPart(parts, name);
    for (const node of scan.textNodes) {
      if (node.ns === W_NS && W_TEXT_LOCALS.has(node.local)) chunks.push(node.text);
      else if (node.ns === A_NS && node.local === 't') chunks.push(node.text);
      else if (node.ns === C_NS && node.local === 'v') chunks.push(node.text);
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

describe('anonymizeDocx', () => {
  it('stitches split runs, puts the tag in the first run, keeps bold/xml:space and escapes &', async () => {
    const body =
      '<w:p><w:r><w:t>Ива</w:t></w:r>' +
      '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">нов Иван Иванович</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve"> &amp; тел. +7 916 123-45-67</w:t></w:r></w:p>';
    const ctx = contextFor();
    const result = await anonymizeDocx(fileOf(minimalDocx(body), 'split.docx'), ctx);
    const parts = unzip(result.maskedBytes);
    assertPackageValid(parts);

    const scan = scanPart(parts, 'word/document.xml');
    const textElements = scan.elements.filter(
      (element) => element.ns === W_NS && element.local === 't',
    );
    expect(textElements).toHaveLength(3);
    const [first, second, third] = textElements;
    expect(first).toBeDefined();
    if (!first || !second || !third) return;

    const textOf = (element: typeof first): string =>
      element.textNodes.map((node) => node.text).join('');

    expect(textOf(first)).toBe('[[DM7F3_PERSON_1]]');
    expect(textOf(second)).toBe('');
    expect(textOf(third)).toContain('&');
    expect(textOf(third)).toContain('[[DM7F3_PHONE_1]]');

    const secondRun = second.parent;
    const rPr = secondRun?.children.find((child) => child.local === 'rPr');
    expect(rPr?.children.some((child) => child.local === 'b')).toBe(true);
    expect(second.attrMap.get('xml:space')?.value).toBe('preserve');
    expect(third.attrMap.get('xml:space')?.value).toBe('preserve');

    const joined = textElements.map(textOf).join('');
    expect(joined).not.toContain('Ива');
    expect(joined).not.toContain('нов');
    expect(xmlText(parts, 'word/document.xml')).toContain('&amp;');

    expect(result.format).toBe('docx');
    expect(result.maskedName).toBe('split.docx');
    expect(result.entities.map((entity) => entity.key)).toEqual(['PERSON_1', 'PHONE_1']);
    expect(ctx.vault.files).toHaveLength(1);
    expect(ctx.vault.files[0]).toMatchObject({
      originalName: 'split.docx',
      maskedName: 'split.docx',
      format: 'docx',
      size: minimalDocx(body).length,
    });
    expect(ctx.vault.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('does not stitch across w:tab/w:br boundaries', async () => {
    const body =
      '<w:p><w:r><w:t>Ива</w:t><w:tab/><w:t>нов</w:t><w:br/><w:t> конец</w:t></w:r></w:p>';
    const ctx = contextFor();
    const result = await anonymizeDocx(fileOf(minimalDocx(body), 'tab.docx'), ctx);
    const parts = unzip(result.maskedBytes);
    assertPackageValid(parts);

    const scan = scanPart(parts, 'word/document.xml');
    const texts = scan.elements
      .filter((element) => element.ns === W_NS && element.local === 't')
      .map((element) => element.textNodes.map((node) => node.text).join(''));
    expect(texts).toEqual(['Ива', 'нов', ' конец']);
    expect(texts.join('')).not.toContain('_PERSON_');
    expect(xmlText(parts, 'word/document.xml')).toContain('<w:tab/>');
    expect(xmlText(parts, 'word/document.xml')).toContain('<w:br/>');
  });

  it('fails closed when PII spans a hard revision boundary', async () => {
    const body =
      '<w:p><w:r><w:t>ivan@</w:t></w:r>' +
      '<w:ins w:id="9" w:author="Иванов Иван Иванович" w:date="2024-01-01T00:00:00Z">' +
      '<w:r><w:t>example.ru</w:t></w:r></w:ins></w:p>';
    const ctx = contextFor();
    const before = JSON.stringify(ctx.vault);
    await expect(
      anonymizeDocx(fileOf(minimalDocx(body), 'split-boundary.docx'), ctx),
    ).rejects.toThrow(/LeakGuard/u);
    expect(JSON.stringify(ctx.vault)).toBe(before);
  });

  it('masks every story and sanitizes comments, revisions, metadata and rels', async () => {
    const ctx = contextFor();
    const result = await anonymizeDocx(fileOf(fullDocx(), 'full.docx'), ctx);
    const parts = unzip(result.maskedBytes);
    assertPackageValid(parts);
    expectNoPii(parts);

    expect(result.entities.map((entity) => entity.key).sort()).toEqual([
      'EMAIL_1',
      'PERSON_1',
      'PHONE_1',
    ]);
    expect(result.warnings.some((warning) => /field instruction/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /thumbnail/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /signatures/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /external relationship/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /customXml/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /Tracked changes/u.test(warning))).toBe(true);

    const document = xmlText(parts, 'word/document.xml');
    const header = xmlText(parts, 'word/header1.xml');
    const footer = xmlText(parts, 'word/footer1.xml');
    const footnotes = xmlText(parts, 'word/footnotes.xml');
    const endnotes = xmlText(parts, 'word/endnotes.xml');
    const comments = xmlText(parts, 'word/comments.xml');
    const commentsExtended = xmlText(parts, 'word/commentsExtended.xml');
    const commentsIds = xmlText(parts, 'word/commentsIds.xml');
    const commentsExtensible = xmlText(parts, 'word/commentsExtensible.xml');
    const people = xmlText(parts, 'word/people.xml');
    const settings = xmlText(parts, 'word/settings.xml');
    const core = xmlText(parts, 'docProps/core.xml');
    const app = xmlText(parts, 'docProps/app.xml');
    const customXml = xmlText(parts, 'customXml/item1.xml');
    const chart = xmlText(parts, 'word/charts/chart1.xml');
    const diagram = xmlText(parts, 'word/diagrams/data1.xml');
    const documentRels = xmlText(parts, 'word/_rels/document.xml.rels');
    const settingsRels = xmlText(parts, 'word/_rels/settings.xml.rels');
    const rootRels = xmlText(parts, '_rels/.rels');

    expect(header).toContain('[[DM7F3_PERSON_1]]');
    expect(footer).toContain('[[DM7F3_PHONE_1]]');
    expect(footnotes).toContain('[[DM7F3_EMAIL_1]]');
    expect(endnotes).toContain('[[DM7F3_PHONE_1]]');
    expect(chart).toContain('[[DM7F3_EMAIL_1]]');
    expect(chart).toContain('[[DM7F3_PERSON_1]]');
    expect(chart).toContain('123456789');
    expect(chart).toContain('Sheet1!$C$1');
    expect(chart).toContain('General');
    expect(diagram).toContain('[[DM7F3_PHONE_1]]');

    const documentScan = scanPart(parts, 'word/document.xml');
    const textBoxIndex = documentScan.textNodes.findIndex((_node, index) =>
      hasAncestor(documentScan, index, 'txbxContent'),
    );
    expect(textBoxIndex).toBeGreaterThanOrEqual(0);
    expect(documentScan.textNodes[textBoxIndex]?.text).toContain('[[DM7F3_EMAIL_1]]');

    expect(comments).toContain('w:author=""');
    expect(comments).toContain('w:initials=""');
    expect(comments).toContain('w:date="1970-01-01T00:00:00Z"');
    expect(comments).toContain('[[DM7F3_PHONE_1]]');
    expect(comments).toContain('[[DM7F3_EMAIL_1]]');
    expect(commentsExtended).toContain('w15:paraId="1A2B3C4D"');
    expect(commentsIds).toContain('w16cid:durableId="12345678"');
    expect(commentsExtensible).toContain('w16cex:dateUtc="1970-01-01T00:00:00Z"');
    expect(people).toContain('w15:author=""');
    expect(people).toContain('w15:userId=""');
    expect(people).toContain('w15:providerId=""');

    expect(document).toContain('w:commentRangeStart w:id="0"');
    expect(document).toContain('w:commentRangeEnd w:id="0"');
    expect(document).toContain('w:commentReference w:id="0"');
    expect(document).toContain('w:ins w:id="1"');
    expect(document).toContain('w:del w:id="2"');
    expect(document).toContain('w:delText');
    expect(document).toContain('w:author=""');
    expect(document).toContain('w:date="1970-01-01T00:00:00Z"');
    expect(document).toContain('w:instr=""');
    // Field instructions are cleared one-way (paths/includes cannot be tagged).
    expect(document).toContain('<w:instrText xml:space="preserve"></w:instrText>');
    expect(document).not.toContain('HYPERLINK');
    expect(document).not.toContain('mailto:ivan');

    expect(core).toContain('<dc:creator></dc:creator>');
    expect(core).toContain('<dc:title></dc:title>');
    expect(core).toContain('<dc:description></dc:description>');
    expect(core).toContain('<cp:keywords></cp:keywords>');
    expect(core).toContain('<cp:lastModifiedBy></cp:lastModifiedBy>');
    expect(core).toContain('1970-01-01T00:00:00Z');
    expect(app).toContain('<Company></Company>');
    expect(app).toContain('<Manager></Manager>');
    expect(app).toContain('<Template></Template>');
    expect(app).toContain('<HyperlinkBase></HyperlinkBase>');
    expect(parts.has('docProps/custom.xml')).toBe(false);
    expect(customXml).toContain('<name></name>');
    expect(customXml).toContain('<email></email>');
    expect(customXml).toContain('<phone></phone>');

    expect(settings).toContain('w:docVar w:name="" w:val=""');
    expect(settings).toContain('w:rsid w:val="00000000"');
    expect(document).toContain('descr=""');
    expect(document).toContain('w:tooltip=""');
    expect(document).toContain('alt=""');
    expect(document).toContain('name=""');

    expect(documentRels).toContain('https://example.invalid/redacted');
    expect(documentRels).not.toContain('mailto:');
    expect(settingsRels).toContain('https://example.invalid/redacted');
    expect(settingsRels).not.toContain('file:///');
    expect(rootRels).not.toContain('thumbnail');
    expect(rootRels).not.toContain('custom-properties');
    expect(parts.has('docProps/thumbnail.jpeg')).toBe(false);
    expect(parts.has('_xmlsignatures/sig1.xml')).toBe(false);
    expect([...(parts.get('word/media/image1.png') ?? [])]).toEqual([...fullImage()]);
    expect(parts.get('word/embeddings/oleObject1.bin')?.length).toBeGreaterThan(0);
  });

  it('clears instrText including file paths one-way (EMP-M6)', async () => {
    const path = 'C:/Users/ivan/secret-plan.docx';
    const body = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> INCLUDETEXT "${path}" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>поле</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;

    const result = await anonymizeDocx(fileOf(minimalDocx(body), 'instr.docx'), contextFor());
    const document = xmlText(unzip(result.maskedBytes), 'word/document.xml');
    expect(document).not.toContain(path);
    expect(document).not.toContain('INCLUDETEXT');
    expect(document).toContain('поле');
    expect(result.warnings.some((warning) => /field instruction\(s\) cleared/u.test(warning))).toBe(
      true,
    );
  });

  it('clears TitlesOfParts/HeadingPairs in docProps/app.xml (EMP-M3)', async () => {
    const parts = minimalDocxParts();
    parts['docProps/app.xml'] = encoder.encode(
      `${xmlDeclaration()}<Properties xmlns="${EP_NS}" xmlns:vt="${VT_NS}"><Application>DocsMasked Test</Application><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${PERSON}</vt:lpstr></vt:vector></TitlesOfParts><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs></Properties>`,
    );

    const result = await anonymizeDocx(fileOf(buildDocx(parts), 'app.docx'), contextFor());
    const app = xmlText(unzip(result.maskedBytes), 'docProps/app.xml');
    expect(app).not.toContain(PERSON);
    expect(app).not.toContain('Worksheets');
    expect(app).toContain('<vt:i4>1</vt:i4>');
    expect(app).toContain('<Application>DocsMasked Test</Application>');
  });

  it('restores tags in all stories while leaving metadata sanitized', async () => {
    const originalParts = new Map(Object.entries(fullDocxParts()));
    const originalText = contentText(originalParts);

    const ctx = contextFor();
    const result = await anonymizeDocx(fileOf(fullDocx(), 'restore.docx'), ctx);
    const restored = await restoreDocx(fileOf(result.maskedBytes, 'restore.docx'), ctx.vault);
    const restoredParts = unzip(restored.bytes);
    assertPackageValid(restoredParts);

    expect(restored.unknownTags).toEqual([]);
    expect(restored.replacements).toBeGreaterThan(0);
    expect(restored.fileName).toBe('restore.docx');
    expect(contentText(restoredParts)).toBe(originalText);
    expect(contentText(restoredParts)).toContain(PERSON);
    expect(contentText(restoredParts)).toContain(EMAIL);
    expect(contentText(restoredParts)).toContain(PHONE);

    expect(xmlText(restoredParts, 'docProps/core.xml')).toContain('<dc:creator></dc:creator>');
    expect(xmlText(restoredParts, 'docProps/app.xml')).toContain('<Company></Company>');
  });

  it('leaves unknown tags untouched and reports them', async () => {
    const bytes = minimalDocx('<w:p><w:r><w:t>[[ZZZZZ_PERSON_1]]</w:t></w:r></w:p>');
    const vault = createVault('', { prefix: 'DM7F3' });
    const restored = await restoreDocx(fileOf(bytes, 'unknown.docx'), vault);
    const parts = unzip(restored.bytes);
    assertPackageValid(parts);

    expect(restored.unknownTags).toEqual(['[[ZZZZZ_PERSON_1]]']);
    expect(restored.warnings.some((warning) => /unknown tag/u.test(warning))).toBe(true);
    expect(xmlText(parts, 'word/document.xml')).toContain('[[ZZZZZ_PERSON_1]]');
  });

  it('is fail-closed and does not commit a partially masked vault', async () => {
    const parts = fullDocxParts();
    parts['word/document.xml'] = encoder.encode(
      `${xmlDeclaration()}<w:document xmlns:w="${W_NS}"><w:body></w:document>`,
    );
    const bytes = buildDocx(parts);
    const ctx = contextFor();
    const before = JSON.stringify(ctx.vault);

    await expect(anonymizeDocx(fileOf(bytes, 'broken.docx'), ctx)).rejects.toThrow();
    expect(JSON.stringify(ctx.vault)).toBe(before);
  });
});

describe('package linter and DOCX rejections', () => {
  it('accepts the fixture package and rejects missing content types, dangling rels and bad XML', () => {
    assertPackageValid(new Map(Object.entries(fullDocxParts())));

    const missingTypes = new Map(Object.entries(fullDocxParts()));
    missingTypes.delete('[Content_Types].xml');
    expect(() => assertPackageValid(missingTypes)).toThrow(/Content_Types/u);

    const danglingTarget = new Map(Object.entries(fullDocxParts()));
    danglingTarget.set(
      'word/_rels/document.xml.rels',
      encoder.encode(
        xmlText(danglingTarget, 'word/_rels/document.xml.rels').replace(
          'Target="styles.xml"',
          'Target="missing.xml"',
        ),
      ),
    );
    expect(() => assertPackageValid(danglingTarget)).toThrow(/does not exist/u);

    const danglingIdParts = minimalDocxParts(
      '<w:p><w:hyperlink r:id="rIdMissing"><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p>',
    );
    expect(() => assertPackageValid(new Map(Object.entries(danglingIdParts)))).toThrow(
      /Dangling relationship reference/u,
    );

    const badXml = new Map(Object.entries(fullDocxParts()));
    badXml.set(
      'word/document.xml',
      encoder.encode(`${xmlDeclaration()}<w:document xmlns:w="${W_NS}"><w:body></w:document>`),
    );
    expect(() => assertPackageValid(badXml)).toThrow(/not well-formed|Mismatched/u);
  });

  it('detects structural rewrites against a baseline', () => {
    const parts = new Map(Object.entries(fullDocxParts()));
    assertPackageValid(parts);
    const baseline = snapshotPackage(parts);

    const document = xmlText(parts, 'word/document.xml');
    parts.set('word/document.xml', encoder.encode(document.replace('<w:body>', '<w:body><w:p/>')));
    expect(() => assertPackageValid(parts, { baseline })).toThrow(/structure changed/u);
  });

  it('rejects .docm, VBA parts and macro content types', async () => {
    const ctx = contextFor();
    await expect(anonymizeDocx(fileOf(minimalDocx(), 'macros.docm'), ctx)).rejects.toThrow(
      /macro-enabled/u,
    );

    const withVba = minimalDocxParts();
    withVba['word/vbaProject.bin'] = Uint8Array.from([0x01, 0x02, 0x03]);
    await expect(anonymizeDocx(fileOf(buildDocx(withVba), 'vba.docx'), ctx)).rejects.toThrow(
      /VBA macros/u,
    );

    const macroType = minimalDocxParts();
    macroType['[Content_Types].xml'] = encoder.encode(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>' +
        '</Types>',
    );
    await expect(anonymizeDocx(fileOf(buildDocx(macroType), 'macro.docx'), ctx)).rejects.toThrow(
      /macro content/u,
    );
  });

  it('rejects non-DOCX and corrupted bytes', async () => {
    const ctx = contextFor();
    await expect(
      anonymizeDocx(fileOf(encoder.encode('not a zip'), 'bad.docx'), ctx),
    ).rejects.toThrow(/ZIP/u);
    await expect(anonymizeDocx(fileOf(minimalDocx(), 'old.doc'), ctx)).rejects.toThrow(
      /only \.docx/u,
    );
  });
});

describe('docxFormatAdapter', () => {
  it('recognizes .docx and the DOCX MIME type, but not macro/legacy formats', () => {
    expect(docxFormatAdapter.format).toBe('docx');
    expect(
      docxFormatAdapter.canHandle({ name: 'A.DOCX', mimeType: 'application/octet-stream' }),
    ).toBe(true);
    expect(docxFormatAdapter.canHandle({ name: 'file', mimeType: DOCX_MIME })).toBe(true);
    expect(
      docxFormatAdapter.canHandle({ name: 'file', mimeType: `${DOCX_MIME}; charset=binary` }),
    ).toBe(true);
    expect(
      docxFormatAdapter.canHandle({ name: 'file.docm', mimeType: 'application/octet-stream' }),
    ).toBe(false);
    expect(docxFormatAdapter.canHandle({ name: 'file.dotx', mimeType: DOCX_MIME })).toBe(false);
    expect(
      docxFormatAdapter.canHandle({
        name: 'file.docx',
        mimeType: 'application/vnd.ms-word.document.macroEnabled.12',
      }),
    ).toBe(false);
    expect(docxFormatAdapter.canHandle({ name: 'file.doc', mimeType: 'text/plain' })).toBe(false);
  });
});

describe('package helpers', () => {
  it('finds the main part and content type', () => {
    const parts = new Map(Object.entries(fullDocxParts()));
    const types = parseContentTypes(parts);
    expect(types.overrides.get('word/document.xml')).toContain('wordprocessingml.document.main');
  });

  it('re-zips a masked package deterministically', async () => {
    const result = await anonymizeDocx(fileOf(fullDocx()), contextFor());
    const parts = unzip(result.maskedBytes);
    const first = zipPackage(parts);
    const second = zipPackage(parts);
    expect([...first]).toEqual([...second]);
  });
});
