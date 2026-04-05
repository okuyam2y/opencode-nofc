import { Cause, Effect, Layer, ServiceMap } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Log } from "@/util/log"
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

/**
 * Strip tool response/result tags that models echo from conversation history.
 */
function stripToolTags(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/<commentary>[\s\S]*?<\/commentary>/g, "")
    .replace(/<multi_tool_use\.parallel>[\s\S]*?<\/multi_tool_use\.parallel>/g, "")
    .replace(/<\/?tool_call>/g, "")
    .replace(/<\/?commentary>/g, "")
    .replace(/<\/?multi_tool_use\.parallel>/g, "")
    // Strip incomplete tags at end of stream (no closing tag)
    .replace(/<(?:tool_call|tool_result|tool_response|commentary|multi_tool_use\.parallel)>[\s\S]*$/g, "")
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

// Builds a regex that matches a trailing partial opening tag at end of string.
// For tag "tool_call", generates: <(?:t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?$
// This catches any prefix of "<tool_call>" that got cut off mid-stream.
function buildPartialTagRe(names: string[]): RegExp {
  const alts = names.map((name) => {
    let pattern = ""
    for (let i = name.length; i >= 1; i--) {
      pattern = escapeForRegex(name[i - 1]) + "(?:" + pattern + ")?"
    }
    return pattern
  })
  return new RegExp(`<(?:${alts.join("|")})$`)
}
const trailingPartialTagRe = buildPartialTagRe(STRIP_TAG_NAMES)

function createStreamingTagFilter() {
  let buf = ""
  let inside = false
  return {
    push(delta: string): string {
      buf += delta
      let out = ""
      while (true) {
        if (!inside) {
          const m = buf.match(STRIP_OPEN_RE)
          if (m && m.index !== undefined) {
            out += buf.slice(0, m.index)
            buf = buf.slice(m.index)
            inside = true
            continue
          }
          const partialIdx = partialOpenTagIndex(buf)
          if (partialIdx >= 0) {
            out += buf.slice(0, partialIdx)
            buf = buf.slice(partialIdx)
          } else {
            out += buf
            buf = ""
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
        return ""
      }
      // Also strip any partial opening tag left in the buffer (e.g. stream
      // cut off mid-tag like "<tool_respons" or "<multi_tool_use.par").
      const partialIdx = partialOpenTagIndex(buf)
      if (partialIdx >= 0) {
        const rest = buf.slice(0, partialIdx)
        buf = ""
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
      const full = `<${tag}>`
      if (candidate.length < full.length && full.startsWith(candidate)) {
        return offset + i
      }
    }
  }
  return -1
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

  export type Result = "compact" | "stop" | "continue"

  export type Event = LLM.Event

  export interface Handle {
    readonly message: MessageV2.Assistant
    readonly partFromToolCall: (toolCallID: string) => MessageV2.ToolPart | undefined
    readonly abort: () => Effect.Effect<void>
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

  interface ProcessorContext extends Input {
    toolcalls: Record<string, MessageV2.ToolPart>
    /** Set to true by tool-input-start / tool-call, reset by start-step.
     *  Unlike ctx.toolcalls (which entries are deleted on completion),
     *  this flag persists until the next step so finishReason override works. */
    hasToolCalls: boolean
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

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionProcessor") {}

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
              ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text.trimEnd()
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
              ctx.toolcalls[value.id] = yield* session.updatePart({
                id: ctx.toolcalls[value.id]?.id ?? PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "tool",
                tool: value.toolName,
                callID: value.id,
                state: { status: "pending", input: {}, raw: "" },
              } satisfies MessageV2.ToolPart)
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
              let match = ctx.toolcalls[value.toolCallId]
              if (!match) {
                log.warn("tool-call without prior tool-input-start", {
                  toolCallId: value.toolCallId,
                  toolName: value.toolName,
                })
                match = yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "tool",
                  tool: value.toolName,
                  callID: value.toolCallId,
                  state: { status: "pending", input: {}, raw: "" },
                } satisfies MessageV2.ToolPart)
                ctx.toolcalls[value.toolCallId] = match
              }
              ctx.toolcalls[value.toolCallId] = yield* session.updatePart({
                ...match,
                tool: value.toolName,
                state: { status: "running", input: value.input, time: { start: Date.now() } },
                metadata: value.providerMetadata,
              } satisfies MessageV2.ToolPart)
              // Tool is now executing and may mutate the worktree — prevent retry
              hasExecutedTool = true

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
              const match = ctx.toolcalls[value.toolCallId]
              if (!match || match.state.status !== "running") {
                log.warn("tool-result for unknown or non-running tool call", {
                  toolCallId: value.toolCallId,
                  hasMatch: !!match,
                })
                return
              }
              yield* session.updatePart({
                ...match,
                state: {
                  status: "completed",
                  input: value.input ?? match.state.input,
                  output: value.output.output,
                  metadata: value.output.metadata,
                  title: value.output.title,
                  time: { start: match.state.time.start, end: Date.now() },
                  attachments: value.output.attachments,
                },
              })
              hasExecutedTool = true
              delete ctx.toolcalls[value.toolCallId]
              return
            }

            case "tool-error": {
              log.debug("tool-error", { toolCallId: value.toolCallId })
              const match = ctx.toolcalls[value.toolCallId]
              if (!match || match.state.status !== "running") {
                log.warn("tool-error for unknown or non-running tool call", {
                  toolCallId: value.toolCallId,
                  hasMatch: !!match,
                })
                return
              }
              yield* session.updatePart({
                ...match,
                state: {
                  status: "error",
                  input: value.input ?? match.state.input,
                  error: value.error instanceof Error ? value.error.message : String(value.error),
                  time: { start: match.state.time.start, end: Date.now() },
                },
              })
              hasExecutedTool = true
              if (value.error instanceof Permission.RejectedError || value.error instanceof Question.RejectedError) {
                ctx.blocked = ctx.shouldBreak
              }
              delete ctx.toolcalls[value.toolCallId]
              return
            }

            case "error":
              throw value.error

            case "start-step":
              ctx.hasToolCalls = false
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
              log.debug("finish-step", {
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
              SessionSummary.summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
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
              ctx.currentText.text = (yield* plugin.trigger(
                "experimental.text.complete",
                {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: ctx.currentText.id,
                },
                { text: ctx.currentText.text },
              )).text
              ctx.currentText.time = { start: Date.now(), end: Date.now() }
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePart(ctx.currentText)
              ctx.currentText = undefined
              return

            case "finish":
              return

            default:
              log.info("unhandled", { ...value })
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

          const parts = MessageV2.parts(ctx.assistantMessage.id)
          for (const part of parts) {
            if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") continue
            yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: "Tool execution aborted",
                time: { start: Date.now(), end: Date.now() },
              },
            })
          }
          ctx.assistantMessage.time.completed = Date.now()
          yield* session.updateMessage(ctx.assistantMessage)
        })

        const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
          log.error("process", { error: e, stack: e instanceof Error ? e.stack : undefined })
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

        const abort = Effect.fn("SessionProcessor.abort")(() =>
          Effect.gen(function* () {
            if (!ctx.assistantMessage.error) {
              yield* halt(new DOMException("Aborted", "AbortError"))
            }
            if (!ctx.assistantMessage.time.completed) {
              yield* cleanup()
              return
            }
            yield* session.updateMessage(ctx.assistantMessage)
          }),
        )

        const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
          log.info("process")
          ctx.lastStreamInput = streamInput
          ctx.hasToolCalls = false
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

            // Full ctx state reset for next attempt
            ctx.toolcalls = {}
            ctx.hasToolCalls = false
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
              Effect.onInterrupt(() => Effect.sync(() => void (aborted = true))),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => Effect.fail(Cause.squash(cause)),
              ),
              Effect.retry(
                SessionRetry.policy({
                  parse,
                  set: (info) =>
                    rollbackAttempt().pipe(
                      Effect.andThen(
                        status.set(ctx.sessionID, {
                          type: "retry",
                          attempt: info.attempt,
                          message: info.message,
                          next: info.next,
                        }),
                      ),
                    ),
                }),
              ),
              Effect.catch(halt),
              Effect.ensuring(cleanup()),
            )

            if (aborted && !ctx.assistantMessage.error) {
              yield* abort()
            }
            if (ctx.needsCompaction) return "compact"
            if (ctx.blocked || ctx.assistantMessage.error || aborted) return "stop"
            return "continue"
          }).pipe(Effect.onInterrupt(() => abort().pipe(Effect.asVoid)))
        })

        return {
          get message() {
            return ctx.assistantMessage
          },
          partFromToolCall(toolCallID: string) {
            return ctx.toolcalls[toolCallID]
          },
          abort,
          process,
        } satisfies Handle
      })

      return Service.of({ create })
    }),
  )

  export const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Session.defaultLayer),
        Layer.provide(Snapshot.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(LLM.defaultLayer),
        Layer.provide(Permission.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(SessionStatus.layer.pipe(Layer.provide(Bus.layer))),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
      ),
    ),
  )
}
