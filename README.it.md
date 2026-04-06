# OpenCode (nofc fork)

**Chiamate di strumenti per provider senza function calling nativo.**

Fork di [anomalyco/opencode](https://github.com/anomalyco/opencode) — integra il middleware [`@ai-sdk-tool/parser`](https://www.npmjs.com/package/@ai-sdk-tool/parser) in modo che gli strumenti funzionino tramite protocolli testuali (Hermes, XML) invece del parametro strutturato `tools` dell'API.

## Installazione

```bash
npx opencode-ai-nofc

# o installa globalmente
npm i -g opencode-ai-nofc

# o scarica il binario precompilato
curl -fsSL https://github.com/okuyam2y/opencode-nofc/releases/latest/download/opencode-$(uname -s | tr A-Z a-z)-$(uname -m).tar.gz | tar xz
./opencode

# o compila dal codice sorgente
git clone https://github.com/okuyam2y/opencode-nofc.git
cd opencode-nofc && bun install && bun turbo build
```

## Perché questo fork?

Molti gateway API e server di inferenza self-hosted (vLLM, LiteLLM, proxy personalizzati) rimuovono o ignorano il parametro `tools` dalle richieste compatibili con OpenAI. Senza function calling nativo, gli strumenti di OpenCode — read, write, bash e altri — semplicemente non funzionano.

Questo fork risolve il problema analizzando le chiamate di strumenti direttamente dall'output testuale del modello. Il modello scrive tag `<tool_call>` in testo semplice, e il middleware parser li converte in eventi standard di chiamata strumenti dell'AI SDK.

## Configurazione

Aggiungi `toolParser` alle opzioni del tuo provider in `opencode.json`:

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

| Modalità | Descrizione |
|----------|-------------|
| `hermes-strict` | **Consigliato.** Formato JSON rigoroso con regole esplicite nel prompt di sistema. Il più affidabile. |
| `hermes` | Protocollo Hermes standard. Alternativa se hermes-strict causa problemi. |
| `xml` | Formato XML puro per modelli addestrati con chiamate di strumenti XML. |

## Cosa include

Oltre al parser di strumenti, questo fork aggiunge:

- **Filtro tag di streaming** — rimuove i tag `<tool_call>` / `<tool_response>` che trapelano nell'output visibile
- **Deduplicazione chiamate strumenti** — scarta esecuzioni duplicate di strumenti nello stesso passo LLM
- **Sostituzione automatica `apply_patch` → `edit`/`write`** — sostituisce la modifica basata su diff con strumenti basati su righe quando il parser di strumenti è attivo
- **Estrazione testo da PDF / DOCX / XLSX** e OCR macOS Vision
- **Gestione del motivo di fine** — converte i motivi di fine `unknown` in stati terminali, con protezione dai cicli

**[Guida alla configurazione →](docs/guides/toolparser-setup.md)** — impostazioni per modello, tabella di compatibilità dei modelli e risoluzione dei problemi.

## Relazione con l'upstream

Questo fork segue il branch `dev` dell'upstream e viene regolarmente rebasato. Le correzioni di bug vengono inviate come PR quando applicabile.

- npm: [`opencode-ai-nofc`](https://www.npmjs.com/package/opencode-ai-nofc) (separato dal pacchetto ufficiale `opencode-ai`)
- Correlati: [#2917](https://github.com/anomalyco/opencode/issues/2917) (richiesta di parser di strumenti personalizzato) · [#1122](https://github.com/anomalyco/opencode/issues/1122) (vLLM + Hermes)
- Licenza: [MIT](LICENSE) (stessa dell'upstream)

---

> *Il README originale di OpenCode segue qui sotto.*

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo OpenCode">
    </picture>
  </a>
</p>
<p align="center">L’agente di coding AI open source.</p>
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

### Installazione

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package manager
npm i -g opencode-ai@latest        # oppure bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS e Linux (consigliato, sempre aggiornato)
brew install opencode              # macOS e Linux (formula brew ufficiale, aggiornata meno spesso)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Qualsiasi OS
nix run nixpkgs#opencode           # oppure github:anomalyco/opencode per l’ultima branch di sviluppo
```

> [!TIP]
> Rimuovi le versioni precedenti alla 0.1.x prima di installare.

### App Desktop (BETA)

OpenCode è disponibile anche come applicazione desktop. Puoi scaricarla direttamente dalla [pagina delle release](https://github.com/anomalyco/opencode/releases) oppure da [opencode.ai/download](https://opencode.ai/download).

| Piattaforma           | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, oppure AppImage       |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Directory di installazione

Lo script di installazione rispetta il seguente ordine di priorità per il percorso di installazione:

1. `$OPENCODE_INSTALL_DIR` – Directory di installazione personalizzata
2. `$XDG_BIN_DIR` – Percorso conforme alla XDG Base Directory Specification
3. `$HOME/bin` – Directory binaria standard dell’utente (se esiste o può essere creata)
4. `$HOME/.opencode/bin` – Fallback predefinito

```bash
# Esempi
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agenti

OpenCode include due agenti integrati tra cui puoi passare usando il tasto `Tab`.

- **build** – Predefinito, agente con accesso completo per il lavoro di sviluppo
- **plan** – Agente in sola lettura per analisi ed esplorazione del codice
  - Nega le modifiche ai file per impostazione predefinita
  - Chiede il permesso prima di eseguire comandi bash
  - Ideale per esplorare codebase sconosciute o pianificare modifiche

È inoltre incluso un sotto-agente **general** per ricerche complesse e attività multi-step.
Viene utilizzato internamente e può essere invocato usando `@general` nei messaggi.

Scopri di più sugli [agenti](https://opencode.ai/docs/agents).

### Documentazione

Per maggiori informazioni su come configurare OpenCode, [**consulta la nostra documentazione**](https://opencode.ai/docs).

### Contribuire

Se sei interessato a contribuire a OpenCode, leggi la nostra [guida alla contribuzione](./CONTRIBUTING.md) prima di inviare una pull request.

### Costruire su OpenCode

Se stai lavorando a un progetto correlato a OpenCode e che utilizza “opencode” come parte del nome (ad esempio “opencode-dashboard” o “opencode-mobile”), aggiungi una nota nel tuo README per chiarire che non è sviluppato dal team OpenCode e che non è affiliato in alcun modo con noi.

### FAQ

#### In cosa è diverso da Claude Code?

È molto simile a Claude Code in termini di funzionalità. Ecco le principali differenze:

- 100% open source
- Non è legato a nessun provider. Anche se consigliamo i modelli forniti tramite [OpenCode Zen](https://opencode.ai/zen), OpenCode può essere utilizzato con Claude, OpenAI, Google o persino modelli locali. Con l’evoluzione dei modelli, le differenze tra di essi si ridurranno e i prezzi scenderanno, quindi essere indipendenti dal provider è importante.
- Supporto LSP pronto all’uso
- Forte attenzione alla TUI. OpenCode è sviluppato da utenti neovim e dai creatori di [terminal.shop](https://terminal.shop); spingeremo al limite ciò che è possibile fare nel terminale.
- Architettura client/server. Questo, ad esempio, permette a OpenCode di girare sul tuo computer mentre lo controlli da remoto tramite un’app mobile. La frontend TUI è quindi solo uno dei possibili client.

---

**Unisciti alla nostra community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
