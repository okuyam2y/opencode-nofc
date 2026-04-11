import z from "zod"
import { Effect, Scope } from "effect"
import { createReadStream } from "fs"
import { open, readdir } from "fs/promises"
import * as path from "path"
import { createInterface } from "readline"
import { Tool } from "./tool"
import { AppFileSystem } from "../filesystem"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { extractDocumentText, extractImageText, isDocumentFile } from "./document"
import { Config } from "../config/config"
import type { Provider } from "../provider/provider"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`

const parameters = z.object({
  filePath: z.string().describe("The absolute path to the file or directory to read"),
  offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
  limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
})

export const ReadTool = Tool.define(
  "read",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const time = yield* FileTime.Service
    const scope = yield* Scope.Scope

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      // Parent dir search found nothing — search the repo for files with the same basename.
      const root = Instance.directory
      const repoHits = yield* Effect.tryPromise(() =>
        findByBasename(root, base),
      ).pipe(Effect.catch(() => Effect.succeed([] as string[])))

      if (repoHits.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${repoHits.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}\n\nWorking directory: ${Instance.directory}`))
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string, sessionID: Tool.Context["sessionID"]) {
      yield* lsp.touchFile(filepath, false).pipe(Effect.ignore, Effect.forkIn(scope))
      yield* time.read(sessionID, filepath)
    })

    const run = Effect.fn("ReadTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      if (params.offset !== undefined && params.offset < 1) {
        return yield* Effect.fail(new Error("offset must be greater than or equal to 1"))
      }

      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(Instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = AppFileSystem.normalizePath(filepath)
      }
      const title = path.relative(Instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset ?? 1
        const start = offset - 1
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        return {
          title,
          output: [
            `<path>${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
          },
        }
      }

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)

      const mime = AppFileSystem.mimeType(filepath)
      const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
      if (isImage) {
        // Determine whether to attempt OCR instead of returning a raw attachment.
        // OCR is preferred when the image attachment won't reach the model
        // (e.g. gateway strips image_url, or model lacks image input capability).
        const model = ctx.extra?.model as Provider.Model | undefined
        const canReceiveImage = model?.capabilities?.input?.image
        const cfg = yield* Effect.promise(() => Config.get())
        const providerCfg = model ? cfg.provider?.[model.providerID] : undefined
        const hasToolParser = !!(
          (model?.id ? providerCfg?.models?.[model.id]?.options?.toolParser : undefined) ??
          model?.options?.toolParser ??
          providerCfg?.options?.toolParser
        )
        const shouldOCR = hasToolParser || canReceiveImage === false

        if (shouldOCR) {
          const result = yield* Effect.promise(() => extractImageText(filepath))
          if (result.status === "ok") {
            let output = `<path>${filepath}</path>\n<type>Image (OCR)</type>\n<content>\n${result.text}\n</content>`
            if (loaded.length > 0) {
              output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
            }
            return {
              title,
              output,
              metadata: {
                preview: result.text.slice(0, 500),
                truncated: false,
                loaded: loaded.map((item) => item.filepath),
              },
            }
          }
          // OCR did not produce text — fall back to attachment with an explicit reason
          const reason =
            result.status === "no_ocr"
              ? "no OCR tool available"
              : result.status === "empty"
                ? "OCR returned no text"
                : `OCR error: ${result.message}`
          const msg = `Image read (${reason}, image sent as attachment)`
          return {
            title,
            output: msg,
            metadata: {
              preview: msg,
              truncated: false,
              loaded: loaded.map((item) => item.filepath),
            },
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${Buffer.from(yield* fs.readFile(filepath)).toString("base64")}`,
              },
            ],
          }
        }

        // Native image input — return attachment as-is
        const msg = "Image read successfully"
        return {
          title,
          output: msg,
          metadata: {
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(yield* fs.readFile(filepath)).toString("base64")}`,
            },
          ],
        }
      }

      // Document extraction: PDF, .docx, .xlsx, .pptx
      const ext = path.extname(filepath).toLowerCase()
      if (isDocumentFile(ext)) {
        const result = yield* Effect.promise(() => extractDocumentText(filepath)).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (result && result.text.trim()) {
          const content = result.text
          const preview = content.slice(0, 500)
          let output = `<path>${filepath}</path>\n<type>${result.type}</type>\n<content>\n${content}\n</content>`
          if (loaded.length > 0) {
            output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
          }
          return {
            title,
            output,
            metadata: {
              preview,
              truncated: false,
              loaded: loaded.map((item) => item.filepath),
            },
          }
        }

        // For PDF with no extractable text, fall back to image attachment
        if (ext === ".pdf") {
          const msg = "PDF read successfully (image-based, no text could be extracted)"
          return {
            title,
            output: msg,
            metadata: {
              preview: msg,
              truncated: false,
              loaded: loaded.map((item) => item.filepath),
            },
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${Buffer.from(yield* fs.readFile(filepath)).toString("base64")}`,
              },
            ],
          }
        }
      }

      if (yield* Effect.promise(() => isBinaryFile(filepath, Number(stat.size)))) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      const file = yield* Effect.promise(() =>
        lines(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset ?? 1 }),
      )
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>" + "\n"].join("\n")
      output += file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n")

      const last = file.offset + file.raw.length - 1
      const next = last + 1
      const truncated = file.more || file.cut
      if (file.cut) {
        output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`
      } else if (file.more) {
        output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
      } else {
        output += `\n\n(End of file - total ${file.count} lines)`
      }
      output += "\n</content>"

      yield* warm(filepath, ctx.sessionID)

      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      return {
        title,
        output,
        metadata: {
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

async function lines(filepath: string, opts: { limit: number; offset: number }) {
  const stream = createReadStream(filepath, { encoding: "utf8" })
  const rl = createInterface({
    input: stream,
    // Note: we use the crlfDelay option to recognize all instances of CR LF
    // ('\r\n') in file as a single line break.
    crlfDelay: Infinity,
  })

  const start = opts.offset - 1
  const raw: string[] = []
  let bytes = 0
  let count = 0
  let cut = false
  let more = false
  try {
    for await (const text of rl) {
      count += 1
      if (count <= start) continue

      if (raw.length >= opts.limit) {
        more = true
        continue
      }

      const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        cut = true
        more = true
        break
      }

      raw.push(line)
      bytes += size
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return { raw, count, cut, more, offset: opts.offset }
}

async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".ppt":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  if (fileSize === 0) return false

  const fh = await open(filepath, "r")
  try {
    const sampleSize = Math.min(4096, fileSize)
    const bytes = Buffer.alloc(sampleSize)
    const result = await fh.read(bytes, 0, sampleSize, 0)
    if (result.bytesRead === 0) return false

    let nonPrintableCount = 0
    for (let i = 0; i < result.bytesRead; i++) {
      if (bytes[i] === 0) return true
      if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
        nonPrintableCount++
      }
    }
    // If >30% non-printable characters, consider it binary
    return nonPrintableCount / result.bytesRead > 0.3
  } finally {
    await fh.close()
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "dist", "build", ".next", "__pycache__", ".venv", "target"])

async function findByBasename(root: string, basename: string, maxResults = 5): Promise<string[]> {
  const results: string[] = []
  const lower = basename.toLowerCase()

  async function walk(dir: string, depth: number) {
    if (depth > 8) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), depth + 1)
      } else if (entry.name.toLowerCase() === lower) {
        results.push(path.join(dir, entry.name))
      }
    }
  }

  await walk(root, 0)
  return results.sort().slice(0, maxResults)
}
