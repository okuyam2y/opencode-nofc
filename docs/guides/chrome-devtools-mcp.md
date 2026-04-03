# Chrome DevTools MCP を OpenCode で使う

最終更新: 2026-03-31

## 1. 設定を追加

グローバル設定 `~/.config/opencode/opencode.json` の `mcp` セクションに追加する。

```json
{
  "mcp": {
    "chrome-devtools": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest"],
      "enabled": true
    }
  }
}
```

プロジェクト単位で使いたい場合は `.opencode/opencode.jsonc` の `mcp` に同じ内容を書く。

## 2. 接続モード

### A. MCP に Chrome を起動させる（推奨・最も簡単）

オプションなしの設定（上記）で OK。MCP が自分で Chrome を起動・管理する。
- 独自プロファイル（`~/.cache/chrome-devtools-mcp/chrome-profile`）を使用
- **普段のログイン状態は引き継がれない**
- DevTools 接続は自動確立

### B. 既存の Chrome に接続する

macOS ではデフォルトプロファイルで `--remote-debugging-port` が使えない制約がある。
対処法は2つ:

**方法 1: `--user-data-dir` で別プロファイル指定**（ログイン状態なし）

```bash
# Chrome を完全終了してから:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/chrome-debug-profile"
```

```json
"command": ["npx", "-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"]
```

**方法 2: `--autoConnect`**（Chrome 144+、ログイン状態あり）

1. Chrome で `chrome://inspect/#remote-debugging` を開く
2. 「Enable」ボタンを押してリモートデバッグを有効化

```json
"command": ["npx", "-y", "chrome-devtools-mcp@latest", "--autoConnect"]
```

> 注意: `--remote-debugging-port=9222` をデフォルトデータディレクトリで使うと
> `DevTools remote debugging requires a non-default data directory` エラーになる。

## 3. OpenCode を起動

```bash
oc-dev   # or opencode
```

TUI の MCPs ダイアログで `chrome-devtools` が `✓ Enabled` になっていれば接続成功。

## 4. 使えるツール

| ツール | 用途 |
|--------|------|
| `navigate_page` | URL に遷移 |
| `take_screenshot` | スクリーンショット取得 |
| `click` / `fill` / `type_text` | 要素操作 |
| `evaluate_script` | JS 実行 |
| `list_network_requests` | ネットワーク監視 |
| `lighthouse_audit` | パフォーマンス監査 |
| `get_console_message` | コンソールログ取得 |
| `performance_start_trace` / `stop_trace` | パフォーマンストレース |

## 5. 主なオプション

`command` 配列の末尾にフラグを追加できる。

| オプション | 説明 |
|-----------|------|
| `--headless` | ヘッドレスモード |
| `--browserUrl http://127.0.0.1:9222` | 既存の Chrome に接続 |
| `--autoConnect` | Chrome 144+ でローカル Chrome に自動接続 |
| `--viewport 1280x720` | ビューポートサイズ指定 |
| `--isolated` | 一時プロファイルで起動（終了時に削除） |

## 参考

- [chrome-devtools-mcp (npm)](https://www.npmjs.com/package/chrome-devtools-mcp)
- [ChromeDevTools/chrome-devtools-mcp (GitHub)](https://github.com/ChromeDevTools/chrome-devtools-mcp)
