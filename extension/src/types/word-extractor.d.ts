/**
 * Minimal ambient types for the word-extractor CJS entry points used by the
 * legacy `.doc` adapter. The package ships no TypeScript declarations.
 */
declare module 'word-extractor/lib/word-ole-extractor.js' {
  export interface WordExtractorDocument {
    getBody(options?: { filterUnicode?: boolean }): string;
    getHeaders(options?: { filterUnicode?: boolean; includeFooters?: boolean }): string;
    getFooters(options?: { filterUnicode?: boolean }): string;
    getFootnotes(options?: { filterUnicode?: boolean }): string;
    getEndnotes(options?: { filterUnicode?: boolean }): string;
    getAnnotations(options?: { filterUnicode?: boolean }): string;
    getTextboxes(options?: {
      filterUnicode?: boolean;
      includeBody?: boolean;
      includeHeadersAndFooters?: boolean;
    }): string;
  }

  export default class WordOleExtractor {
    extract(reader: unknown): Promise<WordExtractorDocument>;
  }
}

declare module 'word-extractor/lib/buffer-reader.js' {
  export default class BufferReader {
    constructor(buffer: unknown);
  }
}
