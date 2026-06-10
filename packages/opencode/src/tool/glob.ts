import path from "path"
import { Effect, Option, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
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
 * The tool caller passing `**\/*` almost always means "list every matched
 * file" (i.e. every file visible after gitignore filtering), not "force-
 * include every ignored build artifact".  Dropping the --glob argument for
 * these match-all patterns makes the behavior match the likely intent and
 * preserves gitignore semantics.  The drop itself lives in the core
 * Ripgrep.glob implementation (see MATCH_ALL_PATTERN there) because the
 * new Ripgrep API does not expose a pattern-less file walk.
 *
 * Observed in 2026-04-19 planetiler review (ses_25eaafacfffe*): a reviewer
 * agent ran `glob **\/*` at worktree root and got back 100 `.class` files
 * from `target/test-classes/`, which polluted context and triggered a
 * downstream hallucination.
 */
export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
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
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const limit = 100
          // Fetch one past the limit so we can tell "exactly limit files" (complete)
          // from ">limit" (truncated). The new Ripgrep.glob API (#31566) discards
          // the internal truncated flag and returns at most `limit` entries, so
          // upstream's `entries.length === limit` check false-positives at exactly
          // `limit` matches. Over-fetching by one restores the fork's pre-#31566
          // precision (dev-tip used Stream.take(limit + 1) + `> limit`).
          const fetched = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit: limit + 1, signal: ctx.abort })
          const truncated = fetched.length > limit
          const entries = truncated ? fetched.slice(0, limit) : fetched

          // Sort by mtime (most recent first) so callers see actively edited
          // files before stale ones; pre-#27802 upstream behavior the fork keeps.
          const files = yield* Effect.forEach(
            entries,
            (entry) =>
              Effect.gen(function* () {
                const full = path.resolve(search, entry.path)
                const stat = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
                const mtime =
                  stat?.mtime.pipe(
                    Option.map((date) => date.getTime()),
                    Option.getOrElse(() => 0),
                  ) ?? 0
                return { path: full, mtime }
              }),
            { concurrency: 16 },
          )
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
