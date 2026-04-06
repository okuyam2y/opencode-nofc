# OpenCode (nofc fork)

**Tool-Aufrufe für Provider ohne natives Function Calling.**

Fork von [anomalyco/opencode](https://github.com/anomalyco/opencode) — integriert [`@ai-sdk-tool/parser`](https://www.npmjs.com/package/@ai-sdk-tool/parser)-Middleware, sodass Tools über textbasierte Protokolle (Hermes, XML) statt über den strukturierten `tools`-API-Parameter funktionieren.

## Installation

```bash
npx opencode-ai-nofc

# oder global installieren
npm i -g opencode-ai-nofc

# oder vorkompilierte Binärdatei herunterladen
curl -fsSL https://github.com/okuyam2y/opencode-nofc/releases/latest/download/opencode-$(uname -s | tr A-Z a-z)-$(uname -m).tar.gz | tar xz
./opencode

# oder aus dem Quellcode bauen
git clone https://github.com/okuyam2y/opencode-nofc.git
cd opencode-nofc && bun install && bun turbo build
```

## Warum dieser Fork?

Viele API-Gateways und selbst gehostete Inferenz-Server (vLLM, LiteLLM, benutzerdefinierte Proxys) entfernen oder ignorieren den `tools`-Parameter aus OpenAI-kompatiblen Anfragen. Ohne natives Function Calling funktionieren die Tools von OpenCode — read, write, bash und andere — schlichtweg nicht.

Dieser Fork löst das Problem, indem er Tool-Aufrufe direkt aus der Textausgabe des Modells parst. Das Modell schreibt `<tool_call>`-Tags in Klartext, und die Parser-Middleware wandelt sie in standardmäßige AI SDK Tool-Call-Ereignisse um.

## Konfiguration

Fügen Sie `toolParser` zu Ihren Provider-Optionen in `opencode.json` hinzu:

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

| Modus | Beschreibung |
|-------|--------------|
| `hermes-strict` | **Empfohlen.** Striktes JSON-Format mit expliziten Regeln im System-Prompt. Am zuverlässigsten. |
| `hermes` | Standard-Hermes-Protokoll. Fallback, falls hermes-strict Probleme verursacht. |
| `xml` | Reines XML-Format für Modelle, die mit XML-Tool-Calling trainiert wurden. |

## Was enthalten ist

Über den Tool-Parser hinaus fügt dieser Fork hinzu:

- **Streaming-Tag-Filter** — entfernt `<tool_call>` / `<tool_response>`-Tags, die in die sichtbare Ausgabe durchsickern
- **Tool-Call-Deduplizierung** — verwirft doppelte Tool-Ausführungen innerhalb desselben LLM-Schritts
- **Automatische Ersetzung `apply_patch` → `edit`/`write`** — ersetzt diff-basiertes Editieren durch zeilenbasierte Tools, wenn der Tool-Parser aktiv ist
- **PDF / DOCX / XLSX Textextraktion** und macOS Vision OCR
- **Finish-Reason-Behandlung** — konvertiert `unknown`-Finish-Reasons in Terminalzustände, mit Schleifenschutz

**[Einrichtungsanleitung →](docs/guides/toolparser-setup.md)** — Einstellungen pro Modell, Modellkompatibilitätstabelle und Fehlerbehebung.

## Beziehung zum Upstream

Dieser Fork verfolgt den upstream `dev`-Branch und wird regelmäßig rebaset. Fehlerbehebungen werden bei Bedarf als PRs eingereicht.

- npm: [`opencode-ai-nofc`](https://www.npmjs.com/package/opencode-ai-nofc) (getrennt vom offiziellen `opencode-ai`-Paket)
- Verwandt: [#2917](https://github.com/anomalyco/opencode/issues/2917) (Anfrage für benutzerdefinierten Tool-Parser) · [#1122](https://github.com/anomalyco/opencode/issues/1122) (vLLM + Hermes)
- Lizenz: [MIT](LICENSE) (gleich wie Upstream)

---

> *Das originale OpenCode-README folgt unten.*

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Der Open-Source KI-Coding-Agent.</p>
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

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Paketmanager
npm i -g opencode-ai@latest        # oder bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS und Linux (empfohlen, immer aktuell)
brew install opencode              # macOS und Linux (offizielle Brew-Formula, seltener aktualisiert)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # jedes Betriebssystem
nix run nixpkgs#opencode           # oder github:anomalyco/opencode für den neuesten dev-Branch
```

> [!TIP]
> Entferne Versionen älter als 0.1.x vor der Installation.

### Desktop-App (BETA)

OpenCode ist auch als Desktop-Anwendung verfügbar. Lade sie direkt von der [Releases-Seite](https://github.com/anomalyco/opencode/releases) oder [opencode.ai/download](https://opencode.ai/download) herunter.

| Plattform             | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` oder AppImage          |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installationsverzeichnis

Das Installationsskript beachtet die folgende Prioritätsreihenfolge für den Installationspfad:

1. `$OPENCODE_INSTALL_DIR` - Benutzerdefiniertes Installationsverzeichnis
2. `$XDG_BIN_DIR` - XDG Base Directory Specification-konformer Pfad
3. `$HOME/bin` - Standard-Binärverzeichnis des Users (falls vorhanden oder erstellbar)
4. `$HOME/.opencode/bin` - Standard-Fallback

```bash
# Beispiele
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode enthält zwei eingebaute Agents, zwischen denen du mit der `Tab`-Taste wechseln kannst.

- **build** - Standard-Agent mit vollem Zugriff für Entwicklungsarbeit
- **plan** - Nur-Lese-Agent für Analyse und Code-Exploration
  - Verweigert Datei-Edits standardmäßig
  - Fragt vor dem Ausführen von bash-Befehlen nach
  - Ideal zum Erkunden unbekannter Codebases oder zum Planen von Änderungen

Außerdem ist ein **general**-Subagent für komplexe Suchen und mehrstufige Aufgaben enthalten.
Dieser wird intern genutzt und kann in Nachrichten mit `@general` aufgerufen werden.

Mehr dazu unter [Agents](https://opencode.ai/docs/agents).

### Dokumentation

Mehr Infos zur Konfiguration von OpenCode findest du in unseren [**Docs**](https://opencode.ai/docs).

### Beitragen

Wenn du zu OpenCode beitragen möchtest, lies bitte unsere [Contributing Docs](./CONTRIBUTING.md), bevor du einen Pull Request einreichst.

### Auf OpenCode aufbauen

Wenn du an einem Projekt arbeitest, das mit OpenCode zusammenhängt und "opencode" als Teil seines Namens verwendet (z.B. "opencode-dashboard" oder "opencode-mobile"), füge bitte einen Hinweis in deine README ein, dass es nicht vom OpenCode-Team gebaut wird und nicht in irgendeiner Weise mit uns verbunden ist.

### FAQ

#### Worin unterscheidet sich das von Claude Code?

In Bezug auf die Fähigkeiten ist es Claude Code sehr ähnlich. Hier sind die wichtigsten Unterschiede:

- 100% open source
- Nicht an einen Anbieter gekoppelt. Wir empfehlen die Modelle aus [OpenCode Zen](https://opencode.ai/zen); OpenCode kann aber auch mit Claude, OpenAI, Google oder sogar lokalen Modellen genutzt werden. Mit der Weiterentwicklung der Modelle werden die Unterschiede kleiner und die Preise sinken, deshalb ist Provider-Unabhängigkeit wichtig.
- LSP-Unterstützung direkt nach dem Start
- Fokus auf TUI. OpenCode wird von Neovim-Nutzern und den Machern von [terminal.shop](https://terminal.shop) gebaut; wir treiben die Grenzen dessen, was im Terminal möglich ist.
- Client/Server-Architektur. Das ermöglicht z.B., OpenCode auf deinem Computer laufen zu lassen, während du es von einer mobilen App aus fernsteuerst. Das TUI-Frontend ist nur einer der möglichen Clients.

---

**Tritt unserer Community bei** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
