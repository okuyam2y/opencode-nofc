import path from "path"
import { Effect, Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

/**
 * ripgrep treats a match-all `--glob` argument (e.g. `**\/*`, `**`, `*`,
 * `**\/**`, `***`) as a catch-all include override that effectively disables
 * the .gitignore-based subtree pruning — paths under target/, dist/,
 * node_modules/, etc. come back in the walk even when those directories are
 * gitignored.  More specific patterns like `**\/*.ts` or `src/**\/*.java`
 * do NOT trigger the override; the usual gitignore pruning still applies.
 *
 * The tool caller passing a match-all glob almost always means "list every
 * matched file" (i.e. every file visible after gitignore filtering), not
 * "force-include every ignored build artifact".  Dropping the --glob argument
 * for these match-all patterns makes the behavior match the likely intent
 * and preserves gitignore semantics.
 *
 * Observed in 2026-04-19 planetiler review (ses_25eaafacfffe*): a reviewer
 * agent ran `glob **\/*` at worktree root and got back 100 `.class` files
 * from `target/test-classes/`, which polluted context and triggered a
 * downstream hallucination.
 */
const MATCH_ALL_PATTERN = /^[*/\\]+$/
const isMatchAll = (pattern: string) => MATCH_ALL_PATTERN.test(pattern)

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const rg = yield* Ripgrep.Service
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          // Surface a clear error when the caller passes a path that doesn't
          // exist, instead of letting ripgrep fail later with a raw
          // `IO error for operation on .: No such file or directory`.
          if (!info && params.path !== undefined) {
            throw new Error(
              `glob path "${params.path}" (resolved to "${search}") does not exist. ` +
                `Create it first or omit the path parameter to search ${ins.directory}.`,
            )
          }
          yield* assertExternalDirectoryEffect(ctx, search, { kind: "directory" })

          const limit = 100
          let truncated = false
          // Match-all patterns → drop the --glob override so ripgrep still
          // respects .gitignore.  See MATCH_ALL_PATTERN at top of file.
          const rgGlob = isMatchAll(params.pattern) ? undefined : [params.pattern]
          const files = yield* rg.files({ cwd: search, glob: rgGlob, signal: ctx.abort }).pipe(
            Stream.mapEffect((file) =>
              Effect.gen(function* () {
                const full = path.resolve(search, file)
                const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
                const mtime =
                  info?.mtime.pipe(
                    Option.map((date) => date.getTime()),
                    Option.getOrElse(() => 0),
                  ) ?? 0
                return { path: full, mtime }
              }),
            ),
            Stream.take(limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )

          if (files.length > limit) {
            truncated = true
            files.length = limit
          }
          files.sort((a, b) => b.mtime - a.mtime)

          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...files.map((file) => file.path))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
