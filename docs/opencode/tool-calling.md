# OpenCode ツール呼び出し方式

最終更新: 2026-04-04

ネイティブ function calling と hermes-strict パーサーの比較。このフォークがなぜ・どのように tool calling を実現しているかの解説。

---

## 1. ネイティブ function calling（通常方式）

AI SDK / OpenAI API 標準の方式。`tools` パラメータでツール定義を渡し、モデルが `tool_calls` を返す。

### リクエスト

```json
{
  "model": "gpt-5.4",
  "messages": [
    { "role": "system", "content": "You are a coding assistant..." },
    { "role": "user", "content": "このファイルを読んで" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read",
        "description": "Read a file from the local filesystem...",
        "parameters": {
          "type": "object",
          "properties": {
            "file_path": { "type": "string" },
            "offset": { "type": "number" },
            "limit": { "type": "number" }
          },
          "required": ["file_path"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

### レスポンス

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "read",
          "arguments": "{\"file_path\": \"/path/to/file.ts\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

### ツール結果の返送

```json
{
  "messages": [
    { "role": "assistant", "tool_calls": [{"id": "call_abc123", ...}] },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "1→import foo from 'bar'\n2→..."
    }
  ]
}
```

### 特徴

- モデルが `tool_calls` を構造化データとして出力（テキストとは別チャネル）
- `finish_reason: "tool_calls"` でツール呼び出しを明示
- `tool` ロールでツール結果を返す
- prompt caching が効く（ツール定義は API 側で最適化される）

---

## 2. hermes-strict パーサー（このフォークの方式）

ゲートウェイが `tools` パラメータを除去するため、ネイティブ function calling が使えない。`@ai-sdk-tool/parser` ミドルウェアで、テキストベースのツール呼び出しに変換する。

### ミドルウェアの処理

```
[OpenCode] → [tool-parser MW] → [ゲートウェイ] → [LLM]
                 │
                 │ transformParams:
                 │  1. ツール定義をシステムプロンプトに注入
                 │  2. tools: [] に設定（除去）
                 │  3. tool ロール → user ロールに変換
                 │
                 │ wrapStream:
                 │  1. <tool_call> タグを検出・バッファリング
                 │  2. JSON をパース
                 │  3. AI SDK の tool-call イベントに変換
```

### リクエスト（ゲートウェイに送られる実際の形）

```json
{
  "model": "my-model",
  "messages": [
    {
      "role": "system",
      "content": "You have access to tools. To call a tool, you MUST use EXACTLY this format:\n\n<tool_call>\n{\"name\": \"TOOL_NAME\", \"arguments\": {\"param1\": \"value1\"}}\n</tool_call>\n\nCRITICAL RULES:\n- You MUST wrap the JSON in <tool_call> and </tool_call> tags\n- The JSON object MUST have exactly two keys: \"name\" and \"arguments\"\n- Do NOT add any extra characters between the JSON and </tool_call>\n...\n\nAvailable tools: <tools>[{\"name\":\"read\",\"description\":\"Read a file...\",\"parameters\":{...}},{\"name\":\"bash\",...},...]</tools>\n\n[元のシステムプロンプト]"
    },
    {
      "role": "user",
      "content": "このファイルを読んで"
    }
  ],
  "stream": true
}
```

**`tools` フィールドがない。** ツール定義は全てシステムプロンプト内のテキストとして注入される。

### レスポンス（モデルが返すテキスト）

```
ファイルを読みます。

<tool_call>
{"name": "read", "arguments": {"file_path": "/path/to/file.ts"}}
</tool_call>
```

モデルは通常のテキスト出力として `<tool_call>` タグを生成する。パーサーがストリーム中にこのタグを検出し、AI SDK の `tool-call` イベントに変換する。

### ツール結果の返送

tool-parser が `tool` ロールを `user` ロールに変換:

```json
{
  "messages": [
    {
      "role": "assistant",
      "content": "ファイルを読みます。\n\n<tool_call>\n{\"name\": \"read\", \"arguments\": {\"file_path\": \"/path/to/file.ts\"}}\n</tool_call>"
    },
    {
      "role": "user",
      "content": "<tool_response>\n{\"tool_call_id\": \"call_xxx\", \"name\": \"read\", \"content\": \"1→import foo from 'bar'\\n2→...\"}\n</tool_response>"
    }
  ]
}
```

### 特徴

- ツール定義がシステムプロンプトに全展開（20+ ツール → 数千トークン）
- モデルはテキストとして `<tool_call>` タグを出力
- `finish_reason` は `"stop"` のまま（ネイティブのように `"tool_calls"` にならない）→ processor.ts で override
- ツール結果は `user` ロールで返送（連続 user メッセージは自動結合される）
- prompt caching は効かない（ゲートウェイ経由のため）

---

## 3. 方式の比較

| | ネイティブ function calling | hermes-strict パーサー |
|---|---|---|
| ツール定義の渡し方 | `tools` パラメータ（構造化） | システムプロンプトにテキスト注入 |
| ツール呼び出しの出力 | `tool_calls` フィールド（構造化） | `<tool_call>` タグ内の JSON（テキスト） |
| ツール結果の返送 | `tool` ロール | `user` ロール（`<tool_response>` タグ） |
| finish_reason | `"tool_calls"` | `"stop"` → processor.ts で `"tool_calls"` に override |
| 入力トークン | ツール定義は API 側で最適化 | 毎回数千トークン増（全ツール定義がプロンプトに展開） |
| prompt caching | 効く（プロバイダー依存） | 効かない（OpenAI 互換ゲートウェイ経由） |
| パース精度 | API が保証 | モデルのテキスト出力に依存（稀にパース失敗） |
| ゲートウェイ互換性 | `tools` を通すゲートウェイが必要 | **任意の OpenAI 互換 API で動作** |

### モデル要件

hermes-strict はネイティブ function calling より**モデルへの要求が高い**。ネイティブ方式では API がツール定義の最適化と出力フォーマットの強制を担うが、hermes-strict ではモデル自身が:

1. テキストとして渡された JSON Schema を正しく理解する
2. `<tool_call>` タグ内に正確な JSON を出力する（閉じ括弧、エスケープ含む）
3. 毎回数千トークンのツール定義がコンテキストを消費する中で品質を維持する

**結論: ネイティブ function calling に余裕があるモデルでないと hermes-strict は安定しない。**

ネイティブで安定しないモデルが、テキストベースで安定する道理はない。むしろ壊れ方が増える（閉じタグ忘れ、JSON 壊れ、タグ外へのゴミ出力等）。

#### 実測データ（2026-04-03、planetiler 直近10コミットレビュー）

| モデル | hermes-strict 安定性 | 長いプロンプト（248行）との両立 | 典型的な崩壊パターン |
|--------|-------------------|---------------------------|-----------------|
| Sonnet 4.5 | **安定** | 完遂 | — |
| GPT-5.4 | 安定（PROMPT_GPT grounding 必須） | 完遂 | grounding なしだとツール結果を無視し架空データ生成 |
| GPT-5.1 | borderline | 崩壊（prompt-following collapse） | ツールは実行できるが、その後 prose に脱線し深掘りを放棄 |
| Mistral Medium | **崩壊** | N/A | `</s>` `[INST]` 漏出、無限ループ、出力制御自体が破綻 |
| GLM-5 Turbo | **崩壊** | N/A | `<tool_call[]>` 構文エラー、ツール0件実行、全コンテンツがハルシネーション |

GLM-5 Turbo はネイティブ FC では Critical バグを発見し python3 検証まで実行する優秀なモデルだが、hermes-strict では `<tool_call>` タグの構文すら正しく生成できない。**ネイティブ FC 対応 ≠ hermes-strict 対応**。hermes の `<tool_call>` 構文を正しく生成する訓練が別途必要。

| モデル | ネイティブ function calling | hermes-strict |
|--------|---------------------------|---------------|
| GPT-5.4 / GPT-5.1 | 安定 | **安定**（コードレビュー3パス完走実績あり） |
| Sonnet 4.5 | 安定 | **安定** |
| Mistral Medium | 安定 | **安定**（構造化出力が丁寧） |
| Gemini 3 Flash | 安定 | **ムラあり**（JSON 途中切れ発生実績） |
| Llama 4 Maverick | ムラあり | **厳しい**（制御トークン混入、JSON 後に余計な説明） |
| 小型モデル全般 | ムラあり | **使用不可**（フォーマット遵守が不安定） |

Gemini 3 Flash が良い実例で、Google API 直接のネイティブ function calling なら余裕で安定するが、ゲートウェイ経由の hermes-strict だと JSON 途中切れが発生する。**ネイティブで API が面倒を見てくれる部分を、モデル自身がテキストで正確に出す必要がある**ため、ボーダーラインのモデルほど差が出る。

実用上は **GPT-5.x / Sonnet 4.5 / Mistral Medium あたりの上位モデル専用** と割り切るのが現実的。

---

## 4. hermes-strict 固有の処理

### finishReason override（processor.ts）

ネイティブ方式では API が `finish_reason: "tool_calls"` を返すが、hermes-strict ではモデルが `<tool_call>` タグを出力しても `finish_reason` は `"stop"` のまま。prompt.ts の会話ループは `finish_reason` で継続判定するため、processor.ts で強制上書き:

```typescript
const finishReason = hasToolCalls &&
  value.finishReason !== "length" &&
  value.finishReason !== "tool-calls"
  ? "tool-calls"       // ← override
  : value.finishReason
```

### stripToolTags（processor.ts）

モデルがツール結果をエコーすることがある。テキスト保存時に除去:

```typescript
function stripToolTags(text: string): string {
  return text
    .replace(/<tool_result>\s*\{[\s\S]*?\}\s*<\/tool_result>/g, "")
    .replace(/<tool_response>\s*\{[\s\S]*?\}\s*<\/tool_response>/g, "")
    .replace(/<commentary>[\s\S]*?<\/commentary>/g, "")
    .trim()
}
```

### experimental_repairToolCall（llm.ts）

モデルがツール名を間違えた場合の修復:

```typescript
// 1. 小文字に変換してマッチ
const lower = toolCall.toolName.toLowerCase()
if (tools[lower]) return { ...toolCall, toolName: lower }

// 2. マッチしなければ "invalid" tool にリダイレクト
return { toolName: "invalid", ... }
```

### JSON パッチ（patches/@ai-sdk-tool%2Fparser@2.1.7.patch）

`@ai-sdk-tool/parser` の JSON パーサーにバグがあり、ツール引数内の改行・制御文字でパースが失敗する。パッチで `normalizeJsonStringCtrl` 関数を追加し、制御文字をエスケープシーケンスに変換:

```
\n → \\n
\r → \\r
\t → \\t
```

### JSON 修復（`repairToolCallJson`）

モデルが大きな文字列引数（apply_patch の patchText、edit の old_string/new_string 等）でダブルクォートのエスケープに失敗し、`JSON.parse` が失敗するケースへの対策。

**修復フロー:**
1. `"name"` フィールドを正規表現で抽出（短いので壊れない）
2. `"arguments"` 内のキー・値ペアを `,"key":` パターンで分割
3. 重複キー名がある場合は最後の出現を真の境界とする（値内のパターンを誤検出しない）
4. 各値を個別に修復: エスケープされていない `"` を `\"` に変換、リテラル改行/タブもエスケープ
5. 修復成功なら `tool-call` イベントに変換、失敗ならテキストフォールバック

**適用箇所:** `parseGeneratedText` と `createStreamParser` の両方の catch ブロック。

**既知の制限:** 値の中に**同一キー名**の `,"key":` パターンが出現する場合は誤分割する可能性がある（極めて稀）。

### ツール選択: apply_patch vs edit/write

`toolParser` が有効な場合、`registry.ts` で `apply_patch` を無効にし `edit`/`write` に切り替え。

- **理由**: apply_patch の patchText はコード丸ごとを含む巨大な文字列。hermes text-based middleware ではモデルが手動で JSON を生成するため、大きな引数で壊れやすい
- **edit/write は引数が小さい**ので壊れにくく、JSON 修復も効きやすい
- **判定**: `cfg.provider?.[providerID]?.options?.toolParser` をチェック

---

## 5. 設定方法

`opencode.json` でプロバイダーレベルまたはモデルレベルで設定:

```jsonc
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "toolParser": "hermes-strict"  // プロバイダーレベル（全モデルに適用）
      },
      "models": {
        "model-a": {
          "id": "model-a",
          "options": {
            "toolParser": "hermes"     // モデルレベルで上書き可能
          }
        }
      }
    }
  }
}
```

### 利用可能なモード

| モード | ミドルウェア | 用途 |
|--------|------------|------|
| `"hermes"` | `hermesToolMiddleware` | JSON in `<tool_call>` tags（基本形） |
| `"hermes-strict"` | カスタム `createToolMiddleware` | 明示的なフォーマット例 + ルール付き（推奨） |
| `"xml"` | `morphXmlToolMiddleware` | 純 XML 形式（JSON が苦手なモデル向け） |
| 未設定 | なし | ネイティブ function calling（デフォルト） |

### 優先度

```
model.options.toolParser > provider.options.toolParser > undefined（デフォルト）
```
