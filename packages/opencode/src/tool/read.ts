import { Effect, Option, Schema, Scope, Stream } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { readdir } from "fs/promises"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { isImageAttachment, sniffAttachmentMime } from "@/util/media"
import { extractDocumentText, extractImageText, isDocumentFile, type OcrResult } from "./document"
import { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096

/** Prefix used by every `miss()` error variant. processor.ts inspects this
 *  prefix to attach `metadata.notFound: true` for hermes-path context exclusion
 *  (docs/designs/hermes-notfound-context-exclusion.md). Keep them in sync. */
export const READ_NOT_FOUND_PREFIX = "File not found:"

class ReadStop extends Schema.TaggedErrorClass<ReadStop>()("ReadStop", {}) {}

// `offset` and `limit` were originally `z.coerce.number()` — the runtime
// coercion was useful when the tool was called from a shell but serves no
// purpose in the LLM tool-call path (the model emits typed JSON). The JSON
// Schema output is identical (`type: "number"`), so the LLM view is
// unchanged; purely CLI-facing uses must now send numbers rather than strings.
export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "The maximum number of lines to read (defaults to 2000)",
  }),
})

type Display =
  | {
      type: "directory"
      path: string
      entries: string[]
      offset: number
      totalEntries: number
      truncated: boolean
    }
  | {
      type: "file"
      path: string
      text: string
      lineStart: number
      lineEnd: number
      totalLines: number
      truncated: boolean
    }

type Metadata = {
  preview: string
  truncated: boolean
  loaded: string[]
  display?: Display
}

export const ReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Instruction.Service | LSP.Service | Scope.Scope
>(
  "read",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const scope = yield* Scope.Scope

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const ctx = yield* InstanceState.context
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const baseLower = base.toLowerCase()
      // Parent-dir similar names — restrict to files so directory siblings like
      // `geo/` or `util/` aren't offered when the caller asked for a file.
      // These are substring matches, not basename matches, so they go in a
      // separate bucket with a weaker label.
      const parentSimilar = yield* fs.readDirectoryEntries(dir).pipe(
        Effect.map((entries) =>
          entries
            .filter((e) => e.type === "file")
            .map((e) => e.name)
            .filter((name) => {
              const nameLower = name.toLowerCase()
              if (nameLower === baseLower) return false
              return nameLower.includes(baseLower) || baseLower.includes(nameLower)
            })
            .map((name) => path.join(dir, name)),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )
      const root = ctx.directory
      const repoExact = yield* Effect.tryPromise(() =>
        findByBasename(root, base),
      ).pipe(Effect.catch(() => Effect.succeed([] as string[])))

      if (repoExact.length > 0) {
        return yield* Effect.fail(
          new Error(
            `${READ_NOT_FOUND_PREFIX} ${filepath}

Do NOT retry the same path. A file with this basename exists at:
${repoExact.slice(0, 5).join("\n")}

Use one of the paths above, or run a glob (e.g., \`**/${base}\`) before the next Read.`,
          ),
        )
      }

      if (parentSimilar.length > 0) {
        return yield* Effect.fail(
          new Error(
            `${READ_NOT_FOUND_PREFIX} ${filepath}

No file named "${base}" exists. Files with similar names in the same directory (contents may be unrelated):
${parentSimilar.slice(0, 5).join("\n")}

Do NOT retry the same path. Confirm the correct filename with glob or grep before the next Read — do not assume a similar name is the intended file.`,
          ),
        )
      }

      return yield* Effect.fail(
        new Error(
          `${READ_NOT_FOUND_PREFIX} ${filepath}

No file named "${base}" exists anywhere in the repository — this file may not exist at all.

Working directory: ${ctx.directory}

Do NOT retry the same path. Run glob or grep to locate the correct file before the next Read. If no such file exists, do not reference it in subsequent output.`,
        ),
      )
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

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      // LSP warm-up is optional; do not let a background defect fail an otherwise successful read.
      yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const lines = Effect.fn("ReadTool.lines")(function* (filepath: string, opts: { limit: number; offset: number }) {
      const start = opts.offset - 1
      const raw: string[] = []
      const flags = { bytes: 0, count: 0, cut: false, more: false, done: false }

      // Note: prefer manual TextDecoder over Stream.decodeText — when the source stream
      // ends without flushing, decodeText drops the final unterminated line. We also
      // avoid Stream.runForEachWhile (it currently swallows the final unterminated
      // line of the upstream splitLines pipeline) and use a tagged error to stop the
      // upstream file stream as soon as the byte cap is reached.
      const decoder = new TextDecoder("utf-8")
      yield* fs.stream(filepath).pipe(
        Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
        Stream.splitLines,
        Stream.runForEach((text) =>
          Effect.gen(function* () {
            if (flags.done) return yield* new ReadStop()
            flags.count += 1
            if (flags.count <= start) return

            if (raw.length >= opts.limit) {
              flags.more = true
              return
            }

            const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
            const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
            if (flags.bytes + size <= MAX_BYTES) {
              raw.push(line)
              flags.bytes += size
              return
            }

            flags.cut = true
            flags.more = true
            flags.done = true
            return yield* new ReadStop()
          }),
        ),
        Effect.catchTag("ReadStop", () => Effect.void),
      )

      return { raw, count: flags.count, cut: flags.cut, more: flags.more, offset: opts.offset }
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
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
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
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
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = FSUtil.normalizePath(filepath)
      }
      const title = path.relative(instance.worktree, filepath)

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
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset || 1
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
            display: {
              type: "directory" as const,
              path: filepath,
              entries: sliced,
              offset,
              totalEntries: items.length,
              truncated,
            },
          },
        }
      }

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, FSUtil.mimeType(filepath))
      if (isImageAttachment(mime)) {
        // Determine whether to attempt OCR instead of returning a raw attachment.
        // OCR is preferred when the image attachment won't reach the model
        // (e.g. gateway strips image_url, or model lacks image input capability).
        const model = ctx.extra?.model as Provider.Model | undefined
        const canReceiveImage = model?.capabilities?.input?.image
        const cfg = yield* Config.Service.use((svc) => svc.get()).pipe(Effect.provide(Config.defaultLayer))
        const providerCfg = model ? cfg.provider?.[model.providerID] : undefined
        const hasToolParser = !!(
          (model?.id ? providerCfg?.models?.[model.id]?.options?.toolParser : undefined) ??
          model?.options?.toolParser ??
          providerCfg?.options?.toolParser
        )
        const shouldOCR = hasToolParser || canReceiveImage === false

        if (shouldOCR) {
          // extractImageText can reject (runVisionOcr's fs.mkdir sits outside
          // its try/catch); Effect.promise would turn that rejection into an
          // uncatchable defect — route it into the error channel like the
          // document path below (C-058).
          const result = yield* Effect.tryPromise({
            try: () => extractImageText(filepath),
            catch: (cause): OcrResult => ({ status: "error", message: String(cause).slice(0, 200) }),
          }).pipe(Effect.catch((failure) => Effect.succeed(failure)))
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
        const bytes = yield* fs.readFile(filepath)
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
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      // Document extraction: PDF, .docx, .xlsx, .pptx
      const ext = path.extname(filepath).toLowerCase()
      if (isDocumentFile(ext)) {
        // extractDocumentText rejects on corrupt/mislabeled archives (zip parse
        // throws). Effect.promise turns a rejection into an unrecoverable defect
        // that Effect.catch cannot handle, so use tryPromise to route it into the
        // error channel and fall back to undefined → binary/text handling.
        const result = yield* Effect.tryPromise({
          try: () => extractDocumentText(filepath),
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
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

      if (isBinaryFile(filepath, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      const file = yield* lines(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset || 1 })
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
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

      yield* warm(filepath)

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
          display: {
            type: "file" as const,
            path: filepath,
            text: file.raw.join("\n"),
            lineStart: file.offset,
            lineEnd: last,
            totalLines: file.count,
            truncated,
          },
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

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
