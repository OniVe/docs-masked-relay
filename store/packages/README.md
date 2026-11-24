# Пакет для Chrome Web Store — DocsMasked Relay 0.2.1

Готовый архив для загрузки в Chrome Web Store. Публикация не выполнялась и не входит в
задачу: загружает, отправляет на проверку и публикует владелец проекта.

## Файл пакета

| Параметр | Значение |
| --- | --- |
| Путь | `store/packages/DocsMaskedRelay-0.2.1-chrome-webstore.zip` |
| Размер | 5 994 242 байт (5,72 МиБ) |
| SHA256 | `b04ff97d5a7b285717c10c5d5a14c608d974e2decf14727c418ba031c759dbde` |
| Версия | 0.2.1 |
| Файлов внутри | 52 |
| Размер распакованного | 15 789 437 байт |

SHA256 и размер также записаны в `store/packages/SHA256SUMS`. Проверка целостности:

```bash
cd store/packages
sha256sum -c SHA256SUMS
```

Архив `.zip` намеренно не коммитится (см. `.gitignore` в этой папке): в репозитории
хранятся только `README.md`, `SHA256SUMS` и `.gitignore`, а сам ZIP передаётся владельцу
отдельно.

## Что загружать

Загружать в Chrome Web Store нужно **именно этот ZIP**:

`DocsMaskedRelay-0.2.1-chrome-webstore.zip`

Не загружать:

- `.exe` — это установщик для самостоятельной/enterprise-раздачи, не пакет магазина;
- `.crx` — это подписанный пакет для ручной установки, Chrome Web Store его не принимает;
- `.pem` — это приватный ключ подписи, его нельзя передавать или загружать куда-либо.

## Проверка пакета (выполнена)

- `manifest.json` лежит в корне архива, `"version": "0.2.1"`, Manifest V3.
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
  `e969928c2c0a6309f4c0c2b4dd9ea4ee15fa7036288d2bf62f5b2f0bf6ebf836`.

Пакет собран из текущего исходного кода командой `bun run zip` в `extension/`, версия
0.2.1. ZIP не коммитится: его нужно собрать локально и при необходимости переименовать в
`DocsMaskedRelay-0.2.1-chrome-webstore.zip` перед загрузкой в магазин.

## Чек-лист Chrome Web Store

1. **Аккаунт:** Chrome Web Store Developer Dashboard, подтверждённый контактный email,
   2FA, регистрационный сбор (исторически 5 USD; проверить актуальную сумму).
2. **Новый элемент:** Dashboard → New item → загрузить
   `DocsMaskedRelay-0.2.1-chrome-webstore.zip`. Убедиться, что dashboard показывает
   версию 0.2.1, название и описание.
3. **Листинг:** тексты брать из `store/chrome-listing.md` — название, краткое и полное
   описание, категория, обоснование разрешений, ответы о данных. Там остаются
   placeholder-ы, которые заполняет владелец; этот файл не изменялся.
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
