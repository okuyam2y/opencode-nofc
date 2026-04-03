# OpenCode アーキテクチャ概要

最終更新: 2026-04-02

---

## 1. システム全体図

```
┌─────────────────────────────────────────────────────────────┐
│  CLI / Desktop / Web                                         │
│  ユーザー入力 → TUI or API                                    │
└──────────┬──────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Server (HTTP API)                                            │
│  packages/opencode/src/server/server.ts                       │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │ Session  │  │ Agent    │  │ Config   │  │ Auth        │ │
│  │ Service  │  │ Service  │  │ Service  │  │ Service     │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘ │
│       │             │             │                │        │
│  ┌────▼─────────────▼─────────────▼────────────────▼──────┐ │
│  │                  LLM Layer                             │ │
│  │  SessionPrompt → SessionProcessor → LLM.stream()      │ │
│  └────┬───────────────────────────────────────────────────┘ │
│       │                                                      │
│  ┌────▼───────────────────────────────────────────────────┐ │
│  │  Tool Execution Engine                                 │ │
│  │  ToolRegistry → Tool.execute() → Permission check      │ │
│  └────┬───────────────────────────────────────────────────┘ │
│       │                                                      │
│  ┌────▼───────────────────────────────────────────────────┐ │
│  │  Plugin System                                         │ │
│  │  Plugin.trigger() — 14+ hook ポイント                   │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────┬───────────────────────────────────────────────────┘
           │ AI SDK (streamText / wrapLanguageModel)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Provider Layer                                               │
│                                                              │
│  Provider.getLanguage() → SDK → LanguageModelV2              │
│  ProviderTransform — メッセージ正規化・パラメータ変換           │
│                                                              │
│  ┌───────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Anthropic │  │ OpenAI   │  │ Google   │  │ OpenAI-   │  │
│  │           │  │          │  │          │  │ Compatible│  │
│  └─────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│        │             │             │               │        │
│  ┌─────▼─────────────▼─────────────▼───────────────▼─────┐  │
│  │  Middleware Chain                                      │  │
│  │  1. Tool Parser (hermes/xml) — optional               │  │
│  │  2. transformParams (message transform + maxTokens)    │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Storage Layer                                                │
│                                                              │
│  SQLite (Drizzle ORM)                                        │
│  sessions / messages / parts / permissions / tasks            │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. モジュール構成

### src/ ディレクトリ構造

```
packages/opencode/src/
├── session/          ← セッション・LLM ストリーミング・メッセージ処理（中核）
├── provider/         ← プロバイダー・モデル管理・認証・パラメータ変換
├── tool/             ← ツール定義・実行・レジストリ
├── plugin/           ← プラグイン発見・ロード・フック実行
├── agent/            ← エージェント定義・選択
├── config/           ← opencode.json 読み込み・バリデーション
├── auth/             ← 認証情報管理（OAuth/API Key）
├── permission/       ← ツール実行パーミッション検証
├── cli/              ← CLI コマンド・TUI
├── server/           ← HTTP API サーバー
├── project/          ← プロジェクトコンテキスト・インスタンス
├── storage/          ← SQLite データベース（Drizzle ORM）
├── mcp/              ← MCP（Model Context Protocol）サーバー統合
├── lsp/              ← LSP クライアント統合
├── bus/              ← イベント配信（Pub/Sub）
├── effect/           ← Effect.ts インテグレーション・状態管理
├── skill/            ← スキル（再利用可能プロンプト）
├── command/          ← コマンド実行
├── file/             ← ファイル操作
└── util/             ← ロギング・FS・プロセス実行など（40+）
```

### 主要モジュールの責務

| モジュール | 責務 | 主要ファイル |
|-----------|------|------------|
| **session/** | チャットセッション管理・LLM 呼び出し・メッセージ永続化 | index.ts, llm.ts, prompt.ts, processor.ts, message-v2.ts |
| **provider/** | モデルインスタンス生成・SDK キャッシュ・パラメータ変換 | provider.ts, transform.ts, models.ts |
| **tool/** | 組み込み 15+ ツール定義・レジストリ・実行 | registry.ts, tool.ts, bash.ts, read.ts, ... |
| **plugin/** | 4 つの認証プラグイン・フック実行 | index.ts, codex.ts, copilot.ts |
| **config/** | Zod スキーマで opencode.json を検証・8段階の優先度マージ | config.ts |

---

## 3. データフロー

### ユーザー入力 → LLM レスポンスの全体フロー

```
User Input
  │
  ▼
SessionPrompt.prompt()
  │ ユーザーメッセージ作成 → DB 永続化
  │
  ▼
SessionPrompt.loop()          ← while(true) ループ
  │
  ├─ MessageV2.stream()       ← DB からメッセージ読み込み
  ├─ filterCompacted()        ← compaction 以降を削除
  ├─ resolveTools()           ← ToolRegistry + MCP ツール解決
  ├─ SystemPrompt構築         ← environment + instructions + skills
  │
  ▼
SessionProcessor.process()
  │
  ▼
LLM.stream()
  │ Provider.getLanguage()    ← SDK キャッシュ or 生成
  │ wrapLanguageModel()       ← ミドルウェアチェーン
  │ streamText()              ← AI SDK 呼び出し
  │
  ▼
fullStream イテレート
  │ text-delta    → TextPart 逐次更新
  │ tool-call     → ToolPart 作成 → Tool.execute()
  │ tool-result   → ToolPart 完了
  │ finish-step   → トークン・コスト集計
  │
  ▼
Loop 継続判定
  │ finish === "tool-calls" → continue（ツール結果で再推論）
  │ finish === "stop"       → break
  │ error(retryable)        → retry with backoff
  │ error(context overflow) → compaction → continue
  │
  ▼
Assistant Message 完成 → DB 永続化
```

---

## 4. 設計パターン

### Effect.ts Service パターン

OpenCode は **Effect.ts ServiceMap** パターンを全面採用:

```typescript
export namespace MyService {
  export interface Interface {
    readonly method: () => Effect.Effect<ReturnType>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/MyService") {}

  export const layer = Layer.effect(Service, Effect.gen(function* () {
    return Service.of({ method })
  }))

  export const defaultLayer = layer.pipe(Layer.provide(/* 依存 layers */))

  // 外部向けラッパー（Effect 外から呼ぶための bridge）
  const { runPromise } = makeRuntime(Service, defaultLayer)
  export async function method() {
    return runPromise((svc) => svc.method())
  }
}
```

### イベント駆動（Bus）

`Bus` による Pub/Sub でモジュール間を疎結合に接続:

```typescript
// 発行
Bus.publish(Session.Event.Updated({ sessionID, info }))

// 購読
Bus.subscribe(Session.Event.Updated, (event) => { ... })
```

### インスタンス状態（InstanceState）

`ScopedCache` ベースの状態管理。Instance（プロジェクトディレクトリ）ごとにキャッシュされ、`invalidate` で再初期化:

```typescript
import { InstanceState } from "@/effect/instance-state"

// Layer 内で初期化
const state = yield* InstanceState.make<State>(() =>
  Effect.gen(function* () {
    // 初期化処理（Instance ごとに1回）
    return { providers: {}, sdk: new Map() }
  })
)

// 読み取り
const providers = yield* InstanceState.use(state, (s) => s.providers)
const s = yield* InstanceState.get(state)

// 無効化（再初期化トリガー）
yield* InstanceState.invalidate(state)
```

---

## 5. セッション層のファイル構成

| ファイル | 行数 | 責務 |
|---------|------|------|
| **prompt.ts** | 1901 | 会話ループ制御、ツール解決、structured output |
| **message-v2.ts** | 1050 | メッセージ・Part スキーマ、永続化、エラー分類 |
| **index.ts** | 892 | Session CRUD、イベント、サマリー |
| **processor.ts** | 757 | LLM ストリーム → Parts → DB パイプライン |
| **llm.ts** | 426 | AI SDK streamText ラッパー、ミドルウェアチェーン |
| **compaction.ts** | 427 | コンテキスト overflow 対応、history pruning |
| **instruction.ts** | 192 | CLAUDE.md/AGENTS.md 動的読み込み |
| **summary.ts** | 181 | diff 計算、セッションサマリー |
| **revert.ts** | 173 | undo/revert 機能 |
| **retry.ts** | 106 | リトライ遅延計算、retryable 判定 |
| **status.ts** | 102 | セッション状態管理（busy/idle/retry） |
| **session.sql.ts** | 103 | Drizzle ORM テーブル定義 |
| **system.ts** | 76 | モデル別 system prompt テンプレート |
| **todo.ts** | 57 | TODO パーツ管理 |
| **schema.ts** | 38 | SessionID, MessageID, PartID ブランド型 |
| **合計** | ~6480 | |

---

## 6. 外部依存関係

### AI SDK

- `ai@5.x` — Vercel AI SDK（streamText, wrapLanguageModel, LanguageModelV2）
- `@ai-sdk/provider@2.0.x` — プロバイダーインターフェース
- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, ... — バンドル済み SDK（20種、GitHub Copilot はカスタム実装）

### Tool Parser（フォーク追加）

- `@ai-sdk-tool/parser@2.1.7` — function calling 非対応 API 向けミドルウェア

### その他

- Effect.ts — 関数型プログラミング・サービス管理
- Drizzle ORM — SQLite データベース
- Zod — スキーマバリデーション
- Ink — React ベース TUI
