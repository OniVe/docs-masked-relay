/**
 * Synthetic XLSX fixtures for the M2b tests.
 *
 * Fixtures are built with fflate directly (not with the production zip writer)
 * so the tests exercise the real unzip/lint path. Every package is a valid OPC
 * graph: content types cover all parts and every internal relationship
 * resolves. The workbook intentionally contains hidden/veryHidden sheets,
 * shared/inline strings, numeric/date cells, comments, threaded comments,
 * persons, charts, pivot cache, external links, customXml, metadata,
 * calcChain, revision logs and a digital signature.
 */

import { type Zippable, zipSync } from 'fflate';

export type FixturePart = string | Uint8Array;
export type FixtureParts = Record<string, Uint8Array>;

export const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
export const CP_NS = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
export const DC_NS = 'http://purl.org/dc/elements/1.1/';
export const DCTERMS_NS = 'http://purl.org/dc/terms/';
export const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
export const EP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
export const VT_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
export const CUSTOM_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
export const DS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml';
export const THREADED_NS =
  'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
export const PERSON_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2017/person';
export const REVISION_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
export const SIG_ORIGIN_NS = 'http://schemas.openxmlformats.org/package/2006/digital-signature';
export const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

const FIXED_DATE = new Date(2020, 0, 1, 0, 0, 0, 0);
const encoder = new TextEncoder();

function bytesOf(part: FixturePart): Uint8Array {
  return typeof part === 'string' ? encoder.encode(part) : part;
}

/** Builds a ZIP with a deterministic timestamp; used only by tests. */
export function buildXlsx(parts: Record<string, FixturePart>): Uint8Array {
  const zippable: Zippable = {};
  for (const [name, part] of Object.entries(parts)) {
    zippable[name] = bytesOf(part);
  }
  return zipSync(zippable, { level: 6, mtime: FIXED_DATE, os: 0 });
}

export function xmlDeclaration(encoding = 'UTF-8'): string {
  return `<?xml version="1.0" encoding="${encoding}" standalone="yes"?>`;
}

export function contentTypesXml(): string {
  return `${xmlDeclaration()}
<Types xmlns="${CT_NS}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>
  <Override PartName="/xl/threadedComments/threadedComment1.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>
  <Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>
  <Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
  <Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>
  <Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/>
  <Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/>
  <Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>
  <Override PartName="/xl/revisions/revisionHeaders.xml" ContentType="application/vnd.ms-excel.revisionHeaders+xml"/>
  <Override PartName="/xl/users.xml" ContentType="application/vnd.ms-excel.usernames+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>
  <Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>
  <Override PartName="/_xmlsignatures/origin.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/>
  <Override PartName="/_xmlsignatures/sig1.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/>
</Types>`;
}

export function rootRelsXml(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="_xmlsignatures/origin.xml"/>
</Relationships>`;
}

export function workbookRelsXml(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>
  <Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/>
  <Relationship Id="rIdPivot" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>
  <Relationship Id="rIdPerson" Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"/>
  <Relationship Id="rIdRevisions" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/revisionHeaders" Target="revisions/revisionHeaders.xml"/>
  <Relationship Id="rIdUsers" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/usernames" Target="users.xml"/>
  <Relationship Id="rIdCustomXml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>
</Relationships>`;
}

export function workbookXml(): string {
  return `${xmlDeclaration()}
<workbook xmlns="${S_NS}" xmlns:r="${R_NS}">
  <fileSharing userName="Иванов Иван Иванович"/>
  <workbookPr date1904="1"/>
  <workbookProtection workbookPassword="ABCD" lockStructure="1"/>
  <bookViews>
    <workbookView xWindow="0" yWindow="0" windowWidth="12000" windowHeight="8000"/>
  </bookViews>
  <sheets>
    <sheet name="Лист1" sheetId="1" r:id="rId1"/>
    <sheet name="Скрытый" sheetId="2" state="hidden" r:id="rId2"/>
    <sheet name="ОченьСкрытый" sheetId="3" state="veryHidden" r:id="rId3"/>
  </sheets>
  <externalReferences>
    <externalReference r:id="rIdExt"/>
  </externalReferences>
  <definedNames>
    <definedName name="_xlnm.Print_Area" localSheetId="0">Лист1!$A$1:$G$4</definedName>
    <definedName name="Клиенты">Лист1!$A$1:$A$2</definedName>
  </definedNames>
  <calcPr calcId="191029"/>
  <pivotCaches>
    <pivotCache cacheId="1" r:id="rIdPivot"/>
  </pivotCaches>
</workbook>`;
}

export function sharedStringsXml(): string {
  return `${xmlDeclaration()}
<sst xmlns="${S_NS}" count="4" uniqueCount="4">
  <si><t>Иванов Иван Иванович</t></si>
  <si>
    <r><rPr><b/></rPr><t>Ива</t></r>
    <r><t>нов Иван</t></r>
    <r><t xml:space="preserve"> Иванович</t></r>
    <rPh sb="0" eb="1"><t>Иванов</t></rPh>
  </si>
  <si><t>ivan@example.ru</t></si>
  <si><t>+7 916 123-45-67</t></si>
</sst>`;
}

export function stylesXml(): string {
  return `${xmlDeclaration()}
<styleSheet xmlns="${S_NS}">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="dd.mm.yyyy"/>
  </numFmts>
  <fonts count="1">
    <font><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="45" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
}

export function sheet1Xml(): string {
  return `${xmlDeclaration()}
<worksheet xmlns="${S_NS}" xmlns:r="${R_NS}">
  <sheetPr><outlinePr summaryBelow="1"/></sheetPr>
  <dimension ref="A1:G5"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>0</v></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>ivan@example.ru</t></is></c>
      <c r="B2" t="str"><f>"Иванов Иван Иванович"&amp;A1</f><v>Иванов Иван Иванович</v></c>
      <c r="C2" s="1"><v>4081781009991001</v></c>
      <c r="D2" s="2"><v>44562</v></c>
      <c r="E2" s="3"><v>44562.5</v></c>
      <c r="F2" s="4"><v>44562</v></c>
      <c r="G2" s="5"><v>44562</v></c>
    </row>
    <row r="3">
      <c r="A3" t="n"><v>4081781009991001</v></c>
      <c r="B3" t="b"><v>1</v></c>
      <c r="C3" t="e"><v>#N/A</v></c>
      <c r="D3" t="d"><v>2024-01-01T00:00:00Z</v></c>
    </row>
    <row r="4">
      <c r="A4" t="inlineStr"><is><t>Код</t></is></c>
      <c r="B4" t="inlineStr"><is><t>Сумма</t></is></c>
    </row>
    <row r="5">
      <c r="A5" t="n"><v>1234567</v></c>
      <c r="B5" t="n"><v>45292</v></c>
    </row>
  </sheetData>
  <conditionalFormatting sqref="A1">
    <cfRule type="expression" priority="1"><formula>"Иванов Иван Иванович"=A1</formula></cfRule>
  </conditionalFormatting>
  <dataValidations count="1">
    <dataValidation type="textLength" operator="lessThanOrEqual" sqref="A1" promptTitle="Иванов Иван Иванович" prompt="Тел. +7 916 123-45-67" errorTitle="ivan@example.ru" error="Ошибка: Иванов Иван Иванович">
      <formula1>"Иванов Иван Иванович"</formula1>
    </dataValidation>
  </dataValidations>
  <hyperlinks>
    <hyperlink ref="A1" r:id="rIdLink" tooltip="ivan@example.ru" display="Иванов Иван Иванович"/>
  </hyperlinks>
  <printOptions horizontalCentered="1"/>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
  <pageSetup orientation="portrait"/>
  <headerFooter>
    <oddHeader>&amp;LИванов Иван Иванович</oddHeader>
    <oddFooter>+7 916 123-45-67</oddFooter>
  </headerFooter>
  <drawing r:id="rIdDrawing"/>
</worksheet>`;
}

export function sheet2Xml(): string {
  return `${xmlDeclaration()}
<worksheet xmlns="${S_NS}">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>ivan@example.ru</t></is></c>
    </row>
  </sheetData>
</worksheet>`;
}

export function sheet3Xml(): string {
  return `${xmlDeclaration()}
<worksheet xmlns="${S_NS}">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>3</v></c>
    </row>
  </sheetData>
</worksheet>`;
}

export function sheet1RelsXml(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/>
  <Relationship Id="rIdThreaded" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/>
  <Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
  <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/ivanov" TargetMode="External"/>
</Relationships>`;
}

export function commentsXml(): string {
  return `${xmlDeclaration()}
<comments xmlns="${S_NS}">
  <authors><author>Иванов Иван Иванович</author></authors>
  <commentList>
    <comment ref="A1" authorId="0" shapeId="0">
      <text>
        <r><rPr><b/></rPr><t>Позвонить: +7 916 123-45-67</t></r>
        <r><t xml:space="preserve">, ivan@example.ru</t></r>
      </text>
    </comment>
  </commentList>
</comments>`;
}

export function threadedCommentsXml(): string {
  return `${xmlDeclaration()}
<ThreadedComments xmlns="${THREADED_NS}">
  <threadedComment ref="A1" dT="2024-01-01T00:00:00Z" personId="{11111111-1111-1111-1111-111111111111}" id="{22222222-2222-2222-2222-222222222222}" done="0">
    <text>Иванов Иван Иванович: ivan@example.ru</text>
  </threadedComment>
</ThreadedComments>`;
}

export function personsXml(): string {
  return `${xmlDeclaration()}
<personList xmlns="${PERSON_NS}">
  <person displayName="Иванов Иван Иванович" id="{11111111-1111-1111-1111-111111111111}" userId="ivan@example.ru" providerId="AD"/>
</personList>`;
}

export function drawingXml(): string {
  return `${xmlDeclaration()}
<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:c="${C_NS}">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="Иванов Иван Иванович" descr="Иванов Иван Иванович"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="${C_NS}"><c:chart r:id="rIdChart"/></a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;
}

export function drawingRelsXml(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`;
}

export function chartXml(): string {
  return `${xmlDeclaration()}
<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">
  <c:chart>
    <c:title>
      <c:tx><c:rich>
        <a:bodyPr/>
        <a:p><a:r><a:t>Доход Иванов Иван Иванович</a:t></a:r></a:p>
      </c:rich></c:tx>
    </c:title>
    <c:plotArea>
      <c:barChart>
        <c:ser>
          <c:tx><c:v>Иванов Иван Иванович</c:v></c:tx>
          <c:cat><c:strRef><c:f>Лист1!$A$1</c:f><c:strCache>
            <c:ptCount val="1"/><c:pt idx="0"><c:v>ivan@example.ru</c:v></c:pt>
          </c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Лист1!$C$1</c:f><c:numCache>
            <c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>123456789</c:v></c:pt>
          </c:numCache></c:numRef></c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;
}

export function pivotCacheDefinitionXml(): string {
  return `${xmlDeclaration()}
<pivotCacheDefinition xmlns="${S_NS}" xmlns:r="${R_NS}" r:id="rIdRecords" refreshOnLoad="1" recordCount="1">
  <cacheSource type="worksheet"><worksheetSource ref="A1:C2" sheet="Лист1"/></cacheSource>
  <cacheFields count="2">
    <cacheField name="Иванов Иван Иванович" numFmtId="0">
      <sharedItems count="1"><s v="ivan@example.ru"/></sharedItems>
    </cacheField>
    <cacheField name="Сумма" numFmtId="0">
      <sharedItems containsNumber="1"><n v="10"/></sharedItems>
    </cacheField>
  </cacheFields>
</pivotCacheDefinition>`;
}

export function pivotCacheRecordsXml(): string {
  return `${xmlDeclaration()}
<pivotCacheRecords xmlns="${S_NS}" count="1"><r><n v="0"/><n v="10"/></r></pivotCacheRecords>`;
}

export function pivotCacheRelsXml(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rIdRecords" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheRecords" Target="pivotCacheRecords1.xml"/>
</Relationships>`;
}

export function externalLinkXml(): string {
  return `${xmlDeclaration()}
<externalLink xmlns="${S_NS}" xmlns:r="${R_NS}">
  <externalBook r:id="rIdExternal">
    <sheetNames><sheetName val="Иванов Иван Иванович"/></sheetNames>
    <sheetDataSet>
      <sheetData sheetId="0">
        <row r="1">
          <cell r="A1"><v>ivan@example.ru</v></cell>
          <cell r="B1"><v>123456789</v></cell>
        </row>
      </sheetData>
    </sheetDataSet>
  </externalBook>
</externalLink>`;
}

export function externalLinkRelsXml(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///C:/Users/Иванов/report.xlsx" TargetMode="External"/>
</Relationships>`;
}

export function customXmlItemXml(): string {
  return `${xmlDeclaration()}
<root xmlns:x="${DC_NS}" name="Иванов Иван Иванович">
  <person email="ivan@example.ru">+7 916 123-45-67</person>
</root>`;
}

export function customXmlPropsXml(): string {
  return `${xmlDeclaration()}
<ds:datastoreItem xmlns:ds="${DS_NS}" ds:itemID="{33333333-3333-3333-3333-333333333333}" ds:itemName="Иванов Иван Иванович">
  <ds:schemaRefs/>
</ds:datastoreItem>`;
}

export function customXmlRelsXml(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rIdProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/>
</Relationships>`;
}

export function coreXml(): string {
  return `${xmlDeclaration()}
<cp:coreProperties xmlns:cp="${CP_NS}" xmlns:dc="${DC_NS}" xmlns:dcterms="${DCTERMS_NS}" xmlns:xsi="${XSI_NS}">
  <dc:title>Иванов Иван Иванович</dc:title>
  <dc:subject>ivan@example.ru</dc:subject>
  <dc:creator>Иванов Иван Иванович</dc:creator>
  <cp:keywords>+7 916 123-45-67</cp:keywords>
  <dc:description>Иванов Иван Иванович</dc:description>
  <cp:lastModifiedBy>Иванов Иван Иванович</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-02-02T00:00:00Z</dcterms:modified>
</cp:coreProperties>`;
}

export function appXml(): string {
  return `${xmlDeclaration()}
<Properties xmlns="${EP_NS}" xmlns:vt="${VT_NS}">
  <Application>DocsMasked Test</Application>
  <Company>ООО Ромашка</Company>
  <Manager>Иванов Иван Иванович</Manager>
  <Template>Normal.xltx</Template>
  <HyperlinkBase>https://example.ru/ivan</HyperlinkBase>
  <Pages>1</Pages>
</Properties>`;
}

export function customPropsXml(): string {
  return `${xmlDeclaration()}
<Properties xmlns="${CUSTOM_NS}" xmlns:vt="${VT_NS}">
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Клиент">
    <vt:lpwstr>Иванов Иван Иванович</vt:lpwstr>
  </property>
</Properties>`;
}

export function calcChainXml(): string {
  return `${xmlDeclaration()}
<calcChain xmlns="${S_NS}"><c r="A1" i="1"/></calcChain>`;
}

export function signatureOriginXml(): string {
  return `${xmlDeclaration()}
<SignatureOrigin xmlns="${SIG_ORIGIN_NS}"><Signature Id="idPackageSignature"/></SignatureOrigin>`;
}

export function signatureRelsXml(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rIdSig" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature" Target="sig1.xml"/>
</Relationships>`;
}

export function signatureXml(): string {
  return `${xmlDeclaration()}
<Signature xmlns="${DSIG_NS}"><SignedInfo/></Signature>`;
}

export function revisionHeadersXml(): string {
  return `${xmlDeclaration()}
<revisionHeaders xmlns="${REVISION_NS}">
  <header guid="{44444444-4444-4444-4444-444444444444}" userId="Иванов Иван Иванович" initials="ИИИ" dateTime="2024-03-01T10:00:00Z"/>
</revisionHeaders>`;
}

export function usersXml(): string {
  return `${xmlDeclaration()}
<users xmlns="${REVISION_NS}">
  <user guid="{55555555-5555-5555-5555-555555555555}" name="Иванов Иван Иванович" initials="ИИИ" userId="ivan@example.ru"/>
</users>`;
}

export function thumbnailBytes(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

export function imageBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

/** Minimal valid XLSX with one shared string; used for focused tests. */
export function minimalXlsxParts(inlineText = 'Иванов Иван Иванович'): FixtureParts {
  return {
    '[Content_Types].xml': bytesOf(`${xmlDeclaration()}
<Types xmlns="${CT_NS}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`),
    '_rels/.rels': bytesOf(rootRelsWithoutExtras()),
    'xl/workbook.xml': bytesOf(`${xmlDeclaration()}
<workbook xmlns="${S_NS}" xmlns:r="${R_NS}">
  <sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': bytesOf(`${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': bytesOf(`${xmlDeclaration()}
<worksheet xmlns="${S_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${inlineText}</t></is></c></row></sheetData></worksheet>`),
    'xl/sharedStrings.xml': bytesOf(`${xmlDeclaration()}
<sst xmlns="${S_NS}" count="0" uniqueCount="0"/>`),
  };
}

function rootRelsWithoutExtras(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

export function fullXlsxParts(): FixtureParts {
  return {
    '[Content_Types].xml': bytesOf(contentTypesXml()),
    '_rels/.rels': bytesOf(rootRelsXml()),
    'xl/workbook.xml': bytesOf(workbookXml()),
    'xl/_rels/workbook.xml.rels': bytesOf(workbookRelsXml()),
    'xl/worksheets/sheet1.xml': bytesOf(sheet1Xml()),
    'xl/worksheets/sheet2.xml': bytesOf(sheet2Xml()),
    'xl/worksheets/sheet3.xml': bytesOf(sheet3Xml()),
    'xl/worksheets/_rels/sheet1.xml.rels': bytesOf(sheet1RelsXml()),
    'xl/sharedStrings.xml': bytesOf(sharedStringsXml()),
    'xl/styles.xml': bytesOf(stylesXml()),
    'xl/comments1.xml': bytesOf(commentsXml()),
    'xl/threadedComments/threadedComment1.xml': bytesOf(threadedCommentsXml()),
    'xl/persons/person.xml': bytesOf(personsXml()),
    'xl/charts/chart1.xml': bytesOf(chartXml()),
    'xl/drawings/drawing1.xml': bytesOf(drawingXml()),
    'xl/drawings/_rels/drawing1.xml.rels': bytesOf(drawingRelsXml()),
    'xl/pivotCache/pivotCacheDefinition1.xml': bytesOf(pivotCacheDefinitionXml()),
    'xl/pivotCache/pivotCacheRecords1.xml': bytesOf(pivotCacheRecordsXml()),
    'xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels': bytesOf(pivotCacheRelsXml()),
    'xl/externalLinks/externalLink1.xml': bytesOf(externalLinkXml()),
    'xl/externalLinks/_rels/externalLink1.xml.rels': bytesOf(externalLinkRelsXml()),
    'xl/calcChain.xml': bytesOf(calcChainXml()),
    'xl/revisions/revisionHeaders.xml': bytesOf(revisionHeadersXml()),
    'xl/users.xml': bytesOf(usersXml()),
    'customXml/item1.xml': bytesOf(customXmlItemXml()),
    'customXml/itemProps1.xml': bytesOf(customXmlPropsXml()),
    'customXml/_rels/item1.xml.rels': bytesOf(customXmlRelsXml()),
    'docProps/core.xml': bytesOf(coreXml()),
    'docProps/app.xml': bytesOf(appXml()),
    'docProps/custom.xml': bytesOf(customPropsXml()),
    'docProps/thumbnail.jpeg': thumbnailBytes(),
    'xl/media/image1.png': imageBytes(),
    '_xmlsignatures/origin.xml': bytesOf(signatureOriginXml()),
    '_xmlsignatures/sig1.xml': bytesOf(signatureXml()),
    '_xmlsignatures/_rels/origin.xml.rels': bytesOf(signatureRelsXml()),
  };
}

export function fullXlsx(): Uint8Array {
  return buildXlsx(fullXlsxParts());
}

export function minimalXlsx(inlineText = 'Иванов Иван Иванович'): Uint8Array {
  return buildXlsx(minimalXlsxParts(inlineText));
}
