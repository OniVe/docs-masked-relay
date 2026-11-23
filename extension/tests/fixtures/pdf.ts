/**
 * PDF fixtures (M5a), generated with pdf-lib so they are reproducible in
 * Node and in the extension e2e (pdf-lib is a runtime dependency of the
 * adapter, so tests may use it).
 */

import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  rgb,
  StandardFonts,
} from 'pdf-lib';

export const PDF_PERSON = 'Mr John Smith';
export const PDF_EMAIL = 'john@example.com';
export const PDF_PHONE = '+1 555 123 4567';
export const PDF_PUBLIC = 'Public sentence stays here.';

/** 1x1 opaque PNG; enough to make an image-only page with no text layer. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

/** Born-digital one-page PDF carrying a person, email, phone and public text. */
export async function samplePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle('Personnel record');
  document.setAuthor(PDF_PERSON);
  document.setSubject(PDF_EMAIL);
  document.setKeywords(['personnel', PDF_PHONE]);
  document.setCreator('DocsMasked fixture creator');
  document.setProducer('DocsMasked fixture producer');

  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);

  page.drawText('PERSONNEL RECORD', { x: 72, y: 720, size: 16, font });
  page.drawText(PDF_PERSON, { x: 72, y: 690, size: 12, font });
  page.drawText(PDF_EMAIL, { x: 72, y: 670, size: 12, font });
  page.drawText(PDF_PHONE, { x: 72, y: 650, size: 12, font });
  page.drawText(PDF_PUBLIC, { x: 72, y: 630, size: 12, font });

  return document.save();
}

/** Image-only page: PDFium reports `charCount === 0`, our scan fail-closed path. */
export async function scannedPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 200]);
  const image = await document.embedPng(Buffer.from(TINY_PNG_BASE64, 'base64'));
  page.drawImage(image, { x: 50, y: 50, width: 200, height: 100 });
  page.drawRectangle({ x: 0, y: 0, width: 300, height: 200, borderColor: rgb(0, 0, 0) });
  return document.save();
}

/** Minimal multi-page PDF for the page-count limit (no text needed). */
export async function pdfWithPages(count: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) {
    document.addPage([200, 200]);
  }
  return document.save();
}

/**
 * A PDF with the same PII on two pages, used to prove every page is processed
 * (not just the first).
 */
export async function twoPagePiiPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, value] of [PDF_PERSON, PDF_EMAIL].entries()) {
    const page = document.addPage([400, 300]);
    page.drawText(value, { x: 40, y: 200, size: 14, font });
    page.drawText(PDF_PUBLIC, { x: 40, y: 170, size: 12, font });
    page.drawText(`Page ${index + 1}`, { x: 40, y: 250, size: 10, font });
  }
  return document.save();
}

/**
 * PII carriers that the first sanitizer revision missed: page-level XMP,
 * PieceInfo private data, page /AF, a Widget/field /V (Name) and a FreeText
 * /AP appearance stream. All values are synthetic.
 */
export const PDF_CARRIER_MARKERS = {
  email: 'carrier.email@example.test',
  card: '4111111111111111',
  person: 'Иванов Иван Иванович',
  phone: '+7 999 123-45-67',
} as const;

export const PDF_METADATA_MARKERS = {
  infoTitle: 'SECRET_INFO_TITLE_MARKER',
  infoAuthor: 'SECRET_INFO_AUTHOR_MARKER',
  xmp: 'SECRET_XMP_MARKER',
  attachment: 'SECRET_ATTACHMENT_MARKER',
  annotationContents: 'SECRET_ANNOT_CONTENTS_MARKER',
  annotationAuthor: 'SECRET_ANNOT_AUTHOR_MARKER',
} as const;

/**
 * Metadata torture fixture: Info, XMP, a document-level attachment name tree
 * and annotation text. `useObjectStreams:false` keeps the markers visible to a
 * raw byte scan, so the sanitizer test proves the objects are actually gone
 * rather than merely unreferenced.
 */
export async function metadataTrapPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(PDF_METADATA_MARKERS.infoTitle);
  document.setAuthor(PDF_METADATA_MARKERS.infoAuthor);
  document.setSubject(PDF_METADATA_MARKERS.infoAuthor);

  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([400, 300]);
  page.drawText(PDF_PUBLIC, { x: 40, y: 200, size: 12, font });

  const annotation = document.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [10, 10, 30, 30],
    Contents: PDFString.of(PDF_METADATA_MARKERS.annotationContents),
    T: PDFString.of(PDF_METADATA_MARKERS.annotationAuthor),
  });
  const annotationRef = document.context.register(annotation);
  page.node.set(PDFName.of('Annots'), document.context.obj([annotationRef]));

  const xmpRef = document.context.register(
    PDFRawStream.of(
      document.context.obj({ Type: 'Metadata', Subtype: 'XML' }),
      new TextEncoder().encode(`<x:xmpmeta>${PDF_METADATA_MARKERS.xmp}</x:xmpmeta>`),
    ),
  );
  document.catalog.set(PDFName.of('Metadata'), xmpRef);

  const attachmentRef = document.context.register(
    PDFRawStream.of(
      document.context.obj({ Type: 'EmbeddedFile' }),
      new TextEncoder().encode(PDF_METADATA_MARKERS.attachment),
    ),
  );
  const fileSpec = document.context.obj({
    Type: 'Filespec',
    F: 'secret.txt',
    EF: { F: attachmentRef },
  });
  document.catalog.set(
    PDFName.of('Names'),
    document.context.obj({ EmbeddedFiles: { Names: ['secret.txt', fileSpec] } }),
  );

  return document.save({ useObjectStreams: false });
}

/**
 * Page-level carrier fixture: a Widget/field /V, a FreeText /AP stream, page
 * /Metadata, /PieceInfo and /AF. `useObjectStreams:false` keeps the marker
 * bytes visible to the raw scan, so removal is proven structurally.
 */
export async function carrierTrapPdf(options: { withTextPii?: boolean } = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const context = document.context;
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([420, 320]);
  page.drawText(PDF_PUBLIC, { x: 40, y: 250, size: 12, font });
  if (options.withTextPii) {
    page.drawText(PDF_CARRIER_MARKERS.email, { x: 40, y: 220, size: 12, font });
  }

  const pageXmpRef = context.register(
    PDFRawStream.of(
      context.obj({ Type: 'Metadata', Subtype: 'XML' }),
      new TextEncoder().encode(
        `<x:xmpmeta><dc:creator>${PDF_CARRIER_MARKERS.email}</dc:creator></x:xmpmeta>`,
      ),
    ),
  );
  page.node.set(PDFName.of('Metadata'), pageXmpRef);

  page.node.set(
    PDFName.of('PieceInfo'),
    context.obj({
      DocsMasked: context.obj({ Private: PDFString.of(PDF_CARRIER_MARKERS.card) }),
    }),
  );

  const pageAfRef = context.register(
    PDFRawStream.of(
      context.obj({ Type: 'EmbeddedFile' }),
      new TextEncoder().encode(PDF_CARRIER_MARKERS.phone),
    ),
  );
  page.node.set(
    PDFName.of('AF'),
    context.obj([
      context.obj({ Type: 'Filespec', F: 'carrier.txt', EF: context.obj({ F: pageAfRef }) }),
    ]),
  );

  const appearanceRef = context.register(
    PDFRawStream.of(
      context.obj({
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 50],
        Resources: context.obj({}),
      }),
      new TextEncoder().encode(PDF_CARRIER_MARKERS.person),
    ),
  );
  const freeTextRef = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: [40, 150, 240, 200],
      Contents: PDFString.of('note'),
      AP: context.obj({ N: appearanceRef }),
    }),
  );

  const fieldRef = context.register(
    context.obj({
      FT: 'Tx',
      T: 'person',
      V: PDFString.of(PDF_CARRIER_MARKERS.person),
      DV: PDFString.of(PDF_CARRIER_MARKERS.person),
    }),
  );
  const widgetRef = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [40, 100, 240, 140],
      Parent: fieldRef,
      V: PDFString.of(PDF_CARRIER_MARKERS.person),
    }),
  );
  page.node.set(PDFName.of('Annots'), context.obj([freeTextRef, widgetRef]));
  document.catalog.set(
    PDFName.of('AcroForm'),
    context.obj({ Fields: [fieldRef], DA: '/Helv 0 Tf 0 g' }),
  );

  return document.save({ useObjectStreams: false });
}

/**
 * Nested carrier fixture (R4): XMP on an image XObject, a Form XObject, the
 * embedded font and a tiling pattern, plus nested PieceInfo/AF/AA. The page
 * text layer only contains public text and one email, so the nested markers
 * are invisible to the text detectors and can only be removed structurally.
 * `useObjectStreams:false` keeps markers visible to a raw byte scan.
 */
export const PDF_NESTED_MARKERS = {
  image: 'nested.image.xmp@example.test',
  form: 'nested.form.xmp@example.test',
  font: 'nested.font.xmp@example.test',
  pattern: 'nested.pattern.xmp@example.test',
} as const;

export async function nestedCarrierTrapPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const context = document.context;
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([420, 320]);
  page.drawText(PDF_PUBLIC, { x: 40, y: 260, size: 12, font });
  page.drawText(PDF_CARRIER_MARKERS.email, { x: 40, y: 230, size: 12, font });

  const metadataStream = (marker: string) =>
    context.register(
      PDFRawStream.of(
        context.obj({ Type: 'Metadata', Subtype: 'XML' }),
        new TextEncoder().encode(`<x:xmpmeta>${marker}</x:xmpmeta>`),
      ),
    );

  const imageXmp = metadataStream(PDF_NESTED_MARKERS.image);
  const formXmp = metadataStream(PDF_NESTED_MARKERS.form);
  const fontXmp = metadataStream(PDF_NESTED_MARKERS.font);
  const patternXmp = metadataStream(PDF_NESTED_MARKERS.pattern);

  const image = await document.embedPng(Buffer.from(TINY_PNG_BASE64, 'base64'));
  const imageDict = context.lookupMaybe(image.ref, PDFDict);
  imageDict?.set(PDFName.of('Metadata'), imageXmp);
  imageDict?.set(
    PDFName.of('PieceInfo'),
    context.obj({ DocsMasked: context.obj({ Private: PDFString.of(PDF_CARRIER_MARKERS.card) }) }),
  );
  page.drawImage(image, { x: 40, y: 40, width: 60, height: 60 });

  const fontDict = context.lookupMaybe(font.ref, PDFDict);
  fontDict?.set(PDFName.of('Metadata'), fontXmp);

  const formRef = context.register(
    PDFRawStream.of(
      context.obj({
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 20, 20],
        Resources: context.obj({}),
        Metadata: formXmp,
        AA: context.obj({ O: context.obj({ S: 'JavaScript', JS: 'app.alert(1)' }) }),
      }),
      new TextEncoder().encode('0 0 20 20 re f'),
    ),
  );
  page.node.setXObject(PDFName.of('Fm0'), formRef);
  const formUse = context.register(
    PDFRawStream.of(context.obj({}), new TextEncoder().encode('q 1 0 0 1 140 60 cm /Fm0 Do Q')),
  );
  page.node.addContentStream(formUse);

  const attachmentRef = context.register(
    PDFRawStream.of(
      context.obj({ Type: 'EmbeddedFile' }),
      new TextEncoder().encode(PDF_CARRIER_MARKERS.phone),
    ),
  );
  const patternRef = context.register(
    PDFRawStream.of(
      context.obj({
        Type: 'Pattern',
        PatternType: 1,
        PaintType: 1,
        TilingType: 1,
        BBox: [0, 0, 10, 10],
        XStep: 10,
        YStep: 10,
        Resources: context.obj({}),
        Metadata: patternXmp,
        AF: context.obj([
          context.obj({ Type: 'Filespec', F: 'nested.txt', EF: context.obj({ F: attachmentRef }) }),
        ]),
      }),
      new TextEncoder().encode('0 0 10 10 re f'),
    ),
  );
  const resources = page.node.Resources();
  resources?.set(PDFName.of('Pattern'), context.obj({ P0: patternRef }));

  // pdf-lib normalization adds an empty page /Annots; remove it so this
  // fixture isolates the *nested* carrier check (page/catalog are clean).
  page.node.delete(PDFName.of('Annots'));

  return document.save({ useObjectStreams: false });
}
