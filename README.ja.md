# OpenCode (nofc fork)

**ネイティブの function calling を持たないプロバイダー向けのツール呼び出し対応。**

[anomalyco/opencode](https://github.com/anomalyco/opencode) のフォークです。[`@ai-sdk-tool/parser`](https://www.npmjs.com/package/@ai-sdk-tool/parser) ミドルウェアを統合し、構造化された `tools` API パラメータの代わりに、テキストベースのプロトコル（Hermes, XML）でツール呼び出しを実現します。

## インストール

```bash
npx opencode-ai-nofc

# グローバルインストール
npm i -g opencode-ai-nofc

# ビルド済みバイナリをダウンロード
curl -fsSL https://github.com/okuyam2y/opencode-nofc/releases/latest/download/opencode-$(uname -s | tr A-Z a-z)-$(uname -m).tar.gz | tar xz
./opencode

# ソースからビルド
git clone https://github.com/okuyam2y/opencode-nofc.git
cd opencode-nofc && bun install && bun turbo build
```

## なぜこのフォーク？

多くの API ゲートウェイやセルフホスト推論サーバー（vLLM, LiteLLM, カスタムプロキシ等）は、OpenAI 互換リクエストの `tools` パラメータを無視、または除去します。ネイティブの function calling がなければ、OpenCode のツール群（read, write, bash など）は動作しません。

このフォークは、モデルのテキスト出力からツール呼び出しを直接パースすることで問題を解決します。モデルがプレーンテキストで `<tool_call>` タグを出力し、パーサーミドルウェアがそれを AI SDK 標準のツール呼び出しイベントに変換します。

## 設定

`opencode.json` のプロバイダーオプションに `toolParser` を追加してください：

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

| モード | 説明 |
|--------|------|
| `hermes-strict` | **推奨。** システムプロンプトに明示的なルールを含む厳密な JSON 形式。最も安定。 |
| `hermes` | 標準の Hermes プロトコル。hermes-strict で問題が出る場合のフォールバック。 |
| `xml` | XML ツール呼び出しで訓練されたモデル向けの純粋な XML 形式。 |

## 含まれる機能

ツールパーサー以外に、このフォークでは以下を追加しています：

- **ストリーミングタグフィルター** — 表示出力に漏れた `<tool_call>` / `<tool_response>` タグを除去
- **ツール呼び出し重複排除** — 同一 LLM ステップ内の重複ツール実行をドロップ
- **`apply_patch` → `edit`/`write` 自動切替** — ツールパーサー有効時に diff ベースの編集を行ベースのツールに置換
- **PDF / DOCX / XLSX テキスト抽出** および macOS Vision OCR
- **終了理由ハンドリング** — `unknown` 終了理由を終了状態に変換、ループガードレール付き

**[セットアップガイド →](docs/guides/toolparser-setup.md)** — モデル別設定、モデル互換性一覧、トラブルシューティング。

## upstream との関係

このフォークは upstream の `dev` ブランチを追跡し、定期的にリベースしています。バグ修正は適宜 upstream に PR を提出しています。

- npm: [`opencode-ai-nofc`](https://www.npmjs.com/package/opencode-ai-nofc)（公式の `opencode-ai` パッケージとは別）
- 関連: [#2917](https://github.com/anomalyco/opencode/issues/2917)（カスタムツールパーサー要望）· [#1122](https://github.com/anomalyco/opencode/issues/1122)（vLLM + Hermes）
- ライセンス: [MIT](LICENSE)（upstream と同一）

---

> *以下は OpenCode 本体の README です。*

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">オープンソースのAIコーディングエージェント。</p>
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

### インストール

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# パッケージマネージャー
npm i -g opencode-ai@latest        # bun/pnpm/yarn でもOK
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS と Linux（推奨。常に最新）
brew install opencode              # macOS と Linux（公式 brew formula。更新頻度は低め）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # どのOSでも
nix run nixpkgs#opencode           # または github:anomalyco/opencode で最新 dev ブランチ
```

> [!TIP]
> インストール前に 0.1.x より古いバージョンを削除してください。

### デスクトップアプリ (BETA)

OpenCode はデスクトップアプリとしても利用できます。[releases page](https://github.com/anomalyco/opencode/releases) から直接ダウンロードするか、[opencode.ai/download](https://opencode.ai/download) を利用してください。

| プラットフォーム      | ダウンロード                          |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`、`.rpm`、または AppImage       |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### インストールディレクトリ

インストールスクリプトは、インストール先パスを次の優先順位で決定します。

1. `$OPENCODE_INSTALL_DIR` - カスタムのインストールディレクトリ
2. `$XDG_BIN_DIR` - XDG Base Directory Specification に準拠したパス
3. `$HOME/bin` - 標準のユーザー用バイナリディレクトリ（存在する場合、または作成できる場合）
4. `$HOME/.opencode/bin` - デフォルトのフォールバック

```bash
# 例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode には組み込みの Agent が2つあり、`Tab` キーで切り替えられます。

- **build** - デフォルト。開発向けのフルアクセス Agent
- **plan** - 分析とコード探索向けの読み取り専用 Agent
  - デフォルトでファイル編集を拒否
  - bash コマンド実行前に確認
  - 未知のコードベース探索や変更計画に最適

また、複雑な検索やマルチステップのタスク向けに **general** サブ Agent も含まれています。
内部的に使用されており、メッセージで `@general` と入力して呼び出せます。

[agents](https://opencode.ai/docs/agents) の詳細はこちら。

### ドキュメント

OpenCode の設定については [**ドキュメント**](https://opencode.ai/docs) を参照してください。

### コントリビュート

OpenCode に貢献したい場合は、Pull Request を送る前に [contributing docs](./CONTRIBUTING.md) を読んでください。

### OpenCode の上に構築する

OpenCode に関連するプロジェクトで、名前に "opencode"（例: "opencode-dashboard" や "opencode-mobile"）を含める場合は、そのプロジェクトが OpenCode チームによって作られたものではなく、いかなる形でも関係がないことを README に明記してください。

### FAQ

#### Claude Code との違いは？

機能面では Claude Code と非常に似ています。主な違いは次のとおりです。

- 100% オープンソース
- 特定のプロバイダーに依存しません。[OpenCode Zen](https://opencode.ai/zen) で提供しているモデルを推奨しますが、OpenCode は Claude、OpenAI、Google、またはローカルモデルでも利用できます。モデルが進化すると差は縮まり価格も下がるため、provider-agnostic であることが重要です。
- そのまま使える LSP サポート
- TUI にフォーカス。OpenCode は neovim ユーザーと [terminal.shop](https://terminal.shop) の制作者によって作られており、ターミナルで可能なことの限界を押し広げます。
- クライアント/サーバー構成。例えば OpenCode をあなたのPCで動かし、モバイルアプリからリモート操作できます。TUI フロントエンドは複数あるクライアントの1つにすぎません。

---

**コミュニティに参加** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
