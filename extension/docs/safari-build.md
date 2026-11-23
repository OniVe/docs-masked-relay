# Сборка и подпись Safari Web Extension

Дата: 22.11.2026. Актуально для Safari 18+ / macOS Sonoma+.

На Windows Safari-расширение **не собрать, не подписать и не загрузить**. В репозитории
готовятся исходники и Safari-манифест; все шаги ниже выполняются на macOS с Xcode.

## 1. Что подготовлено в репозитории

```bash
cd extension
bun install
bun run check
bun run test
bun run typecheck
bun run build:safari
```

Результат: `.output/safari-mv3/`.

WXT-хук `build:manifestGenerated` переписывает manifest для Safari:

- `background: { "scripts": ["background.js"], "persistent": false }` вместо
  `service_worker`;
- удаляются `offscreen` и `downloads` permissions (их в Safari нет);
- content scripts остаются статическими, включая `world: "MAIN"` (Safari 18+);
- PDF обрабатывается в background page, а не в offscreen-документе.

Проверка без macOS:

```bash
bun -e "const m=require('./.output/safari-mv3/manifest.json'); console.log(m.background, m.permissions, m.content_scripts.map(s=>s.world))"
```

Ожидается `background.scripts`, `persistent:false`, permissions `storage` +
`unlimitedStorage`, два content script (`MAIN` и ISOLATED).

## 2. Требования на macOS

- macOS Sonoma 14+ (рекомендуется последняя).
- Xcode 15/16+ и Command Line Tools: `xcode-select --install`.
- Safari 18+.
- Apple Developer Program ($99/год) — для App Store или Developer ID + notarization.
- Bun 1.4+ и Node 24 (для сборки WXT).
- Свободный bundle identifier, например `com.example.docs-masked-relay`.

Проверка инструментов:

```bash
xcrun --version
xcrun safari-web-extension-converter --help
security find-identity -v -p codesigning
```

## 3. Конвертация в Xcode-проект

```bash
cd extension
bun run build:safari

xcrun safari-web-extension-converter .output/safari-mv3 \
  --project-location build/safari \
  --bundle-identifier com.example.docs-masked-relay \
  --app-name "DocsMasked Relay" \
  --swift \
  --macos-only \
  --no-open
```

Параметры:

- `--project-location` — куда создать проект (каталог не должен существовать или
  допускается перезапись с `--force`).
- `--bundle-identifier` — уникальный id; Xcode создаст app + extension targets.
- `--app-name` — отображаемое имя.
- `--swift` — Swift-обертка (наш код JS/TS, Swift только контейнер).
- `--macos-only` — без iOS target (iOS вне MVP).
- `--no-open` — не открывать Xcode автоматически.
- `--copy-resources` — копировать ресурсы в проект вместо ссылки на `.output`; удобно для
  архива, но требует повторной конвертации после каждого build.

Откройте проект:

```bash
open "build/safari/DocsMasked Relay/DocsMasked Relay.xcodeproj"
```

В Xcode проверьте, что extension target содержит `manifest.json`, `background.js`,
`content-scripts/`, `chunks/`, `assets/`, `offscreen.html` (файл может остаться в
бандле, но Safari его не использует), `icon/`.

## 4. Настройки Xcode

1. Выберите app target → **Signing & Capabilities** → Team, автоматическая подпись.
2. Bundle Identifier: `com.example.docs-masked-relay` (app) и
   `com.example.docs-masked-relay.Extension` (extension).
3. Version / Build: например `0.1.0` / `1`; для App Store каждая загрузка — новый build.
4. Deployment target: macOS 14.0+; Safari 18+ на тестовой машине.
5. App Sandbox: включен по умолчанию; сеть не требуется самому расширению (запросы идут
   из page context), host permissions уже в manifest.
6. Hardened Runtime: включен для Developer ID; для App Store — как предлагает Xcode.
7. Убедитесь, что extension target **embedded** в app (Frameworks/PlugIns).

## 5. Privacy manifest и App Privacy

Добавьте `PrivacyInfo.xcprivacy` в app и extension targets (File → New → Property List,
имя строго `PrivacyInfo.xcprivacy`). Минимальный шаблон:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key>
  <false/>
  <key>NSPrivacyTrackingDomains</key>
  <array/>
  <key>NSPrivacyCollectedDataTypes</key>
  <array/>
  <key>NSPrivacyAccessedAPITypes</key>
  <array/>
</dict>
</plist>
```

Обоснование: расширение не собирает данные для разработчика; файлы обрабатываются
локально. Если позже появятся `UserDefaults`/file timestamp/disk space APIs, добавьте
соответствующие `NSPrivacyAccessedAPIType` с reason-кодами. В App Store Connect в
App Privacy укажите **Data Not Collected**; tracking — off.

## 6. Локальная проверка

1. Запустите app scheme в Xcode (My Mac).
2. Safari → Settings → Advanced → Show features for web developers.
3. Develop → Allow Unsigned Extensions (при локальной сборке без подписи; после
   перезапуска Safari флаг сбрасывается).
4. Safari → Settings → Extensions → включите DocsMasked Relay, выдайте доступ к
   chatgpt.com.
5. Проверьте:
   - popup и options открываются;
   - `dm:settings-get` отвечает, toggle меняет `dmProtection`;
   - upload TXT/DOCX/XLSX маскируется; download с тегами восстанавливается;
   - ручной режим работает;
   - PDF: background page запускает PDFium; при недоступном runtime — fail-closed и
     предложение ручного режима;
   - passphrase: включение, lock, unlock, смена, снятие, export/import;
   - после перезапуска Safari vault в passphrase-режиме остается заблокированным.

Проверка консоли: Develop → Web Extension Background Page / popup. Логи не должны
содержать PII или парольные фразы.

## 7. Распространение

### Вариант A: App Store

1. App Store Connect → My Apps → New App (macOS).
2. Product → Archive → Distribute App → App Store Connect → Upload.
3. TestFlight → внутреннее тестирование.
4. Заполните App Privacy, категории, скриншоты, privacy policy URL (хостится на вашем
   сайте; текст — `PRIVACY.md`).
5. Отправьте на review. После одобрения расширение устанавливается из App Store.

### Вариант B: Developer ID + notarization (Safari 18.4+)

1. Сертификат **Developer ID Application** в Keychain.
2. Product → Archive → Distribute App → Developer ID → Export.
3. Подпишите вложенный extension и app (Xcode делает это при export; проверьте
   `codesign -dv --verbose=4 <app>`).
4. Нотаризация:

   ```bash
   xcrun notarytool submit "DocsMasked Relay.zip" \
     --apple-id "you@example.com" \
     --team-id "TEAMID" \
     --password "@keychain:AC_PASSWORD" \
     --wait
   xcrun stapler staple "DocsMasked Relay.app"
   ```

5. Распространяйте `.app`/`.dmg`. Пользователь открывает приложение один раз, затем
   включает расширение в Safari → Settings → Extensions. Safari 18.4+ поддерживает
   notarized extensions вне App Store; на более старых версиях может потребоваться
   App Store.

## 8. Ограничения Safari

- Нет `browser.offscreen`: PDF идет через background page (DOM есть), не через
  service worker.
- Нет `browser.downloads` и `debugger`; скачивание восстанавливается только
  page-context fetch/XHR.
- `storage.local` ограничен; vault хранится в IndexedDB.
- MAIN world: статический `world:"MAIN"` требует Safari 18+; для 16.4–17 нужна
  динамическая регистрация из background (в текущей сборке не реализована).
- Автоматический перехват — desktop-only; iOS share sheet не поддерживается.
- Notarization/App Store требуют Apple Developer и macOS; Windows-сборка не подписывается.
- Safari может приостанавливать background page; PDF/большие файлы тестируйте вручную.

## 9. Чек-лист релиза Safari

- [ ] `bun run check && bun run test && bun run typecheck && bun run build:safari`.
- [ ] manifest: `background.scripts`, `persistent:false`, нет `offscreen`/`downloads`.
- [ ] Иконки 16/32/48/128 в бандле.
- [ ] `PrivacyInfo.xcprivacy` в app и extension.
- [ ] App Privacy = Data Not Collected, tracking off.
- [ ] Тест upload/download/manual/PDF/passphrase на Safari 18+.
- [ ] Проверены логи без PII.
- [ ] App Store: build загружен, review пройден; Developer ID: notarization + staple.
