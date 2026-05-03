import { afterAll, afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import { LineEditTool } from "../../src/tool/line_edit"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { LSP } from "../../src/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import * as Truncate from "../../src/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"

const testLayer = Layer.mergeAll(
  LSP.defaultLayer,
  AppFileSystem.defaultLayer,
  Format.defaultLayer,
  Bus.layer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)

const runtime = ManagedRuntime.make(testLayer)
afterAll(() => runtime.dispose())

const ctx = {
  sessionID: SessionID.make("ses_test-line-edit-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: (input: unknown) =>
    Effect.gen(function* () {
      return input
    }),
  ask: (req: unknown) =>
    Effect.gen(function* () {
      return req
    }),
}

const resolve = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const info = yield* LineEditTool
      return yield* info.init()
    }),
  )

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.line_edit", () => {
  async function setup(tmp: { path: string }, content: string) {
    const filepath = path.join(tmp.path, "test.txt")
    await fs.writeFile(filepath, content, "utf-8")
    const tool = await resolve()
    return { filepath, tool }
  }

  test("replace single line", async () => {
    const tmp = await tmpdir()
    const { filepath, tool } = await setup(tmp, "line1\nline2\nline3\n")

    const result = await WithInstance.provide({
      directory: tmp.path,
      fn: () =>
        runtime.runPromise(
          tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 2,
              newText: "replaced",
            },
            ctx as any,
          ),
        ),
    })

    expect(result.output).toContain("Edit applied successfully")
    const content = await fs.readFile(filepath, "utf-8")
    expect(content).toBe("line1\nreplaced\nline3\n")
  })

  test("replace multiple lines", async () => {
    const tmp = await tmpdir()
    const { filepath, tool } = await setup(tmp, "line1\nline2\nline3\nline4\n")

    await WithInstance.provide({
      directory: tmp.path,
      fn: () =>
        runtime.runPromise(
          tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 3,
              newText: "new2\nnew3\nnew3b",
            },
            ctx as any,
          ),
        ),
    })

    const content = await fs.readFile(filepath, "utf-8")
    expect(content).toBe("line1\nnew2\nnew3\nnew3b\nline4\n")
  })

  test("delete lines (empty newText)", async () => {
    const tmp = await tmpdir()
    const { filepath, tool } = await setup(tmp, "line1\nline2\nline3\n")

    await WithInstance.provide({
      directory: tmp.path,
      fn: () =>
        runtime.runPromise(
          tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 2,
              newText: "",
            },
            ctx as any,
          ),
        ),
    })

    const content = await fs.readFile(filepath, "utf-8")
    expect(content).toBe("line1\nline3\n")
  })

  test("rejects out-of-range endLine", async () => {
    const tmp = await tmpdir()
    const { filepath, tool } = await setup(tmp, "line1\nline2\n")

    await expect(
      WithInstance.provide({
        directory: tmp.path,
        fn: () =>
          runtime.runPromise(
            tool.execute(
              {
                filePath: filepath,
                startLine: 1,
                endLine: 5,
                newText: "x",
              },
              ctx as any,
            ),
          ),
      }),
    ).rejects.toThrow(/exceeds file length/)
  })

  test("rejects content mismatch when oldText is provided", async () => {
    const tmp = await tmpdir()
    const { filepath, tool } = await setup(tmp, "line1\nline2\nline3\n")

    await expect(
      WithInstance.provide({
        directory: tmp.path,
        fn: () =>
          runtime.runPromise(
            tool.execute(
              {
                filePath: filepath,
                startLine: 2,
                endLine: 2,
                oldText: "wrong content",
                newText: "replaced",
              },
              ctx as any,
            ),
          ),
      }),
    ).rejects.toThrow(/Content mismatch/)
  })

  test("accepts matching oldText", async () => {
    const tmp = await tmpdir()
    const { filepath, tool } = await setup(tmp, "line1\nline2\nline3\n")

    const result = await WithInstance.provide({
      directory: tmp.path,
      fn: () =>
        runtime.runPromise(
          tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 2,
              oldText: "line2",
              newText: "replaced",
            },
            ctx as any,
          ),
        ),
    })

    expect(result.output).toContain("Edit applied successfully")
    const content = await fs.readFile(filepath, "utf-8")
    expect(content).toBe("line1\nreplaced\nline3\n")
  })
})
