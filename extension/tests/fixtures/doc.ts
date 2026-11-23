/**
 * Real legacy `.doc` fixtures (M5b).
 *
 * Files are copied from the MIT-licensed word-extractor repository:
 * https://github.com/morungos/node-word-extractor (`__tests__/data`).
 * See `legacy/ATTRIBUTION.md`. They exercise the real OLE/BIFF parser, not a
 * synthetic stand-in; PII masking is additionally covered through the adapter's
 * injectable extractor seam in tests/unit/legacy.test.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DocSection } from '../../src/core/formats/doc';

const LEGACY_DIR = new URL('./legacy/', import.meta.url);

export type DocFixtureName = 'test01' | 'test04' | 'test13';

export function docFixture(name: DocFixtureName): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`${name}.doc`, LEGACY_DIR))));
}

export function docFixtureBase64(name: DocFixtureName): string {
  return Buffer.from(docFixture(name)).toString('base64');
}

/** Deterministic story text, used with the adapter's extractor seam. */
export function piiDocSections(): DocSection[] {
  return [
    { kind: 'body', text: 'Договор\nИванов Иван Иванович\nivan@example.ru\n+7 916 123-45-67' },
    { kind: 'headers', text: 'Клиент: Иванов Иван Иванович' },
    { kind: 'footers', text: 'Стр. 1' },
    { kind: 'footnotes', text: 'ИНН 7707083893' },
    { kind: 'endnotes', text: 'Примечание' },
    { kind: 'comments', text: 'Позвонить Иванову' },
    { kind: 'textboxes', text: 'ivan@example.ru' },
  ];
}
