import z from "zod"
import * as path from "path"
import * as fs from "fs/promises"
import { Tool } from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectory } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import { Filesystem } from "../util/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { Format } from "../format"

const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

/**
 * Shared helper: apply parsed hunks with full pipeline (permissions, file I/O,
 * Format, Bus events, LSP notifications, diagnostics).
 * Used by both ApplyPatchTool and bash tool's apply_patch intercept.
 */
export async function applyPatchWithFullPipeline(
  hunks: Patch.Hunk[],
  cwd: string,
  ctx: Tool.Context,
): Promise<{
  output: string
  metadata: {
    diff: string
    files: Array<{
      filePath: string
      relativePath: string
      type: string
      patch: string
      additions: number
      deletions: number
      movePath?: string
    }>
    diagnostics: Awaited<ReturnType<typeof LSP.diagnostics>>
  }
}> {
  const fileChanges: Array<{
    filePath: string
    oldContent: string
    newContent: string
    type: "add" | "update" | "delete" | "move"
    movePath?: string
    diff: string
    additions: number
    deletions: number
  }> = []

  let totalDiff = ""

  for (const hunk of hunks) {
    if (ctx.abort.aborted) throw new Error("apply_patch aborted")
    const filePath = path.resolve(cwd, hunk.path)
    await assertExternalDirectory(ctx, filePath)

    switch (hunk.type) {
      case "add": {
        const oldContent = ""
        const newContent =
          hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

        let additions = 0
        let deletions = 0
        for (const change of diffLines(oldContent, newContent)) {
          if (change.added) additions += change.count || 0
          if (change.removed) deletions += change.count || 0
        }

        fileChanges.push({
          filePath,
          oldContent,
          newContent,
          type: "add",
          diff,
          additions,
          deletions,
        })

        totalDiff += diff + "\n"
        break
      }

      case "update": {
        const stats = await fs.stat(filePath).catch(() => null)
        if (!stats || stats.isDirectory()) {
          throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`)
        }

        const oldContent = await fs.readFile(filePath, "utf-8")
        let newContent = oldContent

        try {
          const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks)
          newContent = fileUpdate.content
        } catch (error) {
          throw new Error(`apply_patch verification failed: ${error}`)
        }

        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

        let additions = 0
        let deletions = 0
        for (const change of diffLines(oldContent, newContent)) {
          if (change.added) additions += change.count || 0
          if (change.removed) deletions += change.count || 0
        }

        const movePath = hunk.move_path ? path.resolve(cwd, hunk.move_path) : undefined
        await assertExternalDirectory(ctx, movePath)

        fileChanges.push({
          filePath,
          oldContent,
          newContent,
          type: hunk.move_path ? "move" : "update",
          movePath,
          diff,
          additions,
          deletions,
        })

        totalDiff += diff + "\n"
        break
      }

      case "delete": {
        const contentToDelete = await fs.readFile(filePath, "utf-8").catch((error) => {
          throw new Error(`apply_patch verification failed: ${error}`)
        })
        const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

        const deletions = contentToDelete.split("\n").length

        fileChanges.push({
          filePath,
          oldContent: contentToDelete,
          newContent: "",
          type: "delete",
          diff: deleteDiff,
          additions: 0,
          deletions,
        })

        totalDiff += deleteDiff + "\n"
        break
      }
    }
  }

  const files = fileChanges.map((change) => ({
    filePath: change.filePath,
    relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
    type: change.type,
    patch: change.diff,
    additions: change.additions,
    deletions: change.deletions,
    movePath: change.movePath,
  }))

  const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"))
  await ctx.ask({
    permission: "edit",
    patterns: relativePaths,
    always: ["*"],
    metadata: {
      filepath: relativePaths.join(", "),
      diff: totalDiff,
      files,
    },
  })

  const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

  for (const change of fileChanges) {
    if (ctx.abort.aborted) throw new Error("apply_patch aborted")
    const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
    switch (change.type) {
      case "add":
        await fs.mkdir(path.dirname(change.filePath), { recursive: true })
        await fs.writeFile(change.filePath, change.newContent, "utf-8")
        updates.push({ file: change.filePath, event: "add" })
        break

      case "update":
        await fs.writeFile(change.filePath, change.newContent, "utf-8")
        updates.push({ file: change.filePath, event: "change" })
        break

      case "move":
        if (change.movePath) {
          await fs.mkdir(path.dirname(change.movePath), { recursive: true })
          await fs.writeFile(change.movePath, change.newContent, "utf-8")
          await fs.unlink(change.filePath)
          updates.push({ file: change.filePath, event: "unlink" })
          updates.push({ file: change.movePath, event: "add" })
        }
        break

      case "delete":
        await fs.unlink(change.filePath)
        updates.push({ file: change.filePath, event: "unlink" })
        break
    }

    if (edited) {
      await Format.file(edited)
      Bus.publish(File.Event.Edited, { file: edited })
    }
  }

  for (const update of updates) {
    await Bus.publish(FileWatcher.Event.Updated, update)
  }

  for (const change of fileChanges) {
    if (ctx.abort.aborted) break
    if (change.type === "delete") continue
    const target = change.movePath ?? change.filePath
    await LSP.touchFile(target, true)
  }
  const diagnostics = ctx.abort.aborted ? {} : await LSP.diagnostics()

  const summaryLines = fileChanges.map((change) => {
    if (change.type === "add") {
      return `A ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
    }
    if (change.type === "delete") {
      return `D ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
    }
    const target = change.movePath ?? change.filePath
    return `M ${path.relative(Instance.worktree, target).replaceAll("\\", "/")}`
  })
  let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

  const MAX_DIAGNOSTICS_PER_FILE = 20
  for (const change of fileChanges) {
    if (change.type === "delete") continue
    const target = change.movePath ?? change.filePath
    const normalized = Filesystem.normalizePath(target)
    const issues = diagnostics[normalized] ?? []
    const errors = issues.filter((item) => item.severity === 1)
    if (errors.length > 0) {
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      output += `\n\nLSP errors detected in ${path.relative(Instance.worktree, target).replaceAll("\\", "/")}, please fix:\n<diagnostics file="${target}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }
  }

  return {
    output,
    metadata: {
      diff: totalDiff,
      files,
      diagnostics,
    },
  }
}

export const ApplyPatchTool = Tool.define("apply_patch", {
  description: DESCRIPTION,
  parameters: PatchParams,
  async execute(params, ctx) {
    if (!params.patchText) {
      throw new Error("patchText is required")
    }

    let hunks: Patch.Hunk[]
    try {
      const parseResult = Patch.parsePatch(params.patchText)
      hunks = parseResult.hunks
    } catch (error) {
      throw new Error(`apply_patch verification failed: ${error}`)
    }

    if (hunks.length === 0) {
      const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
      if (normalized === "*** Begin Patch\n*** End Patch") {
        throw new Error("patch rejected: empty patch")
      }
      throw new Error("apply_patch verification failed: no hunks found")
    }

    const result = await applyPatchWithFullPipeline(hunks, Instance.directory, ctx)

    return {
      title: result.output,
      ...result,
    }
  },
})
