import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export namespace SystemPrompt {
  export function provider(model: Provider.Model, options?: { toolParser?: string }) {
    let prompts: string[]
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      prompts = [PROMPT_BEAST]
    else if (model.api.id.includes("gpt")) {
      if (model.api.id.includes("codex")) {
        prompts = [PROMPT_CODEX]
      } else {
        prompts = [PROMPT_GPT]
      }
    } else if (model.api.id.includes("gemini-")) prompts = [PROMPT_GEMINI]
    else if (model.api.id.includes("claude")) prompts = [PROMPT_ANTHROPIC]
    else if (model.api.id.toLowerCase().includes("trinity")) prompts = [PROMPT_TRINITY]
    else if (model.api.id.toLowerCase().includes("kimi")) prompts = [PROMPT_KIMI]
    else prompts = [PROMPT_DEFAULT]

    if (options?.toolParser) {
      const toolParserGuidance = [
        "",
        "## Tool-parser environment rules",
        "- When reusing opaque values (hashes, IDs, URLs, paths, PR numbers) from a previous tool result, prefer piping or combining commands so the value never leaves the shell (e.g. `git log --format=%H -3 | xargs git show --stat`). If you must pass a value to a separate tool call, use the shortest unambiguous form and keep the count minimal.",
        "",
        "## Editing best practices (tool-parser environment)",
        "- apply_patch is not available. Use the available file editing tools instead.",
        "- For new files, use write. For structured content (JSON, YAML, XML, config files), prefer write over edit — edit arguments containing deeply nested quotes are fragile.",
        "- For modifying existing files, use edit for small targeted changes.",
        "- Edit one location at a time. Do not batch multiple edits into a single tool call — if one fails, it corrupts the context for subsequent edits in the same file.",
        "- After each successful edit on a complex file, re-read the surrounding section before the next edit.",
        "- For large files (roughly 200+ lines) or files with multiple similar methods/blocks, prefer read + line_edit over broad edit replacements.",
        "- If an edit fails, re-read the file before retrying. Do not retry with the same old_string — the file content may have shifted.",
        "- If two consecutive edits fail on the same file, stop and switch to line_edit or re-read a larger window.",
        "- When using write for full-file replacement of an existing file, re-read the file first and verify the result immediately after.",
      ].join("\n")
      prompts = prompts.map((p) =>
        p
          .replace(
            /^.*Always use apply_patch for manual code edits\..*$/m,
            "- Use the available file editing tools for code edits. Do not use cat, echo, or heredocs to create or edit files.",
          )
          .replace(
            /^.*Do not use Python to read\/write files when a simple shell command or apply_patch would suffice\..*$/m,
            "- Do not use Python to read/write files when a dedicated tool or simple shell command would suffice.",
          )
          .replace(
            /^.*Try to use apply_patch for single file edits.*$/m,
            "- Use the available file editing tools for single file edits.",
          ) + toolParserGuidance,
      )
    }

    return prompts
  }

  export interface Interface {
    readonly environment: (model: Provider.Model) => string[]
    readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const skill = yield* Skill.Service

      return Service.of({
        environment(model) {
          const project = Instance.project
          return [
            [
              `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
              `Here is some useful information about the environment you are running in:`,
              `<env>`,
              `  Working directory: ${Instance.directory}`,
              `  Workspace root folder: ${Instance.worktree}`,
              `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
              `  Platform: ${process.platform}`,
              `  Today's date: ${new Date().toDateString()}`,
              `</env>`,
            ].join("\n"),
          ]
        },

        skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
          if (Permission.disabled(["skill"], agent.permission).has("skill")) return

          const list = yield* skill.available(agent)

          return [
            "Skills provide specialized instructions and workflows for specific tasks.",
            "Use the skill tool to load a skill when a task matches its description.",
            // the agents seem to ingest the information about skills a bit better if we present a more verbose
            // version of them here and a less verbose version in tool description, rather than vice versa.
            Skill.fmt(list, { verbose: true }),
          ].join("\n")
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))
}
