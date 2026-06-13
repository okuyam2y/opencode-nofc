import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { Slug } from "@opencode-ai/core/util/slug"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

const COPY_NAME_AGENT: Agent.Info = {
  name: "project-copy-name",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: "",
}

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service

    const generateName = Effect.fn("ProjectCopyHttpApi.generateName")(function* (context: string | undefined) {
      const text = context?.trim()
      if (!text) return Slug.create()
      const fallback = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!fallback) return Slug.create()
      const model =
        (yield* provider.getSmallModel(fallback.providerID)) ??
        (yield* provider.getModel(fallback.providerID, fallback.modelID))
      const sessionID = SessionID.descending()
      const result = yield* llm
        .stream({
          agent: COPY_NAME_AGENT,
          user: {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: COPY_NAME_AGENT.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          system: [],
          small: true,
          tools: {},
          model,
          sessionID,
          retries: 2,
          messages: [{ role: "user", content: `Generate a short 2-3 word name that describes this task:\n${text}` }],
        })
        .pipe(
          // Fork's LLM.stream yields the AI SDK stream (LLM.Event = TextStreamPart),
          // not upstream's native @opencode-ai/llm LLMEvent, so narrow on the AI SDK
          // text-delta part instead of LLMEvent.is.textDelta.
          Stream.filter((part): part is Extract<LLM.Event, { type: "text-delta" }> => part.type === "text-delta"),
          Stream.map((part) => part.text),
          Stream.mkString,
        )
      const output = result.trim()
      return output ? slugify(output.split(/\s+/).slice(0, 3).join(" ")) : Slug.create()
    })

    return handlers.handle("generateName", (ctx) =>
      generateName(ctx.payload.context).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project copy name generation failed", {
            projectID: ctx.params.projectID,
            cause,
          }).pipe(Effect.as(Slug.create())),
        ),
        Effect.map((name) => ({ name })),
      ),
    )
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
