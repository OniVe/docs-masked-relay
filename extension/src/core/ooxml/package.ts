/**
 * OPC package model: content types, relationships and the mandatory linter.
 *
 * The linter is the fail-closed gate for every edited package:
 * - every part has a content type;
 * - every internal relationship target exists;
 * - every `r:id`/`r:embed`/`r:link` reference resolves;
 * - every XML part is well-formed and DTD-free;
 * - unless a part is explicitly removed, the tag/attribute-name skeleton is
 *   unchanged (text and attribute values may change by design).
 */

import {
  applyXmlEdits,
  type DecodedXml,
  decodeXml,
  encodeXml,
  escapeXmlAttribute,
  scanXml,
  validateXmlText,
  type XmlEdit,
  type XmlElement,
  type XmlScan,
  xmlSkeletonFromScan,
} from './xml';
import { validatePartName } from './zip';

export interface ContentTypeMap {
  /** Extension (lower-case, without dot) -> content type. */
  defaults: Map<string, string>;
  /** Part name (without leading slash) -> content type. */
  overrides: Map<string, string>;
}

export type RelationshipTargetMode = 'Internal' | 'External';

export interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode: RelationshipTargetMode;
  element: XmlElement;
}

export interface RelationshipsPart {
  partName: string;
  sourcePart: string;
  relationships: Relationship[];
  decoded: DecodedXml;
  scan: XmlScan;
}

export interface RelationshipSnapshot {
  id: string;
  type: string;
  target: string;
  targetMode: RelationshipTargetMode;
}

export interface ContentTypesSnapshot {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

export interface RelationshipsSnapshot {
  sourcePart: string;
  relationships: RelationshipSnapshot[];
}

/** Structure baseline captured before edits and compared after. */
export interface PackageBaseline {
  partNames: Set<string>;
  /** Part name -> skeleton for XML parts. */
  skeletons: Map<string, string>;
  contentTypes: ContentTypesSnapshot;
  /** Rels part name -> snapshot. */
  relationships: Map<string, RelationshipsSnapshot>;
}

export interface PackageLintOptions {
  baseline?: PackageBaseline;
  /** Parts deliberately removed from the package (thumbnail, signatures). */
  removedParts?: ReadonlySet<string>;
}

export interface PackageLintResult {
  warnings: string[];
}

export class PackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageError';
  }
}

const CONTENT_TYPES_PART = '[Content_Types].xml';
const PACKAGE_CONTENT_TYPES_NS = new Set([
  'http://schemas.openxmlformats.org/package/2006/content-types',
  'http://purl.oclc.org/ooxml/package/content-types',
]);
const PACKAGE_RELATIONSHIPS_NS = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
]);
const RELATIONSHIP_REFERENCE_NS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
  'http://schemas.microsoft.com/office/2006/relationships',
]);
const RELATIONSHIP_REFERENCE_LOCALS = new Set([
  'id',
  'embed',
  'link',
  'pict',
  'dm',
  'lo',
  'qs',
  'cs',
]);

function attrValue(element: XmlElement, local: string): string | undefined {
  for (const attr of element.attrs) {
    if (attr.ns === '' && attr.local === local) return attr.value;
  }
  return undefined;
}

function requireAttr(element: XmlElement, local: string, context: string): string {
  const value = attrValue(element, local);
  if (value === undefined || value.length === 0) {
    throw new PackageError(`${context} is missing the "${local}" attribute`);
  }
  return value;
}

function normalizePartName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

export function readXmlPart(
  parts: ReadonlyMap<string, Uint8Array>,
  partName: string,
): { bytes: Uint8Array; decoded: DecodedXml; scan: XmlScan } {
  const bytes = parts.get(partName);
  if (!bytes) throw new PackageError(`Package part not found: ${partName}`);
  const decoded = decodeXml(bytes);
  const scan = scanXml(decoded.text, decoded.encoding, decoded.bom);
  return { bytes, decoded, scan };
}

/** Applies raw edits and re-encodes with the source encoding/BOM. */
export function applyPartEdits(
  parts: Map<string, Uint8Array>,
  partName: string,
  decoded: DecodedXml,
  edits: readonly XmlEdit[],
): void {
  if (edits.length === 0) return;
  const text = applyXmlEdits(decoded.text, edits);
  parts.set(partName, encodeXml(text, decoded.encoding, decoded.bom));
}

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

export function parseContentTypes(parts: ReadonlyMap<string, Uint8Array>): ContentTypeMap {
  const { scan } = readXmlPart(parts, CONTENT_TYPES_PART);
  if (scan.root.local !== 'Types' || !PACKAGE_CONTENT_TYPES_NS.has(scan.root.ns)) {
    throw new PackageError(`Invalid ${CONTENT_TYPES_PART}: unexpected root element`);
  }

  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();

  for (const child of scan.root.children) {
    if (child.ns !== scan.root.ns) continue;
    if (child.local === 'Default') {
      const extension = requireAttr(child, 'Extension', 'Content type Default').toLowerCase();
      const contentType = requireAttr(child, 'ContentType', 'Content type Default');
      if (defaults.has(extension)) {
        throw new PackageError(`Duplicate content type Default for ".${extension}"`);
      }
      defaults.set(extension, contentType);
      continue;
    }
    if (child.local === 'Override') {
      const rawName = requireAttr(child, 'PartName', 'Content type Override');
      if (!rawName.startsWith('/')) {
        throw new PackageError(`Content type Override PartName is not absolute: ${rawName}`);
      }
      const partName = normalizePartName(rawName);
      const contentType = requireAttr(child, 'ContentType', 'Content type Override');
      if (overrides.has(partName)) {
        throw new PackageError(`Duplicate content type Override for ${partName}`);
      }
      overrides.set(partName, contentType);
    }
  }

  return { defaults, overrides };
}

export function contentTypeOf(types: ContentTypeMap, partName: string): string | undefined {
  const normalized = normalizePartName(partName);
  const override = types.overrides.get(normalized);
  if (override !== undefined) return override;

  const slash = normalized.lastIndexOf('/');
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  const dot = basename.lastIndexOf('.');
  if (dot === -1 || dot === basename.length - 1) return undefined;
  return types.defaults.get(basename.slice(dot + 1).toLowerCase());
}

export function isXmlPart(partName: string, contentType: string | undefined): boolean {
  if (partName.endsWith('.xml') || isRelsPartName(partName)) return true;
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return (
    normalized === 'application/xml' || normalized === 'text/xml' || normalized.endsWith('+xml')
  );
}

/** OPC part names are case-insensitive; `.rels` detection must be too. */
export function isRelsPartName(partName: string): boolean {
  return partName.toLowerCase().endsWith('.rels');
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function dirname(partName: string): string {
  const slash = partName.lastIndexOf('/');
  return slash === -1 ? '' : partName.slice(0, slash);
}

function basename(partName: string): string {
  const slash = partName.lastIndexOf('/');
  return slash === -1 ? partName : partName.slice(slash + 1);
}

/** `word/document.xml` -> `word/_rels/document.xml.rels`; root -> `_rels/.rels`. */
export function relsPartNameFor(partName: string): string {
  if (partName.length === 0) return '_rels/.rels';
  const dir = dirname(partName);
  return `${dir.length > 0 ? `${dir}/` : ''}_rels/${basename(partName)}.rels`;
}

/** Inverse of `relsPartNameFor`. */
export function sourcePartForRelsPart(relsPartName: string): string {
  if (relsPartName === '_rels/.rels') return '';
  const match = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/iu.exec(relsPartName);
  if (!match) throw new PackageError(`Not a relationship part name: ${relsPartName}`);
  const [, dir = '', file = ''] = match;
  return `${dir.length > 0 ? `${dir}/` : ''}${file}`;
}

function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0)
        throw new PackageError(`Relationship target escapes the package: ${path}`);
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * Resolves an internal relationship target. Returns every plausible spelling
 * (raw and percent-decoded) because OPC part names may be URI-encoded.
 */
export function internalTargetCandidates(sourcePart: string, target: string): string[] {
  const withoutFragment = target.split('#')[0] ?? '';
  if (withoutFragment.length === 0) return [sourcePart];

  const base = withoutFragment.startsWith('/') ? '' : dirname(sourcePart);
  const combined = withoutFragment.startsWith('/')
    ? withoutFragment.slice(1)
    : `${base.length > 0 ? `${base}/` : ''}${withoutFragment}`;
  const raw = normalizeSegments(combined);
  const candidates = new Set<string>([raw]);

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.add(normalizeSegments(decoded));
  } catch {
    // Invalid percent escapes stay raw; existence check will fail closed.
  }

  return [...candidates];
}

export function resolveInternalTarget(sourcePart: string, target: string): string {
  const candidates = internalTargetCandidates(sourcePart, target);
  return candidates[0] ?? sourcePart;
}

export function parseRelationshipsPart(
  parts: ReadonlyMap<string, Uint8Array>,
  relsPartName: string,
): RelationshipsPart | undefined {
  const bytes = parts.get(relsPartName);
  if (!bytes) return undefined;

  const decoded = decodeXml(bytes);
  const scan = scanXml(decoded.text, decoded.encoding, decoded.bom);
  if (scan.root.local !== 'Relationships' || !PACKAGE_RELATIONSHIPS_NS.has(scan.root.ns)) {
    throw new PackageError(`Invalid relationship part ${relsPartName}: unexpected root element`);
  }

  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  for (const child of scan.root.children) {
    if (child.ns !== scan.root.ns) continue;
    if (child.local !== 'Relationship') continue;
    const id = requireAttr(child, 'Id', `Relationship in ${relsPartName}`);
    if (seen.has(id))
      throw new PackageError(`Duplicate relationship Id "${id}" in ${relsPartName}`);
    seen.add(id);

    const type = requireAttr(child, 'Type', `Relationship "${id}" in ${relsPartName}`);
    const target = requireAttr(child, 'Target', `Relationship "${id}" in ${relsPartName}`);
    const rawMode = attrValue(child, 'TargetMode');
    if (rawMode !== undefined && rawMode !== 'Internal' && rawMode !== 'External') {
      throw new PackageError(`Invalid TargetMode "${rawMode}" in ${relsPartName}`);
    }
    relationships.push({
      id,
      type,
      target,
      targetMode: rawMode === 'External' ? 'External' : 'Internal',
      element: child,
    });
  }

  return {
    partName: relsPartName,
    sourcePart: sourcePartForRelsPart(relsPartName),
    relationships,
    decoded,
    scan,
  };
}

export function findParts(
  parts: ReadonlyMap<string, Uint8Array>,
  predicate: (name: string, bytes: Uint8Array) => boolean,
): string[] {
  const result: string[] = [];
  for (const [name, bytes] of parts) {
    if (predicate(name, bytes)) result.push(name);
  }
  return result.sort();
}

// ---------------------------------------------------------------------------
// Main part
// ---------------------------------------------------------------------------

export function findMainPart(
  parts: ReadonlyMap<string, Uint8Array>,
  types: ContentTypeMap = parseContentTypes(parts),
): string {
  const rootRels = parseRelationshipsPart(parts, '_rels/.rels');
  if (rootRels) {
    for (const relationship of rootRels.relationships) {
      if (relationship.targetMode !== 'Internal') continue;
      if (!relationship.type.endsWith('/officeDocument')) continue;
      for (const candidate of internalTargetCandidates('', relationship.target)) {
        if (parts.has(candidate)) return candidate;
      }
    }
  }

  const contentCandidates: string[] = [];
  for (const [partName, contentType] of types.overrides) {
    if (
      /wordprocessingml\.(?:document|template)\.main\+xml$/u.test(contentType) ||
      /wordprocessingml\.macroEnabled\.main\+xml$/u.test(contentType)
    ) {
      if (parts.has(partName)) contentCandidates.push(partName);
    }
  }
  if (contentCandidates.length === 1) return contentCandidates[0] as string;
  if (contentCandidates.length > 1) {
    throw new PackageError('Package has multiple main document parts');
  }

  if (parts.has('word/document.xml')) return 'word/document.xml';
  throw new PackageError('DOCX package has no main document part');
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function snapshotPackage(parts: ReadonlyMap<string, Uint8Array>): PackageBaseline {
  const types = parseContentTypes(parts);
  const partNames = new Set(parts.keys());
  const skeletons = new Map<string, string>();
  const relationships = new Map<string, RelationshipsSnapshot>();

  for (const [partName, bytes] of parts) {
    const contentType = contentTypeOf(types, partName);
    if (isRelsPartName(partName)) {
      const parsed = parseRelationshipsPart(parts, partName);
      if (parsed) {
        relationships.set(partName, {
          sourcePart: parsed.sourcePart,
          relationships: parsed.relationships.map((relationship) => ({
            id: relationship.id,
            type: relationship.type,
            target: relationship.target,
            targetMode: relationship.targetMode,
          })),
        });
      }
      continue;
    }
    if (partName === CONTENT_TYPES_PART || !isXmlPart(partName, contentType)) continue;
    const decoded = decodeXml(bytes);
    const scan = scanXml(decoded.text, decoded.encoding, decoded.bom);
    skeletons.set(partName, xmlSkeletonFromScan(scan));
  }

  return {
    partNames,
    skeletons,
    contentTypes: {
      defaults: new Map(types.defaults),
      overrides: new Map(types.overrides),
    },
    relationships,
  };
}

// ---------------------------------------------------------------------------
// Linter
// ---------------------------------------------------------------------------

function skeletonDifference(before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const length = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < length; index += 1) {
    const left = beforeLines[index] ?? '<missing>';
    const right = afterLines[index] ?? '<missing>';
    if (left !== right) {
      return `line ${index + 1}: ${left} -> ${right}`;
    }
  }
  return 'unknown difference';
}

function assertContentTypesUnchanged(
  before: ContentTypesSnapshot,
  after: ContentTypeMap,
  parts: ReadonlyMap<string, Uint8Array>,
  removedParts: ReadonlySet<string>,
): void {
  if (before.defaults.size !== after.defaults.size) {
    throw new PackageError('Content type defaults changed unexpectedly');
  }
  for (const [extension, contentType] of before.defaults) {
    if (after.defaults.get(extension) !== contentType) {
      throw new PackageError(`Content type default changed for ".${extension}"`);
    }
  }
  for (const [partName, contentType] of before.overrides) {
    const current = after.overrides.get(partName);
    if (current === contentType) continue;
    if (current !== undefined) {
      throw new PackageError(`Content type override changed for ${partName}`);
    }
    if (parts.has(partName) || !removedParts.has(partName)) {
      throw new PackageError(`Content type override removed for a live part: ${partName}`);
    }
  }
  for (const partName of after.overrides.keys()) {
    if (!before.overrides.has(partName)) {
      throw new PackageError(`Content type override added for ${partName}`);
    }
  }
}

function assertRelationshipsCompatible(
  before: RelationshipsSnapshot,
  after: RelationshipsPart | undefined,
  parts: ReadonlyMap<string, Uint8Array>,
  removedParts: ReadonlySet<string>,
  relsPartName: string,
): void {
  if (!after) {
    if (!removedParts.has(relsPartName)) {
      throw new PackageError(`Relationship part removed unexpectedly: ${relsPartName}`);
    }
    return;
  }

  const beforeById = new Map(
    before.relationships.map((relationship) => [relationship.id, relationship]),
  );
  const afterIds: string[] = [];

  for (const relationship of after.relationships) {
    const original = beforeById.get(relationship.id);
    if (!original) {
      throw new PackageError(
        `Relationship added unexpectedly: ${relationship.id} in ${relsPartName}`,
      );
    }
    afterIds.push(relationship.id);
    if (original.type !== relationship.type || original.targetMode !== relationship.targetMode) {
      throw new PackageError(
        `Relationship metadata changed for ${relationship.id} in ${relsPartName}`,
      );
    }
    if (original.targetMode === 'Internal' && original.target !== relationship.target) {
      throw new PackageError(`Internal relationship target changed for ${relationship.id}`);
    }
  }

  const expectedOrder = before.relationships
    .map((relationship) => relationship.id)
    .filter((id) => afterIds.includes(id));
  if (expectedOrder.join('\u0000') !== afterIds.join('\u0000')) {
    throw new PackageError(`Relationship order changed in ${relsPartName}`);
  }

  for (const original of before.relationships) {
    if (afterIds.includes(original.id)) continue;
    if (original.targetMode === 'External') {
      throw new PackageError(`External relationship removed unexpectedly: ${original.id}`);
    }
    const candidates = internalTargetCandidates(before.sourcePart, original.target);
    const removed = candidates.every(
      (candidate) => !parts.has(candidate) && removedParts.has(candidate),
    );
    if (!removed) {
      throw new PackageError(
        `Relationship removed but its target is still present: ${original.id}`,
      );
    }
  }
}

export function lintPackage(
  parts: ReadonlyMap<string, Uint8Array>,
  options: PackageLintOptions = {},
): PackageLintResult {
  const warnings: string[] = [];
  const removedParts = options.removedParts ?? new Set<string>();

  if (!parts.has(CONTENT_TYPES_PART)) {
    throw new PackageError(`Package is missing ${CONTENT_TYPES_PART}`);
  }

  const types = parseContentTypes(parts);
  const names = new Set(parts.keys());
  const folded = new Set<string>();
  for (const name of names) {
    validatePartName(name);
    const lower = name.toLowerCase();
    if (folded.has(lower)) throw new PackageError(`Duplicate package part name: ${name}`);
    folded.add(lower);
  }

  for (const [partName, contentType] of types.overrides) {
    if (!names.has(partName)) {
      throw new PackageError(`Content type Override points to a missing part: ${partName}`);
    }
    if (contentType.length === 0) {
      throw new PackageError(`Empty content type for ${partName}`);
    }
  }

  for (const partName of names) {
    if (partName === CONTENT_TYPES_PART) continue;
    if (contentTypeOf(types, partName) === undefined) {
      throw new PackageError(`Package part has no content type: ${partName}`);
    }
  }

  const relationshipParts = new Map<string, RelationshipsPart>();
  for (const partName of [...names].sort()) {
    if (!isRelsPartName(partName)) continue;
    const parsed = parseRelationshipsPart(parts, partName);
    if (!parsed) continue;
    relationshipParts.set(partName, parsed);

    for (const relationship of parsed.relationships) {
      if (relationship.targetMode === 'External') continue;
      if (relationship.target.startsWith('#')) continue;
      const candidates = internalTargetCandidates(parsed.sourcePart, relationship.target);
      if (!candidates.some((candidate) => names.has(candidate))) {
        throw new PackageError(
          `Internal relationship target does not exist: ${relationship.target} (${partName})`,
        );
      }
    }
  }

  const scans = new Map<string, XmlScan>();
  for (const partName of [...names].sort()) {
    const contentType = contentTypeOf(types, partName);
    if (!isXmlPart(partName, contentType)) continue;
    const bytes = parts.get(partName);
    if (!bytes) continue;
    const decoded = decodeXml(bytes);
    const scan = scanXml(decoded.text, decoded.encoding, decoded.bom);
    validateXmlText(decoded.text, partName);
    scans.set(partName, scan);
  }

  for (const [partName, scan] of scans) {
    if (isRelsPartName(partName)) continue;
    const relsPartName = relsPartNameFor(partName);
    const rels = relationshipParts.get(relsPartName);
    const ids = new Set(rels?.relationships.map((relationship) => relationship.id) ?? []);

    for (const element of scan.elements) {
      for (const attr of element.attrs) {
        if (!RELATIONSHIP_REFERENCE_NS.has(attr.ns)) continue;
        if (!RELATIONSHIP_REFERENCE_LOCALS.has(attr.local)) continue;
        if (attr.value.length === 0) {
          throw new PackageError(`Empty relationship reference ${attr.qname} in ${partName}`);
        }
        if (!ids.has(attr.value)) {
          throw new PackageError(
            `Dangling relationship reference ${attr.qname}="${attr.value}" in ${partName}`,
          );
        }
      }
    }
  }

  if (options.baseline) {
    const baseline = options.baseline;

    for (const partName of baseline.partNames) {
      if (parts.has(partName)) continue;
      if (!removedParts.has(partName)) {
        throw new PackageError(`Package part removed without declaration: ${partName}`);
      }
    }
    for (const partName of names) {
      if (!baseline.partNames.has(partName)) {
        throw new PackageError(`Package part added unexpectedly: ${partName}`);
      }
    }

    assertContentTypesUnchanged(baseline.contentTypes, types, parts, removedParts);

    for (const [relsPartName, before] of baseline.relationships) {
      const after = relationshipParts.get(relsPartName);
      assertRelationshipsCompatible(before, after, parts, removedParts, relsPartName);
    }
    for (const relsPartName of relationshipParts.keys()) {
      if (!baseline.relationships.has(relsPartName)) {
        throw new PackageError(`Relationship part added unexpectedly: ${relsPartName}`);
      }
    }

    for (const [partName, beforeSkeleton] of baseline.skeletons) {
      if (partName === CONTENT_TYPES_PART || isRelsPartName(partName) || !parts.has(partName)) {
        continue;
      }
      const bytes = parts.get(partName);
      if (!bytes) continue;
      const decoded = decodeXml(bytes);
      const afterScan = scanXml(decoded.text, decoded.encoding, decoded.bom);
      const afterSkeleton = xmlSkeletonFromScan(afterScan);
      if (afterSkeleton !== beforeSkeleton) {
        throw new PackageError(
          `XML structure changed unexpectedly in ${partName} (${skeletonDifference(beforeSkeleton, afterSkeleton)})`,
        );
      }
    }
  }

  return { warnings };
}

export function assertPackageValid(
  parts: ReadonlyMap<string, Uint8Array>,
  options: PackageLintOptions = {},
): void {
  lintPackage(parts, options);
}

// ---------------------------------------------------------------------------
// Package edits
// ---------------------------------------------------------------------------

/** Removes a part, its own rels part, its content-type override and inbound rels. */
export function removePackagePart(parts: Map<string, Uint8Array>, partName: string): boolean {
  const normalized = normalizePartName(partName);
  if (!parts.has(normalized)) return false;

  parts.delete(normalized);

  const ownRels = relsPartNameFor(normalized);
  if (ownRels !== normalized && parts.has(ownRels)) {
    parts.delete(ownRels);
  }
  const removedNames = new Set([normalized, ownRels]);

  // Content type overrides.
  const contentTypesBytes = parts.get(CONTENT_TYPES_PART);
  if (contentTypesBytes) {
    const decoded = decodeXml(contentTypesBytes);
    const scan = scanXml(decoded.text, decoded.encoding, decoded.bom);
    const edits: XmlEdit[] = [];
    for (const child of scan.root.children) {
      if (child.ns !== scan.root.ns) continue;
      if (child.local !== 'Override') continue;
      const rawName = attrValue(child, 'PartName');
      if (rawName === undefined) continue;
      if (!removedNames.has(normalizePartName(rawName))) continue;
      edits.push({ start: child.start, end: child.end, text: '' });
    }
    applyPartEdits(parts, CONTENT_TYPES_PART, decoded, edits);
  }

  // Inbound relationships.
  for (const relsPartName of [...parts.keys()]) {
    if (!isRelsPartName(relsPartName)) continue;
    if (removedNames.has(relsPartName)) continue;
    const parsed = parseRelationshipsPart(parts, relsPartName);
    if (!parsed) continue;
    const edits: XmlEdit[] = [];
    for (const relationship of parsed.relationships) {
      if (relationship.targetMode !== 'Internal') continue;
      const candidates = internalTargetCandidates(parsed.sourcePart, relationship.target);
      if (!candidates.some((candidate) => removedNames.has(candidate))) continue;
      edits.push({ start: relationship.element.start, end: relationship.element.end, text: '' });
    }
    applyPartEdits(parts, relsPartName, parsed.decoded, edits);
  }

  return true;
}

/** Replaces every external relationship target with a non-resolving URL. */
export function redactExternalRelationships(
  parts: Map<string, Uint8Array>,
  placeholder = 'https://example.invalid/redacted',
): number {
  let count = 0;

  for (const relsPartName of [...parts.keys()].sort()) {
    if (!isRelsPartName(relsPartName)) continue;
    const parsed = parseRelationshipsPart(parts, relsPartName);
    if (!parsed) continue;
    const edits: XmlEdit[] = [];
    for (const relationship of parsed.relationships) {
      if (relationship.targetMode !== 'External') continue;
      const targetAttr = relationship.element.attrMap.get('Target');
      if (!targetAttr) continue;
      edits.push({
        start: targetAttr.valueStart,
        end: targetAttr.valueEnd,
        text: escapeXmlAttribute(placeholder),
      });
      count += 1;
    }
    applyPartEdits(parts, relsPartName, parsed.decoded, edits);
  }

  return count;
}
