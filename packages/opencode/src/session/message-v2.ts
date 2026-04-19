import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID, PartID } from "./schema"
import z from "zod"
import { NamedError } from "@opencode-ai/shared/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { LSP } from "../lsp"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "../sync"
import { Database, NotFoundError, and, desc, eq, inArray, lt, or } from "@/storage"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { ProviderError } from "@/provider"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect } from "effect"
import { EffectLogger } from "@/effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached image(s) from tool result:"
export { isMedia }

export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
export const StructuredOutputError = NamedError.create(
  "StructuredOutputError",
  z.object({
    message: z.string(),
    retries: z.number(),
  }),
)
export const AuthError = NamedError.create(
  "ProviderAuthError",
  z.object({
    providerID: z.string(),
    message: z.string(),
  }),
)
export const APIError = NamedError.create(
  "APIError",
  z.object({
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
    // Hard veto used by SessionRetry. When true, retryable() returns undefined
    // even if statusCode is 5xx (which would otherwise force-retry regardless of
    // isRetryable). Set by fromError when forceNonRetryable=true (i.e. a tool
    // already executed in this attempt and re-running would duplicate side
    // effects). isRetryable=false alone is not enough because retry.ts:retryable
    // intentionally retries 5xx with isRetryable=false to recover from gateways
    // that mismark transient failures.
    nonRetryable: z.boolean().optional(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
)
export type APIError = z.infer<typeof APIError.Schema>
export const ContextOverflowError = NamedError.create(
  "ContextOverflowError",
  z.object({ message: z.string(), responseBody: z.string().optional() }),
)

export const OutputFormatText = z
  .object({
    type: z.literal("text"),
  })
  .meta({
    ref: "OutputFormatText",
  })

export const OutputFormatJsonSchema = z
  .object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.any()).meta({ ref: "JSONSchema" }),
    retryCount: z.number().int().min(0).default(2),
  })
  .meta({
    ref: "OutputFormatJsonSchema",
  })

export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
  ref: "OutputFormat",
})
export type OutputFormat = z.infer<typeof Format>

const PartBase = z.object({
  id: PartID.zod,
  sessionID: SessionID.zod,
  messageID: MessageID.zod,
})

export const SnapshotPart = PartBase.extend({
  type: z.literal("snapshot"),
  snapshot: z.string(),
}).meta({
  ref: "SnapshotPart",
})
export type SnapshotPart = z.infer<typeof SnapshotPart>

export const PatchPart = PartBase.extend({
  type: z.literal("patch"),
  hash: z.string(),
  files: z.string().array(),
}).meta({
  ref: "PatchPart",
})
export type PatchPart = z.infer<typeof PatchPart>

export const TextPart = PartBase.extend({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  time: z
    .object({
      start: z.number(),
      end: z.number().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).meta({
  ref: "TextPart",
})
export type TextPart = z.infer<typeof TextPart>

export const ReasoningPart = PartBase.extend({
  type: z.literal("reasoning"),
  text: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
  time: z.object({
    start: z.number(),
    end: z.number().optional(),
  }),
}).meta({
  ref: "ReasoningPart",
})
export type ReasoningPart = z.infer<typeof ReasoningPart>

const FilePartSourceBase = z.object({
  text: z
    .object({
      value: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    })
    .meta({
      ref: "FilePartSourceText",
    }),
})

export const FileSource = FilePartSourceBase.extend({
  type: z.literal("file"),
  path: z.string(),
}).meta({
  ref: "FileSource",
})

export const SymbolSource = FilePartSourceBase.extend({
  type: z.literal("symbol"),
  path: z.string(),
  range: LSP.Range,
  name: z.string(),
  kind: z.number().int(),
}).meta({
  ref: "SymbolSource",
})

export const ResourceSource = FilePartSourceBase.extend({
  type: z.literal("resource"),
  clientName: z.string(),
  uri: z.string(),
}).meta({
  ref: "ResourceSource",
})

export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
  ref: "FilePartSource",
})

export const FilePart = PartBase.extend({
  type: z.literal("file"),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string(),
  source: FilePartSource.optional(),
}).meta({
  ref: "FilePart",
})
export type FilePart = z.infer<typeof FilePart>

export const AgentPart = PartBase.extend({
  type: z.literal("agent"),
  name: z.string(),
  source: z
    .object({
      value: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    })
    .optional(),
}).meta({
  ref: "AgentPart",
})
export type AgentPart = z.infer<typeof AgentPart>

export const CompactionPart = PartBase.extend({
  type: z.literal("compaction"),
  auto: z.boolean(),
  overflow: z.boolean().optional(),
}).meta({
  ref: "CompactionPart",
})
export type CompactionPart = z.infer<typeof CompactionPart>

export const SubtaskPart = PartBase.extend({
  type: z.literal("subtask"),
  prompt: z.string(),
  description: z.string(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  command: z.string().optional(),
}).meta({
  ref: "SubtaskPart",
})
export type SubtaskPart = z.infer<typeof SubtaskPart>

export const RetryPart = PartBase.extend({
  type: z.literal("retry"),
  attempt: z.number(),
  error: APIError.Schema,
  time: z.object({
    created: z.number(),
  }),
}).meta({
  ref: "RetryPart",
})
export type RetryPart = z.infer<typeof RetryPart>

export const StepStartPart = PartBase.extend({
  type: z.literal("step-start"),
  snapshot: z.string().optional(),
}).meta({
  ref: "StepStartPart",
})
export type StepStartPart = z.infer<typeof StepStartPart>

export const StepFinishPart = PartBase.extend({
  type: z.literal("step-finish"),
  reason: z.string(),
  snapshot: z.string().optional(),
  cost: z.number(),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
}).meta({
  ref: "StepFinishPart",
})
export type StepFinishPart = z.infer<typeof StepFinishPart>

export const ToolStatePending = z
  .object({
    status: z.literal("pending"),
    input: z.record(z.string(), z.any()),
    raw: z.string(),
  })
  .meta({
    ref: "ToolStatePending",
  })

export type ToolStatePending = z.infer<typeof ToolStatePending>

export const ToolStateRunning = z
  .object({
    status: z.literal("running"),
    input: z.record(z.string(), z.any()),
    title: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
    }),
  })
  .meta({
    ref: "ToolStateRunning",
  })
export type ToolStateRunning = z.infer<typeof ToolStateRunning>

export const ToolStateCompleted = z
  .object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.any()),
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), z.any()),
    time: z.object({
      start: z.number(),
      end: z.number(),
      compacted: z.number().optional(),
    }),
    attachments: FilePart.array().optional(),
  })
  .meta({
    ref: "ToolStateCompleted",
  })
export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

export const ToolStateError = z
  .object({
    status: z.literal("error"),
    input: z.record(z.string(), z.any()),
    error: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  })
  .meta({
    ref: "ToolStateError",
  })
export type ToolStateError = z.infer<typeof ToolStateError>

export const ToolState = z
  .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
  .meta({
    ref: "ToolState",
  })

export const ToolPart = PartBase.extend({
  type: z.literal("tool"),
  callID: z.string(),
  tool: z.string(),
  state: ToolState,
  metadata: z.record(z.string(), z.any()).optional(),
}).meta({
  ref: "ToolPart",
})
export type ToolPart = z.infer<typeof ToolPart>

const Base = z.object({
  id: MessageID.zod,
  sessionID: SessionID.zod,
})

export const User = Base.extend({
  role: z.literal("user"),
  time: z.object({
    created: z.number(),
  }),
  format: Format.optional(),
  summary: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      diffs: Snapshot.FileDiff.array(),
    })
    .optional(),
  agent: z.string(),
  model: z.object({
    providerID: ProviderID.zod,
    modelID: ModelID.zod,
    variant: z.string().optional(),
  }),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
}).meta({
  ref: "UserMessage",
})
export type User = z.infer<typeof User>

export const Part = z
  .discriminatedUnion("type", [
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
  ])
  .meta({
    ref: "Part",
  })
export type Part = z.infer<typeof Part>

export const Assistant = Base.extend({
  role: z.literal("assistant"),
  time: z.object({
    created: z.number(),
    completed: z.number().optional(),
  }),
  error: z
    .discriminatedUnion("name", [
      AuthError.Schema,
      NamedError.Unknown.Schema,
      OutputLengthError.Schema,
      AbortedError.Schema,
      StructuredOutputError.Schema,
      ContextOverflowError.Schema,
      APIError.Schema,
    ])
    .optional(),
  parentID: MessageID.zod,
  modelID: ModelID.zod,
  providerID: ProviderID.zod,
  /**
   * @deprecated
   */
  mode: z.string(),
  agent: z.string(),
  path: z.object({
    cwd: z.string(),
    root: z.string(),
  }),
  summary: z.boolean().optional(),
  cost: z.number(),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
  structured: z.any().optional(),
  variant: z.string().optional(),
  finish: z.string().optional(),
}).meta({
  ref: "AssistantMessage",
})
export type Assistant = z.infer<typeof Assistant>

export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
  ref: "Message",
})
export type Info = z.infer<typeof Info>

export const Event = {
  Updated: SyncEvent.define({
    type: "message.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Removed: SyncEvent.define({
    type: "message.removed",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
    }),
  }),
  PartUpdated: SyncEvent.define({
    type: "message.part.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      part: Part,
      time: z.number(),
    }),
  }),
  PartDelta: BusEvent.define(
    "message.part.delta",
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      field: z.string(),
      delta: z.string(),
    }),
  ),
  PartRemoved: SyncEvent.define({
    type: "message.part.removed",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
    }),
  }),
}

export const WithParts = z.object({
  info: Info,
  parts: z.array(Part),
})
export type WithParts = z.infer<typeof WithParts>

const Cursor = z.object({
  id: MessageID.zod,
  time: z.number(),
})
type Cursor = z.infer<typeof Cursor>

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return Cursor.parse(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
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
  // for providers that don't support media in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Other SDKs (anthropic, google,
  // bedrock) handle type: "content" with media parts natively.
  //
  // Only apply this workaround if the model actually supports image input -
  // otherwise there's no point extracting images.
  const supportsMediaInToolResults = (() => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  })()

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
          { type: "text", text: outputObject.text },
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
      result.push(userMessage)
      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored)
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
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string }> = []

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
      for (const part of msg.parts) {
        if (part.type === "text")
          assistantMessage.parts.push({
            type: "text",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
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
            let outputText = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
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
            const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
            if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
              media.push(...mediaAttachments)
            }
            const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

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
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
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
  options?: { stripMedia?: boolean; pendingDirectives?: Map<string, string> },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options).pipe(Effect.provide(EffectLogger.layer)))
}

export function page(input: { sessionID: SessionID; limit: number; before?: string }) {
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
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
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
}

export function* stream(sessionID: SessionID) {
  const size = 50
  let before: string | undefined
  while (true) {
    const next = page({ sessionID, limit: size, before })
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

export function get(input: { sessionID: SessionID; messageID: MessageID }): WithParts {
  const row = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get(),
  )
  if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: parts(input.messageID),
  }
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  for (const msg of msgs) {
    result.push(msg)
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(stream(sessionID))
})

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
