# OpenCode プラグイン・ツールシステム

最終更新: 2026-03-26

プラグイン、ツール、ProviderTransform の仕組みと拡張ポイント。

---

## 1. プラグインシステム

### 登録方法

**1. 内部プラグイン（Built-in）**

`packages/opencode/src/plugin/` に直接コード化:

| プラグイン | ファイル | 役割 |
|-----------|---------|------|
| CodexAuthPlugin | codex.ts | OpenAI Codex OAuth 認証 |
| CopilotAuthPlugin | copilot.ts | GitHub Copilot OAuth 認証 |
| GitlabAuthPlugin | gitlab.ts | GitLab 認証 |
| PoeAuthPlugin | poe.ts | Poe 認証 |

**2. 外部プラグイン（NPM/File）**

```jsonc
// opencode.json
{
  "plugin": [
    "opencode-plugin-xxx",        // npm パッケージ
    "custom-plugin@1.0.0",        // バージョン指定
    "file:///path/to/plugin.js"   // ローカルファイル
  ]
}
```

### プラグインの型

```typescript
type Plugin = (input: PluginInput) => Promise<Hooks>

type PluginInput = {
  client: OpencodeClient      // SDK クライアント
  project: Project
  worktree: string
  directory: string
  serverUrl: URL
  $: Bun.$                    // Bun シェル実行
}

type Hooks = {
  [hookName: string]: HookFunction
  auth?: {
    provider: string
    loader: (getAuth, provider) => Promise<Options>
    methods: AuthMethod[]
  }
}
```

---

## 2. Plugin.trigger() フック一覧

### LLM 関連フック

| フック名 | 実行タイミング | Input | Output（変更可能） |
|---------|--------------|-------|-------------------|
| `chat.params` | LLM 呼び出し直前 | sessionID, agent, model, provider, message | temperature, topP, topK, options |
| `chat.headers` | HTTP リクエスト構築時 | sessionID, agent, model, provider, message | headers: {} |
| `chat.message` | メッセージ送信時 | sessionID, messageID, model, input | void |
| `experimental.chat.system.transform` | system prompt 構築時 | sessionID, model | system |
| `experimental.chat.messages.transform` | メッセージ変換時 | {} | messages |
| `experimental.text.complete` | テキスト補完時 | partial | complete |

### ツール関連フック

| フック名 | 実行タイミング | Input | Output |
|---------|--------------|-------|--------|
| `tool.definition` | ツール初期化時 | toolID | description, parameters |
| `tool.execute.before` | ツール実行前 | toolID, args | void |
| `tool.execute.after` | ツール実行後 | toolID, args, result | void |

### シェル・コマンドフック

| フック名 | 実行タイミング | Input | Output |
|---------|--------------|-------|--------|
| `shell.env` | シェル環境構築時 | cwd | env: {} |
| `command.execute.before` | コマンド実行前 | command, cwd | void |

### セッション関連フック

| フック名 | 実行タイミング | Input | Output |
|---------|--------------|-------|--------|
| `experimental.session.compacting` | compaction 時 | sessionID | compacting? |

### システムフック

| フック名 | 実行タイミング | Input | Output |
|---------|--------------|-------|--------|
| `event` | バスイベント発生時 | event: BusEvent | void |
| `config` | 設定ロード時 | config | void |

### フック実行フロー

```
Plugin.trigger("chat.params", input, output)
  │
  ▼
Plugin.list() → 全プラグインのフック取得
  │
  ▼
各プラグインの hooks["chat.params"] を順次実行
  │ output オブジェクトを変更可能
  │
  ▼
変更済み output を返却
```

---

## 3. ツールシステム

### Tool.define() — ツール定義

```typescript
Tool.define("my-tool", async (ctx?: InitContext) => ({
  description: "ツールの説明",
  parameters: z.object({ arg: z.string() }),
  async execute(args, ctx: Tool.Context) {
    // ctx.sessionID, ctx.abort, ctx.messages 等にアクセス可能
    // ctx.metadata({ title, metadata }) で進捗報告
    // ctx.ask({ ... }) でユーザーに許可を求める
    return {
      title: "実行結果のタイトル",
      metadata: { ... },
      output: "結果テキスト",
      attachments?: [{ type: "file", mime, url }]
    }
  }
}))
```

### Tool.Context

```typescript
type Context = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: Record<string, any>
  messages: MessageV2.WithParts[]
  metadata(input: { title?, metadata? }): void    // 進捗報告
  ask(input: Permission.Request): Promise<void>    // 許可要求
}
```

### 組み込みツール一覧

| Tool ID | 説明 | 条件 |
|---------|------|------|
| `bash` | シェルコマンド実行 | 常時 |
| `read` | ファイル/ディレクトリ読み取り | 常時 |
| `edit` | ファイル修正（差分適用） | 常時（apply_patch と排他） |
| `write` | ファイル作成 | 常時（apply_patch と排他） |
| `glob` | ファイルパターンマッチ | 常時 |
| `grep` | ファイル内容検索 | 常時 |
| `task` | タスク管理（作成・更新・削除） | 常時 |
| `webfetch` | URL から内容取得 | 常時 |
| `websearch` | Web 検索（Exa API） | opencode provider or flag |
| `codesearch` | コード検索（Exa API） | opencode provider or flag |
| `todo_write` | TODO リスト書き込み | 常時 |
| `skill` | スキル実行 | 常時 |
| `question` | ユーザーに質問 | CLI/Desktop |
| `invalid` | 無効なツール呼び出しのフォールバック | 常時 |
| `apply_patch` | パッチ適用（GPT 向け） | GPT-4/5 系統 |
| `lsp` | Language Server 統合 | experimental flag |
| `batch` | バッチ実行 | config 有効化時 |
| `plan_exit` | Plan モード終了 | experimental + CLI |

### ToolRegistry — ツール解決フロー

```
ToolRegistry.tools(model, agent)
  │
  ├─ 組み込みツール定義の配列構築
  │   （モデル・エージェントによるフィルタリング）
  │
  ├─ カスタムツール検出
  │   config directories の {tool,tools}/*.{js,ts}
  │
  ├─ プラグインからのツール取得
  │
  ▼ 各ツール
  Tool.init(ctx?)
  │ → description, parameters, execute を返す
  │
  ▼
  Plugin.trigger("tool.definition")
  │ → Plugin がツール定義を修正可能
  │
  ▼
  AI SDK の tools オブジェクトに変換
  → streamText() に渡される
```

### ツール実行フロー

```
streamText() が tool-call イベントを発行
  │
  ▼
processor.ts で検出
  │ ToolPart 作成（status=pending → running）
  │
  ▼
Doom loop 検出（同じ tool + 同じ input が 3 回連続）
  │ → Permission.ask で確認
  │
  ▼
tool.execute(args, ctx)
  │ Plugin.trigger("tool.execute.before")
  │ ツール処理実行
  │ Plugin.trigger("tool.execute.after")
  │
  ▼
結果を ToolPart に格納（status=completed or error）
  │ output, title, metadata, attachments
  │
  ▼
Session.updatePart() で DB 永続化
```

---

## 4. ProviderTransform

`packages/opencode/src/provider/transform.ts`

プロバイダー固有の差異を吸収する変換レイヤー。

### 主要関数

| 関数 | 役割 |
|------|------|
| `message()` | メッセージをプロバイダー形式に正規化 |
| `temperature()` | モデルごとのデフォルト temperature |
| `topP()` / `topK()` | モデルごとのデフォルト値 |
| `options()` | プロバイダーオプション構築 |
| `providerOptions()` | SDK が期待するネスト構造に変換 |
| `maxOutputTokens()` | 出力トークン数制限 |
| `variants()` | 推論努力レベルの定義 |
| `schema()` | JSON Schema 変換 |

### message() の処理パイプライン

```
raw ModelMessage[]
  │
  ▼ unsupportedParts()
  │ サポートされないメディアタイプ → エラーテキストに変換
  │
  ▼ normalizeMessages()
  │ プロバイダー固有の正規化:
  │ - Anthropic/Bedrock: 空コンテント削除
  │ - Claude: toolCallId から非英数字削除
  │ - Mistral: toolCallId を 9 文字英数字に、メッセージ順序修正
  │ - Interleaved reasoning: 推論部分を providerOptions に移動
  │
  ▼ applyCaching()
  │ キャッシュ制御ヘッダ追加:
  │ - Anthropic: cacheControl: { type: "ephemeral" }
  │ - Bedrock: cachePoint: { type: "default" }
  │ - OpenRouter/OpenAI互換: cache_control: { type: "ephemeral" }
  │
  ▼ providerKey リマップ
  │ npm パッケージ → SDK キー:
  │ "@ai-sdk/openai" → "openai"
  │ "@ai-sdk/anthropic" → "anthropic"
  │
  ▼ 正規化済み ModelMessage[]
```

### providerOptions() — SDK 形式への変換

```typescript
// 入力（フラット）
{ temperature: 0.7, reasoning: { effort: "high" } }

// 出力（@ai-sdk/anthropic の場合）
{ anthropic: { temperature: 0.7, reasoning: { effort: "high" } } }

// 出力（@ai-sdk/gateway の場合）
{ anthropic: { temperature: 0.7 }, gateway: { reasoning: { effort: "high" } } }
```

### variants() — 推論努力レベル

各プロバイダーの推論機能に対応:

```typescript
// OpenAI
{ low: { reasoning: { effort: "low" } }, high: { reasoning: { effort: "high" } } }

// Anthropic (Adaptive Thinking)
{ low: { thinking: { type: "adaptive" }, effort: "low" },
  max: { thinking: { type: "adaptive" }, effort: "max" } }

// Google (Gemini)
{ low: { thinkingConfig: { thinkingLevel: "low" } },
  max: { thinkingConfig: { thinkingLevel: "max", thinkingBudget: 100000 } } }
```

---

## 5. LLM.stream() での統合ポイント

```typescript
LLM.stream(input) {
  // 1. ProviderTransform.options() → base オプション
  const base = ProviderTransform.options({ model, sessionID, providerOptions })

  // 2. マージ: base → model.options → agent.options → variant
  const options = pipe(base, mergeDeep(model.options), mergeDeep(agent.options), mergeDeep(variant))

  // 3. Plugin.trigger("chat.params") → temperature, topP, topK 調整
  const params = await Plugin.trigger("chat.params", {...}, {
    temperature: ProviderTransform.temperature(model),
    topP: ProviderTransform.topP(model),
    topK: ProviderTransform.topK(model),
    options,
  })

  // 4. Plugin.trigger("chat.headers") → カスタムヘッダ

  // 5. Tool parser middleware（toolParserMode に基づく）
  // 6. transformParams middleware（ProviderTransform.message() 呼び出し）

  // 7. streamText() 呼び出し
  return streamText({
    model: wrapLanguageModel({ model: language, middleware }),
    providerOptions: ProviderTransform.providerOptions(model, params.options),
    maxOutputTokens: ProviderTransform.maxOutputTokens(model),
    ...
  })
}
```

---

## 6. 拡張ポイントまとめ

コードを変更せずにカスタマイズできるポイント:

| 拡張ポイント | 方法 | 用途 |
|-------------|------|------|
| ツール追加 | `{tool,tools}/*.{js,ts}` + opencode.json | カスタムツール |
| プラグイン追加 | opencode.json `plugin` | 認証・フック |
| MCP サーバー | opencode.json `mcp` | 外部ツール連携 |
| スキル | opencode.json `skills` | 再利用可能プロンプト |
| エージェント | opencode.json `agent` | カスタムエージェント |
| コマンド | opencode.json `command` | カスタムコマンド |
| プロバイダー | opencode.json `provider` | カスタム API ゲートウェイ |

コード変更が必要な拡張ポイント:

| 拡張ポイント | ファイル | 用途 |
|-------------|---------|------|
| ミドルウェア追加 | llm.ts | ストリーム前後の処理 |
| ProviderTransform | transform.ts | プロバイダー固有の変換 |
| Tool Parser | llm.ts | 新しいパーサーモード |
| CUSTOM_LOADERS | provider.ts | プロバイダー固有の初期化 |
| BUNDLED_PROVIDERS | provider.ts | 新しい SDK のバンドル |
