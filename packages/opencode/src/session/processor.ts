import { generateId } from "ai"
import { Cause, Deferred, Effect, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "."
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { Log } from "@/util/log"
import { isRecord } from "@/util/record"
import { containsSpamInValues, stripSpam } from "@/util/spam-filter"
import { Flag } from "@/flag/flag"

/**
 * Strip tool response/result tags that models echo from conversation history.
 */
function stripToolTags(text: string): string {
  return text
    // 1. Remove complete tag pairs (open...close)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/<commentary>[\s\S]*?<\/commentary>/g, "")
    .replace(/<multi_tool_use\.parallel>[\s\S]*?<\/multi_tool_use\.parallel>/g, "")
    // 2. Remove unclosed open tag through end of string — must run BEFORE
    //    standalone tag removal (step 3), otherwise step 3 strips the open tag
    //    but leaves the content (JSON body, etc.) intact.
    .replace(/<(?:tool_call|tool_result|tool_response|commentary|multi_tool_use\.parallel)>[\s\S]*$/g, "")
    // 3. Remove orphaned standalone open/close tags
    .replace(/<\/?tool_call>/g, "")
    .replace(/<\/?tool_response>/g, "")
    .replace(/<\/?tool_result>/g, "")
    .replace(/<\/?commentary>/g, "")
    .replace(/<\/?multi_tool_use\.parallel>/g, "")
    .replace(trailingPartialTagRe, "")
    .trimEnd()
}

/**
 * Streaming-aware filter that buffers text-delta chunks when they might be
 * inside a tag that stripToolTags would remove at text-end.
 */
const STRIP_TAG_NAMES = ["tool_call", "tool_response", "tool_result", "commentary", "multi_tool_use.parallel"]
const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const STRIP_OPEN_RE = new RegExp(`<(?:${STRIP_TAG_NAMES.map(escapeForRegex).join("|")})>`)
const STRIP_CLOSE_RE = new RegExp(`</(?:${STRIP_TAG_NAMES.map(escapeForRegex).join("|")})>`)

// Builds a regex that matches a trailing partial tag (open or close) at end of string.
// For tag "tool_call", generates open: <(?:t(?:o(...)?)?)?$ and close: <(?:/(?:t(?:o(...)?)?)?)?$
// This catches any prefix of "<tool_call>" or "</tool_call>" that got cut off mid-stream.
function buildPartialTagRe(names: string[]): RegExp {
  const alts: string[] = []
  for (const name of names) {
    // Open tag: <tag_name>
    let open = ""
    for (let i = name.length; i >= 1; i--) {
      open = escapeForRegex(name[i - 1]) + "(?:" + open + ")?"
    }
    alts.push(open)
    // Close tag: </tag_name>
    let close = ""
    for (let i = name.length; i >= 1; i--) {
      close = escapeForRegex(name[i - 1]) + "(?:" + close + ")?"
    }
    alts.push(`/(?:${close})?`)
  }
  return new RegExp(`<(?:${alts.join("|")})$`)
}
const trailingPartialTagRe = buildPartialTagRe(STRIP_TAG_NAMES)

function createStreamingTagFilter() {
  let buf = ""
  let inside = false
  let hasPartial = false
  return {
    push(delta: string): string {
      buf += delta
      let out = ""
      while (true) {
        if (!inside) {
          // If we were holding a partial tag prefix from a previous delta,
          // check whether it's still valid before doing anything else.
          // This prevents stale prefixes from leaking via later tag matches.
          if (hasPartial && !isStillValidPartial(buf)) {
            const dropLen = longestValidPrefixLen(buf)
            buf = buf.slice(dropLen)
            hasPartial = false
            continue
          }
          const m = buf.match(STRIP_OPEN_RE)
          if (m && m.index !== undefined) {
            out += buf.slice(0, m.index)
            buf = buf.slice(m.index)
            inside = true
            hasPartial = false
            continue
          }
          const partialIdx = partialOpenTagIndex(buf)
          if (partialIdx >= 0) {
            out += buf.slice(0, partialIdx)
            buf = buf.slice(partialIdx)
            hasPartial = true
          } else {
            out += buf
            buf = ""
            hasPartial = false
          }
          break
        } else {
          const cm = buf.match(STRIP_CLOSE_RE)
          if (cm && cm.index !== undefined) {
            buf = buf.slice(cm.index + cm[0].length)
            inside = false
            continue
          }
          break
        }
      }
      return out
    },
    flush(): string {
      if (inside) {
        // Discard buffered content inside an unclosed tag (e.g. stream cut off
        // mid-tag due to gateway error) to prevent leaking raw tool markup.
        buf = ""
        inside = false
        hasPartial = false
        return ""
      }
      // Also strip any partial opening tag left in the buffer (e.g. stream
      // cut off mid-tag like "<tool_respons" or "<multi_tool_use.par").
      const partialIdx = partialOpenTagIndex(buf)
      if (partialIdx >= 0) {
        const rest = buf.slice(0, partialIdx)
        buf = ""
        hasPartial = false
        return rest
      }
      const rest = buf
      buf = ""
      return rest
    },
  }
}

function partialOpenTagIndex(text: string): number {
  const tail = text.slice(-30)
  const offset = text.length - tail.length
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i] !== "<") continue
    const candidate = tail.slice(i)
    for (const tag of STRIP_TAG_NAMES) {
      // Check both open tag `<tag>` and close tag `</tag>` prefixes
      const open = `<${tag}>`
      if (candidate.length < open.length && open.startsWith(candidate)) {
        return offset + i
      }
      const close = `</${tag}>`
      if (candidate.length < close.length && close.startsWith(candidate)) {
        return offset + i
      }
    }
  }
  return -1
}

/** Check whether `buf` (which starts with a previously-valid partial tag)
 *  could still resolve normally — either it's still an incomplete prefix that
 *  could complete into `<tag_name>` or `</tag_name>`, or it already contains a
 *  complete tag (which STRIP_OPEN_RE/STRIP_CLOSE_RE will handle).  Returns
 *  false only when buf has diverged from all tag names. */
function isStillValidPartial(buf: string): boolean {
  for (const tag of STRIP_TAG_NAMES) {
    for (const full of [`<${tag}>`, `</${tag}>`]) {
      const checkLen = Math.min(buf.length, full.length)
      if (full.slice(0, checkLen) === buf.slice(0, checkLen)) return true
    }
  }
  return false
}

/** Return the length of the longest prefix of `text` that is also a prefix
 *  of some tag (open or close) in STRIP_TAG_NAMES.  Used to determine how
 *  many characters to drop when a previously-valid partial tag becomes invalid
 *  (e.g. "<tool" was valid, then " match" arrived making "<tool match" invalid;
 *  longestValidPrefixLen returns 5 for "<tool"). */
function longestValidPrefixLen(text: string): number {
  let maxLen = 0
  for (const tag of STRIP_TAG_NAMES) {
    for (const full of [`<${tag}>`, `</${tag}>`]) {
      let len = 0
      while (len < text.length && len < full.length && text[len] === full[len]) {
        len++
      }
      if (len > maxLen) maxLen = len
    }
  }
  return maxLen
}

/**
 * Estimate character count of an unknown value for token estimation.
 * Strings are measured by length; structured data (object/array/number/boolean/null)
 * is serialized to capture keys, delimiters, and non-string primitives.
 */
function estimateChars(value: unknown): number {
  if (typeof value === "string") return value.length
  if (value === undefined) return 0
  return JSON.stringify(value).length
}

/**
 * Estimate token count from messages and system prompts by character count.
 * Used as fallback when gateway returns non-cumulative usage data.
 *
 * The returned value represents "effective input" (cached + uncached),
 * matching the definition of reportedInput (= usage.tokens.input + cache.read).
 */
function estimateTokensFromInput(input: { messages: unknown[]; system: string[]; tools: Record<string, unknown> }): number {
  let chars = 0
  for (const sys of input.system) {
    chars += sys.length
  }
  // llm.ts adds agent.prompt / SystemPrompt.provider / user.system to the
  // system array AFTER streamInput is constructed.  These are not included
  // in streamInput.system, so we add a fixed overhead (~8K chars for the
  // default system prompt + agent prompt + provider-specific additions).
  const SYSTEM_PROMPT_OVERHEAD_CHARS = 8000
  chars += SYSTEM_PROMPT_OVERHEAD_CHARS
  const TOOL_SCHEMA_OVERHEAD_CHARS = 1800
  for (const t of Object.values(input.tools)) {
    const tool = t as Record<string, unknown>
    if (typeof tool.description === "string") chars += tool.description.length
    chars += TOOL_SCHEMA_OVERHEAD_CHARS
  }
  for (const msg of input.messages) {
    const m = msg as Record<string, unknown>
    if (typeof m.content === "string") {
      chars += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        const p = part as Record<string, unknown>
        if (typeof p.text === "string") chars += p.text.length
        if (typeof p.content === "string") chars += p.content.length
        // ToolResultPart.output — tool result (text, json, content, error-text, etc.)
        if (p.output !== undefined) chars += estimateChars(p.output)
        // ToolCallPart.args — tool call input
        if (p.args !== undefined) chars += estimateChars(p.args)
        // ToolApprovalResponse.result — approval/denial reason text
        if (typeof p.result === "string") chars += p.result.length
      }
    }
  }
  return Math.ceil(chars / 3)
}

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  /**
   * Build a dedup key from tool name and input.
   * NUL separator prevents collisions between tool names and input JSON.
   */
  export function dedupKey(toolName: string, input: Record<string, unknown>): string {
    return toolName + "\0" + JSON.stringify(input)
  }

  /**
   * Check whether an identical tool call (same name + input) was already
   * accepted in this step.  Uses a Set that survives tool-result deletions
   * from ctx.toolcalls (which clears entries on completion).
   *
   * Exported for unit testing.
   */
  /** Re-export for unit testing. */
  export const _stripToolTags = stripToolTags

  export function isDuplicate(
    acceptedKeys: Set<string>,
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    return acceptedKeys.has(dedupKey(toolName, input))
  }

  /**
   * Detect near-duplicate write tool calls targeting the same filePath within
   * a single step.  hermes parser boundary errors can split one write into
   * two calls — first incomplete, second complete.  Exact dedup (isDuplicate)
   * misses these because the content differs.
   *
   * Pure check — does NOT update the map.  Call {@link trackWriteFilePath}
   * after deciding to allow the write so skipped calls never become the
   * comparison baseline.
   * Exported for unit testing.
   */
  export function checkNearDuplicateWrite(
    writeFilePaths: Map<string, { toolCallId: string; contentLength: number }>,
    toolName: string,
    input: Record<string, unknown>,
  ): { prevToolCallId: string; prevContentLength: number; newContentLength: number } | undefined {
    if (toolName !== "write" || typeof input.filePath !== "string") return
    const prev = writeFilePaths.get(input.filePath)
    if (!prev) return
    const contentLength = typeof input.content === "string" ? input.content.length : 0
    return { prevToolCallId: prev.toolCallId, prevContentLength: prev.contentLength, newContentLength: contentLength }
  }

  /** Record an allowed write so future near-duplicate checks compare against it. */
  export function trackWriteFilePath(
    writeFilePaths: Map<string, { toolCallId: string; contentLength: number }>,
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ): void {
    if (toolName !== "write" || typeof input.filePath !== "string") return
    const contentLength = typeof input.content === "string" ? input.content.length : 0
    writeFilePaths.set(input.filePath, { toolCallId, contentLength })
  }

  export type Result = "compact" | "stop" | "continue"

  export type Event = LLM.Event

  export interface Handle {
    readonly message: MessageV2.Assistant
    readonly updateToolCall: (
      toolCallID: string,
      update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
    ) => Effect.Effect<MessageV2.ToolPart | undefined>
    readonly completeToolCall: (
      toolCallID: string,
      output: {
        title: string
        metadata: Record<string, any>
        output: string
        attachments?: MessageV2.FilePart[]
      },
    ) => Effect.Effect<void>
    readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  }

  type Input = {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
    /** Highest confirmed inputTokens (input + cache.read) from previous turns.
     *  Used by the monotonic-decrease detector to catch per-turn gateways that
     *  slip through the multi-step and single-step heuristics. */
    confirmedInput?: number
  }

  export interface Interface {
    readonly create: (input: Input) => Effect.Effect<Handle>
  }

  type ToolCall = {
    partID: MessageV2.ToolPart["id"]
    messageID: MessageV2.ToolPart["messageID"]
    sessionID: MessageV2.ToolPart["sessionID"]
    done: Deferred.Deferred<void>
  }

  interface ProcessorContext extends Input {
    toolcalls: Record<string, ToolCall>
    /** Set to true by tool-input-start / tool-call, reset by start-step.
     *  Unlike ctx.toolcalls (which entries are deleted on completion),
     *  this flag persists until the next step so finishReason override works. */
    hasToolCalls: boolean
    /** Keys of accepted (non-deduped) tool calls: "toolName\0" + JSON.stringify(input).
     *  Persists across tool-result deletions from ctx.toolcalls so that dedup
     *  still detects duplicates even after the first call completes. */
    acceptedToolKeys: Set<string>
    /** Tracks write tool filePaths within the current step for near-duplicate
     *  detection.  Maps filePath → { toolCallId, contentLength }. */
    writeFilePaths: Map<string, { toolCallId: string; contentLength: number }>
    shouldBreak: boolean
    snapshot: string | undefined
    blocked: boolean
    needsCompaction: boolean
    currentText: MessageV2.TextPart | undefined
    tagFilter: ReturnType<typeof createStreamingTagFilter> | undefined
    reasoningMap: Record<string, MessageV2.ReasoningPart>
    lastStreamInput: LLM.StreamInput | undefined
    /** Highest reported inputTokens seen across steps.  Used to detect
     *  gateways that return per-turn (non-cumulative) usage — the first
     *  step typically includes system prompt + tool defs and is large,
     *  while subsequent steps drop to near-zero. */
    maxReportedInput: number
  }

  type StreamEvent = Event

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Session.Service
    | Config.Service
    | Bus.Service
    | Snapshot.Service
    | Agent.Service
    | LLM.Service
    | Permission.Service
    | Plugin.Service
    | SessionSummary.Service
    | SessionStatus.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const session = yield* Session.Service
      const config = yield* Config.Service
      const bus = yield* Bus.Service
      const snapshot = yield* Snapshot.Service
      const agents = yield* Agent.Service
      const llm = yield* LLM.Service
      const permission = yield* Permission.Service
      const plugin = yield* Plugin.Service
      const summary = yield* SessionSummary.Service
      const scope = yield* Scope.Scope
      const status = yield* SessionStatus.Service

      const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
        // Pre-capture snapshot before the LLM stream starts. The AI SDK
        // may execute tools internally before emitting start-step events,
        // so capturing inside the event handler can be too late.
        const initialSnapshot = yield* snapshot.track()
        const ctx: ProcessorContext = {
          assistantMessage: input.assistantMessage,
          sessionID: input.sessionID,
          model: input.model,
          toolcalls: {},
          hasToolCalls: false,
          acceptedToolKeys: new Set(),
          writeFilePaths: new Map(),
          shouldBreak: false,
          snapshot: initialSnapshot,
          blocked: false,
          needsCompaction: false,
          currentText: undefined,
          tagFilter: undefined,
          lastStreamInput: undefined,
          maxReportedInput: 0,
          reasoningMap: {},
        }
        let aborted = false
        const slog = log.clone().tag("sessionID", input.sessionID).tag("messageID", input.assistantMessage.id)
        /** Attempt-scoped flag: set to true when any tool reaches completed or error state.
         *  Unlike ctx.hasToolCalls (step-scoped, reset on start-step), this persists
         *  across steps within a single attempt and prevents retry after tool execution. */
        let hasExecutedTool = false

        const parse = (e: unknown) =>
          MessageV2.fromError(e, {
            providerID: input.model.providerID,
            aborted,
            forceNonRetryable: hasExecutedTool,
          })

        const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
          const done = ctx.toolcalls[toolCallID]?.done
          delete ctx.toolcalls[toolCallID]
          if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
        })

        const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
          const call = ctx.toolcalls[toolCallID]
          if (!call) return
          const part = yield* session.getPart({
            partID: call.partID,
            messageID: call.messageID,
            sessionID: call.sessionID,
          })
          if (!part || part.type !== "tool") {
            delete ctx.toolcalls[toolCallID]
            return
          }
          return { call, part }
        })

        const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
          toolCallID: string,
          update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
        ) {
          const match = yield* readToolCall(toolCallID)
          if (!match) return
          const part = yield* session.updatePart(update(match.part))
          ctx.toolcalls[toolCallID] = {
            ...match.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return part
        })

        const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
          toolCallID: string,
          output: {
            title: string
            metadata: Record<string, any>
            output: string
            attachments?: MessageV2.FilePart[]
          },
        ) {
          const match = yield* readToolCall(toolCallID)
          if (!match || match.part.state.status !== "running") return
          yield* session.updatePart({
            ...match.part,
            state: {
              status: "completed",
              input: match.part.state.input,
              output: output.output,
              metadata: output.metadata,
              title: output.title,
              time: { start: match.part.state.time.start, end: Date.now() },
              attachments: output.attachments,
            },
          })
          yield* settleToolCall(toolCallID)
        })

        const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
          const match = yield* readToolCall(toolCallID)
          if (!match || match.part.state.status !== "running") return false
          yield* session.updatePart({
            ...match.part,
            state: {
              status: "error",
              input: match.part.state.input,
              error: errorMessage(error),
              time: { start: match.part.state.time.start, end: Date.now() },
            },
          })
          if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
            ctx.blocked = ctx.shouldBreak
          }
          yield* settleToolCall(toolCallID)
          return true
        })

        const handleEvent = Effect.fn("SessionProcessor.handleEvent")(function* (value: StreamEvent) {
          switch (value.type) {
            case "start":
              yield* status.set(ctx.sessionID, { type: "busy" })
              return

            case "reasoning-start":
              if (value.id in ctx.reasoningMap) return
              ctx.reasoningMap[value.id] = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "reasoning",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              yield* session.updatePart(ctx.reasoningMap[value.id])
              return

            case "reasoning-delta":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text += value.text
              if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: ctx.reasoningMap[value.id].sessionID,
                messageID: ctx.reasoningMap[value.id].messageID,
                partID: ctx.reasoningMap[value.id].id,
                field: "text",
                delta: value.text,
              })
              return

            case "reasoning-end":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text
              ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
              if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
              yield* session.updatePart(ctx.reasoningMap[value.id])
              delete ctx.reasoningMap[value.id]
              return

            case "tool-input-start":
              log.debug("tool-input-start", { id: value.id, toolName: value.toolName })
              ctx.hasToolCalls = true
              if (ctx.assistantMessage.summary) {
                throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
              }
              const part = yield* session.updatePart({
                id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "tool",
                tool: value.toolName,
                callID: value.id,
                state: { status: "pending", input: {}, raw: "" },
                metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
              } satisfies MessageV2.ToolPart)
              ctx.toolcalls[value.id] = {
                done: yield* Deferred.make<void>(),
                partID: part.id,
                messageID: part.messageID,
                sessionID: part.sessionID,
              }
              return

            case "tool-input-delta":
              return

            case "tool-input-end":
              return

            case "tool-call": {
              log.debug("tool-call", { toolCallId: value.toolCallId, toolName: value.toolName })
              ctx.hasToolCalls = true
              if (ctx.assistantMessage.summary) {
                throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
              }
              // tool-parser middleware (hermes) skips tool-input-start and emits
              // tool-call directly.  Create the tool part on the fly when it
              // doesn't exist yet — otherwise the call is silently dropped, the
              // tool never executes, and the prompt loop spins forever.
              if (!ctx.toolcalls[value.toolCallId]) {
                log.warn("tool-call without prior tool-input-start", {
                  toolCallId: value.toolCallId,
                  toolName: value.toolName,
                })
                const part = yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "tool",
                  tool: value.toolName,
                  callID: value.toolCallId,
                  state: { status: "pending", input: {}, raw: "" },
                } satisfies MessageV2.ToolPart)
                ctx.toolcalls[value.toolCallId] = {
                  done: yield* Deferred.make<void>(),
                  partID: part.id,
                  messageID: part.messageID,
                  sessionID: part.sessionID,
                }
              }
              // Stage 3: reject tool calls with spam-contaminated arguments
              if (containsSpamInValues(value.input)) {
                log.warn("tool-call blocked: spam detected in arguments", {
                  toolCallId: value.toolCallId,
                  toolName: value.toolName,
                })
                const spamMatch = yield* readToolCall(value.toolCallId)
                if (spamMatch) {
                  yield* session.updatePart({
                    ...spamMatch.part,
                    tool: value.toolName,
                    state: {
                      status: "error",
                      input: value.input,
                      error: "Tool call blocked: training data contamination detected in arguments",
                      time: { start: Date.now(), end: Date.now() },
                    },
                  })
                  yield* settleToolCall(value.toolCallId)
                }
                return
              }
              // Stage 4: deduplicate identical tool calls within the same step.
              if (isDuplicate(ctx.acceptedToolKeys, value.toolName, value.input)) {
                log.warn("tool-call deduplicated", {
                  toolCallId: value.toolCallId,
                  toolName: value.toolName,
                  input: JSON.stringify(value.input).slice(0, 200),
                })
                const dupMatch = yield* readToolCall(value.toolCallId)
                if (dupMatch) {
                  yield* session.updatePart({
                    ...dupMatch.part,
                    tool: value.toolName,
                    state: {
                      status: "error",
                      input: value.input,
                      error: "Duplicate tool call deduplicated",
                      time: { start: Date.now(), end: Date.now() },
                    },
                  })
                  yield* settleToolCall(value.toolCallId)
                }
                return
              }
              ctx.acceptedToolKeys.add(dedupKey(value.toolName, value.input))
              // Stage 5: near-duplicate write detection (same filePath, different content).
              // hermes can split one write into incomplete + complete pair.
              // The second (longer) write overwrites the first, so allow execution
              // but log for monitoring.  Shorter duplicates are skipped.
              // Map is only updated for allowed writes so skipped calls never
              // become the comparison baseline.
              const nearDup = checkNearDuplicateWrite(ctx.writeFilePaths, value.toolName, value.input)
              if (nearDup) {
                if (nearDup.newContentLength <= nearDup.prevContentLength) {
                  log.warn("near-duplicate write skipped (shorter or equal content)", {
                    toolCallId: value.toolCallId,
                    toolName: value.toolName,
                    filePath: (value.input as Record<string, unknown>).filePath,
                    prevToolCallId: nearDup.prevToolCallId,
                    prevContentLength: nearDup.prevContentLength,
                    newContentLength: nearDup.newContentLength,
                  })
                  const ndMatch = yield* readToolCall(value.toolCallId)
                  if (ndMatch) {
                    yield* session.updatePart({
                      ...ndMatch.part,
                      tool: value.toolName,
                      state: {
                        status: "error",
                        input: value.input,
                        error: "Near-duplicate write to same filePath skipped (shorter content)",
                        time: { start: Date.now(), end: Date.now() },
                      },
                    })
                    yield* settleToolCall(value.toolCallId)
                  }
                  return
                }
                log.warn("near-duplicate write detected (longer content, allowing)", {
                  toolCallId: value.toolCallId,
                  toolName: value.toolName,
                  filePath: (value.input as Record<string, unknown>).filePath,
                  prevToolCallId: nearDup.prevToolCallId,
                  prevContentLength: nearDup.prevContentLength,
                  newContentLength: nearDup.newContentLength,
                })
              }
              trackWriteFilePath(ctx.writeFilePaths, value.toolName, value.input, value.toolCallId)
              // Mark as executed BEFORE updateToolCall — prevents retry if updateToolCall fails
              hasExecutedTool = true
              yield* updateToolCall(value.toolCallId, (match) => ({
                ...match,
                tool: value.toolName,
                state: {
                  ...match.state,
                  status: "running",
                  input: value.input,
                  time: { start: Date.now() },
                },
                metadata: match.metadata?.providerExecuted
                  ? { ...value.providerMetadata, providerExecuted: true }
                  : value.providerMetadata,
              }))

              const parts = MessageV2.parts(ctx.assistantMessage.id)
              const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

              if (
                recentParts.length !== DOOM_LOOP_THRESHOLD ||
                !recentParts.every(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === value.toolName &&
                    part.state.status !== "pending" &&
                    JSON.stringify(part.state.input) === JSON.stringify(value.input),
                )
              ) {
                return
              }

              const agent = yield* agents.get(ctx.assistantMessage.agent)
              yield* permission.ask({
                permission: "doom_loop",
                patterns: [value.toolName],
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: value.toolName, input: value.input },
                always: [value.toolName],
                ruleset: agent.permission,
              })
              return
            }

            case "tool-result": {
              log.debug("tool-result", { toolCallId: value.toolCallId })
              hasExecutedTool = true
              yield* completeToolCall(value.toolCallId, value.output)
              return
            }

            case "tool-error": {
              log.debug("tool-error", { toolCallId: value.toolCallId })
              hasExecutedTool = true
              yield* failToolCall(value.toolCallId, value.error)
              return
            }

            case "error":
              throw value.error

            case "start-step":
              ctx.hasToolCalls = false
              ctx.acceptedToolKeys.clear()
              ctx.writeFilePaths.clear()
              if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                snapshot: ctx.snapshot,
                type: "step-start",
              })
              return

            case "finish-step": {
              const usage = Session.getUsage({
                model: ctx.model,
                usage: value.usage,
                metadata: value.providerMetadata,
              })
              // Detect gateways that return per-turn (non-cumulative) usage.
              // Two strategies:
              //
              // 1. Multi-step detection: track max reported inputTokens across
              //    steps.  If a subsequent step drops to < 20% of the max, the
              //    gateway is returning per-turn values.
              //
              // 2. Single-step fallback: if the conversation is clearly large
              //    (estimatedInput >= 20K) but reported input is extremely small
              //    (<= min(estimatedInput * 0.1, 2000)), apply the estimate.
              //    This catches single-step responses where maxReportedInput
              //    has no prior baseline to compare against.
              const reportedInput = usage.tokens.input + usage.tokens.cache.read
              ctx.maxReportedInput = Math.max(ctx.maxReportedInput, reportedInput)
              const estimatedInput = ctx.lastStreamInput ? estimateTokensFromInput(ctx.lastStreamInput) : 0
              const isPerTurnMultiStep =
                ctx.maxReportedInput > 1000 &&
                reportedInput < ctx.maxReportedInput * 0.2
              const isPerTurnSingleStep =
                estimatedInput >= 20_000 &&
                reportedInput <= Math.min(estimatedInput * 0.1, 2_000)
              // 3. Monotonic-decrease: if the reported input dropped significantly
              //    from the confirmed baseline of previous turns, the gateway is
              //    returning per-turn values.  The 0.8 multiplier tolerates minor
              //    fluctuations from cache accounting or prompt shaping.
              const prevConfirmed = input.confirmedInput ?? 0
              const isPerTurnMonotonic =
                prevConfirmed > 0 &&
                reportedInput < prevConfirmed * 0.8
              if ((isPerTurnMultiStep || isPerTurnSingleStep || isPerTurnMonotonic) && estimatedInput > reportedInput) {
                log.debug("usage-fallback", {
                  reportedInput,
                  maxReportedInput: ctx.maxReportedInput,
                  confirmedInput: prevConfirmed,
                  estimatedInput,
                  reportedTotal: usage.tokens.total,
                  trigger: isPerTurnMonotonic ? "monotonic" : isPerTurnMultiStep ? "multi-step" : "single-step",
                })
                // estimatedInput represents effective input (cached + uncached).
                // Zero out cache.read so downstream (confirmedInput update in
                // prompt.ts: input + cache.read) doesn't double-count the cache.
                usage.tokens.input = estimatedInput
                usage.tokens.cache.read = 0
                usage.tokens.total =
                  estimatedInput + usage.tokens.output + usage.tokens.cache.write
              }
              // Recover from hermes tool call drops: when the model omits
              // </tool_call>, the parser drops the call and reports it via
              // onError(reason: "unfinished").  Create synthetic error tool
              // parts so the model sees the failure and can retry.
              const dropped = yield* llm.consumeDroppedToolCalls(ctx.sessionID)
              if (dropped.length > 0) {
                for (const entry of dropped) {
                  const toolName = entry.toolName ?? "unknown"
                  log.info("hermes-drop-recovery", { toolName, rawLength: entry.raw.length })
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: ctx.assistantMessage.id,
                    sessionID: ctx.sessionID,
                    type: "tool",
                    tool: toolName,
                    callID: generateId(),
                    state: {
                      status: "error",
                      input: {},
                      error: `Tool call was incomplete (closing tag missing). Tool: ${toolName}. Please retry this tool call.`,
                      time: { start: Date.now(), end: Date.now() },
                    },
                    metadata: { dropRecovery: true },
                  } satisfies MessageV2.ToolPart)
                }
                ctx.hasToolCalls = true
              }
              // tool-parser middleware doesn't rewrite finishReason in streaming
              // mode, so the provider's original reason passes through.  Override
              // to "tool-calls" when tool calls were detected in this step.
              // ctx.hasToolCalls is reset at the start of each process() call.
              const hasToolCalls = ctx.hasToolCalls
              const finishReason =
                hasToolCalls && value.finishReason !== "length" && value.finishReason !== "tool-calls"
                  ? "tool-calls"
                  : !hasToolCalls && (value.finishReason as string) === "unknown"
                    ? "stop"
                    : value.finishReason
              if (Flag.OPENCODE_DEBUG_LLM) log.info("finish-step", {
                originalReason: value.finishReason,
                effectiveReason: finishReason,
                hasToolCalls,
              })
              ctx.assistantMessage.finish = finishReason
              ctx.assistantMessage.cost += usage.cost
              ctx.assistantMessage.tokens = usage.tokens
              yield* session.updatePart({
                id: PartID.ascending(),
                reason: finishReason,
                snapshot: yield* snapshot.track(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "step-finish",
                tokens: usage.tokens,
                cost: usage.cost,
              })
              yield* session.updateMessage(ctx.assistantMessage)
              if (ctx.snapshot) {
                const patch = yield* snapshot.patch(ctx.snapshot)
                if (patch.files.length) {
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: ctx.assistantMessage.id,
                    sessionID: ctx.sessionID,
                    type: "patch",
                    hash: patch.hash,
                    files: patch.files,
                  })
                }
                ctx.snapshot = undefined
              }
              yield* summary
                .summarize({
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.parentID,
                })
                .pipe(Effect.ignore, Effect.forkIn(scope))
              if (!ctx.assistantMessage.summary) {
                // Use max(reported, estimated) for overflow check only.
                // This catches cases where the provider reports accurate but
                // delayed usage while the estimate is already close to the limit.
                // The overflow tokens are ephemeral — usage.tokens is not modified.
                const reportedTotal = usage.tokens.total
                  || (usage.tokens.input + usage.tokens.output + usage.tokens.cache.read + usage.tokens.cache.write)
                const estimatedTotal = estimatedInput + usage.tokens.output
                const overflowTotal = Math.max(reportedTotal, estimatedTotal)
                const overflowTokens = { ...usage.tokens, total: overflowTotal }
                if (isOverflow({ cfg: yield* config.get(), tokens: overflowTokens, model: ctx.model })) {
                  ctx.needsCompaction = true
                }
              }
              return
            }

            case "text-start":
              ctx.currentText = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "text",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              ctx.tagFilter = createStreamingTagFilter()
              yield* session.updatePart(ctx.currentText)
              return

            case "text-delta":
              if (!ctx.currentText) return
              // Deduplicate overlapping chunks from LLM/gateway stream retransmission.
              // Detects when the start of a new delta matches the end of accumulated text
              // (15+ chars). This pattern occurs when the gateway resends part of the
              // previous chunk. Legitimate text rarely has 15+ char exact suffix-prefix
              // overlap with the accumulated buffer at a chunk boundary.
              let deduped = value.text
              if (ctx.currentText.text.length >= 15 && deduped.length >= 15) {
                const tail = ctx.currentText.text.slice(-200)
                let overlap = 0
                for (let len = Math.min(tail.length, deduped.length); len >= 15; len--) {
                  if (tail.endsWith(deduped.slice(0, len))) {
                    overlap = len
                    break
                  }
                }
                if (overlap > 0) {
                  log.warn("text-delta-dedup", {
                    overlap,
                    tail: tail.slice(-50),
                    deltaStart: deduped.slice(0, 50),
                  })
                  deduped = deduped.slice(overlap)
                  if (!deduped) return
                }
              }
              ctx.currentText.text += deduped
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              // Filter stripped tags from streaming delta to prevent UI flicker
              const filtered = ctx.tagFilter ? ctx.tagFilter.push(deduped) : deduped
              if (filtered !== deduped) {
                log.debug("text-delta-filtered", {
                  raw: deduped.slice(0, 200),
                  filtered: filtered.slice(0, 200),
                })
              }
              if (filtered) {
                if (STRIP_OPEN_RE.test(filtered) || STRIP_CLOSE_RE.test(filtered)) {
                  log.warn("text-delta-tag-leak", {
                    filtered: filtered.slice(0, 300),
                    accumulated: ctx.currentText.text.slice(-100),
                  })
                }
                yield* session.updatePartDelta({
                  sessionID: ctx.currentText.sessionID,
                  messageID: ctx.currentText.messageID,
                  partID: ctx.currentText.id,
                  field: "text",
                  delta: filtered,
                })
              }
              return

            case "text-end":
              if (!ctx.currentText) return
              ctx.tagFilter?.flush()
              ctx.tagFilter = undefined
              ctx.currentText.text = stripToolTags(ctx.currentText.text)
              ctx.currentText.text = stripSpam(ctx.currentText.text)
              ctx.currentText.text = (yield* plugin.trigger(
                "experimental.text.complete",
                {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: ctx.currentText.id,
                },
                { text: ctx.currentText.text },
              )).text
              {
                const end = Date.now()
                ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
              }
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePart(ctx.currentText)
              ctx.currentText = undefined
              return

            case "finish":
              return

            default:
              slog.info("unhandled", { event: value.type, value })
              return
          }
        })

        const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
          if (ctx.snapshot) {
            const patch = yield* snapshot.patch(ctx.snapshot)
            if (patch.files.length) {
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            ctx.snapshot = undefined
          }

          if (ctx.currentText) {
            const end = Date.now()
            ctx.tagFilter?.flush()
            ctx.tagFilter = undefined
            ctx.currentText.text = stripToolTags(ctx.currentText.text)
            ctx.currentText.text = stripSpam(ctx.currentText.text)
            ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
          }

          for (const part of Object.values(ctx.reasoningMap)) {
            const end = Date.now()
            yield* session.updatePart({
              ...part,
              time: { start: part.time.start ?? end, end },
            })
          }
          ctx.reasoningMap = {}

          yield* Effect.forEach(
            Object.values(ctx.toolcalls),
            (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
            { concurrency: "unbounded" },
          )

          for (const toolCallID of Object.keys(ctx.toolcalls)) {
            const match = yield* readToolCall(toolCallID)
            if (!match) continue
            const part = match.part
            const end = Date.now()
            const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
            yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: "Tool execution aborted",
                metadata: { ...metadata, interrupted: true },
                time: { start: "time" in part.state ? part.state.time.start : end, end },
              },
            })
          }
          ctx.toolcalls = {}
          ctx.assistantMessage.time.completed = Date.now()
          yield* session.updateMessage(ctx.assistantMessage)
        })

        const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
          slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
          const error = parse(e)
          if (MessageV2.ContextOverflowError.isInstance(error)) {
            ctx.needsCompaction = true
            yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            return
          }
          ctx.assistantMessage.error = error
          yield* bus.publish(Session.Event.Error, {
            sessionID: ctx.assistantMessage.sessionID,
            error: ctx.assistantMessage.error,
          })
          yield* status.set(ctx.sessionID, { type: "idle" })
        })

        const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
          slog.info("process")
          ctx.lastStreamInput = streamInput
          ctx.hasToolCalls = false
          ctx.acceptedToolKeys.clear()
          ctx.writeFilePaths.clear()
          ctx.needsCompaction = false
          hasExecutedTool = false
          ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

          // Baseline for attempt rollback — captured before stream starts
          const baselinePartIDs = new Set(
            MessageV2.parts(ctx.assistantMessage.id).map((p) => p.id),
          )
          const baselineFinish = ctx.assistantMessage.finish
          const baselineCost = ctx.assistantMessage.cost
          const baselineTokens = ctx.assistantMessage.tokens
          const baselineSnapshot = ctx.snapshot

          const rollbackAttempt = Effect.fn("SessionProcessor.rollbackAttempt")(function* () {
            if (hasExecutedTool) {
              // This should never happen: fromError() sets forceNonRetryable which
              // makes retryable() return undefined → Cause.done before set() is called.
              // If we get here anyway, fail hard to prevent unsafe retry.
              throw new Error("rollbackAttempt called after tool execution — aborting retry")
            }
            log.info("rollback-attempt", { partsBefore: baselinePartIDs.size })

            // Remove parts created during the failed attempt (DB + in-memory)
            const currentParts = MessageV2.parts(ctx.assistantMessage.id)
            for (const part of currentParts) {
              if (!baselinePartIDs.has(part.id)) {
                yield* session.removePart({
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: part.id,
                })
              }
            }

            // Restore worktree snapshot
            if (ctx.snapshot) {
              yield* snapshot.restore(ctx.snapshot)
            }
            ctx.snapshot = baselineSnapshot

            // Settle all pending Deferreds before clearing (prevents leak)
            for (const tc of Object.values(ctx.toolcalls)) {
              yield* Deferred.succeed(tc.done, undefined).pipe(Effect.ignore)
            }
            ctx.toolcalls = {}
            ctx.hasToolCalls = false
            ctx.acceptedToolKeys.clear()
            ctx.writeFilePaths.clear()
            hasExecutedTool = false
            ctx.currentText = undefined
            ctx.tagFilter = undefined
            ctx.reasoningMap = {}
            ctx.maxReportedInput = 0
            ctx.blocked = false
            ctx.needsCompaction = false
            ctx.assistantMessage.finish = baselineFinish
            ctx.assistantMessage.cost = baselineCost
            ctx.assistantMessage.tokens = baselineTokens
          })

          return yield* Effect.gen(function* () {
            yield* Effect.gen(function* () {
              ctx.currentText = undefined
              ctx.reasoningMap = {}
              const stream = llm.stream(streamInput)

              yield* stream.pipe(
                Stream.tap((event) => handleEvent(event)),
                Stream.takeUntil(() => ctx.needsCompaction),
                Stream.runDrain,
              )
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  aborted = true
                  if (!ctx.assistantMessage.error) {
                    yield* halt(new DOMException("Aborted", "AbortError"))
                  }
                }),
              ),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => Effect.fail(Cause.squash(cause)),
              ),
              Effect.retry(
                SessionRetry.policy({
                  parse,
                  set: (info) =>
                    Effect.gen(function* () {
                      // Rollback is best-effort: absorb failures/defects so status.set
                      // always runs, but re-throw any cause containing interrupts.
                      yield* rollbackAttempt().pipe(
                        Effect.catchCauseIf(
                          (cause) => !Cause.hasInterrupts(cause),
                          (cause) =>
                            Effect.sync(() => log.warn("rollback-attempt-failed", { error: Cause.squash(cause) })),
                        ),
                      )
                      yield* status.set(ctx.sessionID, {
                        type: "retry",
                        attempt: info.attempt,
                        message: info.message,
                        next: info.next,
                      })
                    }),
                }),
              ),
              Effect.catch(halt),
              Effect.ensuring(cleanup()),
            )

            if (ctx.needsCompaction) return "compact"
            if (ctx.blocked || ctx.assistantMessage.error) return "stop"
            return "continue"
          })
        })

        return {
          get message() {
            return ctx.assistantMessage
          },
          updateToolCall,
          completeToolCall,
          process,
        } satisfies Handle
      })

      return Service.of({ create })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Session.defaultLayer),
      Layer.provide(Snapshot.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(LLM.defaultLayer),
      Layer.provide(Permission.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(SessionSummary.defaultLayer),
      Layer.provide(SessionStatus.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(Config.defaultLayer),
    ),
  )
}
