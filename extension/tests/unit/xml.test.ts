import { describe, expect, it } from 'vitest';
import type { AnonymizeResult, FileInput, Vault } from '../../src/core';
import {
  anonymizeXml,
  createVault,
  decodeTextBytes,
  encodeTextBytes,
  LeakGuardError,
  restoreXml,
  scanXml,
  validateXmlText,
  xmlFormatAdapter,
} from '../../src/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fileOf(name: string, bytes: Uint8Array, mimeType = 'application/xml'): FileInput {
  return { name, mimeType, bytes };
}

interface RoundTrip {
  result: AnonymizeResult;
  masked: string;
  restored: string;
  restoredBytes: Uint8Array;
  sourceBytes: Uint8Array;
  vault: Vault;
}

async function roundTrip(
  name: string,
  source: string,
  options: { mimeType?: string } = {},
): Promise<RoundTrip> {
  const sourceBytes = encoder.encode(source);
  const vault = createVault(source);
  const file = fileOf(name, sourceBytes, options.mimeType);

  const result = await anonymizeXml(file, { vault, maxBytes: 1_000_000 });
  const masked = decoder.decode(result.maskedBytes);
  const restored = await restoreXml(fileOf(name, result.maskedBytes, options.mimeType), vault);

  return {
    result,
    masked,
    restored: decoder.decode(restored.bytes),
    restoredBytes: restored.bytes,
    sourceBytes,
    vault,
  };
}

describe('XML adapter', () => {
  it('masks text and attributes while preserving nested elements and namespaces', async () => {
    const source = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<r:root xmlns:r="urn:r" xmlns="urn:def" owner="Иван Петров">',
      '  <r:item code="A&amp;B">ivan@example.ru</r:item>',
      '  <item>+7 916 123-45-67</item>',
      '</r:root>',
      '',
    ].join('\n');

    const { masked, restored, result } = await roundTrip('data.xml', source);

    expect(masked).not.toContain('Иван Петров');
    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).not.toContain('+7 916 123-45-67');
    expect(masked).toContain('<r:root xmlns:r="urn:r" xmlns="urn:def" owner="[[');
    expect(masked).toContain('<r:item code="A&amp;B">');
    expect(() => validateXmlText(masked)).not.toThrow();
    expect(result.format).toBe('xml');
    expect(result.entities.map((entity) => entity.label)).toEqual(
      expect.arrayContaining(['PERSON', 'EMAIL', 'PHONE']),
    );
    expect(restored).toBe(source);
  });

  it('converts a PII-bearing CDATA section to text and restores its text', async () => {
    const source = '<root><![CDATA[Иван Петров & test@example.ru]]></root>';
    const { masked, restored, result } = await roundTrip('cdata.xml', source);

    expect(masked).not.toContain('Иван Петров');
    expect(masked).not.toContain('test@example.ru');
    expect(masked).not.toContain(']]]]>');
    expect(masked).toContain('&amp;');
    expect(() => validateXmlText(masked)).not.toThrow();
    expect(result.warnings.some((warning) => /CDATA/u.test(warning))).toBe(true);

    const restoredScan = scanXml(restored);
    expect(restoredScan.textNodes.map((node) => node.text).join('')).toBe(
      'Иван Петров & test@example.ru',
    );
  });

  it('does not create an accidental CDATA terminator when the tag ends the section', async () => {
    const source = '<root><![CDATA[ivan@example.ru]]></root>';
    const { masked } = await roundTrip('cdata-tag.xml', source);

    expect(masked).not.toContain(']]]]>');
    expect(() => validateXmlText(masked)).not.toThrow();
  });

  it('clears comments and processing instructions one-way with a warning', async () => {
    const source = [
      '<?xml version="1.0"?>',
      '<!-- Иван Петров ivan@example.ru -->',
      '<?xml-stylesheet href="https://example.ru/style.css"?>',
      '<root>ok</root>',
      '',
    ].join('\n');

    const { masked, restored, result } = await roundTrip('comments.xml', source);

    expect(masked).toContain('<!---->');
    expect(masked).toContain('<?xml-stylesheet?>');
    expect(masked).toContain('<?xml version="1.0"?>');
    expect(masked).not.toContain('Иван Петров');
    expect(masked).not.toContain('example.ru/style.css');
    expect(result.warnings.some((warning) => /one-way/u.test(warning))).toBe(true);

    expect(restored).not.toContain('Иван Петров');
    expect(restored).toContain('<!---->');
    expect(restored).toContain('<?xml-stylesheet?>');
  });

  it('rejects DTDs, unknown entities and malformed XML without mutating the vault', async () => {
    const cases = [
      ['<!DOCTYPE root [<!ENTITY e "x">]><root>&e;</root>', /DOCTYPE|DTD/u],
      ['<root>&custom;</root>', /Unknown entity/u],
      ['<root><b></root>', /well-formed|Mismatched/u],
    ] as const;

    for (const [source, message] of cases) {
      const vault = createVault(source);
      await expect(
        anonymizeXml(fileOf('bad.xml', encoder.encode(source)), { vault, maxBytes: 1_000_000 }),
      ).rejects.toThrow(message);
      expect(vault.occurrences).toHaveLength(0);
      expect(vault.files).toHaveLength(0);
    }
  });

  it('rolls the in-place vault back when a later value trips LeakGuard', async () => {
    const source = '<doc><phone>+79161234567</phone><email>ivan@example.ru</email></doc>';
    const vault = createVault(source);
    await expect(
      anonymizeXml(fileOf('partial.xml', encoder.encode(source)), {
        vault,
        maxBytes: 1_000_000,
        config: { labels: new Set(['PHONE'] as const) },
      }),
    ).rejects.toThrow(LeakGuardError);
    expect(vault.occurrences).toHaveLength(0);
    expect(vault.entities).toEqual({});
    expect(vault.files).toHaveLength(0);
  });

  it('restores windows-1251 bytes and rewrites the declaration on upload', async () => {
    const source =
      '<?xml version="1.0" encoding="windows-1251"?><root name="Иван Петров">test@example.ru</root>';
    const sourceBytes = encodeTextBytes(source, 'windows-1251', false);
    const vault = createVault(source);

    const masked = await anonymizeXml(fileOf('win1251.xml', sourceBytes), {
      vault,
      maxBytes: 1_000_000,
    });
    const maskedText = decoder.decode(masked.maskedBytes);
    expect(maskedText).toContain('encoding="UTF-8"');
    expect(maskedText).not.toContain('Иван Петров');

    const restored = await restoreXml(fileOf('win1251.xml', masked.maskedBytes), vault);
    expect(restored.bytes).toEqual(sourceBytes);
    expect(decodeTextBytes(restored.bytes, 'windows-1251', false)).toBe(source);
  });

  it('round-trips UTF-16LE with BOM and restores the declaration label', async () => {
    const source =
      '<?xml version="1.0" encoding="UTF-16"?><root name="Иван Петров">test@example.ru</root>';
    const sourceBytes = encodeTextBytes(source, 'utf-16le', true);
    const vault = createVault(source);

    const masked = await anonymizeXml(fileOf('utf16.xml', sourceBytes), {
      vault,
      maxBytes: 1_000_000,
    });
    const maskedText = decoder.decode(masked.maskedBytes);
    expect(maskedText).toContain('encoding="UTF-8"');

    const restored = await restoreXml(fileOf('utf16.xml', masked.maskedBytes), vault);
    expect(restored.bytes).toEqual(sourceBytes);
  });

  it('escapes attribute values and restores the original spelling', async () => {
    const source = '<root note="Иван Петров &amp; &quot;Петров&quot; test@example.ru">ok</root>';
    const { masked, restored } = await roundTrip('attr.xml', source);

    expect(masked).not.toContain('Иван Петров');
    expect(masked).not.toContain('test@example.ru');
    expect(masked).toContain('&amp;');
    expect(() => validateXmlText(masked)).not.toThrow();
    expect(restored).toBe(source);
  });

  it('masks a full name with a city-homonym first name in text and attributes', async () => {
    const source =
      '<root owner="Иванов Владимир Иванович"><name>Петров Владимир Сергеевич</name></root>';
    const { masked, restored } = await roundTrip('city-name.xml', source);

    expect(masked).not.toContain('Владимир');
    expect(masked).not.toContain('Иванов');
    expect(masked).not.toContain('Петров');
    expect(() => validateXmlText(masked)).not.toThrow();
    expect(restored).toBe(source);
  });

  it('keeps benign namespace declarations structural', async () => {
    const source =
      '<root xmlns="urn:example" xmlns:x="urn:x"><x:a x:code="ivan@example.ru">ok</x:a></root>';
    const { masked } = await roundTrip('ns.xml', source);

    expect(masked).toContain('xmlns="urn:example"');
    expect(masked).toContain('xmlns:x="urn:x"');
    expect(masked).not.toContain('x:code="ivan@example.ru"');
    expect(masked).toContain('x:code="[[');
  });

  it('rejects PII in namespace URI declarations (fail-closed, M8-M2)', async () => {
    for (const source of [
      '<root xmlns="urn:ivan@example.ru"/>',
      '<root xmlns:x="urn:Иванов"><x:a/></root>',
    ]) {
      const vault = createVault(source);
      await expect(
        anonymizeXml(fileOf('ns-pii.xml', encoder.encode(source)), {
          vault,
          maxBytes: 1_000_000,
        }),
      ).rejects.toThrow(/structural|PII|namespace/iu);
      expect(vault.occurrences).toHaveLength(0);
      expect(vault.files).toHaveLength(0);
    }
  });

  it('rejects percent-encoded PII in namespace URIs (fail-closed, M8R3-M1)', async () => {
    const pii = '<root xmlns:x="urn:%D0%98%D0%B2%D0%B0%D0%BD"><x:a/></root>';
    const vault = createVault(pii);
    await expect(
      anonymizeXml(fileOf('ns-encoded-pii.xml', encoder.encode(pii)), {
        vault,
        maxBytes: 1_000_000,
      }),
    ).rejects.toThrow(/structural|PII|namespace/iu);
    expect(vault.occurrences).toHaveLength(0);
    expect(vault.files).toHaveLength(0);

    const benign = '<root xmlns:x="urn:%65xample"><x:a/></root>';
    const benignResult = await roundTrip('ns-encoded-ok.xml', benign);
    expect(benignResult.masked).toContain('xmlns:x="urn:%65xample"');
    expect(benignResult.restored).toBe(benign);
  });

  it('masks xml:base/xml:id values but keeps xml:lang/xml:space structural (M8-1)', async () => {
    const source =
      '<root xml:base="mailto:ivan@example.ru" xml:id="ivan_petrov" xml:lang="ru" xml:space="preserve" owner="Иван Петров">Иван Петров</root>';
    const { masked, restored } = await roundTrip('xml-attrs.xml', source);

    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).not.toContain('ivan_petrov');
    expect(masked).not.toContain('Иван Петров');
    expect(masked).toContain('xml:lang="ru"');
    expect(masked).toContain('xml:space="preserve"');
    expect(masked).toMatch(/xml:base="mailto:\[\[[A-Z0-9]{5}_EMAIL_1\]\]"/u);
    expect(() => validateXmlText(masked)).not.toThrow();
    expect(restored).toBe(source);
  });

  it('masks person names in URI/identifier values and lone ids (M8-1)', async () => {
    const source = [
      '<root xml:base="https://example.ru/ivan_petrov" xml:id="ivan"',
      '  url="https://example.ru/path" home="/home/user" urn="urn:example" section="section1"/>',
    ].join('\n');
    const { masked, restored } = await roundTrip('uri-id.xml', source);

    expect(masked).not.toContain('ivan_petrov');
    expect(masked).not.toContain('="ivan"');
    expect(masked).toContain('url="https://example.ru/path"');
    expect(masked).toContain('home="/home/user"');
    expect(masked).toContain('urn="urn:example"');
    expect(masked).toContain('section="section1"');
    expect(restored).toBe(source);

    const bare = '<root><a xml:base="https://example.ru/ivan"/></root>';
    const bareResult = await roundTrip('uri-bare.xml', bare);
    expect(bareResult.masked).not.toContain('example.ru/ivan');
    expect(bareResult.restored).toBe(bare);

    const cyrillic = '<root xml:base="https://example.ru/Иван_Петров" xml:id="Иван"/>';
    const cyrillicResult = await roundTrip('uri-cyr.xml', cyrillic);
    expect(cyrillicResult.masked).not.toContain('Иван');
    expect(cyrillicResult.masked).not.toContain('Петров');
    expect(cyrillicResult.restored).toBe(cyrillic);

    const encoded = '<root xml:base="https://example.ru/%D0%98%D0%B2%D0%B0%D0%BD"/>';
    const encodedResult = await roundTrip('uri-encoded.xml', encoded);
    expect(encodedResult.masked).not.toContain('%D0%98');
    expect(encodedResult.restored).toBe(encoded);
  });

  it('masks whole URI values with userinfo and keeps benign URLs (M8-1 r3)', async () => {
    const uris = [
      'https://ivan:petrov@example.ru/path',
      'https://sidorov:sasha@example.ru/path',
      'https://ivan@example.ru/path',
      '//ivan:petrov@example.ru/path',
    ];
    for (const uri of uris) {
      const source = `<root xml:base="${uri}" url="${uri}">${uri}</root>`;
      const { masked, restored } = await roundTrip('userinfo.xml', source);

      // The observed leak shape: `ivan:[[..._EMAIL_1]]` / `sidorov:[[...`.
      for (const fragment of ['ivan:', 'sidorov:', 'sasha@', 'ivan@', 'petrov@']) {
        expect(masked.toLowerCase()).not.toContain(fragment);
      }
      expect(masked).not.toContain('@example.ru');
      expect(() => validateXmlText(masked)).not.toThrow();
      expect(restored).toBe(source);
    }

    const benign = '<root xml:base="https://example.ru/home/user" url="//cdn.example/x"/>';
    const benignResult = await roundTrip('benign-userinfo.xml', benign);
    expect(benignResult.masked).toBe(benign);
    expect(benignResult.restored).toBe(benign);
  });

  it('masks userinfo URI substrings in prose and CDATA, keeping the prose (M8-1 r3)', async () => {
    const prose = '<root>See https://ivan:petrov@example.ru/path now</root>';
    const proseResult = await roundTrip('prose-userinfo.xml', prose);
    expect(proseResult.masked).toContain('See ');
    expect(proseResult.masked).toContain(' now');
    for (const fragment of ['ivan:', 'petrov@', '@example.ru']) {
      expect(proseResult.masked).not.toContain(fragment);
    }
    expect(() => validateXmlText(proseResult.masked)).not.toThrow();
    expect(proseResult.restored).toBe(prose);

    const attrProse = '<root note="see https://sidorov:sasha@example.ru/path now"/>';
    const attrResult = await roundTrip('attr-prose-userinfo.xml', attrProse);
    expect(attrResult.masked).toContain('note="see ');
    expect(attrResult.masked).toContain(' now"');
    for (const fragment of ['sidorov:', 'sasha@', '@example.ru']) {
      expect(attrResult.masked).not.toContain(fragment);
    }
    expect(attrResult.restored).toBe(attrProse);

    const relative = '<root>see //ivan:petrov@example.ru/path now</root>';
    const relativeResult = await roundTrip('relative-userinfo.xml', relative);
    expect(relativeResult.masked).toContain('see ');
    expect(relativeResult.masked).toContain(' now');
    expect(relativeResult.masked).not.toContain('ivan:');
    expect(relativeResult.restored).toBe(relative);

    const cdata = '<root><![CDATA[See https://ivan:petrov@example.ru/path now]]></root>';
    const cdataResult = await roundTrip('cdata-userinfo.xml', cdata);
    expect(cdataResult.masked).toContain('See ');
    expect(cdataResult.masked).not.toContain('ivan:');
    expect(cdataResult.masked).not.toContain('@example.ru');
    // CDATA markup is one-way by design; its text content round-trips.
    expect(cdataResult.restored).toBe(cdata.replace('<![CDATA[', '').replace(']]>', ''));
  });

  it('masks person names in URI path segments of ordinary attributes (M8-1 r3)', async () => {
    const source = [
      '<root>',
      '  <a url="https://example.ru/ivan"/>',
      '  <b href="https://example.ru/Иван_Петров"/>',
      '  <c link="see https://example.ru/ivan_petrov now"/>',
      '</root>',
    ].join('\n');
    const { masked, restored } = await roundTrip('attr-path.xml', source);

    for (const fragment of ['example.ru/ivan', 'Иван', 'Петров']) {
      expect(masked).not.toContain(fragment);
    }
    expect(masked).toMatch(/link="see \[\[[A-Z0-9]{5}_PERSON_[0-9]+\]\] now"/u);
    expect(() => validateXmlText(masked)).not.toThrow();
    expect(restored).toBe(source);
  });

  it('masks person names in URI path inside prose text and CDATA (M8-1 r3)', async () => {
    const latin = '<root>See https://example.ru/ivan now</root>';
    const latinResult = await roundTrip('prose-path.xml', latin);
    expect(latinResult.masked).toContain('See ');
    expect(latinResult.masked).toContain(' now');
    expect(latinResult.masked).not.toContain('example.ru/ivan');
    expect(latinResult.restored).toBe(latin);

    const cyrillic = '<root>See https://example.ru/Иван_Петров now</root>';
    const cyrillicResult = await roundTrip('prose-path-cyr.xml', cyrillic);
    expect(cyrillicResult.masked).toContain('See ');
    expect(cyrillicResult.masked).not.toContain('Иван');
    expect(cyrillicResult.masked).not.toContain('Петров');
    expect(cyrillicResult.restored).toBe(cyrillic);

    const cdata = '<root><![CDATA[See https://example.ru/ivan now]]></root>';
    const cdataResult = await roundTrip('cdata-path.xml', cdata);
    expect(cdataResult.masked).toContain('See ');
    expect(cdataResult.masked).not.toContain('example.ru/ivan');
    // CDATA markup is one-way by design; its text content round-trips.
    expect(cdataResult.restored).toBe(cdata.replace('<![CDATA[', '').replace(']]>', ''));

    const benign = '<root>See https://example.ru/home/user now</root>';
    const benignResult = await roundTrip('prose-path-benign.xml', benign);
    expect(benignResult.masked).toBe(benign);
    expect(benignResult.restored).toBe(benign);
  });

  it('masks person names in opaque scheme URIs of ordinary attributes (M8-1 r3)', async () => {
    const source = [
      '<root>',
      '  <a urn="urn:ivan"/>',
      '  <b urn="urn:Иван_Петров"/>',
      '  <c note="see urn:ivan_petrov now"/>',
      '  <d mail="mailto:ivan@example.ru"/>',
      '  <e note="send mailto:user@example.ru now"/>',
      '</root>',
    ].join('\n');
    const { masked, restored } = await roundTrip('opaque-uri.xml', source);

    expect(masked).not.toContain('urn:ivan');
    expect(masked).not.toContain('Иван');
    expect(masked).not.toContain('Петров');
    expect(masked).toMatch(/note="see \[\[[A-Z0-9]{5}_PERSON_[0-9]+\]\] now"/u);
    // An email keeps the email detector's tag (login is inside the span).
    expect(masked).not.toContain('ivan@example.ru');
    expect(masked).not.toContain('user@example.ru');
    expect(masked).toMatch(/mail="mailto:\[\[[A-Z0-9]{5}_EMAIL_1\]\]"/u);
    expect(() => validateXmlText(masked)).not.toThrow();
    expect(restored).toBe(source);

    const benign = '<root urn="urn:example" note="see urn:example now"/>';
    const benignResult = await roundTrip('opaque-benign.xml', benign);
    expect(benignResult.masked).toBe(benign);
    expect(benignResult.restored).toBe(benign);
  });

  it('keeps benign URI attributes, prose and non-URI identifiers (M8-1 r3)', async () => {
    const source =
      '<root url="https://example.ru/home/user" urn="urn:example" section="section1" note="see https://example.ru/home/user now"><a href="https://example.ru/path"/></root>';
    const { masked, restored } = await roundTrip('attr-benign.xml', source);

    expect(masked).toBe(source);
    expect(restored).toBe(source);
  });

  it('masks role-aware name fields in any position, nesting or parent (M8-2/M8R2-N2)', async () => {
    const source = [
      '<people>',
      '  <person first="Иван" last="Петров" middle="Сергеевич"/>',
      '  <full name="Иван Петров"/>',
      '  <first>Иван</first><age>30</age><last>Петров</last>',
      '  <nested><first><value>Иван</value></first><last><![CDATA[Петров]]></last></nested>',
      '  <one><first>Иван</first></one><two><last>Петров</last></two>',
      '</people>',
    ].join('\n');
    const { masked, restored } = await roundTrip('role-aware.xml', source);

    for (const value of ['Иван', 'Петров', 'Сергеевич']) {
      expect(masked).not.toContain(`>${value}<`);
      expect(masked).not.toContain(`"${value}"`);
    }
    expect(masked).not.toContain('"Иван Петров"');
    expect(() => validateXmlText(masked)).not.toThrow();
    // CDATA markup is one-way by design (text value is restored exactly).
    expect(restored).toBe(source.replace('<![CDATA[Петров]]>', 'Петров'));
  });

  it('rejects PII in element/attribute names and PI targets (fail-closed, M8-M2)', async () => {
    const cases = [
      '<Иванов_Иван/>',
      '<root attr_Петров="x"/>',
      '<?Петров_Иван data?><root/>',
      '<root xmlns:Петров="urn:x"/>',
      '<ivan/>',
      '<Ivan/>',
      '<IVAN/>',
      '<Ivan_Ivan/>',
      '<root xmlns="urn:ivan"/>',
      '<root xmlns:ivan="urn:x"/>',
      '<ivan:root xmlns:ivan="urn:x"/>',
      '<?ivan?><root/>',
      '<root attr_ivan="x"/>',
      '<Иванов/>',
    ];

    for (const source of cases) {
      const vault = createVault(source);
      await expect(
        anonymizeXml(fileOf('name-pii.xml', encoder.encode(source)), {
          vault,
          maxBytes: 1_000_000,
        }),
      ).rejects.toThrow(/structural|PII/iu);
      expect(vault.occurrences).toHaveLength(0);
      expect(vault.files).toHaveLength(0);
    }
  });

  it('accepts benign structural names, PI targets and namespace URIs', async () => {
    const source =
      '<?xml-stylesheet href="#" type="text/xsl"?><root xmlns="urn:example" xmlns:x="urn:x" xml:lang="ru"><x:first>ok</x:first><last>done</last></root>';
    const { masked } = await roundTrip('benign-names.xml', source);

    expect(masked).toContain('<root xmlns="urn:example"');
    expect(masked).toContain('<?xml-stylesheet?>');
    expect(masked).toContain('<x:first>ok</x:first>');
  });

  it('accepts field-type element names and masks their values (M8-M2)', async () => {
    const source =
      '<person><Фамилия>Петров</Фамилия><Имя>Иван</Имя><Отчество>Иванович</Отчество></person>';
    const { masked, restored } = await roundTrip('field-names.xml', source);

    expect(masked).toContain('<Фамилия>');
    expect(masked).toContain('<Имя>');
    expect(masked).toContain('<Отчество>');
    for (const value of ['Петров', 'Иван', 'Иванович']) {
      expect(masked).not.toContain(`>${value}<`);
    }
    expect(restored).toBe(source);
  });

  it('rejects invalid xml:lang/xml:space values (fail-closed, M8R2-M1)', async () => {
    for (const source of [
      '<root xml:lang="ivan@example.ru"/>',
      '<root xml:lang="Иван"/>',
      '<root xml:space="Иван Петров"/>',
      '<root xml:space="PRESERVE"/>',
    ]) {
      const vault = createVault(source);
      await expect(
        anonymizeXml(fileOf('reserved.xml', encoder.encode(source)), {
          vault,
          maxBytes: 1_000_000,
        }),
      ).rejects.toThrow(/xml:lang|xml:space|structural/iu);
      expect(vault.occurrences).toHaveLength(0);
      expect(vault.files).toHaveLength(0);
    }
  });

  it('accepts an empty xml:lang and keeps xml:space strict (M8R3-M2)', async () => {
    const source = '<root xml:lang=""><a xml:lang="ru-RU">ok</a></root>';
    const { masked, restored } = await roundTrip('empty-lang.xml', source);
    expect(masked).toContain('xml:lang=""');
    expect(restored).toBe(source);

    const strictSpace = '<root xml:space=""/>';
    const vault = createVault(strictSpace);
    await expect(
      anonymizeXml(fileOf('empty-space.xml', encoder.encode(strictSpace)), {
        vault,
        maxBytes: 1_000_000,
      }),
    ).rejects.toThrow(/xml:space|structural/iu);
    expect(vault.occurrences).toHaveLength(0);
  });

  it('rejects a PERSON subtag in xml:lang and accepts benign tags (M8R3)', async () => {
    for (const tag of ['en-US', 'ru-RU', 'und', 'x-private']) {
      const source = `<root xml:lang="${tag}"><a/></root>`;
      const { masked, restored } = await roundTrip('lang-ok.xml', source);
      expect(masked).toContain(`xml:lang="${tag}"`);
      expect(restored).toBe(source);
    }
    for (const tag of ['en-Ivan', 'en-Ivanov']) {
      const source = `<root xml:lang="${tag}"><a/></root>`;
      const vault = createVault(source);
      await expect(
        anonymizeXml(fileOf('lang-pii.xml', encoder.encode(source)), {
          vault,
          maxBytes: 1_000_000,
        }),
      ).rejects.toThrow(/structural|PII|xml:lang/iu);
      expect(vault.occurrences).toHaveLength(0);
      expect(vault.files).toHaveLength(0);
    }
  });

  it('keeps valid xml:lang/xml:space structural', async () => {
    const source = '<root xml:lang="ru-RU" xml:space="preserve"><a xml:lang="en">ok</a></root>';
    const { masked, restored } = await roundTrip('reserved-ok.xml', source);

    expect(masked).toContain('xml:lang="ru-RU"');
    expect(masked).toContain('xml:space="preserve"');
    expect(restored).toBe(source);
  });

  it('restores a non-canonical XML declaration encoding label exactly (M8R2-N3)', async () => {
    const source = '<?xml version="1.0" encoding="utf8"?><root name="Иван Петров">ok</root>';
    const { masked, restored } = await roundTrip('decl-encoding.xml', source);

    expect(masked).toContain('encoding="UTF-8"');
    expect(restored).toBe(source);
  });

  it('restores mixed line endings byte-exactly when nothing was masked (M8-M1)', async () => {
    const source = '<?xml version="1.0"?>\r\n<root>\n  <a>ok</a>\r\n</root>\r\n';
    const { restoredBytes, sourceBytes } = await roundTrip('mixed-eol.xml', source);

    expect(restoredBytes).toEqual(sourceBytes);
  });

  it('masks split first/last sibling elements as person parts (M8-2)', async () => {
    const source =
      '<person><first>Иван</first><last>Петров</last><email>ivan@example.ru</email></person>';
    const { masked, restored } = await roundTrip('person-split.xml', source);

    expect(masked).not.toContain('>Иван<');
    expect(masked).not.toContain('>Петров<');
    expect(masked).not.toContain('ivan@example.ru');
    expect(restored).toBe(source);
  });

  it('masks a lone name-context value but not unrelated or non-name-context ones', async () => {
    const lone = '<person><name>Иван</name></person>';
    const loneResult = await roundTrip('lone-name.xml', lone);
    expect(loneResult.masked).not.toContain('>Иван<');
    expect(loneResult.restored).toBe(lone);

    const unrelated = '<doc><first>Север</first><last>Юг</last></doc>';
    const unrelatedResult = await roundTrip('not-person.xml', unrelated);
    expect(unrelatedResult.masked).toContain('>Север<');
    expect(unrelatedResult.masked).toContain('>Юг<');

    const notNameContext = '<doc><nick>Иван</nick></doc>';
    const nickResult = await roundTrip('nick.xml', notNameContext);
    expect(nickResult.masked).toContain('>Иван<');
  });

  it('rejects long digit runs with a LeakGuard error (fail-closed, M8-3)', async () => {
    for (const source of ['<root>123456789</root>', '<root id="1700000000"/>']) {
      const vault = createVault(source);
      await expect(
        anonymizeXml(fileOf('digits.xml', encoder.encode(source)), {
          vault,
          maxBytes: 1_000_000,
        }),
      ).rejects.toThrow(/LeakGuard/u);
      expect(vault.occurrences).toHaveLength(0);
    }
  });

  it('returns application/xml (or text/xml) as maskedMime (M8-R2)', async () => {
    const plain = await anonymizeXml(
      fileOf('plain.xml', encoder.encode('<root>ok</root>'), 'text/plain'),
      { vault: createVault(''), maxBytes: 1_000_000 },
    );
    expect(plain.maskedMime).toBe('application/xml');

    const textXml = await anonymizeXml(
      fileOf('text.xml', encoder.encode('<root>ok</root>'), 'text/xml'),
      { vault: createVault(''), maxBytes: 1_000_000 },
    );
    expect(textXml.maskedMime).toBe('text/xml');
  });

  it('enforces the nesting limit and the configured byte limit', async () => {
    const deep = `${'<a>'.repeat(201)}x${'</a>'.repeat(201)}`;
    const deepVault = createVault(deep);
    await expect(
      anonymizeXml(fileOf('deep.xml', encoder.encode(deep)), {
        vault: deepVault,
        maxBytes: 1_000_000,
      }),
    ).rejects.toThrow(/nesting limit/u);

    const source = '<root>Иван Петров</root>';
    const vault = createVault(source);
    await expect(
      anonymizeXml(fileOf('big.xml', encoder.encode(source)), { vault, maxBytes: 4 }),
    ).rejects.toThrow(/limit/u);
  });

  it('leaves unknown tags untouched and reports them on restore', async () => {
    const source = '<root>[[ZZZZZ_PERSON_1]]</root>';
    const vault = createVault('');
    const restored = await restoreXml(fileOf('unknown.xml', encoder.encode(source)), vault);

    expect(decoder.decode(restored.bytes)).toBe(source);
    expect(restored.unknownTags).toEqual(['[[ZZZZZ_PERSON_1]]']);
    expect(restored.warnings[0]).toMatch(/unknown tag/u);
  });

  it('routes XML by extension and MIME', () => {
    expect(xmlFormatAdapter.format).toBe('xml');
    expect(
      xmlFormatAdapter.canHandle({ name: 'a.xml', mimeType: 'application/octet-stream' }),
    ).toBe(true);
    expect(xmlFormatAdapter.canHandle({ name: 'a.bin', mimeType: 'text/xml' })).toBe(true);
    expect(xmlFormatAdapter.canHandle({ name: 'a.bin', mimeType: 'application/xml' })).toBe(true);
    expect(xmlFormatAdapter.canHandle({ name: 'a.txt', mimeType: 'text/plain' })).toBe(false);
  });
});
