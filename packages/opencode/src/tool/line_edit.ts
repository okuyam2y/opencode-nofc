import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./line_edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { Format } from "../format"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectory } from "./external-directory"
import { containsSpam } from "@/util/spam-filter"
import { trimDiff } from "./edit"

const MAX_DIAGNOSTICS_PER_FILE = 20

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

export const LineEditTool = Tool.define("line_edit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to modify"),
    startLine: z.number().int().describe("The starting line number (1-based, inclusive)"),
    endLine: z.number().int().describe("The ending line number (1-based, inclusive)"),
    oldText: z.string().describe("The exact current content at the specified line range (for verification)"),
    newText: z.string().describe("The new content to replace the specified line range with"),
  }),
  async execute(params, ctx) {
    if (!params.filePath) {
      throw new Error("filePath is required")
    }

    if (containsSpam(params.newText)) {
      throw new Error("Edit blocked: training data contamination detected in arguments")
    }

    if (normalizeLineEndings(params.oldText) === normalizeLineEndings(params.newText)) {
      throw new Error("No changes to apply: oldText and newText are identical.")
    }

    if (params.startLine < 1) {
      throw new Error(`startLine must be >= 1, got ${params.startLine}`)
    }

    if (params.endLine < params.startLine) {
      throw new Error(`endLine (${params.endLine}) must be >= startLine (${params.startLine})`)
    }

    const filePath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filePath)

    let diff = ""
    let contentOld = ""
    let contentNew = ""
    await FileTime.withLock(filePath, async () => {
      const stats = Filesystem.stat(filePath)
      if (!stats) throw new Error(`File ${filePath} not found`)
      if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
      await FileTime.assert(ctx.sessionID, filePath)

      contentOld = await Filesystem.readText(filePath)
      const normalizedOld = normalizeLineEndings(contentOld)
      const lines = normalizedOld.split("\n")

      // Drop trailing empty element from trailing newline so line count
      // matches what the Read tool displays (cat -n style).
      const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === ""
      if (hadTrailingNewline) {
        lines.pop()
      }

      if (params.endLine > lines.length) {
        throw new Error(`endLine (${params.endLine}) exceeds file length (${lines.length} lines)`)
      }

      const actual = lines.slice(params.startLine - 1, params.endLine).join("\n")
      const expected = normalizeLineEndings(params.oldText)

      if (actual !== expected) {
        throw new Error(
          `Content mismatch at lines ${params.startLine}-${params.endLine}. Expected:\n${params.oldText}\n\nActual:\n${actual}\n\nThe file may have changed. Use the Read tool to get the current content.`,
        )
      }

      const newLines = params.newText === "" ? [] : normalizeLineEndings(params.newText).split("\n")
      lines.splice(params.startLine - 1, params.endLine - params.startLine + 1, ...newLines)
      // Restore trailing newline if the original file had one, but not for empty result
      contentNew = lines.length > 0 ? lines.join("\n") + (hadTrailingNewline ? "\n" : "") : ""

      // Restore original line ending style if the file used CRLF
      if (contentOld.includes("\r\n")) {
        contentNew = contentNew.replaceAll("\n", "\r\n")
      }

      diff = trimDiff(createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)))
      await ctx.ask({
        permission: "edit",
        patterns: [path.relative(Instance.worktree, filePath)],
        always: ["*"],
        metadata: {
          filepath: filePath,
          diff,
        },
      })

      await Filesystem.write(filePath, contentNew)
      await Format.file(filePath)
      Bus.publish(File.Event.Edited, { file: filePath })
      await Bus.publish(FileWatcher.Event.Updated, {
        file: filePath,
        event: "change",
      })
      contentNew = await Filesystem.readText(filePath)
      diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
      )
      await FileTime.read(ctx.sessionID, filePath)
    })

    const filediff: Snapshot.FileDiff = {
      file: filePath,
      patch: diff,
      additions: 0,
      deletions: 0,
    }
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) filediff.additions += change.count || 0
      if (change.removed) filediff.deletions += change.count || 0
    }

    ctx.metadata({
      metadata: {
        diff,
        filediff,
        diagnostics: {},
      },
    })

    let output = "Edit applied successfully."
    await LSP.touchFile(filePath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilePath = Filesystem.normalizePath(filePath)
    const issues = diagnostics[normalizedFilePath] ?? []
    const errors = issues.filter((item) => item.severity === 1)
    if (errors.length > 0) {
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
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
  },
})
