/**
 * Byte-level OOXML XML scanner.
 *
 * The scanner deliberately does not use DOMParser/XMLSerializer: those drop
 * namespace prefixes referenced by `mc:Ignorable`, reorder attributes and can
 * change entity/self-closing spelling. Instead the raw decoded string is
 * tokenized with offsets, so edits splice the original bytes only where a text
 * node or attribute value lives. `saxes` is used as an independent strict
 * well-formedness check, never as a serializer.
 *
 * Supported encodings match what OPC producers emit: UTF-8, UTF-16LE and
 * UTF-16BE, with or without a BOM. DTD/DOCTYPE and non-predefined entities are
 * rejected (OPC forbids DTDs; this also closes XXE / billion-laughs).
 */

import { SaxesParser } from 'saxes';

export type XmlEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export interface DecodedXml {
  text: string;
  encoding: XmlEncoding;
  /** Source started with a byte-order mark. */
  bom: boolean;
}

export interface XmlAttribute {
  qname: string;
  prefix: string;
  local: string;
  /** Namespace URI; empty string for unqualified attributes. */
  ns: string;
  /** Entity-decoded value. */
  value: string;
  /** Offset of the first character inside the quotes. */
  valueStart: number;
  /** Offset just past the last character inside the quotes. */
  valueEnd: number;
  quote: '"' | "'";
}

export type XmlTextKind = 'text' | 'cdata';

export interface XmlTextNode {
  /** Raw content offset (inside the owning element). */
  start: number;
  /** Raw content end, exclusive. */
  end: number;
  raw: string;
  /** Entity-decoded text (`raw` itself for CDATA). */
  text: string;
  path: string;
  /** Namespace URI of the owning element. */
  ns: string;
  /** Local name of the owning element. */
  local: string;
  qname: string;
  /** Attribute map of the owning element, by qualified name. */
  attrs: Record<string, string>;
  element: XmlElement;
  kind: XmlTextKind;
  /**
   * Decoded-boundary -> raw-boundary map. Present only when the raw content
   * contains entity/character references; `undefined` means identity.
   */
  decodedToRaw?: number[];
}

export interface XmlElement {
  qname: string;
  prefix: string;
  local: string;
  /** Resolved namespace URI; empty string when unqualified. */
  ns: string;
  attrs: XmlAttribute[];
  attrMap: Map<string, XmlAttribute>;
  parent: XmlElement | null;
  children: XmlElement[];
  textNodes: XmlTextNode[];
  /** Offset of the opening `<`. */
  start: number;
  /** Offset just past the closing `>` of the end tag (or of the start tag). */
  end: number;
  /** Offset just past the start tag's `>`. */
  startTagEnd: number;
  /** Offset where an extra attribute can be inserted (after the last attribute). */
  insertAt: number;
  selfClosing: boolean;
  path: string;
}

export type XmlToken =
  | {
      kind: 'start';
      start: number;
      end: number;
      qname: string;
      selfClosing: boolean;
      /** Attribute qualified names in source order. */
      attrs: string[];
    }
  | { kind: 'end'; start: number; end: number; qname: string }
  | { kind: 'text'; start: number; end: number }
  | { kind: 'cdata'; start: number; end: number }
  | { kind: 'comment'; start: number; end: number }
  | { kind: 'pi'; start: number; end: number; target: string };

export interface XmlScan {
  text: string;
  encoding: XmlEncoding;
  bom: boolean;
  root: XmlElement;
  elements: XmlElement[];
  textNodes: XmlTextNode[];
  tokens: XmlToken[];
}

export interface XmlEdit {
  start: number;
  end: number;
  /** Replacement text; callers that need escaping should use `escapeXmlText`. */
  text: string;
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isNameTerminator(code: number): boolean {
  return (
    isWhitespaceCode(code) ||
    code === 0x2f || // /
    code === 0x3e || // >
    code === 0x3d || // =
    code === 0x3c || // <
    code === 0x22 || // "
    code === 0x27 || // '
    code === 0x26 || // &
    code === 0x3b || // ;
    code === 0x21 || // !
    code === 0x3f // ?
  );
}

function isValidXmlCharCodePoint(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
  if (code < 0x20) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (code === 0xfffe || code === 0xffff) return false;
  return code <= 0x10ffff;
}

export function assertValidXmlChars(text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      throw new XmlError(`Invalid XML character at offset ${i}: lone high surrogate`);
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new XmlError(`Invalid XML character at offset ${i}: lone low surrogate`);
    }
    if (!isValidXmlCharCodePoint(code)) {
      throw new XmlError(
        `Invalid XML character U+${code.toString(16).toUpperCase().padStart(4, '0')} at offset ${i}`,
      );
    }
  }
}

function splitQName(qname: string, offset: number): { prefix: string; local: string } {
  const colon = qname.indexOf(':');
  if (colon === -1) return { prefix: '', local: qname };
  if (colon === 0 || colon === qname.length - 1 || qname.indexOf(':', colon + 1) !== -1) {
    throw new XmlError(`Invalid qualified name "${qname}" at offset ${offset}`);
  }
  return { prefix: qname.slice(0, colon), local: qname.slice(colon + 1) };
}

function assertNameToken(name: string, offset: number): void {
  if (name.length === 0) throw new XmlError(`Empty name at offset ${offset}`);
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (isNameTerminator(code) || code <= 0x20) {
      throw new XmlError(`Invalid name "${name}" at offset ${offset}`);
    }
  }
}

function decodeXmlEntity(ref: string, offset: number): string {
  if (ref.startsWith('#')) {
    const hex = ref.startsWith('#x');
    const digits = hex ? ref.slice(2) : ref.slice(1);
    if (digits.length === 0 || !(hex ? /^[0-9A-Fa-f]+$/u : /^[0-9]+$/u).test(digits)) {
      throw new XmlError(`Invalid character reference "&${ref};" at offset ${offset}`);
    }
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (!isValidXmlCharCodePoint(code)) {
      throw new XmlError(`Invalid character reference "&${ref};" at offset ${offset}`);
    }
    return String.fromCodePoint(code);
  }

  const value = NAMED_ENTITIES.get(ref);
  if (value === undefined) {
    throw new XmlError(`Unknown entity "&${ref};" at offset ${offset}`);
  }
  return value;
}

interface DecodedText {
  text: string;
  decodedToRaw?: number[];
}

function decodeXmlText(raw: string): DecodedText {
  if (raw.indexOf('&') === -1) {
    return { text: raw };
  }

  let text = '';
  const decodedToRaw: number[] = [0];

  for (let i = 0; i < raw.length; ) {
    const code = raw.charCodeAt(i);
    if (code !== 0x26) {
      text += raw[i];
      i += 1;
      decodedToRaw.push(i);
      continue;
    }

    const semicolon = raw.indexOf(';', i + 1);
    if (semicolon === -1) {
      throw new XmlError(`Unterminated entity reference at offset ${i}`);
    }
    const value = decodeXmlEntity(raw.slice(i + 1, semicolon), i);
    const end = semicolon + 1;
    text += value;
    // Character references map every emitted code unit to the end of the raw
    // reference. A boundary inside a surrogate pair is never used (splitting a
    // surrogate pair is rejected), so the duplicate entries are harmless.
    for (let k = 0; k < value.length; k += 1) decodedToRaw.push(end);
    i = end;
  }

  assertValidXmlChars(text);
  return { text, decodedToRaw };
}

function decodeCdata(raw: string): DecodedText {
  return { text: raw };
}

function decodeWith(bytes: Uint8Array, encoding: XmlEncoding): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new XmlError(`XML part is not valid ${encoding}`);
  }
}

function declarationEncoding(text: string): string | undefined {
  const match = /^\s*<\?xml\b[^>]*\bencoding\s*=\s*(['"])([^'"]+)\1/u.exec(text);
  return match?.[2]?.toLowerCase();
}

function checkDeclaredEncoding(text: string, encoding: XmlEncoding): void {
  const declared = declarationEncoding(text);
  if (declared === undefined) return;

  const normalized = declared.replace(/_/gu, '-');
  const allowed =
    encoding === 'utf-8'
      ? normalized === 'utf-8' || normalized === 'utf8'
      : normalized === 'utf-16' ||
        normalized === 'utf16' ||
        normalized === encoding ||
        (encoding === 'utf-16le' && normalized === 'utf-16le') ||
        (encoding === 'utf-16be' && normalized === 'utf-16be');

  if (!allowed) {
    throw new XmlError(`XML declares unsupported encoding "${declared}" (detected ${encoding})`);
  }
}

/** Detects the encoding and decodes the BOM-stripped document text. */
export function decodeXml(bytes: Uint8Array): DecodedXml {
  if (bytes.length === 0) throw new XmlError('Empty XML part');

  let encoding: XmlEncoding = 'utf-8';
  let bom = false;
  let offset = 0;

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8';
    bom = true;
    offset = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    bom = true;
    offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    bom = true;
    offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0x3c && bytes[1] === 0x00) {
    encoding = 'utf-16le';
  } else if (bytes.length >= 2 && bytes[0] === 0x00 && bytes[1] === 0x3c) {
    encoding = 'utf-16be';
  }

  const text = decodeWith(bytes.subarray(offset), encoding);
  assertValidXmlChars(text);
  checkDeclaredEncoding(text, encoding);
  return { text, encoding, bom };
}

function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const offset = i * 2;
    if (littleEndian) {
      out[offset] = code & 0xff;
      out[offset + 1] = code >>> 8;
    } else {
      out[offset] = code >>> 8;
      out[offset + 1] = code & 0xff;
    }
  }
  return out;
}

/** Re-encodes decoded text exactly like the source (BOM included). */
export function encodeXml(text: string, encoding: XmlEncoding, bom = false): Uint8Array {
  assertValidXmlChars(text);

  if (encoding === 'utf-8') {
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
  }

  const body = encodeUtf16(text, encoding === 'utf-16le');
  if (!bom) return body;
  const out = new Uint8Array(body.length + 2);
  out.set(encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff], 0);
  out.set(body, 2);
  return out;
}

function resolvePrefix(prefix: string, nsMap: ReadonlyMap<string, string>, offset: number): string {
  const uri = nsMap.get(prefix);
  if (uri === undefined) {
    throw new XmlError(`Undeclared namespace prefix "${prefix}" at offset ${offset}`);
  }
  return uri;
}

function attrsRecord(element: XmlElement): Record<string, string> {
  const record: Record<string, string> = Object.create(null);
  for (const attr of element.attrs) record[attr.qname] = attr.value;
  return record;
}

/** Scans a decoded XML document into elements, text nodes and tokens. */
export function scanXml(text: string, encoding: XmlEncoding = 'utf-8', bom = false): XmlScan {
  assertValidXmlChars(text);

  const elements: XmlElement[] = [];
  const textNodes: XmlTextNode[] = [];
  const tokens: XmlToken[] = [];
  const stack: XmlElement[] = [];
  const childCounts = new Map<XmlElement, Map<string, number>>();
  const nsStack: Map<string, string>[] = [
    new Map<string, string>([
      ['xml', XML_NS],
      ['', ''],
    ]),
  ];
  let root: XmlElement | null = null;
  let i = 0;

  const currentParent = (): XmlElement | null =>
    stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
  const currentNsMap = (): ReadonlyMap<string, string> =>
    nsStack[nsStack.length - 1] ?? (nsStack[0] as Map<string, string>);

  const addText = (start: number, end: number, kind: XmlTextKind): void => {
    const parent = currentParent();
    if (parent === null) {
      if (kind !== 'text' || text.slice(start, end).trim().length > 0) {
        throw new XmlError(`Text outside the root element at offset ${start}`);
      }
      return;
    }

    const raw = text.slice(start, end);
    if (raw.includes(']]>')) {
      throw new XmlError(`"]]>" is not allowed in text at offset ${start}`);
    }
    const decoded = kind === 'cdata' ? decodeCdata(raw) : decodeXmlText(raw);

    const node: XmlTextNode = {
      start,
      end,
      raw,
      text: decoded.text,
      path: parent.path,
      ns: parent.ns,
      local: parent.local,
      qname: parent.qname,
      attrs: attrsRecord(parent),
      element: parent,
      kind,
      decodedToRaw: decoded.decodedToRaw,
    };
    textNodes.push(node);
    parent.textNodes.push(node);
    tokens.push(kind === 'cdata' ? { kind: 'cdata', start, end } : { kind: 'text', start, end });
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      addText(i, text.length, 'text');
      i = text.length;
      break;
    }
    if (lt > i) addText(i, lt, 'text');
    i = lt;

    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      if (close === -1) throw new XmlError(`Unterminated comment at offset ${i}`);
      tokens.push({ kind: 'comment', start: i, end: close + 3 });
      i = close + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', i)) {
      if (currentParent() === null) {
        throw new XmlError(`CDATA outside the root element at offset ${i}`);
      }
      const close = text.indexOf(']]>', i + 9);
      if (close === -1) throw new XmlError(`Unterminated CDATA section at offset ${i}`);
      addText(i + 9, close, 'cdata');
      i = close + 3;
      continue;
    }

    if (text.startsWith('<?', i)) {
      const close = text.indexOf('?>', i + 2);
      if (close === -1) throw new XmlError(`Unterminated processing instruction at offset ${i}`);
      let targetEnd = i + 2;
      while (targetEnd < close && !isWhitespaceCode(text.charCodeAt(targetEnd))) targetEnd += 1;
      const target = text.slice(i + 2, targetEnd);
      if (target.length === 0) {
        throw new XmlError(`Empty processing instruction target at offset ${i}`);
      }
      tokens.push({ kind: 'pi', start: i, end: close + 2, target });
      i = close + 2;
      continue;
    }

    if (text.startsWith('</', i)) {
      const tagStart = i;
      i += 2;
      const nameStart = i;
      while (
        i < text.length &&
        !isWhitespaceCode(text.charCodeAt(i)) &&
        text.charCodeAt(i) !== 0x3e
      ) {
        i += 1;
      }
      const qname = text.slice(nameStart, i);
      assertNameToken(qname, nameStart);
      while (i < text.length && isWhitespaceCode(text.charCodeAt(i))) i += 1;
      if (text.charCodeAt(i) !== 0x3e) {
        throw new XmlError(`Malformed end tag at offset ${tagStart}`);
      }
      i += 1;

      const open = stack.pop();
      if (open === undefined) {
        throw new XmlError(`Unexpected end tag </${qname}> at offset ${tagStart}`);
      }
      if (open.qname !== qname) {
        throw new XmlError(
          `Mismatched end tag </${qname}> at offset ${tagStart}; expected </${open.qname}>`,
        );
      }
      open.end = i;
      nsStack.pop();
      tokens.push({ kind: 'end', start: tagStart, end: i, qname });
      continue;
    }

    if (text.startsWith('<!', i)) {
      throw new XmlError(`DOCTYPE/DTD and declarations are not allowed at offset ${i}`);
    }

    // Start tag.
    const tagStart = i;
    i += 1;
    const nameStart = i;
    while (i < text.length && !isNameTerminator(text.charCodeAt(i))) i += 1;
    const qname = text.slice(nameStart, i);
    assertNameToken(qname, nameStart);
    const { prefix, local } = splitQName(qname, nameStart);

    interface RawAttribute {
      qname: string;
      prefix: string;
      local: string;
      value: string;
      valueStart: number;
      valueEnd: number;
      quote: '"' | "'";
      offset: number;
    }

    const rawAttrs: RawAttribute[] = [];
    let lastAttrEnd = i;
    let selfClosing = false;

    while (true) {
      const whitespaceStart = i;
      while (i < text.length && isWhitespaceCode(text.charCodeAt(i))) i += 1;
      const hadWhitespace = i > whitespaceStart;

      if (i >= text.length) throw new XmlError(`Unterminated start tag at offset ${tagStart}`);
      const code = text.charCodeAt(i);

      if (code === 0x3e) {
        i += 1;
        break;
      }
      if (code === 0x2f) {
        if (text.charCodeAt(i + 1) !== 0x3e) {
          throw new XmlError(`Malformed self-closing tag at offset ${tagStart}`);
        }
        i += 2;
        selfClosing = true;
        break;
      }
      if (!hadWhitespace) {
        throw new XmlError(`Expected whitespace before attribute at offset ${i}`);
      }

      const attrStart = i;
      while (i < text.length && !isNameTerminator(text.charCodeAt(i))) i += 1;
      const attrQName = text.slice(attrStart, i);
      assertNameToken(attrQName, attrStart);
      const attrName = splitQName(attrQName, attrStart);

      while (i < text.length && isWhitespaceCode(text.charCodeAt(i))) i += 1;
      if (text.charCodeAt(i) !== 0x3d) {
        throw new XmlError(`Expected "=" after attribute "${attrQName}" at offset ${i}`);
      }
      i += 1;
      while (i < text.length && isWhitespaceCode(text.charCodeAt(i))) i += 1;

      const quoteCode = text.charCodeAt(i);
      if (quoteCode !== 0x22 && quoteCode !== 0x27) {
        throw new XmlError(`Unquoted attribute "${attrQName}" at offset ${attrStart}`);
      }
      const quote = quoteCode === 0x22 ? '"' : "'";
      const valueStart = i + 1;
      const valueEnd = text.indexOf(quote, valueStart);
      if (valueEnd === -1) {
        throw new XmlError(`Unterminated attribute "${attrQName}" at offset ${attrStart}`);
      }
      const rawValue = text.slice(valueStart, valueEnd);
      if (rawValue.includes('<')) {
        throw new XmlError(`"<" is not allowed in attribute "${attrQName}" at offset ${attrStart}`);
      }
      const decoded = decodeXmlText(rawValue);
      rawAttrs.push({
        qname: attrQName,
        prefix: attrName.prefix,
        local: attrName.local,
        value: decoded.text,
        valueStart,
        valueEnd,
        quote,
        offset: attrStart,
      });
      i = valueEnd + 1;
      lastAttrEnd = i;
    }

    const startTagEnd = i;
    const nsMap = new Map<string, string>(currentNsMap());

    for (const attr of rawAttrs) {
      if (attr.qname === 'xmlns' || attr.prefix === 'xmlns') {
        const declaredPrefix = attr.qname === 'xmlns' ? '' : attr.local;
        if (declaredPrefix === 'xmlns') {
          throw new XmlError(`The xmlns prefix cannot be declared at offset ${attr.offset}`);
        }
        if (declaredPrefix === 'xml' && attr.value !== XML_NS) {
          throw new XmlError(`The xml prefix must map to ${XML_NS}`);
        }
        if (declaredPrefix !== '' && attr.value.length === 0) {
          throw new XmlError(`Namespace prefix "${declaredPrefix}" cannot be undeclared`);
        }
        nsMap.set(declaredPrefix, attr.value);
      }
    }

    const ns = prefix.length > 0 ? resolvePrefix(prefix, nsMap, nameStart) : (nsMap.get('') ?? '');
    const attrs: XmlAttribute[] = [];
    const attrMap = new Map<string, XmlAttribute>();

    for (const attr of rawAttrs) {
      if (attrMap.has(attr.qname)) {
        throw new XmlError(`Duplicate attribute "${attr.qname}" at offset ${attr.offset}`);
      }
      const attrNs =
        attr.qname === 'xmlns' || attr.prefix === 'xmlns'
          ? XMLNS_NS
          : attr.prefix.length > 0
            ? resolvePrefix(attr.prefix, nsMap, attr.offset)
            : '';
      const attribute: XmlAttribute = {
        qname: attr.qname,
        prefix: attr.prefix,
        local: attr.local,
        ns: attrNs,
        value: attr.value,
        valueStart: attr.valueStart,
        valueEnd: attr.valueEnd,
        quote: attr.quote,
      };
      attrs.push(attribute);
      attrMap.set(attribute.qname, attribute);
    }

    const parent = currentParent();
    if (parent === null && root !== null) {
      throw new XmlError(`Multiple root elements at offset ${tagStart}`);
    }

    let ordinal = 1;
    if (parent) {
      let counts = childCounts.get(parent);
      if (!counts) {
        counts = new Map<string, number>();
        childCounts.set(parent, counts);
      }
      ordinal = (counts.get(qname) ?? 0) + 1;
      counts.set(qname, ordinal);
    }
    const path = parent ? `${parent.path}/${qname}[${ordinal}]` : `/${qname}[${ordinal}]`;

    const element: XmlElement = {
      qname,
      prefix,
      local,
      ns,
      attrs,
      attrMap,
      parent,
      children: [],
      textNodes: [],
      start: tagStart,
      end: selfClosing ? startTagEnd : -1,
      startTagEnd,
      insertAt: lastAttrEnd,
      selfClosing,
      path,
    };

    if (parent) parent.children.push(element);
    else root = element;
    elements.push(element);

    if (!selfClosing) {
      stack.push(element);
      nsStack.push(nsMap);
    }

    tokens.push({
      kind: 'start',
      start: tagStart,
      end: startTagEnd,
      qname,
      selfClosing,
      attrs: attrs.map((attr) => attr.qname),
    });
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    throw new XmlError(`Unclosed element <${open?.qname ?? '?'}> at offset ${open?.start ?? 0}`);
  }
  if (root === null) throw new XmlError('XML document has no root element');

  return { text, encoding, bom, root, elements, textNodes, tokens };
}

/** Strict well-formedness check with saxes (namespaces enabled). */
export function validateXmlText(text: string, fileName?: string): void {
  assertValidXmlChars(text);
  try {
    const parser = new SaxesParser({ xmlns: true, position: false, fileName });
    parser.write(text).close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new XmlError(`XML is not well-formed${fileName ? ` (${fileName})` : ''}: ${message}`);
  }
}

/** Decodes, rejects DTDs and validates the part with saxes. */
export function validateXml(bytes: Uint8Array, fileName?: string): void {
  const decoded = decodeXml(bytes);
  scanXml(decoded.text, decoded.encoding, decoded.bom);
  validateXmlText(decoded.text, fileName);
}

/** Maps a decoded offset inside a text node back to its raw content offset. */
export function rawOffsetInTextNode(node: XmlTextNode, decodedOffset: number): number {
  if (decodedOffset < 0 || decodedOffset > node.text.length) {
    throw new XmlError(`Decoded offset ${decodedOffset} is outside a text node`);
  }
  if (!node.decodedToRaw) return decodedOffset;
  const raw = node.decodedToRaw[decodedOffset];
  if (raw === undefined) {
    throw new XmlError(`Decoded offset ${decodedOffset} has no raw mapping`);
  }
  return raw;
}

/** Escapes text content for insertion between tags. */
export function escapeXmlText(value: string): string {
  assertValidXmlChars(value);
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** Escapes an attribute value (double-quoted form). */
export function escapeXmlAttribute(value: string): string {
  assertValidXmlChars(value);
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function assertCodeUnitBoundary(text: string, offset: number): void {
  if (offset <= 0 || offset >= text.length) return;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    throw new XmlError(`Edit boundary at offset ${offset} splits a surrogate pair`);
  }
}

/** Applies non-overlapping raw splices right-to-left. */
export function applyXmlEdits(xml: string, edits: readonly XmlEdit[]): string {
  if (edits.length === 0) return xml;

  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0;
  for (const edit of sorted) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > xml.length
    ) {
      throw new XmlError(`Invalid XML edit range ${edit.start}..${edit.end}`);
    }
    if (edit.start < previousEnd) {
      throw new XmlError(`Overlapping XML edits at offset ${edit.start}`);
    }
    assertCodeUnitBoundary(xml, edit.start);
    assertCodeUnitBoundary(xml, edit.end);
    previousEnd = edit.end;
  }

  let result = xml;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const edit = sorted[index];
    if (!edit) continue;
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

export interface XmlTextReplacement {
  start: number;
  end: number;
  text: string;
}

/** Replaces raw text-node ranges, escaping the replacement as XML text. */
export function replaceTextNodes(xml: string, replacements: readonly XmlTextReplacement[]): string {
  return applyXmlEdits(
    xml,
    replacements.map((replacement) => ({
      start: replacement.start,
      end: replacement.end,
      text: escapeXmlText(replacement.text),
    })),
  );
}

/**
 * Structural skeleton: tag/attribute names and token order, with text and
 * attribute values omitted. Text tokens are omitted entirely because masking
 * may legitimately empty a text node; tag order and opening/closing pairs still
 * catch serializer rewrites. `xml:space` is ignored because adding it is
 * semantically neutral and may be required after a replacement.
 */
export function xmlSkeletonFromScan(scan: XmlScan): string {
  const tokens: string[] = [];
  for (const token of scan.tokens) {
    switch (token.kind) {
      case 'start': {
        const attrs = token.attrs.filter((name) => name !== 'xml:space');
        const suffix = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
        tokens.push(`<${token.qname}${suffix}${token.selfClosing ? '/' : ''}>`);
        break;
      }
      case 'end':
        tokens.push(`</${token.qname}>`);
        break;
      case 'comment':
        tokens.push('<!--#-->');
        break;
      case 'pi':
        tokens.push(`<?${token.target}?>`);
        break;
      default:
        break;
    }
  }
  return tokens.join('\n');
}

export function xmlSkeleton(text: string): string {
  return xmlSkeletonFromScan(scanXml(text));
}
