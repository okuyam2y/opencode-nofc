import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./line_edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { Format } from "../format"
import { Instance } from "../project/instance"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { containsSpam } from "@/util/spam-filter"
import { trimDiff } from "./edit"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"

const MAX_DIAGNOSTICS_PER_FILE = 20

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  startLine: Schema.Int.annotate({ description: "The starting line number (1-based, inclusive)" }),
  endLine: Schema.Int.annotate({ description: "The ending line number (1-based, inclusive)" }),
  oldText: Schema.optional(Schema.String).annotate({
    description:
      "The current content at the specified line range for verification. Omit if you just Read the file and are confident in the line numbers.",
  }),
  newText: Schema.String.annotate({ description: "The new content to replace the specified line range with" }),
})

export const LineEditTool = Tool.define(
  "line_edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          if (containsSpam(params.newText)) {
            throw new Error("Edit blocked: training data contamination detected in arguments")
          }

          if (
            params.oldText != null &&
            normalizeLineEndings(params.oldText) === normalizeLineEndings(params.newText)
          ) {
            throw new Error("No changes to apply: oldText and newText are identical.")
          }

          if (params.startLine < 1) {
            throw new Error(`startLine must be >= 1, got ${params.startLine}`)
          }

          if (params.endLine < params.startLine) {
            throw new Error(`endLine (${params.endLine}) must be >= startLine (${params.startLine})`)
          }

          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(Instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          yield* Effect.gen(function* () {
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats) throw new Error(`File ${filePath} not found`)
            if (stats.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)

            contentOld = yield* afs.readFileString(filePath).pipe(Effect.orDie)
            const normalizedOld = normalizeLineEndings(contentOld)
            const lines = normalizedOld.split("\n")

            const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === ""
            if (hadTrailingNewline) {
              lines.pop()
            }

            if (params.endLine > lines.length) {
              throw new Error(`endLine (${params.endLine}) exceeds file length (${lines.length} lines)`)
            }

            if (params.oldText != null) {
              const actual = lines.slice(params.startLine - 1, params.endLine).join("\n")
              const expected = normalizeLineEndings(params.oldText)

              if (actual !== expected) {
                throw new Error(
                  `Content mismatch at lines ${params.startLine}-${params.endLine}. Expected:\n${params.oldText}\n\nActual:\n${actual}\n\nThe file may have changed. Use the Read tool to get the current content.`,
                )
              }
            }

            const newLines = params.newText === "" ? [] : normalizeLineEndings(params.newText).split("\n")
            lines.splice(params.startLine - 1, params.endLine - params.startLine + 1, ...newLines)
            contentNew = lines.length > 0 ? lines.join("\n") + (hadTrailingNewline ? "\n" : "") : ""

            if (contentOld.includes("\r\n")) {
              contentNew = contentNew.replaceAll("\n", "\r\n")
            }

            diff = trimDiff(
              createTwoFilesPatch(
                filePath,
                filePath,
                normalizeLineEndings(contentOld),
                normalizeLineEndings(contentNew),
              ),
            )
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(Instance.worktree, filePath)],
              always: ["*"],
              metadata: {
                filepath: filePath,
                diff,
              },
            })

            yield* afs.writeWithDirs(filePath, contentNew).pipe(Effect.orDie)
            yield* format.file(filePath)
            yield* bus.publish(File.Event.Edited, { file: filePath })
            yield* bus.publish(FileWatcher.Event.Updated, {
              file: filePath,
              event: "change",
            })
            contentNew = yield* afs.readFileString(filePath).pipe(Effect.orDie)
            diff = trimDiff(
              createTwoFilesPatch(
                filePath,
                filePath,
                normalizeLineEndings(contentOld),
                normalizeLineEndings(contentNew),
              ),
            )
          }).pipe(Effect.orDie)

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = "Edit applied successfully."
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = AppFileSystem.normalizePath(filePath)
          const issues = diagnostics[normalizedFilePath] ?? []
          const errors = issues.filter((item) => item.severity === 1)
          if (errors.length > 0) {
            const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
            const suffix =
              errors.length > MAX_DIAGNOSTICS_PER_FILE
                ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more`
                : ""
            output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filePath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
          }

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            title: `${path.relative(Instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)
