<!-- Improved compatibility of back to top link -->
<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![CI][ci-shield]][ci-url]
[![License][license-shield]][license-url]
[![Chrome Web Store][cws-shield]][cws-url]
[![Manifest V3][mv3-shield]][mv3-url]
[![TypeScript][ts-shield]][ts-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/OniVe/docs-masked-relay">
    <img src="store/assets/icon-128.png" alt="DocsMasked Relay" width="80" height="80">
  </a>

  <h3 align="center">DocsMasked Relay</h3>

  <p align="center">
    Локальная анонимизация персональных данных в файлах для ChatGPT.
    <br />
    Исходные значения и зашифрованное хранилище остаются на устройстве.
    <br />
    <br />
    <a href="#о-проекте"><strong>О проекте</strong></a>
    &middot;
    <a href="#начало-работы"><strong>Начало работы</strong></a>
    &middot;
    <a href="https://github.com/OniVe/docs-masked-relay/issues">Сообщить об ошибке</a>
    &middot;
    <a href="https://github.com/OniVe/docs-masked-relay/issues">Предложить функцию</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Содержание</summary>
  <ol>
    <li><a href="#о-проекте">О проекте</a></li>
    <li><a href="#технологии">Технологии</a></li>
    <li>
      <a href="#начало-работы">Начало работы</a>
      <ul>
        <li><a href="#требования">Требования</a></li>
        <li><a href="#установка">Установка</a></li>
      </ul>
    </li>
    <li><a href="#использование">Использование</a></li>
    <li><a href="#планы">Планы</a></li>
    <li><a href="#участие">Участие</a></li>
    <li><a href="#лицензия">Лицензия</a></li>
    <li><a href="#контакты">Контакты</a></li>
    <li><a href="#благодарности">Благодарности</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
<a id="о-проекте"></a>
## О проекте

[![DocsMasked Relay — настройки][product-screenshot]](https://github.com/OniVe/docs-masked-relay)

DocsMasked Relay — браузерное расширение для Chrome и Edge (Manifest V3). Оно помогает
отправлять файлы в ChatGPT с меньшим риском для персональных данных: находит имена,
телефоны, адреса, email и другие данные, заменяет их метками и отправляет только
обезличенную копию. При скачивании файла с метками расширение возвращает исходные байты и
имя из локального зашифрованного хранилища.

Всё работает в браузере: нет сервера, аккаунта, телеметрии, аналитики, рекламы и
загружаемого кода. В ChatGPT уходит обезличенный файл; исходные значения, ключи и vault
остаются на устройстве.

Почему это полезно:

* **Локальная обработка.** Файлы не отправляются на наш сервер — его просто нет.
* **Восстановление.** Для поддерживаемых форматов можно вернуть исходный текст и имя файла.
* **Ручной режим.** Работает без ChatGPT, если автоматический перехват недоступен.
* **Свои правила.** Можно задать точные термины и метки для них.
* **Открытый код.** MIT; сторонние компоненты перечислены в [NOTICE](NOTICE).

Ограничения: PDF редактируется необратимо; сканы без текстового слоя блокируются; сложная
вёрстка старых офисных файлов может потеряться; автоматические проверки вероятностны.
Расширение не защищает от OpenAI и не заменяет юридическую консультацию.

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- BUILT WITH -->
<a id="технологии"></a>
## Технологии

* [![TypeScript][ts-shield]][ts-url]
* [![WXT][wxt-shield]][wxt-url]
* [![Chrome MV3][mv3-shield]][mv3-url]
* [![Rust WASM][rust-shield]][rust-url]
* [![Bun][bun-shield]][bun-url]
* [![Playwright][playwright-shield]][playwright-url]

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- GETTING STARTED -->
<a id="начало-работы"></a>
## Начало работы

### Требования

* Chrome или Edge stable (Chromium MV3).
* [Bun](https://bun.sh/) 1.4.2+ — для сборки и тестов.
* Git.
* Windows, macOS или Linux для разработки. Safari собирается только на macOS.

### Установка

**Из магазина.** Установите расширение из
[Chrome Web Store](https://chromewebstore.google.com/detail/docsmasked-relay/iieopopifchankeeciiekichbcfdbdnl).

**Локальная сборка:**

```sh
git clone https://github.com/OniVe/docs-masked-relay.git
cd docs-masked-relay/extension
bun install --frozen-lockfile
bun run build
```

Затем в `chrome://extensions` или `edge://extensions` включите режим разработчика и
загрузите папку `extension/.output/chrome-mv3` через **Load unpacked**.

**Проверки:**

```sh
cd extension
bun run ci          # Biome + tsc + 684 unit-тестов
bun run test:e2e    # Playwright, только fixed harness, один worker
```

E2E требует стабильный профиль браузера; не запускайте параллельные профили на одной
Windows-учётной записи.

**Enterprise / self-hosted:** см. [installer/enterprise/README.md](installer/enterprise/README.md).

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- USAGE -->
<a id="использование"></a>
## Использование

1. Откройте окно расширения и убедитесь, что защита включена.
2. Загрузите поддерживаемый файл в ChatGPT как обычно — расширение заменит данные метками.
3. При скачивании файла из чата расширение восстановит исходные значения, если vault
   разблокирован.
4. Если автоматический перехват не сработал, используйте **Ручной режим**: выберите файл,
   нажмите **Анонимизировать и скачать**, затем при необходимости **Восстановить и скачать**.

[![Ручной режим][popup-screenshot]](https://github.com/OniVe/docs-masked-relay)

Подробности: [extension/README.md](extension/README.md), [PRIVACY.md](extension/PRIVACY.md),
[SECURITY.md](extension/SECURITY.md).

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- ROADMAP -->
<a id="планы"></a>
## Планы

- [x] Локальная анонимизация и восстановление для офисных, текстовых и структурированных файлов
- [x] PDF redaction, ручной режим, vault с парольной фразой
- [x] WASM-детекторы и ZIP-кодек
- [x] Публикация в Chrome Web Store
- [ ] Edge Add-ons
- [ ] Safari Web Extension для macOS
- [ ] Расширение покрытия реальными Word/LibreOffice/PDFium-сценариями

Список задач и известных ограничений — в [issues](https://github.com/OniVe/docs-masked-relay/issues).

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- CONTRIBUTING -->
<a id="участие"></a>
## Участие

Вклад приветствуется. Пожалуйста, не используйте реальные персональные данные в фикстурах,
тестах, скриншотах и issue.

1. Форкните репозиторий.
2. Создайте ветку: `git checkout -b feature/AmazingFeature`.
3. Внесите изменения и проверьте: `cd extension && bun run ci && bun run build`.
4. Сделайте коммит и push.
5. Откройте Pull Request.

Подробные правила — в [CONTRIBUTING.md](CONTRIBUTING.md). Уязвимости — через GitHub
private vulnerability reporting, см. [SECURITY.md](SECURITY.md).

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- LICENSE -->
<a id="лицензия"></a>
## Лицензия

Распространяется под лицензией **MIT**. См. [LICENSE](LICENSE). Сторонние компоненты и
attribution — в [NOTICE](NOTICE).

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- CONTACT -->
<a id="контакты"></a>
## Контакты

* Issues: [github.com/OniVe/docs-masked-relay/issues](https://github.com/OniVe/docs-masked-relay/issues)
* Security: GitHub private vulnerability reporting
* Проект: [github.com/OniVe/docs-masked-relay](https://github.com/OniVe/docs-masked-relay)

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- ACKNOWLEDGMENTS -->
<a id="благодарности"></a>
## Благодарности

* [docs_masked](https://github.com/kpshinnik/docs_masked) — MIT, идеи и правила PERSON/ORG/ADDRESS
* [EmbedPDF](https://www.embedpdf.com/) / PDFium — PDF redaction
* [SheetJS CE](https://sheetjs.com/) — legacy XLS
* [WXT](https://wxt.dev/) — расширение и manifest
* [fflate](https://github.com/101arrowz/fflate), [saxes](https://github.com/lddubeau/saxes), [docx](https://github.com/dolanmiu/docx)
* [Shields.io](https://shields.io) — badges
* [Best-README-Template](https://github.com/othneildrew/Best-README-Template) — структура README

<p align="right">(<a href="#readme-top">наверх</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[ci-shield]: https://img.shields.io/github/actions/workflow/status/OniVe/docs-masked-relay/ci.yml?branch=main&style=for-the-badge&label=CI&logo=githubactions&logoColor=white
[ci-url]: https://github.com/OniVe/docs-masked-relay/actions/workflows/ci.yml
[license-shield]: https://img.shields.io/github/license/OniVe/docs-masked-relay.svg?style=for-the-badge
[license-url]: https://github.com/OniVe/docs-masked-relay/blob/main/LICENSE
[cws-shield]: https://img.shields.io/badge/Chrome%20Web%20Store-install-blue?style=for-the-badge&logo=googlechrome&logoColor=white
[cws-url]: https://chromewebstore.google.com/detail/docsmasked-relay/iieopopifchankeeciiekichbcfdbdnl
[mv3-shield]: https://img.shields.io/badge/Manifest-V3-blue?style=for-the-badge
[mv3-url]: https://developer.chrome.com/docs/extensions/develop/migrate
[ts-shield]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[ts-url]: https://www.typescriptlang.org/
[wxt-shield]: https://img.shields.io/badge/WXT-0.21-4B32C3?style=for-the-badge
[wxt-url]: https://wxt.dev/
[rust-shield]: https://img.shields.io/badge/Rust-WASM-000000?style=for-the-badge&logo=rust&logoColor=white
[rust-url]: https://www.rust-lang.org/
[bun-shield]: https://img.shields.io/badge/Bun-1.4.2-000000?style=for-the-badge&logo=bun&logoColor=white
[bun-url]: https://bun.sh/
[playwright-shield]: https://img.shields.io/badge/Playwright-tests-2EAD33?style=for-the-badge&logo=playwright&logoColor=white
[playwright-url]: https://playwright.dev/
[product-screenshot]: store/assets/screenshot-options-1280x800.png
[popup-screenshot]: store/assets/screenshot-popup-1280x800.png
