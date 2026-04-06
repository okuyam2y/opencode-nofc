# OpenCode (nofc fork)

**Вызов инструментов для провайдеров без нативного function calling.**

Форк [anomalyco/opencode](https://github.com/anomalyco/opencode) — интегрирует middleware [`@ai-sdk-tool/parser`](https://www.npmjs.com/package/@ai-sdk-tool/parser), чтобы инструменты работали через текстовые протоколы (Hermes, XML) вместо структурированного параметра `tools` API.

## Установка

```bash
npx opencode-ai-nofc

# или установите глобально
npm i -g opencode-ai-nofc

# или скачайте готовый бинарный файл
curl -fsSL https://github.com/okuyam2y/opencode-nofc/releases/latest/download/opencode-$(uname -s | tr A-Z a-z)-$(uname -m).tar.gz | tar xz
./opencode

# или соберите из исходного кода
git clone https://github.com/okuyam2y/opencode-nofc.git
cd opencode-nofc && bun install && bun turbo build
```

## Зачем этот форк?

Многие API-шлюзы и self-hosted серверы вывода (vLLM, LiteLLM, пользовательские прокси) удаляют или игнорируют параметр `tools` из OpenAI-совместимых запросов. Без нативного function calling инструменты OpenCode — read, write, bash и другие — просто не работают.

Этот форк решает проблему, разбирая вызовы инструментов непосредственно из текстового вывода модели. Модель пишет теги `<tool_call>` в обычном тексте, а middleware-парсер преобразует их в стандартные события вызова инструментов AI SDK.

## Настройка

Добавьте `toolParser` в параметры провайдера в `opencode.json`:

```jsonc
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://your-gateway/v1",
        "toolParser": "hermes-strict"
      },
      "models": {
        "your-model": {
          "name": "Your Model",
          "limit": { "context": 200000, "output": 32768 }
        }
      }
    }
  }
}
```

| Режим | Описание |
|-------|----------|
| `hermes-strict` | **Рекомендуется.** Строгий формат JSON с явными правилами в системном промпте. Наиболее надёжный. |
| `hermes` | Стандартный протокол Hermes. Запасной вариант, если hermes-strict вызывает проблемы. |
| `xml` | Чистый формат XML для моделей, обученных на XML-вызовах инструментов. |

## Что включено

Помимо парсера инструментов, этот форк добавляет:

- **Потоковый фильтр тегов** — удаляет теги `<tool_call>` / `<tool_response>`, просачивающиеся в видимый вывод
- **Дедупликация вызовов инструментов** — отбрасывает дублирующиеся выполнения инструментов в одном шаге LLM
- **Автоматическая замена `apply_patch` → `edit`/`write`** — заменяет редактирование на основе diff инструментами на основе строк при активном парсере инструментов
- **Извлечение текста из PDF / DOCX / XLSX** и macOS Vision OCR
- **Обработка причины завершения** — преобразует причины завершения `unknown` в терминальные состояния, с защитой от циклов

**[Руководство по настройке →](docs/guides/toolparser-setup.md)** — настройки для каждой модели, таблица совместимости моделей и устранение неполадок.

## Связь с upstream

Этот форк отслеживает ветку `dev` upstream и регулярно перебазируется. Исправления ошибок отправляются как PR при необходимости.

- npm: [`opencode-ai-nofc`](https://www.npmjs.com/package/opencode-ai-nofc) (отдельно от официального пакета `opencode-ai`)
- Связанное: [#2917](https://github.com/anomalyco/opencode/issues/2917) (запрос на пользовательский парсер инструментов) · [#1122](https://github.com/anomalyco/opencode/issues/1122) (vLLM + Hermes)
- Лицензия: [MIT](LICENSE) (такая же, как у upstream)

---

> *Оригинальный README OpenCode следует ниже.*

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Открытый AI-агент для программирования.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Установка

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Менеджеры пакетов
npm i -g opencode-ai@latest        # или bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS и Linux (рекомендуем, всегда актуально)
brew install opencode              # macOS и Linux (официальная формула brew, обновляется реже)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # любая ОС
nix run nixpkgs#opencode           # или github:anomalyco/opencode для самой свежей ветки dev
```

> [!TIP]
> Перед установкой удалите версии старше 0.1.x.

### Десктопное приложение (BETA)

OpenCode также доступен как десктопное приложение. Скачайте его со [страницы релизов](https://github.com/anomalyco/opencode/releases) или с [opencode.ai/download](https://opencode.ai/download).

| Платформа             | Загрузка                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` или AppImage           |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Каталог установки

Скрипт установки выбирает путь установки в следующем порядке приоритета:

1. `$OPENCODE_INSTALL_DIR` - Пользовательский каталог установки
2. `$XDG_BIN_DIR` - Путь, совместимый со спецификацией XDG Base Directory
3. `$HOME/bin` - Стандартный каталог пользовательских бинарников (если существует или можно создать)
4. `$HOME/.opencode/bin` - Fallback по умолчанию

```bash
# Примеры
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

В OpenCode есть два встроенных агента, между которыми можно переключаться клавишей `Tab`.

- **build** - По умолчанию, агент с полным доступом для разработки
- **plan** - Агент только для чтения для анализа и изучения кода
  - По умолчанию запрещает редактирование файлов
  - Запрашивает разрешение перед выполнением bash-команд
  - Идеален для изучения незнакомых кодовых баз или планирования изменений

Также включен сабагент **general** для сложных поисков и многошаговых задач.
Он используется внутренне и может быть вызван в сообщениях через `@general`.

Подробнее об [agents](https://opencode.ai/docs/agents).

### Документация

Больше информации о том, как настроить OpenCode: [**наши docs**](https://opencode.ai/docs).

### Вклад

Если вы хотите внести вклад в OpenCode, прочитайте [contributing docs](./CONTRIBUTING.md) перед тем, как отправлять pull request.

### Разработка на базе OpenCode

Если вы делаете проект, связанный с OpenCode, и используете "opencode" как часть имени (например, "opencode-dashboard" или "opencode-mobile"), добавьте примечание в README, чтобы уточнить, что проект не создан командой OpenCode и не аффилирован с нами.

### FAQ

#### Чем это отличается от Claude Code?

По возможностям это очень похоже на Claude Code. Вот ключевые отличия:

- 100% open source
- Не привязано к одному провайдеру. Мы рекомендуем модели из [OpenCode Zen](https://opencode.ai/zen); но OpenCode можно использовать с Claude, OpenAI, Google или даже локальными моделями. По мере развития моделей разрыв будет сокращаться, а цены падать, поэтому важна независимость от провайдера.
- Поддержка LSP из коробки
- Фокус на TUI. OpenCode построен пользователями neovim и создателями [terminal.shop](https://terminal.shop); мы будем раздвигать границы того, что возможно в терминале.
- Архитектура клиент/сервер. Например, это позволяет запускать OpenCode на вашем компьютере, а управлять им удаленно из мобильного приложения. Это значит, что TUI-фронтенд - лишь один из возможных клиентов.

---

**Присоединяйтесь к нашему сообществу** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
