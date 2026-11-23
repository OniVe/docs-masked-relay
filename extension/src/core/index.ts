/**
 * Public core surface for the extension and tests.
 * TXT/MD/DOCX/XLSX adapters live here; PDF and legacy adapters will join later.
 */

export {
  digitsOnly,
  ibanValid,
  inn10Valid,
  inn12Valid,
  innValid,
  luhnCheck,
  ogrnValid,
  snilsValid,
} from './checksums';
export { ALL_LABELS, DEFAULT_LABELS, type DetectOptions, detectAll } from './detect';
export { detectAddress } from './detect/address';
export {
  hasContextBefore,
  hasWordBefore,
  isWordChar,
  lastWordBefore,
  leftContext,
} from './detect/context';
export {
  CUSTOM_LABEL_RE,
  type CustomTermRule,
  DEFAULT_CUSTOM_LABEL,
  detectCustom,
  isCustomTagLabel,
  normalizeCustomLabel,
  parseCustomTermLine,
  parseCustomTermLines,
} from './detect/custom';
export { detectOrg } from './detect/org';
export {
  assertPersonDensity,
  buildPersonIndex,
  DENSITY_LIMIT_MESSAGE,
  DensityLimitError,
  detectPersonSpans,
  encodePersonKey,
  MAX_PERSON_TOKENS,
  type PersonDetectContext,
  type PersonIndex,
} from './detect/person';
export {
  blankSpans,
  compareSpans,
  resolveOverlaps,
  type Span,
  spanLength,
  spansOverlap,
} from './detect/span';

export {
  detectAccount,
  detectCard,
  detectDate,
  detectDocNum,
  detectEmail,
  detectHandle,
  detectIban,
  detectInn,
  detectIp,
  detectKppBik,
  detectLicense,
  detectOgrn,
  detectPassport,
  detectPerson,
  detectPhone,
  detectPlate,
  detectPolicy,
  detectSnils,
  detectStructured,
  detectUrl,
} from './detect/structured';
export {
  anonymizeDoc,
  DOC_LOSS_WARNING,
  DOC_MIME,
  DOC_RESTORE_WARNING,
  DOCX_MIME,
  type DocAnonymizeOptions,
  type DocSection,
  type DocSectionKind,
  type DocTextExtractor,
  docFormatAdapter,
  docxNameFor,
  extractDocSections,
  restoreDoc,
} from './formats/doc';
export {
  anonymizeDocx,
  docxFormatAdapter,
  restoreDocx,
} from './formats/docx';
export {
  anonymizeJson,
  type JsonMode,
  jsonFormatAdapter,
  restoreJson,
} from './formats/json';
export {
  anonymizeMd,
  mdFormatAdapter,
  restoreMd,
} from './formats/md';
export {
  anonymizeTxt,
  applyEol,
  type DetectedEncoding,
  decodeTextBytes,
  detectEncoding,
  detectEol,
  encodeTextBytes,
  findVaultFile,
  parseTxtEncoding,
  resolveVaultFile,
  restoreTxt,
  sha256Hex,
  type TxtEncoding,
  txtFormatAdapter,
} from './formats/txt';
export {
  anonymizeXls,
  restoreXls,
  XLS_LOSS_WARNING,
  XLS_MIME,
  XLS_RESTORE_WARNING,
  XLSX_MIME,
  xlsFormatAdapter,
  xlsxNameFor,
} from './formats/xls';
export {
  anonymizeXlsx,
  restoreXlsx,
  xlsxFormatAdapter,
} from './formats/xlsx';
export {
  anonymizeXml,
  restoreXml,
  xmlFormatAdapter,
} from './formats/xml';
export {
  type AnonymizeTextResult,
  anonymizeText,
  assertClean,
  createFileRestoreSession,
  createRestoreSession,
  findLeaks,
  type LeakFinding,
  LeakGuardError,
  type MaskedReplacement,
  orderOccurrencesByPosition,
  type RestoreSession,
  type RestoreTextOptions,
  type RestoreTextResult,
  restoreText,
} from './masker';
export * from './ooxml';
export { AmbiguousVaultFileError, IdentityMismatchVaultFileError } from './restore-identity';
export {
  makePrefix,
  makeTag,
  type ParsedTag,
  parseTags,
  TAG_PREFIX_ALPHABET,
  TAG_PREFIX_LENGTH,
} from './tag';
export * from './types';
export {
  type AssignedEntity,
  type AssignOptions,
  assignDetection,
  buildTag,
  type CreateVaultOptions,
  canonicalOf,
  createVault,
  createVaultIndex,
  type EntityKeyResolver,
  findStructuredEntityKey,
  occurrencesSince,
  refreshVaultIndex,
  type VaultIndex,
} from './vault';
