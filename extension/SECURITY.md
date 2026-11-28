# Безопасность DocsMasked Relay

Краткая модель угроз и правила для разработки. Полная политика конфиденциальности —
[`PRIVACY.md`](./PRIVACY.md); модель угроз — ниже.

## 1. Что защищаем

1. **Случайную отправку PII в ChatGPT.** Файл проходит детекторы локально; при ошибке,
   лимите, неизвестном формате или заблокированном vault отправка блокируется
   (fail-closed), а не идет в исходном виде.
2. **Локальный vault.** Оригинальные значения и имена файлов лежат только в
   зашифрованном виде в IndexedDB расширения.

Не защищает: от самого OpenAI после отправки, от вредоносного ПО/скомпрометированного
браузера/профиля, от других расширений с широкими правами, от пользователя, который сам
отключил защиту или скопировал PII в чат.

## 2. Ключи и vault

- Master key: случайные 32 байта, AES-GCM-256, в памяти как `extractable:false`.
- По умолчанию master key обернут неэкспортируемым device key (`CryptoKey` в IndexedDB).
- Опционально — парольная фраза: PBKDF2-SHA256, 600 000 итераций, соль 16 байт; без
  пароля vault остается заблокированным после старта.
- Vault: AES-GCM, случайный 12-байтовый IV, AAD = `id|schema`.
- Блокировка очищает master key из памяти и сбрасывает инициализацию; автоблокировка по
  умолчанию 15 минут (настраивается 1–240).
- Экспорт/импорт — только зашифрованный JSON (`dmrelay-export/1`) с отдельной парольной
  фразой; импорт отклоняет конфликт id/prefix целиком. Явный импорт после полной
  валидации снимает tombstone только для id из бэкапа (удалённый в этой сессии vault
  можно восстановить) и пишет все vault одним батчем; при ошибке записи tombstone
  возвращаются и частичных строк не остаётся (R4-M1).
- Content scripts не расшифровывают vault и не получают канонические значения. Только
  background/offscreen владеют ключами.
- Смена пароля требует текущую фразу и атомарно переоборачивает master key; снятие
  пароля также требует текущую фразу.
- «Очистка данных» удаляет базу целиком (vault, ключи, настройки) и создает новую
  пустую; отменить нельзя. Очистка увеличивает поколение vault: запись, начатая до
  очистки и завершившаяся после, отклоняется и не воскрешает vault.

## 3. Сообщения и границы доверия

- MAIN ↔ ISOLATED: `postMessage` с проверкой source/origin/shape/размера, requestId и
  таймаутами; MAIN не имеет доступа к `chrome.*`.
- ISOLATED ↔ background: runtime-сообщения с `requestId`, строгой валидацией payload и
  стабильными кодами ошибок (`LIMIT`, `UNSUPPORTED`, `NO_VAULT`, `INTERNAL`, `LOCKED`,
  `DISABLED`, `BAD_PASSPHRASE`, `CONFLICT`).
- Настройки и состояние защиты приходят в ISOLATED через `dm:settings-get` и
  `dm:settings-changed`; MAIN получает только булев `enabled` и по умолчанию считает
  защиту включенной.
- Ошибки и логи не содержат значений PII, имен файлов, паролей и ключей. Тексты ошибок —
  константы.
- **Уровень доверия к странице.** MAIN/ISOLATED-скрипты работают в origin chatgpt.com.
  Скрипт страницы (или XSS на ней) может подделать `postMessage` (settings-push, ответы
  по id) и инициировать restore-file/restore-name для известных prefix/тегов —
  restore-oracle. Это не песочница против скомпрометированной страницы. Кандидаты
  решения: MessageChannel с токеном, привязка restore к ожидаемому download mapping или
  явное подтверждение пользователя. До решения риск принят и зафиксирован здесь.
- Маркеры привязки чата (`PENDING_KEY`/`BIND_KEY`) лежат в `sessionStorage` страницы
  chatgpt.com и доступны page-скрипту: они не являются границей доверия и могут быть
  подделаны. Они лишь ускоряют поиск vault; сам restore требует существующий vault с
  известным prefix. Тот же принятый риск restore-oracle.
- `customTerms` и `allowlist` хранятся в строке настроек **в открытом виде** (вне
  шифрованного vault). Не вносите туда PII; шифрование списков — отдельное решение
  владельца (см. PRIVACY.md §3).

## 4. Лимиты и fail-closed

- Файл: по умолчанию 25 МБ, настраивается 1 КБ–100 МБ; при превышении — `LIMIT`.
- PDF: до 200 страниц; сканы без текстового слоя — отказ; redaction необратим.
  Санитизация удаляет page-level `/Metadata`/`/PieceInfo`/`/AF`, все аннотации и
  формы (widgets/FreeText `/V`/`/AP`), catalog carriers и рекурсивно — `/Metadata`,
  `/PieceInfo`, `/AF`, `/AA` на всех reachable-объектах (image/Form XObjects,
  fonts, patterns, annotation dictionaries), затем prune'ит unreachable objects.
  `assertNoResidualPii` сканирует сырые финальные байты по детектированным
  оригинальным поверхностям (UTF-8/UTF-16BE/LE; первые 1000 уникальных поверхностей,
  при усечении — warning с counts, R7) и рекурсивно проверяет отсутствие carrier-ключей;
  остаток → файл не отправляется.
- Неизвестный формат/транспорт/не найден захваченный File — abort загрузки и toast.
  После переписанного metadata abort'ится только вероятный транспорт: точный
  `upload_url`, известные hosts/paths (oaiusercontent, estuary, Azure block) и
  cross-origin object-storage из `upload_url` — `*.blob.core.windows.net` (plain Azure
  SAS PUT без `comp`), `*.amazonaws.com` (S3), `*.cloudfront.net` (CDN). Для cloud
  storage обязательны совпадение размера тела с `originalSize` и upload-креденшелы
  (подписанный URL: `sig`/`X-Amz-*`/`Signature`/`Policy`/`Key-Pair-Id`, либо
  cloud-заголовки `x-ms-blob-type`/`x-amz-*`); opaque stream без размера abort'ится;
  для остальных вероятных транспортов размер вспомогательный. Cloud-entry по
  size-match помечается claimed и не изымается: точный `upload_url` её использует,
  повторный вероятный транспорт без точного URL abort'ится, а не проходит с
  оригиналом. Unrelated PUT/POST того же размера на прочих hosts проходит и не
  забирает запись, entry остаётся реальному транспорту (R3-N1/R4-M2/R5-N1). Прочие
  opaque Blob/stream/Request-тела и JSON проходят. Запись сопоставления живёт
  2 минуты. При включённой защите каждый точный `upload_url` из metadata-response
  остаётся fail-closed tombstone до выгрузки страницы (bounded 64 URL): PUT/POST
  на него без живой entry — TTL, eviction или повтор — abort'ится как `TRANSPORT`,
  в том числе opaque stream; оригинальные байты не уходят. При переполнении bound
  самый старый URL забывается, но `announcedOverflow` остаётся выставленным и любой
  несовпавший PUT/POST на известный транспорт abort'ится. Если metadata-response
  нечитаем (non-JSON, >64 KB, malformed или без пригодного `upload_url`), факт
  запоминается как `unannounced` до выгрузки страницы (bounded 64): живая entry
  отдаёт masked bytes, а после её истечения/eviction любой несовпавший PUT/POST
  на известный транспорт abort'ится как `TRANSPORT` (R6). Новые metadata/upload
  и unrelated URL работают; выключение защиты — явное действие, новые
  pass-through upload'ы старым tombstone не блокируются (R2/R5/R6).
- XLSX pivot cache: `<n>` в `sharedItems` и records, а также `minValue`/`maxValue` —
  `xsd:double`; перед проверкой значение канонизируется (`.0`, exponent-запись),
  numeric CARD/PHONE/ACCOUNT/INN/SNILS/OGRN — fail-closed, неразборчивый numeric
  lexeme — fail-closed; `<d>`/`<s>` не ломаются (EMP-R1-v3).
- JSON: strict JSON (комментарии/trailing comma — отказ); строки и ключи маскируются,
  числа не меняются. Числовой INN/SNILS/OGRN/Luhn CARD/20-значный ACCOUNT/PHONE
  отклоняет файл fail-closed (смена типа недопустима); JSONL — all-or-nothing по
  каждой непустой строке. Строка из длинной цифровой серии (≥7 цифр) отклоняется
  LeakGuard (`paranoid:digits`) — принятое fail-closed поведение без утечки; LeakGuard
  не ослабляется. Name-контекст (`first/last/middle/surname/.../фио/имя/фамилия/
  отчество`) маскируется role-aware per-field: PERSON-детектор (включая частичный
  span трёхчастного ФИО) или однословное имя/фамилия/отчество по словарю; покрыты
  non-adjacent, cross-level, arrays, XML attributes/CDATA/nested/cross-parent;
  каждое значение — отдельный тег. Соседние `first`/`last`/`surname`-поля
  по-прежнему склеиваются для проверки полного ФИО.
- XML: `scanXml` отклоняет DOCTYPE/DTD и неизвестные entities (XXE/billion-laughs);
  маскируются text nodes, CDATA и значения атрибутов. Комментарии и processing
  instructions очищаются one-way (в vault не попадают); CDATA с PII заменяется
  escaped-текстом, чтобы тег на границе не создал `]]>`. `xml:lang`, `xml:space` и
  namespace-декларации структурны; `xml:lang` валидируется как BCP47-подобный,
  `xml:space` — только `default|preserve`, invalid → fail-closed throw (иначе PII
  в значении прошла бы в masked bytes). `xml:base`, `xml:id` и прочие `xml:*`
  маскируются; URI/identifier-значение делится на сегменты, percent-decode-ится и
  проверяется по одному/парами/тройками: имя в path (`/ivan`, `/ivan_petrov`,
  `/Иван_Петров`) и lone id маскируются всем значением одним тегом с точным
  restore. Имена элементов/атрибутов, PI target и namespace URI не маскируются,
  но high-confidence PII в них (детекторы + capitalized-кириллица + case-insensitive
  Latin name/surname dictionary; полевой allowlist `Фамилия/Имя/Отчество/first/
  last/name/...` не считается PII) отклоняет файл fail-closed; сообщение об ошибке
  не содержит значение. URI-подстрока с userinfo
  (`https://ivan:petrov@example.ru/path`, `//user@example.ru/path`) в
  text/CDATA/любом non-structural атрибуте маскируется одним тегом с сохранением
  окружающей прозы (M8-1 r3), иначе login остался бы в masked bytes.
  URI-сегментный анализ path/query применяется в text/CDATA и во всех
  non-structural атрибутах (`See https://example.ru/ivan now`,
  `url="https://example.ru/ivan"`); non-hierarchical `urn:ivan`/`urn:Иван_Петров`
  анализируются в обычных атрибутах, а `mailto:` с email сохраняет email-тег
  (login входит в email-span). Benign URL без userinfo/PII не меняются;
  restore точный. Namespace URI проверяется в raw- и одном safe percent-decoded
  виде (M8R3-M1); пустой `xml:lang=""` допустим,
  PERSON-subtag (`en-Ivan`) отклоняет файл (M8R3). Принятое ограничение M8-M2
  (arbiter: under — undecidable, over/closing — refuted): structural names/PI
  target/namespace URI — схема документа, не пользовательские данные;
  high-confidence PII (email/phone/URL/полное имя/percent-decoded) — fail-closed,
  одиночные не-словарные Latin-фамилии (`Sidorov`) — граница охвата детектора,
  словарь не расширяется; over-block `<roman>`/`<peter>` — принятый fail-closed.
  NIT meta F3 (M8R4-N1/N2/N3): generic `scheme:value` в обычном атрибуте
  (`Chapter:Ivan`) может быть принят за opaque URI и замаскирован как PERSON —
  fail-closed over-block benign-значения, restore точный, PII-утечки нет,
  принято как NIT; double-encoded/malformed percent namespace (`urn:%25D0%2598...`, `%ZZ`)
  проходит один safe percent-decode — synthetic structural URI, не user data,
  out_of_scope (high-confidence one-level encoded PII по-прежнему fail-closed);
  opaque scheme (`urn:ivan`) в text/CDATA не анализируется — out_of_scope,
  обычные атрибуты покрыты, userinfo/path в prose (hierarchical URL) маскируются.
  NIT: printable-prefix binary `.txt`
  может пройти sniff (M8R3-N2; нужен текстовый response MIME); MD mixed EOL не
  пере-нормализуется; CDATA-разметка one-way (текст восстанавливается). Лимиты:
  глубина 200, 1M узлов; declaration encoding label сохраняется дословно и
  восстанавливается точно (upload — UTF-8), mixed EOL при restore не
  пере-нормализуется.
- TXT/MD без BOM: эвристика UTF-16 (NUL-паритет, astral-пары, script-score включая
  Han). Валидный printable UTF-8 всегда остаётся UTF-8 (UTF-8-first): ASCII/email/
  URL/код не переклассифицируются в UTF-16 по strong-script-кандидату (EMP-R2-v2).
  Warning `ambiguous` — только для буфера ≥ 16 байт, UTF-8 без пробелов с
  пунктуацией и strong-script-only UTF-16-чтения ≥ 2 code units; короткие ASCII
  (`a>bc`) не предупреждаются (R5-N2). Точный tie BOM-less UTF-16 даёт
  документированный LE и warning `ambiguous`. Короткий CJK-only без BOM, байты
  которого совпадают с printable ASCII (`漢字漢字`), читается как UTF-8 без warning —
  принятый NIT (R4-N2/EMP-R2-v2).
- PDF identity: новый vault сохраняется при resolve под коротким локом; финальная
  запись идёт только в vault, перечитанный по id. Если vault удалён/очищен во время
  работы PDF-движка, запись отклоняется (tombstone), stale reference не воскрешает
  vault; второй PDF/TXT в том же чате присоединяется к сохранённому vault (R3-M1).
  Последний упавший PDF-прогон удаляет общий пустой vault (remaining===0), поэтому два
  failed PDF не оставляют пустую запись (R4-N1).
- Скачивание никогда не блокируется: при `LOCKED`/ошибке файл сохраняется как есть, с
  предупреждением. Если теги есть в имени/download_url или (для TXT/MD/JSON/XML) в теле, но
  замен `0` (неизвестные теги или пустой vault), показывается `MANUAL_FALLBACK`/
  `NO_VAULT`, а unknown tags попадают в warnings. Файл без тегов и без vault по chatId
  проходит молча. Body-tag probe доверяет только текстовому response content-type или
  текстовому имени/расширению; metadata `mime_type` не считается доверенным, поэтому
  binary с лживым `mime_type: text/plain` проходит без restore/MANUAL_FALLBACK.
  Дополнительно `.txt/.md/.json/.xml` с binary response требует printable/UTF-8
  sniff: бинарное тело с тегом не probe-ится и не восстанавливается. Restore-adapter
  получает текстовый response content-type с приоритетом над metadata `mime_type`
  (metadata — fallback), поэтому metadata-lie `application/octet-stream` не мешает
  восстановлению. PDF-путь включается только для `.pdf` или неизвестного расширения
  - `application/pdf`; `.json`/`.txt`/`.xml` + `application/pdf` идут в свой адаптер.
- PDF runtime недоступен (Safari/offscreen) — fail-closed, ручной режим.
- In-page toast авто-пути показывает entity counts и первые 3 warning'а адаптера
  (несканированные носители, altChunk, inferred encoding, PDF sanitation) плюс
  «ещё M»; полный список остаётся в popup. Warning'и — только счётчики/метки, без
  значений PII.
- LeakGuard повторно проверяет текст/метаданные/имена и блокирует остатки PII, если
  включен.

## 5. Release-инварианты

- Нет `eval`, удаленного кода и внешних запросов, кроме ChatGPT/OpenAI signed URL.
- WASM и worker входят в бандл; CSP: `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`.
- Нет разрешений `debugger`, `downloads`, `<all_urls>`; host permissions только
  chatgpt.com/chat.openai.com/*.oaiusercontent.com.
- Метаданные документов очищаются всегда (`stripMetadata` принудительно `true`).
- Passphrase никогда не логируется, не сохраняется и не возвращается в ответах.

## 6. Сообщить об уязвимости

Не создавайте публичный issue с деталями эксплуатации. Используйте приватный контакт
владельца проекта или приватный security advisory в репозитории. Укажите версию,
браузер, шаги воспроизведения и ожидаемое/фактическое поведение без реальных PII.
