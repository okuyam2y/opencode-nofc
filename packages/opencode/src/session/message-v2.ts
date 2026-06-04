import { EventV2 } from "@opencode-ai/core/event"
import { SessionID, MessageID, PartID } from "./schema"
import { NamedError } from "@opencode-ai/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "@/snapshot"
import { Database } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import * as ProviderError from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Schema, Types } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { MessageError } from "./message-error"
import { AuthError, OutputLengthError } from "./message-error"
export { AuthError, OutputLengthError } from "./message-error"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

export const AbortedError = NamedError.create("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = NamedError.create("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const APIError = NamedError.create("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  // Hard veto used by SessionRetry. When true, retryable() returns undefined
  // even if statusCode is 5xx (which would otherwise force-retry regardless of
  // isRetryable). Set by fromError when forceNonRetryable=true (i.e. a tool
  // already executed in this attempt and re-running would duplicate side
  // effects). isRetryable=false alone is not enough because retry.ts:retryable
  // intentionally retries 5xx with isRetryable=false to recover from gateways
  // that mismark transient failures.
  nonRetryable: Schema.optional(Schema.Boolean),
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = Schema.Schema.Type<typeof APIError.Schema>
export const ContextOverflowError = NamedError.create("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})

export class OutputFormatText extends Schema.Class<OutputFormatText>("OutputFormatText")({
  type: Schema.Literal("text"),
}) {}

export class OutputFormatJsonSchema extends Schema.Class<OutputFormatJsonSchema>("OutputFormatJsonSchema")({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}) {}

export const Format = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export type OutputFormat = Schema.Schema.Type<typeof Format>

const partBase = {
  id: PartID,
  sessionID: SessionID,
  messageID: MessageID,
}

export const SnapshotPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("snapshot"),
  snapshot: Schema.String,
}).annotate({ identifier: "SnapshotPart" })
export type SnapshotPart = Types.DeepMutable<Schema.Schema.Type<typeof SnapshotPart>>

export const PatchPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("patch"),
  hash: Schema.String,
  files: Schema.Array(Schema.String),
}).annotate({ identifier: "PatchPart" })
export type PatchPart = Types.DeepMutable<Schema.Schema.Type<typeof PatchPart>>

export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPart" })
export type TextPart = Types.DeepMutable<Schema.Schema.Type<typeof TextPart>>

export const ReasoningPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: Schema.optional(NonNegativeInt),
  }),
}).annotate({ identifier: "ReasoningPart" })
export type ReasoningPart = Types.DeepMutable<Schema.Schema.Type<typeof ReasoningPart>>

const filePartSourceBase = {
  text: Schema.Struct({
    value: Schema.String,
    start: Schema.Finite,
    end: Schema.Finite,
  }).annotate({ identifier: "FilePartSourceText" }),
}

export const FileSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("file"),
  path: Schema.String,
}).annotate({ identifier: "FileSource" })

export const SymbolSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: LSP.Range,
  name: Schema.String,
  kind: NonNegativeInt,
}).annotate({ identifier: "SymbolSource" })

export const ResourceSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
}).annotate({ identifier: "ResourceSource" })

export const FilePartSource = Schema.Union([FileSource, SymbolSource, ResourceSource]).annotate({
  discriminator: "type",
  identifier: "FilePartSource",
})

export const FilePart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePart" })
export type FilePart = Types.DeepMutable<Schema.Schema.Type<typeof FilePart>>

export const AgentPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPart" })
export type AgentPart = Types.DeepMutable<Schema.Schema.Type<typeof AgentPart>>

export const CompactionPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
  overflow: Schema.optional(Schema.Boolean),
  tail_start_id: Schema.optional(MessageID),
}).annotate({ identifier: "CompactionPart" })
export type CompactionPart = Types.DeepMutable<Schema.Schema.Type<typeof CompactionPart>>

export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPart" })
export type SubtaskPart = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPart>>

export const RetryPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("retry"),
  attempt: NonNegativeInt,
  error: APIError.EffectSchema,
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
}).annotate({ identifier: "RetryPart" })
export type RetryPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof RetryPart>>, "error"> & {
  error: APIError
}

export const StepStartPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
}).annotate({ identifier: "StepStartPart" })
export type StepStartPart = Types.DeepMutable<Schema.Schema.Type<typeof StepStartPart>>

export const StepFinishPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
}).annotate({ identifier: "StepFinishPart" })
export type StepFinishPart = Types.DeepMutable<Schema.Schema.Type<typeof StepFinishPart>>

export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.Record(Schema.String, Schema.Any),
  raw: Schema.String,
}).annotate({ identifier: "ToolStatePending" })
export type ToolStatePending = Types.DeepMutable<Schema.Schema.Type<typeof ToolStatePending>>

export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Any),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateRunning" })
export type ToolStateRunning = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateRunning>>

export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Any),
  output: Schema.String,
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Any),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
    compacted: Schema.optional(NonNegativeInt),
  }),
  attachments: Schema.optional(Schema.Array(FilePart)),
}).annotate({ identifier: "ToolStateCompleted" })
export type ToolStateCompleted = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateCompleted>>

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Any),
  error: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateError" })
export type ToolStateError = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateError>>

export const ToolState = Schema.Union([
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
]).annotate({
  discriminator: "status",
  identifier: "ToolState",
})
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export const ToolPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "ToolPart" })
export type ToolPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof ToolPart>>, "state"> & {
  state: ToolState
}

const messageBase = {
  id: MessageID,
  sessionID: SessionID,
}

export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
  format: Schema.optional(Format),
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      diffs: Schema.Array(Snapshot.FileDiff),
    }),
  ),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: ProviderID,
    modelID: ModelID,
    variant: Schema.optional(Schema.String),
  }),
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
}).annotate({ identifier: "UserMessage" })
export type User = Types.DeepMutable<Schema.Schema.Type<typeof User>>

export const Part = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "Part" })
export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

const AssistantErrorSchema = Schema.Union([
  ...MessageError.Shared,
  AbortedError.EffectSchema,
  StructuredOutputError.EffectSchema,
  ContextOverflowError.EffectSchema,
  APIError.EffectSchema,
]).annotate({ discriminator: "name" })
type AssistantError = Schema.Schema.Type<typeof AssistantErrorSchema>

// ── Prompt input schemas ─────────────────────────────────────────────────────
//
// Consumers of `SessionPrompt.PromptInput.parts` send part drafts without the
// ambient IDs (`messageID`, `sessionID`) that live on stored parts, and may
// omit `id` to let the server allocate one.  These Schema-Struct variants
// carry that shape so prompt decoding can accept drafts without stored IDs.

export const TextPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPartInput" })
export type TextPartInput = Types.DeepMutable<Schema.Schema.Type<typeof TextPartInput>>

export const FilePartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePartInput" })
export type FilePartInput = Types.DeepMutable<Schema.Schema.Type<typeof FilePartInput>>

export const AgentPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPartInput" })
export type AgentPartInput = Types.DeepMutable<Schema.Schema.Type<typeof AgentPartInput>>

export const SubtaskPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPartInput" })
export type SubtaskPartInput = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPartInput>>

export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({
    created: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
  error: Schema.optional(AssistantErrorSchema),
  parentID: MessageID,
  modelID: ModelID,
  providerID: ProviderID,
  /**
   * @deprecated
   */
  mode: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  structured: Schema.optional(Schema.Any),
  variant: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),
}).annotate({ identifier: "AssistantMessage" })
export type Assistant = Omit<Types.DeepMutable<Schema.Schema.Type<typeof Assistant>>, "error"> & {
  error?: AssistantError
}

export const Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export type Info = User | Assistant

export const Event = {
  Updated: EventV2.define({
    type: "message.updated",
    sync: { version: 1, aggregate: "sessionID" },
    schema: {
      sessionID: SessionID,
      info: Info,
    },
  }),
  Removed: EventV2.define({
    type: "message.removed",
    sync: { version: 1, aggregate: "sessionID" },
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
    },
  }),
  PartUpdated: EventV2.define({
    type: "message.part.updated",
    sync: { version: 1, aggregate: "sessionID" },
    schema: {
      sessionID: SessionID,
      part: Part,
      time: NonNegativeInt,
    },
  }),
  PartDelta: EventV2.define({
    type: "message.part.delta",
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
      partID: PartID,
      field: Schema.String,
      delta: Schema.String,
    },
  }),
  PartRemoved: EventV2.define({
    type: "message.part.removed",
    sync: { version: 1, aggregate: "sessionID" },
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
      partID: PartID,
    },
  }),
}

export const WithParts = Schema.Struct({
  info: Info,
  parts: Schema.Array(Part),
})
export type WithParts = {
  info: Info
  parts: Part[]
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  if (ids.length > 0) {
    const partRows = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all(),
    )
    for (const row of partRows) {
      const next = part(row)
      const list = partByMessage.get(row.message_id)
      if (list) list.push(next)
      else partByMessage.set(row.message_id, [next])
    }
  }

  return rows.map((row) => ({
    info: info(row),
    parts: partByMessage.get(row.id) ?? [],
  }))
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  // Drop internal flags that must not reach the provider:
  //  - providerExecuted: AI SDK bookkeeping for provider-side tool execution
  //  - notFound: hermes-only marker that tells toModelMessages to rewrite
  //    a File-not-found result into a minimal fixed-text reply
  //  - resetDirective: legacy field from rev.3 of tool-failure-reset-hook
  //    (never actually written in rev.4+, dropped here for forward safety if
  //    historical DB rows or a future bug resurrected it)
  const { providerExecuted: _, notFound: _n, resetDirective: _r, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: {
    stripMedia?: boolean
    toolOutputMaxChars?: number
    /**
     * Map of tool part ID → reset directive.  When a failing tool part is
     * rewritten to a model message and its ID is present in this map, the
     * directive is prepended to errorText so the model sees it immediately
     * before the actual error content.
     *
     * Consume-once invariant: the caller (prompt.ts main loop) drains the
     * pending directives Map before calling toModelMessagesEffect and
     * discards it afterward.  Passing `undefined` or omitting the option
     * (e.g. title generation, compaction) yields existing behavior.
     */
    pendingDirectives?: Map<string, string>
  },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support that media type in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Some SDKs only support a subset
  // of media in tool results; e.g. Bedrock supports images but not PDFs there.
  //
  // Only apply this workaround if the model actually supports that media input -
  // otherwise unsupportedParts() will turn it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns like:
      // step-start, reasoning(signature), text(""), step-start,
      // reasoning(signature). The empty text part is a structural separator,
      // but it does not carry the signature metadata itself. Dropping it shifts
      // signed thinking positions after step-start splitting/provider regrouping;
      // keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // It is unclear whether this shape originates in our stream processing,
      // a proxy, or a lower-level library, but preserving a non-empty separator
      // here is the only safe replay point we have.
      // Use a single space so the separator survives replay without changing
      // the neighboring signed reasoning blocks.
      const hasSignedReasoning = msg.parts.some((part) => {
        if (part.type !== "reasoning") return false
        return part.metadata?.anthropic?.signature != null
      })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          // A reset directive from SessionFailureTracker lives in the caller's
          // pending Map for exactly one rebuild.  Read (not delete) here —
          // the caller guarantees the whole Map is discarded after this call,
          // so the directive fires on exactly one llm.stream() invocation.
          const resetDirective = options?.pendingDirectives?.get(part.id)
          // hermes: replace File-not-found results with a minimal message
          // to prevent hallucination from candidate paths. Keep a glob hint
          // so the model can self-correct. The notFound flag is only set when
          // toolParser is active (processor.ts), so native FC is never affected.
          if (part.metadata?.notFound === true) {
            toolNames.add(part.tool)
            const baseText = "[File does not exist — use glob to search for the correct path]"
            const errorText = resetDirective ? `${resetDirective}\n\n${baseText}` : baseText
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: {},
              errorText,
              // Passthrough metadata (e.g. anthropicCacheControl) must survive
              // the hermes rewrite just like it does on the normal error path.
              // providerMeta() strips internal flags (providerExecuted / notFound /
              // resetDirective).
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
            continue
          }
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            let outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            // Prepend exit code so the model sees non-zero exit explicitly.
            // Currently only bash sets metadata.exit (bash.ts).
            // Skip for compacted messages — the original output is gone, signal is not useful.
            // Note: rev.5 softened the prefix from "[SOFT FAILURE: exit_code=N]" to "[exit_code=N]"
            // because "FAILURE" was too strong — it made models overly cautious in test-driven loops.
            if (!part.state.time.compacted) {
              const exitCode = part.state.metadata?.exit
              if (typeof exitCode === "number" && exitCode !== 0) {
                outputText = `[exit_code=${exitCode}]\n${outputText}`
              }
            }
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              const errorText = resetDirective
                ? `${resetDirective}\n\n---\n${part.state.error}`
                : part.state.error
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            if (part.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: part.metadata,
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number; pendingDirectives?: Map<string, string> },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options).pipe(Effect.provide(EffectLogger.layer)))
}

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(where)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(input.limit + 1)
      .all(),
  )
  if (rows.length === 0) {
    const row = Database.use((db) =>
      db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
    )
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = hydrate(slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

export function* stream(sessionID: SessionID) {
  const size = 50
  let before: string | undefined
  while (true) {
    const next = Effect.runSync(
      page({ sessionID, limit: size, before }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
        ),
      ),
    )
    if (next.items.length === 0) break
    for (let i = next.items.length - 1; i >= 0; i--) {
      yield next.items[i]
    }
    if (!next.more || !next.cursor) break
    before = next.cursor
  }
}

export function parts(message_id: MessageID) {
  const rows = Database.use((db) =>
    db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
  )
  return rows.map(
    (row) =>
      ({
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      }) as Part,
  )
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const row = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get(),
  )
  if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: parts(input.messageID),
  }
})

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(stream(sessionID))
})

// filterCompacted reorders messages for model consumption
// ([compaction-user, summary, ...retained tail..., continue-user]), so array
// position is not chronological. Derive each binding by max id (MessageID
// is monotonic via MessageID.ascending) so a pre-compaction overflowing tail
// assistant doesn't get mistaken for the most recent turn. tasks are
// compaction/subtask parts attached to user messages newer than the latest
// finished assistant — i.e. unprocessed work.
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && (!user || info.id > user.id)) user = info
    if (info.role === "assistant" && (!assistant || info.id > assistant.id)) assistant = info
    if (info.role === "assistant" && info.finish && (!finished || info.id > finished.id)) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && m.info.id <= finished.id
      ? []
      : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

/** Typed Error for retryable stream errors (5xx or transient connection drops).
 *  Preserves statusCode (when present) and the original cause through the
 *  async-iterable error mapper in LLM.Service.stream(). statusCode is optional
 *  because connection-reset errors (ECONNRESET, EPIPE, etc.) have no HTTP status. */
export class StreamRetryableError extends Error {
  readonly statusCode: number | undefined
  constructor(statusCode: number | undefined, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "StreamRetryableError"
    this.statusCode = statusCode
  }
}

const CONTENT_FILTER_RE = /content management policy|content filtering|response was filtered|content_filter/i

/** Connection-reset / transient socket failures we treat as retryable even when
 *  the upstream SDK marks them isRetryable=false. ECONNREFUSED is intentionally
 *  excluded — it indicates the gateway is unreachable, not a transient drop. */
const CONNECTION_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "UND_ERR_SOCKET"])

/** Extract HTTP status code from heterogeneous error shapes (plain objects, Error subclasses, JSON-encoded messages). */
export function extractStatusCode(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined
  const direct = (e as any).status ?? (e as any).statusCode ?? (e as any).code ?? (e as any).response?.statusCode
  if (typeof direct === "number") return direct
  const msg = (e as any).message
  if (typeof msg === "string") {
    try {
      const parsed = JSON.parse(msg)
      if (typeof parsed === "object" && parsed !== null) {
        const code = parsed.status ?? parsed.statusCode ?? parsed.code
        if (typeof code === "number") return code
      }
    } catch {}
  }
  return undefined
}

/** Extract a known transient connection-error code (ECONNRESET, EPIPE, ETIMEDOUT, ECONNABORTED, UND_ERR_SOCKET).
 *  Walks the SDK shapes we observe in stream `error` parts:
 *  - `error.data.metadata.code` (AI SDK APIError JSON serialization)
 *  - `error.metadata.code` (AI SDK APIError instance)
 *  - `error.code` (Node SystemError / direct throw)
 *  - `error.cause.code` (wrapped Error)
 *  Returns the matching code (string) or undefined. */
export function extractConnectionErrorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined
  const candidates: unknown[] = [
    (e as any).data?.metadata?.code,
    (e as any).metadata?.code,
    (e as any).code,
    (e as any).cause?.code,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && CONNECTION_ERROR_CODES.has(c)) return c
  }
  return undefined
}

/** Check if error message indicates a content filter block (should not be retried). */
export function isContentFilter(e: unknown): boolean {
  if (typeof e === "string") return CONTENT_FILTER_RE.test(e)
  if (typeof e !== "object" || e === null) return false
  if (typeof (e as any).message === "string" && CONTENT_FILTER_RE.test((e as any).message)) return true
  const nested = (e as any).error
  if (typeof nested === "object" && nested !== null && typeof nested.message === "string" && CONTENT_FILTER_RE.test(nested.message))
    return true
  try {
    return CONTENT_FILTER_RE.test(JSON.stringify(e))
  } catch {
    return false
  }
}

/** Best-effort extraction of a human-readable error message. AI SDK serializes
 *  APIError instances with the user-facing message at `err.data.message` rather
 *  than `err.message`, so prefer that when present and fall back to top-level. */
function streamErrorMessage(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err)
  const dataMsg = (err as any).data?.message
  if (typeof dataMsg === "string" && dataMsg) return dataMsg
  const topMsg = (err as any).message
  if (typeof topMsg === "string" && topMsg) return topMsg
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Inspect a single AI SDK stream part. If it is an `error` part that should be
 *  promoted to a thrown error (5xx server failure or transient connection drop),
 *  return a StreamRetryableError. Otherwise return undefined and the caller
 *  should pass the part through unchanged. */
export function tryEscalateStreamError(part: unknown): StreamRetryableError | undefined {
  if (typeof part !== "object" || part === null) return undefined
  if ((part as { type?: unknown }).type !== "error") return undefined
  const err = (part as { error?: unknown }).error
  if (isContentFilter(err)) return undefined
  const statusCode = extractStatusCode(err)
  if (statusCode !== undefined && statusCode >= 500) {
    return new StreamRetryableError(statusCode, streamErrorMessage(err), err)
  }
  if (extractConnectionErrorCode(err)) {
    return new StreamRetryableError(undefined, streamErrorMessage(err), err)
  }
  return undefined
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderID; aborted?: boolean; forceNonRetryable?: boolean },
): NonNullable<Assistant["error"]> {
  const result = fromErrorInner(e, ctx)
  // When forceNonRetryable is set (a tool already ran in this attempt and
  // retry would duplicate side effects), stamp the veto on every APIError
  // result. We set BOTH isRetryable=false and nonRetryable=true because
  // SessionRetry.retryable forces-retry 5xx even when isRetryable=false to
  // recover from gateways that mismark transient failures. nonRetryable is
  // the unconditional veto that short-circuits that 5xx escape hatch.
  if (ctx.forceNonRetryable && APIError.isInstance(result)) {
    return new APIError(
      { ...result.data, isRetryable: false, nonRetryable: true },
      { cause: e },
    ).toObject()
  }
  return result
}

function fromErrorInner(
  e: unknown,
  ctx: { providerID: ProviderID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof StreamRetryableError:
      return new APIError(
        {
          message: e.message,
          statusCode: e.statusCode,
          isRetryable: true,
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      // Treat 5xx errors as retryable even when thrown as plain objects
      // (e.g. ai-sdk stream errors from non-standard providers).
      const statusCode = extractStatusCode(e)
      if (typeof statusCode === "number" && statusCode >= 500) {
        const errMsg = typeof (e as any).message === "string" ? (e as any).message : JSON.stringify(e)
        const contentFiltered = isContentFilter(e)
        return new APIError(
          {
            message: contentFiltered
              ? "Request blocked by content filter. Try rephrasing your prompt."
              : errMsg,
            statusCode,
            isRetryable: !contentFiltered,
          },
          { cause: e },
        ).toObject()
      }
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
