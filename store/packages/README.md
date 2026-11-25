# Пакет для Chrome Web Store — DocsMasked Relay 0.2.2

Готовый архив для загрузки в Chrome Web Store. Публикация не выполнялась и не входит в
задачу: загружает, отправляет на проверку и публикует владелец проекта.

## Файл пакета

| Параметр | Значение |
| --- | --- |
| Путь | `store/packages/DocsMaskedRelay-0.2.2-chrome-webstore.zip` |
| Размер | 5 996 396 байт (5,72 МиБ) |
| SHA256 | `aa81f1d5281a3906f2e0a58ab915f317c56db77c69e9192f32509349ce364428` |
| Версия | 0.2.2 |
| Файлов внутри | 52 |
| Размер распакованного | 15 797 859 байт |

SHA256 и размер также записаны в `store/packages/SHA256SUMS`. Проверка целостности:

```bash
cd store/packages
sha256sum -c SHA256SUMS
```

Архив `.zip` намеренно не коммитится (см. `.gitignore` в этой папке): в репозитории
хранятся только `README.md`, `SHA256SUMS` и `.gitignore`, а сам ZIP передаётся владельцу
отдельно.

## История пакетов

| Версия | Файл | Размер | SHA256 | Статус |
| --- | --- | --- | --- | --- |
| 0.2.2 | `DocsMaskedRelay-0.2.2-chrome-webstore.zip` | 5 996 396 байт | `aa81f1d5281a3906f2e0a58ab915f317c56db77c69e9192f32509349ce364428` | подготовлен к отправке |
| 0.2.1 | `DocsMaskedRelay-0.2.1-chrome-webstore.zip` | 5 994 373 байт | `aa70edb0c7c60353f6e9638a2c712e28939fbec54e6d1b03fd2e590bd009c6db` | опубликован 2026-11-25 |
| 0.2.0 | `DocsMaskedRelay-0.2.0-chrome-webstore.zip` | 5 993 985 байт | `6ff5fd9da50cbd068e35e6aa95eb084d22ddebfd17a69626fe70189852f385a1` | опубликован 2026-11-24, заменён 0.2.1 |

## Что загружать

Загружать в Chrome Web Store нужно **именно этот ZIP**:

`DocsMaskedRelay-0.2.2-chrome-webstore.zip`

Не загружать:

- `.exe` — это установщик для самостоятельной/enterprise-раздачи, не пакет магазина;
- `.crx` — это подписанный пакет для ручной установки, Chrome Web Store его не принимает;
- `.pem` — это приватный ключ подписи, его нельзя передавать или загружать куда-либо.

## Проверка пакета (выполнена)

- `manifest.json` лежит в корне архива, `"version": "0.2.2"`, Manifest V3, разрешения не
  изменились: `storage`, `unlimitedStorage`, `offscreen`.
- 52 файла; совпадает с текущей сборкой `.output/chrome-mv3`.
- Нет `.map`, `.ts`, `.tsx`, `.pem`, `.crx`, `node_modules`, тестов/спеков, `.env` и
  исходных карт.
- Присутствуют: иконки 16/32/48/128, `popup.html` и `options.html`, content scripts
  (`content-scripts/chatgpt-main.js`, `content-scripts/chatgpt.js`), `background.js`,
  `offscreen.html`, WASM (`assets/background.wasm`, `assets/pii-scan-DciHxcPO.wasm`,
  `assets/embedpdf-sCpuZ3oM.wasm`).
- `unzip -t` — без ошибок.
- SHA256 `background.js` внутри ZIP совпадает с
  `extension/.output/chrome-mv3/background.js`:
  `bd29837466dcf579ce2c8032a7ba247640b16cb58d3090abf48dc77a290ae804`.

Пакет собран из текущего исходного кода командами `bun run build` и `bun run zip` в
`extension/`, версия 0.2.2. ZIP не коммитится: его нужно собрать локально и при
необходимости переименовать в `DocsMaskedRelay-0.2.2-chrome-webstore.zip` перед загрузкой
в магазин.

## Чек-лист Chrome Web Store

1. **Аккаунт:** Chrome Web Store Developer Dashboard, подтверждённый контактный email,
   2FA, регистрационный сбор (исторически 5 USD; проверить актуальную сумму).
2. **Новый элемент:** Dashboard → New item → загрузить
   `DocsMaskedRelay-0.2.2-chrome-webstore.zip`. Убедиться, что dashboard показывает
   версию 0.2.2, название и описание.
3. **Листинг:** тексты брать из `store/chrome-listing.md` — название, краткое и полное
   описание, категория, обоснование разрешений, ответы о данных. Там остаются
   placeholder-ы, которые заполняет владелец.
4. **Графика:** иконка `store/assets/icon-128.png` (128×128) и четыре скриншота
   1280×800 из `store/assets/`:
   `screenshot-options-1280x800.png`, `screenshot-options-columns-1280x800.png`,
   `screenshot-custom-rules-1280x800.png`, `screenshot-popup-1280x800.png`.
   На скриншотах только синтетические данные.
5. **Приватность:** URL политики конфиденциальности и support/website URL **всё ещё
   предоставляет владелец**. Нужен публичный HTTPS-адрес размещённого
   `store/privacy-policy.html`; выдумывать URL нельзя. Контакт поддержки также
   owner-provided.
6. **Трейдер (EU DSA):** указать статус **non-trader / не трейдер** — расширение
   бесплатное, без монетизации, подписок и встроенных покупок. Финальное решение и
   ответственность за декларацию остаются за владельцем.
7. **Отправка:** заполнить Privacy practices, test instructions (из
   `store/chrome-listing.md` / `store/review-notes.md`), затем **Submit for review**.
   Публикацию не выполнять до явного одобрения владельца.

## Дополнительно

- Полный чек-лист отправки: `store/SUBMISSION.md`.
- Инструкции для ревьюера: `store/review-notes.md`.
- Политика конфиденциальности: `store/privacy-policy.html`.
- Для Microsoft Edge Add-ons используется тот же Chromium MV3-пакет; листинг —
  `store/edge-listing.md`.
