# OpenCode 設定システム

最終更新: 2026-04-02

`opencode.json` のスキーマ、設定の読み込みフロー、Provider/Model の解決について。

---

## 1. opencode.json トップレベルキー

```jsonc
{
  "$schema": "...",

  // === モデル・プロバイダー ===
  "model": "provider/model",           // デフォルトモデル（例: "anthropic/claude-sonnet-4-5"）
  "small_model": "provider/model",     // 小型モデル（summary 等に使用）
  "provider": { ... },                 // プロバイダー定義（下記参照）
  "enabled_providers": ["..."],        // 有効プロバイダー（指定時、これ以外は無効）
  "disabled_providers": ["..."],       // 無効プロバイダー

  // === エージェント ===
  "default_agent": "string",           // デフォルトエージェント名
  "agent": {                           // エージェント定義
    "my-agent": {
      "model": "provider/model",
      "variant": "string",
      "temperature": 0.7,
      "top_p": 0.9,
      "steps": 100,
      "prompt": "string",
      "description": "string",
      "permission": { ... },
      "tools": { "bash": true, "read": false }
    }
  },

  // === コマンド・スキル ===
  "command": { ... },                  // カスタムコマンド
  "skills": { "paths": [], "urls": [] },

  // === プラグイン・MCP・LSP ===
  "plugin": ["opencode-plugin-xxx"],   // NPM プラグイン
  "mcp": {                             // MCP サーバー
    "server-name": {
      "command": "npx",
      "args": ["-y", "@mcp/server"],
      "env": { "KEY": "value" }
    }
  },
  "lsp": false | { ... },             // LSP 設定
  "formatter": false | { ... },       // フォーマッター設定

  // === 権限 ===
  "permission": { ... },              // パーミッション設定
  "tools": { ... },                   // @deprecated → permission へ

  // === UI ===
  "layout": "auto" | "stretch",
  "keybinds": { ... },                // 120+ キーバインド

  // === その他 ===
  "logLevel": "debug" | "info" | "warn" | "error",
  "server": { "port": 0, "hostname": "", "mdns": true },
  "username": "string",
  "share": "manual" | "auto" | "disabled",
  "snapshot": true,
  "autoupdate": true | "notify",
  "instructions": ["string"],         // 追加インストラクション
  "watcher": { "ignore": ["pattern"] },
  "compaction": { "auto": true, "prune": true, "reserved": 20000 },
  "experimental": { ... },
  "enterprise": { "url": "string" }
}
```

---

## 2. Provider スキーマ

### 構造

```jsonc
{
  "provider": {
    "my-gateway": {
      // === 接続情報 ===
      "api": "https://my-gateway/v1",        // API エンドポイント URL
      "npm": "@ai-sdk/openai-compatible",     // AI SDK パッケージ

      // === 認証 ===
      "env": ["MY_API_KEY"],                  // API キーの環境変数名

      // === オプション ===
      "options": {
        "apiKey": "sk-...",                   // API キー直接指定
        "baseURL": "https://...",             // base URL 上書き
        "timeout": 300000,                    // リクエストタイムアウト（ms）
        "chunkTimeout": 30000,                // SSE チャンク間タイムアウト
        "toolParser": "hermes",               // ツールパーサー: "hermes" | "hermes-strict" | "xml"
        "useMaxCompletionTokens": true,       // max_tokens → max_completion_tokens 変換
        "setCacheKey": true                   // プロンプトキャッシュ有効化
      },

      // === モデルフィルタ ===
      "whitelist": ["gpt-5", "gpt-5.1"],     // これだけ有効
      "blacklist": ["gpt-4o"],               // これを無効

      // === モデル定義 ===
      "models": {
        "gpt-5": {
          "id": "gpt-5",
          "name": "GPT-5",
          "options": {
            "toolParser": "hermes-strict"     // モデルレベルで上書き
          }
        }
      }
    }
  }
}
```

### toolParser 設定の優先度

```
model.options.toolParser > provider.options.toolParser > undefined（デフォルト: 無効）
```

---

## 3. Model 型の全フィールド

models.dev（外部データベース）+ opencode.json のマージで構成される。

```typescript
Model = {
  // 識別情報
  id: ModelID                    // "claude-opus-4", "gpt-5" 等（branded string）
  providerID: ProviderID         // "anthropic", "openai" 等

  // 表示
  name: string                   // 表示名
  family?: string                // モデルファミリー（"claude", "gpt"）
  release_date: string           // "2025-03-26"
  status: "alpha" | "beta" | "deprecated" | "active"

  // API 接続
  api: {
    id: string                   // API 呼び出し用 ID（"claude-opus-4-20250805"）
    url: string                  // API エンドポイント（${VAR} 置き換え対応）
    npm: string                  // SDK パッケージ名
  }

  // 能力
  capabilities: {
    temperature: boolean
    reasoning: boolean           // 推論（thinking）サポート
    attachment: boolean
    toolcall: boolean            // ネイティブ function calling
    input: { text, audio, image, video, pdf: boolean }
    output: { text, audio, image, video, pdf: boolean }
    interleaved: boolean | { field: "reasoning_content" | "reasoning_details" }
  }

  // コスト（USD / 1K tokens）
  cost: {
    input: number
    output: number
    cache: { read: number, write: number }
    experimentalOver200K?: { input, output, cache: { read, write } }
  }

  // コンテキスト制限
  limit: {
    context: number              // コンテキストウィンドウサイズ
    input?: number               // 入力制限
    output: number               // 出力制限
  }

  // カスタム設定
  options: Record<string, any>   // モデル固有オプション
  headers: Record<string, string>
  variants?: Record<string, Record<string, any>>  // 推論努力度等
}
```

---

## 4. 設定の読み込み順序（低 → 高優先度）

```
1. Remote .well-known/opencode     ← 組織デフォルト
2. Global ~/.config/opencode/opencode.json{,c}
3. OPENCODE_CONFIG 環境変数        ← カスタムパス
4. Project ./opencode.json{,c}     ← プロジェクトルート
5. .opencode/opencode.json{,c}     ← .opencode ディレクトリ
6. OPENCODE_CONFIG_CONTENT 環境変数 ← インライン設定
7. Account config                  ← アカウント管理
8. Managed /etc/opencode/opencode.json ← 企業向け（最高優先度）
```

---

## 5. Provider 解決フロー

### InstanceState の初期化（Provider.layer 内）

```
1. models.dev データをベース DB として読み込み
   │ 各プロバイダーの全モデル定義（コスト、制限、能力等）
   ▼
2. config.provider オーバーライドをマージ
   │ opencode.json の provider 定義で上書き・追加
   ▼
3. 環境変数から認証をロード
   │ provider.env[] で指定されたキーから API キー取得
   ▼
4. Auth（キーチェーン等）をロード
   │ OAuth トークン、保存済み API キー
   ▼
5. Plugin 認証をロード
   │ CodexAuth, CopilotAuth 等のプラグインから
   ▼
6. CUSTOM_LOADERS を実行
   │ プロバイダー固有の初期化（Bedrock リージョン等）
   ▼
7. フィルタリング
   │ enabled_providers / disabled_providers
   │ whitelist / blacklist
   │ deprecated / alpha モデル除外
   ▼
providers: Record<ProviderID, Provider.Info>
```

### Provider.getLanguage() — AI SDK モデル取得

```typescript
getLanguage(model: Model) → LanguageModelV2

1. キャッシュチェック（key = "${providerID}/${modelID}"）
   → hit なら即返却

2. getSDK(model) → SDK インスタンス取得
   a. オプション解決（provider.options + model.options）
   b. baseURL 解決（${VAR} 環境変数置き換え）
   c. apiKey 解決
   d. fetch ラッパー設定（timeout, useMaxCompletionTokens）
   e. SDK キャッシュ or 新規生成

3. CUSTOM_LOADERS[providerID]?.getModel?()
   → あればカスタムローダーでモデル取得
   → なければ sdk.languageModel(model.api.id)

4. キャッシュ保存 → 返却
```

---

## 6. バンドル済みプロバイダー（20種）

SDK が `packages/opencode` にバンドルされているプロバイダー:

| npm パッケージ | プロバイダー |
|---------------|------------|
| `@ai-sdk/anthropic` | Anthropic（Claude） |
| `@ai-sdk/openai` | OpenAI（GPT） |
| `@ai-sdk/google` | Google（Gemini） |
| `@ai-sdk/amazon-bedrock` | AWS Bedrock |
| `@ai-sdk/azure` | Azure OpenAI |
| `@ai-sdk/google-vertex` | Google Vertex AI |
| `@ai-sdk/openai-compatible` | OpenAI 互換 API |
| `@openrouter/ai-sdk-provider` | OpenRouter |
| `@ai-sdk/xai` | xAI（Grok） |
| `@ai-sdk/mistral` | Mistral |
| `@ai-sdk/groq` | Groq |
| `@ai-sdk/deepinfra` | DeepInfra |
| `@ai-sdk/cerebras` | Cerebras |
| `@ai-sdk/cohere` | Cohere |
| `@ai-sdk/gateway` | AI Gateway |
| `@ai-sdk/togetherai` | Together AI |
| `@ai-sdk/perplexity` | Perplexity |
| `@ai-sdk/vercel` | Vercel |
| `gitlab-ai-provider` | GitLab |
| カスタム実装 (`src/provider/sdk/copilot/`) | GitHub Copilot |

バンドルされていない SDK は `Npm.install()` (`@npmcli/arborist`) で動的インストール。

---

## 7. オプションマージの優先度

LLM.stream() 内でのオプション解決:

```
base = ProviderTransform.options(model, providerOptions)
  ↓ mergeDeep
model.options
  ↓ mergeDeep
agent.options
  ↓ mergeDeep
variant（推論努力度等）
  ↓
Plugin.trigger("chat.params") で最終調整
```

### ProviderTransform のデフォルト値

| パラメータ | モデル | デフォルト値 |
|-----------|--------|------------|
| temperature | Qwen | 0.55 |
| temperature | Claude | undefined（API デフォルト） |
| temperature | Gemini | 1.0 |
| topP | Qwen | 1 |
| topP | Gemini, Kimi | 0.95 |
| topK | Gemini | 64 |
| maxOutputTokens | 全モデル | 32,000（OUTPUT_TOKEN_MAX） |
| timeout | 全モデル | 300,000 ms（5分） |

---

## 8. fetch ラッパー

Provider.getSDK() で設定される fetch ラッパーの処理:

```typescript
options["fetch"] = async (input, init?) => {
  // 1. AbortSignal の合成（ユーザーキャンセル + timeout）
  const signals = []
  if (init?.signal) signals.push(init.signal)
  if (options["timeout"]) signals.push(AbortSignal.timeout(timeout))

  // 2. max_tokens → max_completion_tokens 変換
  if (provider.options?.useMaxCompletionTokens) {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }

  // 3. OpenAI SDK の余分な id フィールド削除
  if (model.api.npm === "@ai-sdk/openai") {
    delete body.id
  }

  return fetchFn(input, { ...init, signal: combined })
}
```

---

## 9. Agent スキーマ

```typescript
Agent = {
  model?: string              // "provider/model"
  variant?: string            // 推論努力度（"low", "high", "max"）
  temperature?: number
  top_p?: number
  steps?: number              // agentic loop 最大ステップ数
  prompt?: string             // system prompt 全体を上書き
  description?: string
  color?: string              // UI 表示色
  hidden?: boolean            // autocomplete から非表示
  mode?: "subagent" | "primary" | "all"
  permission?: Permission
  tools?: Record<string, boolean>
  options?: Record<string, any>
}
```

---

## 10. 実運用の設定例（このフォーク）

```jsonc
{
  "provider": {
    "my-gateway": {
      "api": "https://my-gateway/v1",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "toolParser": "hermes-strict",         // 全モデルに hermes-strict
        "useMaxCompletionTokens": true          // max_tokens → max_completion_tokens
      },
      "models": {
        "gpt-5.4": { "id": "gpt-5.4" },
        "claude-sonnet-4.5": { "id": "claude-sonnet-4.5" },
        "gemini-3-flash": { "id": "gemini-3-flash" },
        "mistral-medium": { "id": "mistral-medium" }
      }
    }
  }
}
```

- 全モデルが 1 つの OpenAI 互換ゲートウェイ配下
- ネイティブ function calling は使わず hermes-strict パーサー経由
- ゲートウェイが max_tokens を 400 に制限するため useMaxCompletionTokens で回避
