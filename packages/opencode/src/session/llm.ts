import { Provider } from "@/provider"
import { Log } from "@/util"
import { Context, Effect, Layer, Record } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import type { LanguageModelV3Middleware } from "@ai-sdk/provider"
import { hermesToolMiddleware, morphXmlToolMiddleware, createToolMiddleware, hermesProtocol } from "@ai-sdk-tool/parser"
import { mergeDeep, pipe } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { EffectBridge } from "@/effect"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"

// Custom hermes middleware with explicit examples for models that don't follow the standard format
const hermesStrictMiddleware = createToolMiddleware({
  protocol: hermesProtocol(),
  toolResponsePromptTemplate: (toolResult) =>
    `<tool_response>${JSON.stringify({ name: toolResult.toolName, content: toolResult.output })}</tool_response>`,
  toolSystemPromptTemplate(tools) {
    const toolsJson = JSON.stringify(tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })))
    return `You have access to tools. To call a tool, you MUST use EXACTLY this format:

<tool_call>
{"name": "TOOL_NAME", "arguments": {"param1": "value1", "param2": "value2"}}
</tool_call>

CRITICAL RULES:
- You MUST wrap the JSON in <tool_call> and </tool_call> tags
- The JSON object MUST have exactly two keys: "name" (string) and "arguments" (object)
- Do NOT add any extra characters, braces, or text between the JSON and </tool_call>
- Output ONLY valid JSON inside the tags — no trailing braces, no comments
- You can call multiple tools by using multiple <tool_call> blocks
- Act immediately. Do not ask for confirmation.
- Do NOT output <tool_response> or <tool_result> tags. Tool results are provided by the system automatically — never echo or repeat them.
- NEVER predict, fabricate, or guess tool results. After calling a tool, STOP and wait for the system to return the actual result in a <tool_response> tag before continuing.
- Do NOT repeat a tool call that has already been executed. If you see a <tool_response> for your tool call, use that result — do not call the same tool again.

CORRECT example:
<tool_call>
{"name": "bash", "arguments": {"command": "echo hello"}}
</tool_call>

WRONG — extra brace after JSON:
<tool_call>
{"name": "bash", "arguments": {"command": "echo hello"}}
}
</tool_call>

Available tools: <tools>${toolsJson}</tools>`
  },
})

// Escape hermes tag strings in user/system message content by inserting a
// zero-width space (U+200B) so the tool-parser's literal matching does not
// trigger on user-provided text.  Without this, user input containing
// "<tool_call>" causes the hermes pipeline to hang (middleware or gateway
// interprets the user text as a protocol tag).  See
// docs/designs/user-message-tag-escape.md.
const HERMES_TAG_REGEX = /<(\/?)(tool_call|tool_response)>/g

/** Exported for unit testing. */
export function _escapeHermesTagsInText(text: string): string {
  return text.replace(HERMES_TAG_REGEX, (_m, slash: string, name: string) => `<${slash}\u200b${name}>`)
}

/** Exported for unit testing. */
export function _escapeHermesTagsInMessage<M extends { role: string; content: any }>(message: M): M {
  if (message.role !== "user" && message.role !== "system") return message
  if (typeof message.content === "string") {
    return { ...message, content: _escapeHermesTagsInText(message.content) }
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((part: any) =>
        part && part.type === "text" && typeof part.text === "string"
          ? { ...part, text: _escapeHermesTagsInText(part.text) }
          : part,
      ),
    }
  }
  return message
}

  const log = Log.create({ service: "llm" })
  
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
  type Result = Awaited<ReturnType<typeof streamText>>

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    parentSessionID?: string
    model: Provider.Model
    agent: Agent.Info
    permission?: Permission.Ruleset
    system: string[]
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
    toolParserActive?: boolean
  }

  export type StreamRequest = StreamInput & {
    abort: AbortSignal
  }

  export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

  export type DroppedToolCall = { toolName?: string; raw: string }

  export interface Interface {
    readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
    readonly consumeDroppedToolCalls: (sessionID: string) => Effect.Effect<DroppedToolCall[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

  export const layer: Layer.Layer<Service, never, Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service> =
    Layer.effect(
      Service,
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const config = yield* Config.Service
        const provider = yield* Provider.Service
        const plugin = yield* Plugin.Service
        const perm = yield* Permission.Service

        // Per-session storage for tool calls dropped by the parser.
        // Keyed by sessionID to prevent cross-session interference.
        // Uses get-or-create (not overwrite) so concurrent runs on the
        // same session (e.g. title generation in step 1) don't wipe
        // drops accumulated by the main stream.
        const droppedToolCallsMap = new Map<string, DroppedToolCall[]>()

        const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
          if (!droppedToolCallsMap.has(input.sessionID)) {
            droppedToolCallsMap.set(input.sessionID, [])
          }
          const l = log
            .clone()
            .tag("providerID", input.model.providerID)
            .tag("modelID", input.model.id)
            .tag("sessionID", input.sessionID)
            .tag("small", (input.small ?? false).toString())
            .tag("agent", input.agent.name)
            .tag("mode", input.agent.mode)
          l.info("stream", {
            modelID: input.model.id,
            providerID: input.model.providerID,
          })

          const [language, cfg, item, info] = yield* Effect.all(
            [
              provider.getLanguage(input.model),
              config.get(),
              provider.getProvider(input.model.providerID),
              auth.get(input.model.providerID),
            ],
            { concurrency: "unbounded" },
          )

          // TODO: move this to a proper hook
          const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

          const toolParser = input.model.options?.toolParser ?? item.options?.toolParser
          // Only rewrite apply_patch references when tool parser is actually active for this request
          const root = SystemPrompt.provider(input.model, {
            toolParser: toolParser && input.toolChoice !== "none" ? toolParser : undefined,
          })
          const system: string[] = []
          system.push(
            [
              // Keep provider prompt grounding even when an agent adds its own prompt.
              ...root,
              ...(input.agent.prompt ? [input.agent.prompt] : []),
              // any custom prompt passed into this call
              ...input.system,
              // any custom prompt from last user message
              ...(input.user.system ? [input.user.system] : []),
            ]
              .filter((x) => x)
              .join("\n"),
          )

          const header = system[0]
          yield* plugin.trigger(
            "experimental.chat.system.transform",
            { sessionID: input.sessionID, model: input.model },
            { system },
          )
          // rejoin to maintain 2-part structure for caching if header unchanged
          if (system.length > 2 && system[0] === header) {
            const rest = system.slice(1)
            system.length = 0
            system.push(header, rest.join("\n"))
          }

          const variant =
            !input.small && input.model.variants && input.user.model.variant
              ? input.model.variants[input.user.model.variant]
              : {}
          const base = input.small
            ? ProviderTransform.smallOptions(input.model)
            : ProviderTransform.options({
                model: input.model,
                sessionID: input.sessionID,
                providerOptions: item.options,
              })
          const options: Record<string, any> = pipe(
            base,
            mergeDeep(input.model.options),
            mergeDeep(input.agent.options),
            mergeDeep(variant),
          )
          if (isOpenaiOauth) {
            options.instructions = system.join("\n")
          }

          const isWorkflow = language instanceof GitLabWorkflowLanguageModel
          const messages = isOpenaiOauth
            ? input.messages
            : isWorkflow
              ? input.messages
              : [
                  ...system.map(
                    (x): ModelMessage => ({
                      role: "system",
                      content: x,
                    }),
                  ),
                  ...input.messages,
                ]

          const params = yield* plugin.trigger(
            "chat.params",
            {
              sessionID: input.sessionID,
              agent: input.agent.name,
              model: input.model,
              provider: item,
              message: input.user,
            },
            {
              temperature: input.model.capabilities.temperature
                ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
                : undefined,
              topP: input.agent.topP ?? ProviderTransform.topP(input.model),
              topK: ProviderTransform.topK(input.model),
              maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
              options,
            },
          )

          const { headers } = yield* plugin.trigger(
            "chat.headers",
            {
              sessionID: input.sessionID,
              agent: input.agent.name,
              model: input.model,
              provider: item,
              message: input.user,
            },
            {
              headers: {},
            },
          )

          const tools = resolveTools(input)

          // LiteLLM and some Anthropic proxies require the tools parameter to be present
          // when message history contains tool calls, even if no tools are being used.
          // Add a dummy tool that is never called to satisfy this validation.
          // This is enabled for:
          // 1. Providers with "litellm" in their ID or API ID (auto-detected)
          // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
          const isLiteLLMProxy =
            item.options?.["litellmProxy"] === true ||
            input.model.providerID.toLowerCase().includes("litellm") ||
            input.model.api.id.toLowerCase().includes("litellm")

          // toolParser is the raw config value; toolParserActive reflects whether
          // the middleware is actually engaged for this request.  Disabled when:
          //   - toolChoice is "none" (no tool calls expected)
          //   - tools is empty (e.g. compaction — parser has nothing to convert,
          //     and stripping _noop would break LiteLLM/copilot gateway compat)
          const toolParserMode = toolParser
          const toolParserActive = !!(toolParserMode && input.toolChoice !== "none" && Object.keys(tools).length > 0)

          // LiteLLM/Bedrock rejects requests where the message history contains tool
          // calls but no tools param is present. When there are no active tools (e.g.
          // during compaction), inject a stub tool to satisfy the validation requirement.
          // The stub description explicitly tells the model not to call it.
          if (
            (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
            !toolParserActive &&
            Object.keys(tools).length === 0 &&
            hasToolCalls(input.messages)
          ) {
            tools["_noop"] = tool({
              description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
              inputSchema: jsonSchema({
                type: "object",
                properties: {
                  reason: { type: "string", description: "Unused" },
                },
              }),
              execute: async () => ({ output: "", title: "", metadata: {} }),
            })
          }

          // Wire up toolExecutor for DWS workflow models so that tool calls
          // from the workflow service are executed via opencode's tool system
          // and results sent back over the WebSocket.
          if (language instanceof GitLabWorkflowLanguageModel) {
            const workflowModel = language as GitLabWorkflowLanguageModel & {
              sessionID?: string
              sessionPreapprovedTools?: string[]
              approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
            }
            workflowModel.sessionID = input.sessionID
            workflowModel.systemPrompt = system.join("\n")
            workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
              const t = tools[toolName]
              if (!t || !t.execute) {
                return { result: "", error: `Unknown tool: ${toolName}` }
              }
              try {
                const result = await t.execute!(JSON.parse(argsJson), {
                  toolCallId: _requestID,
                  messages: input.messages,
                  abortSignal: input.abort,
                })
                const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
                return {
                  result: output,
                  metadata: typeof result === "object" ? result?.metadata : undefined,
                  title: typeof result === "object" ? result?.title : undefined,
                }
              } catch (e: any) {
                return { result: "", error: e.message ?? String(e) }
              }
            }

            const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
            workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
              const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
              return !match || match.action !== "ask"
            })

            const approvedToolsForSession = new Set<string>()
            const bridge = yield* EffectBridge.make()
            workflowModel.approvalHandler = Instance.bind(async (approvalTools) => {
              const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
              // Auto-approve tools that were already approved in this session
              // (prevents infinite approval loops for server-side MCP tools)
              if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
                return { approved: true }
              }

              const id = PermissionID.ascending()
              let reply: Permission.Reply | undefined
              let unsub: (() => void) | undefined
              try {
                unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
                  if (evt.properties.requestID === id) reply = evt.properties.reply
                })
                const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
                  try {
                    const parsed = JSON.parse(t.args) as Record<string, unknown>
                    const title = (parsed?.title ?? parsed?.name ?? "") as string
                    return title ? `${t.name}: ${title}` : t.name
                  } catch {
                    return t.name
                  }
                })
                const uniquePatterns = [...new Set(toolPatterns)] as string[]
                await bridge.promise(
                  perm.ask({
                    id,
                    sessionID: SessionID.make(input.sessionID),
                    permission: "workflow_tool_approval",
                    patterns: uniquePatterns,
                    metadata: { tools: approvalTools },
                    always: uniquePatterns,
                    ruleset: [],
                  }),
                )
                for (const name of uniqueNames) approvedToolsForSession.add(name)
                workflowModel.sessionPreapprovedTools = [
                  ...(workflowModel.sessionPreapprovedTools ?? []),
                  ...uniqueNames,
                ]
                return { approved: true }
              } catch {
                return { approved: false }
              } finally {
                unsub?.()
              }
            })
          }

          const tracer = cfg.experimental?.openTelemetry
            ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
            : undefined

          // Debug: log LLM stream parameters for diagnosing tool-call instability
          if (Flag.OPENCODE_DEBUG_LLM) {
            const systemFull = system.join("\n")
            const hashBuf = yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(systemFull)),
            )
            log.info("stream-debug", {
              buildTag: "20260408-dev-2",
              agentName: input.agent.name ?? "unknown",
              hasAgentPrompt: !!input.agent.prompt,
              toolParserMode: toolParserMode ?? "none",
              systemPromptChars: systemFull.length,
              systemPromptHash: Array.from(new Uint8Array(hashBuf))
                .slice(0, 8)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(""),
              systemPromptPreview: systemFull.slice(0, 100),
              toolCount: Object.keys(tools).length,
              messageCount: messages.length,
              modelID: input.model.api.id,
            })
          }

          return streamText({
            onError(error) {
              const err = (error as any)?.error ?? error
              l.error("stream error", {
                error: typeof err === "object" && err !== null && "message" in err ? (err as any).message : err,
                raw: typeof err === "object" ? (() => { try { return JSON.stringify(err, null, 0) } catch { return "[unserializable]" } })() : undefined,
              })
            },
            async experimental_repairToolCall(failed) {
              const name = failed.toolCall?.toolName
              if (!name) {
                l.warn("repairToolCall: missing toolName", {
                  error: failed.error?.message,
                })
                return {
                  ...failed.toolCall,
                  toolCallId: failed.toolCall?.toolCallId ?? "unknown",
                  input: JSON.stringify({ tool: "unknown", error: failed.error?.message ?? "unknown" }),
                  toolName: "invalid",
                }
              }
              const lower = name.toLowerCase()
              if (lower !== name && tools[lower]) {
                l.info("repairing tool call", { tool: name, repaired: lower })
                return { ...failed.toolCall, toolName: lower }
              }
              return {
                ...failed.toolCall,
                input: JSON.stringify({ tool: name, error: failed.error?.message }),
                toolName: "invalid",
              }
            },
            temperature: params.temperature,
            topP: params.topP,
            topK: params.topK,
            providerOptions: (() => {
              const base = ProviderTransform.providerOptions(input.model, params.options)
              if (!toolParserMode) return base
              const existing = (base as any)?.toolCallMiddleware ?? {}
              const existingOnError = typeof existing.onError === "function" ? existing.onError : undefined
              return {
                ...base,
                toolCallMiddleware: {
                  ...existing,
                  onError: (message: string, context?: Record<string, unknown>) => {
                    existingOnError?.(message, context)
                    // Detect dropped tool calls — structured reason (patched parser)
                    // or message-based fallback (unpatched parser).
                    const isUnfinished = (context as any)?.reason === "unfinished"
                      || message.includes("dropping malformed tool call")
                    if (isUnfinished) {
                      const raw = String((context as any)?.toolCall ?? "")
                      const nameFromCtx = (context as any)?.toolName as string | undefined
                      const nameFromRaw = nameFromCtx ?? raw.match(/"name"\s*:\s*"([^"]+)"/)?.[1]
                      const arr = droppedToolCallsMap.get(input.sessionID)
                      if (arr) arr.push({ toolName: nameFromRaw, raw })
                    }
                    let ctx: string | undefined
                    try { ctx = context ? JSON.stringify(context).slice(0, 200) : undefined } catch { ctx = "[unserializable]" }
                    l.warn("tool-parser", { message, ...(ctx && { context: ctx }) })
                  },
                } as any,
              }
            })(),
            activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
            tools,
            toolChoice: input.toolChoice,
            maxOutputTokens: params.maxOutputTokens,
            abortSignal: input.abort,
            headers: {
              ...(input.model.providerID.startsWith("opencode")
                ? {
                    "x-opencode-project": Instance.project.id,
                    "x-opencode-session": input.sessionID,
                    "x-opencode-request": input.user.id,
                    "x-opencode-client": Flag.OPENCODE_CLIENT,
                  }
                : {
                    "x-session-affinity": input.sessionID,
                    ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                    "User-Agent": `opencode/${InstallationVersion}`,
                  }),
              ...input.model.headers,
              ...headers,
            },
            maxRetries: input.retries ?? 4,
            messages,
            model: wrapLanguageModel({
              model: language,
              middleware: (() => {
                const mw: LanguageModelV3Middleware[] = []
                // Escape hermes tag strings in user/system messages BEFORE
                // the tool-parser middleware runs.  The parser converts
                // tool-role messages to user text containing <tool_response>
                // and injects the hermes-strict system prompt with literal
                // <tool_call> examples; escaping after it would break those.
                // xml (morphXml) uses dynamic tag names and is out of scope.
                if (toolParserActive && (toolParserMode === "hermes" || toolParserMode === "hermes-strict")) {
                  mw.push({
                    specificationVersion: "v3" as const,
                    async transformParams(args) {
                      if (args.type === "stream" && Array.isArray(args.params.prompt)) {
                        args.params.prompt = args.params.prompt.map(_escapeHermesTagsInMessage)
                      }
                      return args.params
                    },
                  })
                }
                // Tool parser middleware for gateways that don't support function calling.
                // Disabled during compaction (tools empty) — parser has nothing to
                // convert, and would interfere with summary-only responses.
                if (toolParserActive) {
                  if (toolParserMode === "hermes") {
                    mw.push(hermesToolMiddleware)
                  } else if (toolParserMode === "hermes-strict") {
                    mw.push(hermesStrictMiddleware)
                  } else if (toolParserMode === "xml") {
                    mw.push(morphXmlToolMiddleware)
                  }
                }
                mw.push({
                  specificationVersion: "v3" as const,
                  async transformParams(args) {
                    if (args.type === "stream") {
                      // @ts-expect-error
                      args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                    }
                    // Strip max_tokens for gateways that reject it (require max_completion_tokens)
                    if (input.model.options?.noMaxTokens ?? item.options?.["noMaxTokens"]) {
                      args.params.maxOutputTokens = undefined
                    }
                    // Debug: log final prompt size after all middleware transforms
                    if (Flag.OPENCODE_DEBUG_LLM) {
                      const promptChars = args.params.prompt?.reduce((acc: number, msg: any) => {
                        if (typeof msg.content === "string") return acc + msg.content.length
                        if (Array.isArray(msg.content)) return acc + msg.content.reduce((a: number, c: any) => a + (c.text?.length ?? 0), 0)
                        return acc
                      }, 0) ?? 0
                      log.info("transform-debug", {
                        promptChars,
                        promptMsgCount: args.params.prompt?.length ?? 0,
                        activeToolCount: args.params.tools?.length ?? 0,
                        hasToolParser: !!toolParserMode,
                      })
                    }
                    return args.params
                  },
                })
                // Stream error escalation — must be last (closest to provider).
                // Converts retryable 5xx error stream parts into thrown StreamRetryableError
                // so they reach processor's Effect.retry via the async-iterable error path.
                mw.push({
                  specificationVersion: "v3" as const,
                  async wrapStream({ doStream }) {
                    const result = await doStream()
                    return {
                      ...result,
                      stream: result.stream.pipeThrough(
                        new TransformStream({
                          transform(part, controller) {
                            if (part.type === "error") {
                              const statusCode = MessageV2.extractStatusCode(part.error)
                              if (statusCode && statusCode >= 500 && !MessageV2.isContentFilter(part.error)) {
                                const msg =
                                  typeof part.error === "object" && part.error !== null && "message" in part.error
                                    ? String((part.error as any).message)
                                    : String(part.error)
                                l.info("stream-5xx-escalation", { statusCode, message: msg })
                                controller.error(new MessageV2.StreamRetryableError(statusCode, msg, part.error))
                                return
                              }
                            }
                            controller.enqueue(part)
                          },
                        }),
                      ),
                    }
                  },
                })
                return mw
              })(),
            }),
            experimental_telemetry: {
              isEnabled: cfg.experimental?.openTelemetry,
              functionId: "session.llm",
              tracer,
              metadata: {
                userId: cfg.username ?? "unknown",
                sessionId: input.sessionID,
              },
            },
          })
        })

        const stream: Interface["stream"] = (input) =>
          Stream.scoped(
            Stream.unwrap(
              Effect.gen(function* () {
                const ctrl = yield* Effect.acquireRelease(
                  Effect.sync(() => new AbortController()),
                  (ctrl) => Effect.sync(() => ctrl.abort()),
                )

                const result = yield* run({ ...input, abort: ctrl.signal })

                return Stream.fromAsyncIterable(result.fullStream, (e) =>
                  e instanceof Error ? e : new Error(String(e)),
                )
              }),
            ),
          )

        const consumeDroppedToolCalls = (sessionID: string) =>
          Effect.sync(() => {
            const result = [...(droppedToolCallsMap.get(sessionID) ?? [])]
            droppedToolCallsMap.delete(sessionID)
            return result
          })

        return Service.of({ stream, consumeDroppedToolCalls })
      }),
    )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Auth.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Permission.defaultLayer),
    ),
  )

  function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = Permission.disabled(
      Object.keys(input.tools),
      Permission.merge(input.agent.permission, input.permission ?? []),
    )
    return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

export * as LLM from "./llm"
