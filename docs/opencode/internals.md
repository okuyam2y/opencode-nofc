# OpenCode 内部構造

最終更新: 2026-03-27

セッション層（`packages/opencode/src/session/`）の内部動作に関する詳細ドキュメント。

---

## 1. LLM ストリーミング（llm.ts）

### LLM.stream() の全体フロー

```typescript
LLM.stream(input: StreamInput)

 1. Provider.getLanguage(model)      → LanguageModelV2 取得（キャッシュ済み）
 2. Config.get(), Provider.getProvider(), Auth.get()  → 並列取得
 3. System prompt 構築
    - agent.prompt || SystemPrompt.provider(model)
    - input.system[]
    - input.user.system
    - Plugin.trigger("experimental.chat.system.transform")
 4. オプション解決（マージ順）
    - base = ProviderTransform.options(model, ...)
    - mergeDeep(model.options)
    - mergeDeep(agent.options)
    - mergeDeep(variant)
 5. Plugin.trigger("chat.params")    → temperature, topP, topK, options
 6. Plugin.trigger("chat.headers")   → カスタム HTTP ヘッダ
 7. Tool parser mode 判定
    - model.options.toolParser ?? provider.options.toolParser
 8. LiteLLM proxy 対応
    - message history に tool_calls あり && active tools なし → _noop tool 注入
 9. Middleware chain 構築
    - [tool-parser MW, transformParams MW]
10. streamText() 呼び出し
    - model: wrapLanguageModel({ model: language, middleware })
    - tools, toolChoice, temperature, topP, topK
    - maxOutputTokens, messages, providerOptions
    - experimental_repairToolCall（tool name 小文字化修正）
11. Return: StreamTextResult
```

### ミドルウェアチェーン

AI SDK v5 は `middleware` 配列の **先頭から順に** `transformParams` を実行する。

```
[tool-parser MW] → [transformParams MW] → [AI SDK 内部] → API 呼び出し
```

#### 1. Tool Parser Middleware（条件付き）

`toolParserMode` が設定されていて `toolChoice !== "none"` の場合のみ挿入。

| モード | ミドルウェア | 動作 |
|--------|------------|------|
| `"hermes"` | `hermesToolMiddleware` | JSON in `<tool_call>` tags |
| `"hermes-strict"` | カスタム `createToolMiddleware` | 明示的な JSON フォーマット + 例文 |
| `"xml"` | `morphXmlToolMiddleware` | 純 XML 形式 |

**処理内容**:
- `transformParams`: ツール定義をテキスト化してシステムプロンプト先頭に注入。`tools: []`, `toolChoice: undefined` に設定。`tool` ロールを `user` に変換
- `wrapStream`: 出力から `<tool_call>...</tool_call>` を検出し `tool-call` ストリームパーツに変換
- `wrapGenerate`: 生成テキスト全体をパースし `tool-call` コンテンツパーツに変換

#### 2. transformParams Middleware（常時）

```typescript
{
  async transformParams(args) {
    // メッセージ変換（プロバイダー固有の正規化）
    args.params.prompt = ProviderTransform.message(prompt, model, options)

    // maxOutputTokens 無効化（useMaxCompletionTokens 対応）
    if (disableMaxTokens) {
      args.params.maxOutputTokens = undefined
    }
    return args.params
  }
}
```

### StreamInput 型

```typescript
type StreamInput = {
  user: MessageV2.User
  sessionID: SessionID
  model: Provider.Model
  agent: Agent.Info
  system: string[]
  messages: ModelMessage[]
  tools: Record<string, Tool>
  toolChoice?: "auto" | "required" | "none"
  abort: AbortSignal
  permission: Permission
  small?: boolean            // 小型モデル用（summary 等）
}
```

### experimental_repairToolCall

LLM が tool name を間違えた場合の修復:

```typescript
experimental_repairToolCall: async ({ toolCall, tools }) => {
  // 1. 小文字に変換してマッチ
  const lower = toolCall.toolName.toLowerCase()
  if (tools[lower]) return { ...toolCall, toolName: lower }

  // 2. マッチしなければ "invalid" tool にリダイレクト
  return { toolName: "invalid", toolCallId: toolCall.toolCallId, args: { ... } }
}
```

---

## 2. ストリーム処理パイプライン（processor.ts）

### SessionProcessor.process() のフロー

```
LLM.stream() 呼び出し
  │
  ▼
fullStream イテレート（case 文で分岐）
  │
  ├─ text-start       → TextPart 作成
  ├─ text-delta        → text += delta（逐次 DB 更新）
  ├─ text-end          → stripToolTags() + Plugin hook
  │
  ├─ reasoning-start   → ReasoningPart 作成
  ├─ reasoning-delta   → reasoning += delta
  ├─ reasoning-end     → ReasoningPart 完了
  │
  ├─ tool-input-start  → ToolPart 作成（status=pending）
  ├─ tool-call         → ToolPart 更新（status=running）
  │                      → Doom loop 検出（同じ tool 3回連続）
  │                      → Tool.execute() 実行
  ├─ tool-result       → ToolPart 更新（status=completed, output 填充）
  ├─ tool-error        → ToolPart 更新（status=error）
  │
  ├─ start-step        → StepStartPart + snapshot 開始
  ├─ finish-step       → token/cost 集計 + finishReason override
  │                      → StepFinishPart + patch 計算
  │
  └─ error             → retryable? → retry loop
                          context overflow? → compaction flag
                          else → error 填充 → break
```

### finishReason override

tool-parser 使用時、プロバイダーは "stop" や "end_turn" を返すが、ツール呼び出しがあった場合はループ継続のため "tool-calls" に強制。また、`hasToolCalls=false` で `"unknown"` が返された場合は `"stop"` に正規化（GLM-5 Turbo 等の非標準プロバイダー対応）:

```typescript
const finishReason = hasToolCalls &&
  value.finishReason !== "length" &&
  value.finishReason !== "tool-calls"
  ? "tool-calls"                              // ← ツール呼び出し時は継続
  : !hasToolCalls && value.finishReason === "unknown"
    ? "stop"                                  // ← unknown → 終端に正規化
    : value.finishReason
```

**prompt.ts 側の終端判定**: `isTerminalFinishReason()` で `"tool-calls"` のみ非終端、それ以外はすべて終端として扱う。upstream 版（tool-parser なし）は prompt.ts 側のみで対応。

### stripToolTags()

モデルが tool response をエコーするのを除去:

```typescript
function stripToolTags(text: string): string {
  return text
    .replace(/<tool_result>\s*\{[\s\S]*?\}\s*<\/tool_result>/g, "")
    .replace(/<tool_response>\s*\{[\s\S]*?\}\s*<\/tool_response>/g, "")
    .replace(/<commentary>[\s\S]*?<\/commentary>/g, "")
    .trim()
}
```

### リトライループ

```
try {
  for await (const value of stream.fullStream) { ... }
} catch (e) {
  error = MessageV2.fromError(e)
  if (ContextOverflowError) → needsCompaction = true
  else {
    retryable? → attempt++ → delay(backoff) → continue
    else       → error 填充 → break
  }
}
```

### 返却値

`process()` は以下のいずれかを返す:
- `"continue"` — ツール呼び出し後のループ継続
- `"stop"` — 完了
- `"compact"` — コンテキスト overflow → compaction 必要

---

## 3. 会話ループ（prompt.ts）

### SessionPrompt.loop() の構造

```
while (true) {
  // 1. メッセージ読み込み
  messages = MessageV2.stream(sessionID) → filterCompacted()

  // 2. 状態チェック
  lastUser, lastAssistant, lastFinished, tasks を取得

  // 3. 終了判定（isTerminalFinishReason）
  //    "tool-calls" のみ非終端。"unknown" 含めそれ以外はすべて終端
  if (isTerminalFinishReason(lastAssistant.finish) && lastUser.id < lastAssistant.id)
    → break

  // 4. Subtask 処理
  if (pending subtask) → TaskTool.execute → continue

  // 5. メイン処理
  model = Provider.Model 取得
  tools = resolveTools(model, agent)
  system = [environment, instructions, skills, ...]
  modelMessages = MessageV2.toModelMessages(messages)

  // 6. LLM 呼び出し
  result = processor.process({
    messages: modelMessages,
    system, tools, model, agent, ...
  })

  // 7. 結果処理
  switch (result) {
    "compact" → SessionCompaction.create() → continue
    "stop"    → break
    default   → continue（ツール結果で再推論）
  }
}
```

### resolveTools()

ツールの解決と権限フィルタリング:

```
ToolRegistry.tools(model, agent)    ← 組み込み 15+ ツール
  + MCP.tools()                     ← MCP サーバーのツール
  + StructuredOutput tool           ← structured output mode 時
  │
  ▼ フィルタリング
  - agent.tools による有効/無効
  - config.tools による有効/無効
  - permission チェック
  │
  ▼ Tool.init()
  - description, parameters（Zod）, execute 関数
  - Plugin.trigger("tool.definition") で定義修正可能
```

---

## 4. メッセージスキーマ（message-v2.ts）

### メッセージ型

```typescript
MessageV2.User = {
  id: MessageID
  sessionID: SessionID
  role: "user"
  time: { created: number }
  format?: { type: "text" | "json_schema", schema? }
  agent: string
  model: { providerID, modelID }
  system?: string
  tools?: Record<string, boolean>
  variant?: string
  summary?: { title?, body?, diffs: FileDiff[] }
}

MessageV2.Assistant = {
  id: MessageID
  sessionID: SessionID
  role: "assistant"
  time: { created, completed?: number }
  error?: APIError | AuthError | ...
  parentID: MessageID
  agent: string
  modelID: ModelID
  providerID: ProviderID
  path: { cwd, root }
  cost: number
  tokens: { total?, input, output, reasoning, cache: { read, write } }
  finish?: "stop" | "length" | "tool-calls" | "end_turn" | ...
  structured?: unknown
}
```

### Part 型（discriminated union）

| Part | 用途 | 主要フィールド |
|------|------|--------------|
| **TextPart** | テキスト出力 | text, time: {start, end?}, metadata |
| **ReasoningPart** | 推論内容（thinking） | text, time, metadata |
| **ToolPart** | ツール呼び出し | tool, callID, state（下記参照） |
| **StepStartPart** | LLM step 開始 | snapshot? |
| **StepFinishPart** | LLM step 終了 | reason, cost, tokens, snapshot? |
| **PatchPart** | ファイル変更差分 | hash, files[] |
| **SnapshotPart** | スナップショット | snapshot |
| **FilePart** | 添付ファイル | mime, filename?, url |
| **RetryPart** | リトライ記録 | attempt, error, time |
| **CompactionPart** | compaction マーカー | auto, overflow? |
| **SubtaskPart** | サブタスク | prompt, description, agent |
| **AgentPart** | エージェント情報 | name, source? |

### ToolState ライフサイクル

```
Pending → Running → Completed
                  → Error
```

```typescript
Pending:   { status: "pending", input: {}, raw: "" }
Running:   { status: "running", input, title?, metadata?, time: { start } }
Completed: { status: "completed", input, output, title, metadata, time: { start, end } }
Error:     { status: "error", input, error, time: { start, end } }
```

### エラー分類

```typescript
MessageV2.fromError(e) → discriminated union:
  - AuthError           ← 認証失敗
  - APIError            ← API エラー（retryable フラグ付き）
  - ContextOverflowError ← コンテキスト超過 → compaction へ
  - OutputLengthError   ← 出力長超過
  - AbortedError        ← ユーザーキャンセル
```

---

## 5. コンテキスト管理（compaction.ts）

### コンテキスト overflow 検出

```typescript
SessionCompaction.isOverflow(model, tokens) =
  tokens.total > model.limit.context - COMPACTION_BUFFER(20K)
```

### Pruning（古いツール出力の削除）

最新 2 ターン以上前の completed tool call の output をクリア:

```typescript
SessionCompaction.prune():
  - PRUNE_MINIMUM: 20,000 tokens 以上削除時のみ実行
  - PRUNE_PROTECT: 40,000 tokens は保護（最新から）
  - PRUNE_PROTECTED_TOOLS: ["skill"] は対象外
```

### Compaction フロー

```
ContextOverflowError 検出
  → processor.process() が "compact" を返す
  → SessionCompaction.create(sessionID)
    → CompactionPart をメッセージに追加
    → filterCompacted() で古いメッセージを除外
  → loop 継続
```

---

## 6. リトライ（retry.ts）

### 遅延計算

```typescript
SessionRetry.delay(attempt, error?):
  - Retry-After header あり → その値を使用
  - なし → RETRY_INITIAL_DELAY(2s) * RETRY_BACKOFF_FACTOR(2) ^ attempt
```

### retryable 判定

```typescript
SessionRetry.retryable(error):
  - ContextOverflowError → false（compaction へ）
  - APIError.isRetryable === true → true
  - "exhausted", "rate_limit", "too_many_requests" → true
  - 5xx status → true
  - その他 → false
```

---

## 7. 重要な定数

| 定数 | 値 | 用途 |
|------|-----|------|
| `DOOM_LOOP_THRESHOLD` | 3 | 同じ tool 3 回連続で Permission.ask |
| `RETRY_INITIAL_DELAY` | 2,000 ms | リトライ初期遅延 |
| `RETRY_BACKOFF_FACTOR` | 2 | exponential backoff 係数 |
| `COMPACTION_BUFFER` | 20,000 tokens | コンテキスト予約バッファ |
| `PRUNE_MINIMUM` | 20,000 tokens | pruning 最小削除量 |
| `PRUNE_PROTECT` | 40,000 tokens | pruning 保護トークン |
| `OUTPUT_TOKEN_MAX` | 32,000 | 最大出力トークン |
| `maxRetries` | 0 | AI SDK レベルのリトライ（OpenCode 側で制御するため 0） |

---

## 8. モジュール間の相互関係

```
prompt.ts ──uses──→ processor.ts ──uses──→ llm.ts
    │                    │                    │
    │                    │                    ├── Provider.getLanguage()
    │                    │                    ├── ProviderTransform.message()
    │                    │                    └── wrapLanguageModel() + streamText()
    │                    │
    │                    ├── Session.updatePart()     ← DB 書き込み
    │                    ├── Session.updatePartDelta() ← ストリーム中の差分
    │                    ├── stripToolTags()
    │                    └── MessageV2.fromError()
    │
    ├── MessageV2.stream()        ← DB 読み込み
    ├── MessageV2.toModelMessages() ← AI SDK 形式変換
    ├── resolveTools()            ← ToolRegistry + MCP
    ├── SessionCompaction.create() ← overflow 対応
    └── SystemPrompt / Instruction ← プロンプト構築
```
