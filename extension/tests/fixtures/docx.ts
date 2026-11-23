/**
 * Synthetic DOCX fixtures for the M2a tests.
 *
 * Fixtures are built with fflate directly (not with the production zip writer)
 * so the tests exercise the real unzip/lint path. Every package is a valid OPC
 * graph: content types cover all parts and every internal relationship resolves.
 */

import { type Zippable, zipSync } from 'fflate';

export type FixturePart = string | Uint8Array;
export type FixtureParts = Record<string, Uint8Array>;

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const V_NS = 'urn:schemas-microsoft-com:vml';
export const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
export const W15_NS = 'http://schemas.microsoft.com/office/word/2012/wordml';
export const W16CID_NS = 'http://schemas.microsoft.com/office/word/2016/wordml/cid';
export const W16CEX_NS = 'http://schemas.microsoft.com/office/word/2018/wordml/cex';
export const DGM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
export const DS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml';
export const CP_NS = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
export const DC_NS = 'http://purl.org/dc/elements/1.1/';
export const DCTERMS_NS = 'http://purl.org/dc/terms/';
export const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
export const EP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
export const VT_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
export const CUSTOM_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
export const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

const FIXED_DATE = new Date(2020, 0, 1, 0, 0, 0, 0);

const encoder = new TextEncoder();

function bytesOf(part: FixturePart): Uint8Array {
  return typeof part === 'string' ? encoder.encode(part) : part;
}

/** Builds a ZIP with a deterministic timestamp; used only by tests. */
export function buildDocx(parts: Record<string, FixturePart>): Uint8Array {
  const zippable: Zippable = {};
  for (const [name, part] of Object.entries(parts)) {
    zippable[name] = bytesOf(part);
  }
  return zipSync(zippable, { level: 6, mtime: FIXED_DATE, os: 0 });
}

export function xmlDeclaration(encoding = 'UTF-8'): string {
  return `<?xml version="1.0" encoding="${encoding}" standalone="yes"?>`;
}

export function documentXml(body: string, sectPr = '<w:sectPr/>'): string {
  return `${xmlDeclaration()}
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:v="${V_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:c="${C_NS}" xmlns:mc="${MC_NS}" xmlns:w14="${W14_NS}" xmlns:w15="${W15_NS}" mc:Ignorable="w14 w15">
<w:body>
${body}
${sectPr}
</w:body>
</w:document>`;
}

export function minimalContentTypes(): string {
  return `${xmlDeclaration()}
<Types xmlns="${TYPES_NS}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

export function minimalRootRels(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

export function minimalDocumentRels(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

export function minimalStyles(): string {
  return `${xmlDeclaration()}
<w:styles xmlns:w="${W_NS}">
  <w:latentStyles w:defLockedState="0"/>
</w:styles>`;
}

export function minimalCoreProps(author = 'Иванов Иван Иванович'): string {
  return `${xmlDeclaration()}
<cp:coreProperties xmlns:cp="${CP_NS}" xmlns:dc="${DC_NS}" xmlns:dcterms="${DCTERMS_NS}" xmlns:xsi="${XSI_NS}">
  <dc:creator>${author}</dc:creator>
  <cp:lastModifiedBy>${author}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-02-02T00:00:00Z</dcterms:modified>
</cp:coreProperties>`;
}

export function minimalAppProps(): string {
  return `${xmlDeclaration()}
<Properties xmlns="${EP_NS}" xmlns:vt="${VT_NS}">
  <Application>DocsMasked Test</Application>
  <Company>ООО Ромашка</Company>
  <Manager>Иванов Иван Иванович</Manager>
  <Template>Normal.dotm</Template>
  <HyperlinkBase>https://example.ru/ivan</HyperlinkBase>
  <Pages>1</Pages>
</Properties>`;
}

export function minimalDocxParts(documentBody?: string): FixtureParts {
  const body = documentBody ?? '<w:p><w:r><w:t>Минимальный документ</w:t></w:r></w:p>';
  return {
    '[Content_Types].xml': bytesOf(minimalContentTypes()),
    '_rels/.rels': bytesOf(minimalRootRels()),
    'word/document.xml': bytesOf(documentXml(body)),
    'word/styles.xml': bytesOf(minimalStyles()),
    'word/_rels/document.xml.rels': bytesOf(minimalDocumentRels()),
    'docProps/core.xml': bytesOf(minimalCoreProps()),
    'docProps/app.xml': bytesOf(minimalAppProps()),
  };
}

/** Minimal valid DOCX; optionally replaces the body paragraphs. */
export function minimalDocx(documentBody?: string): Uint8Array {
  return buildDocx(minimalDocxParts(documentBody));
}

export function fullContentTypes(): string {
  return `${xmlDeclaration()}
<Types xmlns="${TYPES_NS}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
  <Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>
  <Override PartName="/word/commentsIds.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml"/>
  <Override PartName="/word/commentsExtensible.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml"/>
  <Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/glossary/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.glossary+xml"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
  <Override PartName="/word/diagrams/data1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>
  <Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>
  <Override PartName="/_xmlsignatures/sig1.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/>
</Types>`;
}

export function fullRootRels(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>
</Relationships>`;
}

export function fullDocumentRels(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  <Relationship Id="rIdPeople" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>
  <Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rIdGlossary" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/glossaryDocument" Target="glossary/document.xml"/>
  <Relationship Id="rIdCustomXml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>
  <Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>
  <Relationship Id="rIdHyperlink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:ivan@example.ru" TargetMode="External"/>
</Relationships>`;
}

export function fullCommentsRels(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rIdCommentsExtended" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>
  <Relationship Id="rIdCommentsIds" Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds" Target="commentsIds.xml"/>
  <Relationship Id="rIdCommentsExtensible" Type="http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible" Target="commentsExtensible.xml"/>
</Relationships>`;
}

export function fullSettingsRels(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rIdTemplate" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:/Users/Иванов/template.dotm" TargetMode="External"/>
</Relationships>`;
}

export function fullCustomXmlRels(): string {
  return `${xmlDeclaration()}
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rIdProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/>
</Relationships>`;
}

export function fullDocumentBody(): string {
  return `
<w:p>
  <w:r><w:t>Ива</w:t></w:r>
  <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">нов Иван Иванович</w:t></w:r>
  <w:r><w:t xml:space="preserve"> &amp; тел. +7 916 123-45-67</w:t></w:r>
</w:p>
<w:p>
  <w:r><w:t>Сайт: </w:t></w:r>
  <w:hyperlink r:id="rIdHyperlink" w:history="1" w:tooltip="Иванов Иван Иванович">
    <w:r><w:t>ivan@example.ru</w:t></w:r>
  </w:hyperlink>
</w:p>
<w:p>
  <w:ins w:id="1" w:author="Иванов Иван Иванович" w:date="2024-03-01T10:00:00Z" w:initials="ИИИ">
    <w:r><w:t>ivan@example.ru</w:t></w:r>
  </w:ins>
  <w:del w:id="2" w:author="Иванов Иван Иванович" w:date="2024-03-01T11:00:00Z" w:initials="ИИИ">
    <w:r><w:delText>+7 916 123-45-67</w:delText></w:r>
  </w:del>
  <w:r>
    <w:rPr><w:b/><w:rPrChange w:id="3" w:author="Иванов Иван Иванович" w:date="2024-03-01T12:00:00Z"><w:rPr/></w:rPrChange></w:rPr>
    <w:t>Изменено</w:t>
  </w:r>
</w:p>
<w:p>
  <w:commentRangeStart w:id="0"/>
  <w:r><w:t>Иванов Иван Иванович</w:t></w:r>
  <w:commentRangeEnd w:id="0"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
</w:p>
<w:p>
  <w:r><w:pict>
    <v:shape id="tb1" type="#_x0000_t202" style="width:120pt;height:40pt" alt="Иванов Иван Иванович">
      <v:textbox><w:txbxContent><w:p><w:r><w:t>ivan@example.ru</w:t></w:r></w:p></w:txbxContent></v:textbox>
    </v:shape>
  </w:pict></w:r>
</w:p>
<w:p>
  <w:r><w:fldChar w:fldCharType="begin"/></w:r>
  <w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:ivan@example.ru" </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="separate"/></w:r>
  <w:r><w:t>ivan@example.ru</w:t></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r>
</w:p>
<w:p>
  <w:fldSimple w:instr=" HYPERLINK &quot;mailto:ivan@example.ru&quot; ">
    <w:r><w:t>поле</w:t></w:r>
  </w:fldSimple>
</w:p>
<w:p>
  <w:r><w:t>Сноска</w:t><w:footnoteReference w:id="1"/></w:r>
  <w:r><w:endnoteReference w:id="1"/></w:r>
</w:p>
<w:p>
  <w:r><w:drawing>
    <wp:inline>
      <wp:extent cx="1000000" cy="500000"/>
      <wp:docPr id="1" name="Chart 1" descr="Иванов Иван Иванович"/>
      <a:graphic><a:graphicData uri="${C_NS}"><c:chart r:id="rIdChart"/></a:graphicData></a:graphic>
    </wp:inline>
  </w:drawing></w:r>
</w:p>
<w:p>
  <w:r><w:rPr><w:vanish/></w:rPr><w:t>Иванов Иван Иванович</w:t></w:r>
</w:p>`;
}

export function fullSectPr(): string {
  return `<w:sectPr>
  <w:headerReference w:type="default" r:id="rIdHeader"/>
  <w:footerReference w:type="default" r:id="rIdFooter"/>
</w:sectPr>`;
}

export function fullHeader(): string {
  return `${xmlDeclaration()}
<w:hdr xmlns:w="${W_NS}" xmlns:r="${R_NS}">
  <w:p><w:r><w:t>Иванов Иван Иванович</w:t></w:r></w:p>
</w:hdr>`;
}

export function fullFooter(): string {
  return `${xmlDeclaration()}
<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}">
  <w:p><w:r><w:t>+7 916 123-45-67</w:t></w:r></w:p>
</w:ftr>`;
}

export function fullFootnotes(): string {
  return `${xmlDeclaration()}
<w:footnotes xmlns:w="${W_NS}">
  <w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:footnoteRef/><w:t xml:space="preserve"> ivan@example.ru</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
}

export function fullEndnotes(): string {
  return `${xmlDeclaration()}
<w:endnotes xmlns:w="${W_NS}">
  <w:endnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
  <w:endnote w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>
  <w:endnote w:id="1"><w:p><w:r><w:endnoteRef/><w:t xml:space="preserve"> +7 916 123-45-67</w:t></w:r></w:p></w:endnote>
</w:endnotes>`;
}

export function fullComments(): string {
  return `${xmlDeclaration()}
<w:comments xmlns:w="${W_NS}">
  <w:comment w:id="0" w:author="Иванов Иван Иванович" w:date="2024-04-01T09:00:00Z" w:initials="ИИИ">
    <w:p><w:r><w:t>Позвонить: +7 916 123-45-67, ivan@example.ru</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;
}

export function fullCommentsExtended(): string {
  return `${xmlDeclaration()}
<w15:commentsEx xmlns:w15="${W15_NS}">
  <w15:commentEx w15:paraId="1A2B3C4D" w15:paraIdParent="1A2B3C4E" w15:done="0"/>
</w15:commentsEx>`;
}

export function fullCommentsIds(): string {
  return `${xmlDeclaration()}
<w16cid:commentsIds xmlns:w16cid="${W16CID_NS}">
  <w16cid:commentId w16cid:paraId="1A2B3C4D" w16cid:durableId="12345678"/>
</w16cid:commentsIds>`;
}

export function fullCommentsExtensible(): string {
  return `${xmlDeclaration()}
<w16cex:commentsExtensible xmlns:w16cex="${W16CEX_NS}">
  <w16cex:commentExtensible w16cex:durableId="12345678" w16cex:dateUtc="2024-04-01T09:00:00Z"/>
</w16cex:commentsExtensible>`;
}

export function fullPeople(): string {
  return `${xmlDeclaration()}
<w15:people xmlns:w15="${W15_NS}">
  <w15:person w15:author="Иванов Иван Иванович" w15:userId="ivan@example.ru" w15:providerId="AD"/>
</w15:people>`;
}

export function fullSettings(): string {
  return `${xmlDeclaration()}
<w:settings xmlns:w="${W_NS}" xmlns:r="${R_NS}">
  <w:attachedTemplate r:id="rIdTemplate"/>
  <w:docVars>
    <w:docVar w:name="Иванов Иван Иванович" w:val="+7 916 123-45-67"/>
  </w:docVars>
  <w:rsids><w:rsid w:val="00AB12CD"/></w:rsids>
</w:settings>`;
}

export function fullGlossary(): string {
  return `${xmlDeclaration()}
<w:glossaryDocument xmlns:w="${W_NS}">
  <w:docParts><w:docPart><w:docPartBody>
    <w:p><w:r><w:t>Иванов Иван Иванович</w:t></w:r></w:p>
  </w:docPartBody></w:docPart></w:docParts>
</w:glossaryDocument>`;
}

export function fullChart(): string {
  return `${xmlDeclaration()}
<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Иванов Иван Иванович</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea><c:barChart><c:ser>
      <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache>
        <c:ptCount val="1"/><c:pt idx="0"><c:v>ivan@example.ru</c:v></c:pt>
      </c:strCache></c:strRef></c:tx>
      <c:val><c:numRef><c:f>Sheet1!$C$1</c:f><c:numCache>
        <c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>123456789</c:v></c:pt>
      </c:numCache></c:numRef></c:val>
    </c:ser></c:barChart></c:plotArea>
  </c:chart>
</c:chartSpace>`;
}

export function fullDiagramData(): string {
  return `${xmlDeclaration()}
<dgm:dataModel xmlns:dgm="${DGM_NS}" xmlns:a="${A_NS}">
  <dgm:ptLst><dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>+7 916 123-45-67</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst>
</dgm:dataModel>`;
}

export function fullCustomXmlItem(): string {
  return `${xmlDeclaration()}
<root>
  <name>Иванов Иван Иванович</name>
  <email>ivan@example.ru</email>
  <phone>+7 916 123-45-67</phone>
</root>`;
}

export function fullCustomXmlProps(): string {
  return `${xmlDeclaration()}
<ds:datastoreItem xmlns:ds="${DS_NS}" ds:itemID="{11111111-1111-1111-1111-111111111111}">
  <ds:itemName>Иванов Иван Иванович</ds:itemName>
  <ds:schemaRefs/>
</ds:datastoreItem>`;
}

export function fullCoreProps(): string {
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
  <cp:lastPrinted>2024-03-03T00:00:00Z</cp:lastPrinted>
</cp:coreProperties>`;
}

export function fullAppProps(): string {
  return `${xmlDeclaration()}
<Properties xmlns="${EP_NS}" xmlns:vt="${VT_NS}">
  <Application>DocsMasked Test</Application>
  <Company>ООО Ромашка</Company>
  <Manager>Иванов Иван Иванович</Manager>
  <Template>Normal.dotm</Template>
  <HyperlinkBase>https://example.ru/ivan</HyperlinkBase>
  <Pages>1</Pages>
</Properties>`;
}

export function fullCustomProps(): string {
  return `${xmlDeclaration()}
<Properties xmlns="${CUSTOM_NS}" xmlns:vt="${VT_NS}">
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Клиент">
    <vt:lpwstr>Иванов Иван Иванович</vt:lpwstr>
  </property>
</Properties>`;
}

export function fullThumbnail(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

export function fullImage(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

export function fullEmbedding(): Uint8Array {
  return encoder.encode('OLE-COMPOUND-FILE-PLACEHOLDER');
}

export function fullSignature(): string {
  return `${xmlDeclaration()}
<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature>`;
}

export function fullDocxParts(): FixtureParts {
  return {
    '[Content_Types].xml': bytesOf(fullContentTypes()),
    '_rels/.rels': bytesOf(fullRootRels()),
    'word/document.xml': bytesOf(documentXml(fullDocumentBody(), fullSectPr())),
    'word/styles.xml': bytesOf(minimalStyles()),
    'word/_rels/document.xml.rels': bytesOf(fullDocumentRels()),
    'word/header1.xml': bytesOf(fullHeader()),
    'word/footer1.xml': bytesOf(fullFooter()),
    'word/footnotes.xml': bytesOf(fullFootnotes()),
    'word/endnotes.xml': bytesOf(fullEndnotes()),
    'word/comments.xml': bytesOf(fullComments()),
    'word/_rels/comments.xml.rels': bytesOf(fullCommentsRels()),
    'word/commentsExtended.xml': bytesOf(fullCommentsExtended()),
    'word/commentsIds.xml': bytesOf(fullCommentsIds()),
    'word/commentsExtensible.xml': bytesOf(fullCommentsExtensible()),
    'word/people.xml': bytesOf(fullPeople()),
    'word/settings.xml': bytesOf(fullSettings()),
    'word/_rels/settings.xml.rels': bytesOf(fullSettingsRels()),
    'word/glossary/document.xml': bytesOf(fullGlossary()),
    'word/charts/chart1.xml': bytesOf(fullChart()),
    'word/diagrams/data1.xml': bytesOf(fullDiagramData()),
    'customXml/item1.xml': bytesOf(fullCustomXmlItem()),
    'customXml/itemProps1.xml': bytesOf(fullCustomXmlProps()),
    'customXml/_rels/item1.xml.rels': bytesOf(fullCustomXmlRels()),
    'docProps/core.xml': bytesOf(fullCoreProps()),
    'docProps/app.xml': bytesOf(fullAppProps()),
    'docProps/custom.xml': bytesOf(fullCustomProps()),
    'docProps/thumbnail.jpeg': fullThumbnail(),
    'word/media/image1.png': fullImage(),
    'word/embeddings/oleObject1.bin': fullEmbedding(),
    '_xmlsignatures/sig1.xml': bytesOf(fullSignature()),
  };
}

export function fullDocx(): Uint8Array {
  return buildDocx(fullDocxParts());
}
