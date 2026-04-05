import { afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LineEditTool } from "../../src/tool/line_edit"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { FileTime } from "../../src/file/time"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test-line-edit-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.line_edit", () => {
  async function setup(tmp: { path: string }, content: string) {
    const filepath = path.join(tmp.path, "test.txt")
    await fs.writeFile(filepath, content, "utf-8")
    const tool = await LineEditTool.init()

    // Register the file read time so FileTime.assert passes
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await FileTime.read(ctx.sessionID, filepath)
      },
    })

    return { filepath, tool }
  }

  describe("basic replacement", () => {
    test("replaces a range of lines", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "line1\nline2\nline3\nline4\n")

          const result = await tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 3,
              oldText: "line2\nline3",
              newText: "replaced2\nreplaced3",
            },
            ctx,
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("line1\nreplaced2\nreplaced3\nline4\n")
          expect(result.output).toContain("Edit applied successfully")
        },
      })
    })

    test("replaces a single line", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "aaa\nbbb\nccc\n")

          await tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 2,
              oldText: "bbb",
              newText: "BBB",
            },
            ctx,
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("aaa\nBBB\nccc\n")
        },
      })
    })

    test("handles line count increase", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\nb\nc\n")

          await tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 2,
              oldText: "b",
              newText: "b1\nb2\nb3",
            },
            ctx,
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("a\nb1\nb2\nb3\nc\n")
        },
      })
    })
  })

  describe("trailing newline boundary", () => {
    test("file with trailing newline: line count matches read", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // "a\nb\n" has 2 visible lines in `read` (cat -n), not 3
          const { filepath, tool } = await setup(tmp, "a\nb\n")

          // endLine=3 should be rejected because read shows only 2 lines
          expect(
            tool.execute(
              {
                filePath: filepath,
                startLine: 1,
                endLine: 3,
                oldText: "a\nb\n",
                newText: "x",
              },
              ctx,
            ),
          ).rejects.toThrow("exceeds file length (2 lines)")
        },
      })
    })

    test("deleting last line preserves trailing newline", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\nb\nc\n")

          await tool.execute(
            {
              filePath: filepath,
              startLine: 3,
              endLine: 3,
              oldText: "c",
              newText: "C",
            },
            ctx,
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("a\nb\nC\n")
        },
      })
    })
  })

  describe("empty replacement (line deletion)", () => {
    test("deleting a range with empty newText removes lines", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\nb\nc\nd\n")

          await tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 3,
              oldText: "b\nc",
              newText: "",
            },
            ctx,
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("a\nd\n")
        },
      })
    })

    test("deleting all lines produces empty file", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\n")

          await tool.execute(
            {
              filePath: filepath,
              startLine: 1,
              endLine: 1,
              oldText: "a",
              newText: "",
            },
            ctx,
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("")
        },
      })
    })
  })

  describe("validation", () => {
    test("rejects non-integer startLine", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\nb\n")

          expect(
            tool.execute(
              {
                filePath: filepath,
                startLine: 1.5,
                endLine: 2,
                oldText: "a\nb",
                newText: "x",
              } as any,
              ctx,
            ),
          ).rejects.toThrow()
        },
      })
    })

    test("rejects startLine < 1", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\nb\n")

          expect(
            tool.execute(
              {
                filePath: filepath,
                startLine: 0,
                endLine: 1,
                oldText: "a",
                newText: "x",
              },
              ctx,
            ),
          ).rejects.toThrow("startLine must be >= 1")
        },
      })
    })

    test("rejects endLine < startLine", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\nb\n")

          expect(
            tool.execute(
              {
                filePath: filepath,
                startLine: 2,
                endLine: 1,
                oldText: "b",
                newText: "x",
              },
              ctx,
            ),
          ).rejects.toThrow("endLine (1) must be >= startLine (2)")
        },
      })
    })

    test("rejects content mismatch with actual content in error", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\nb\nc\n")

          try {
            await tool.execute(
              {
                filePath: filepath,
                startLine: 2,
                endLine: 2,
                oldText: "wrong",
                newText: "x",
              },
              ctx,
            )
            expect.unreachable("should have thrown")
          } catch (e: any) {
            expect(e.message).toContain("Content mismatch")
            expect(e.message).toContain("Actual:\nb")
          }
        },
      })
    })

    test("rejects identical oldText and newText", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\nb\n")

          expect(
            tool.execute(
              {
                filePath: filepath,
                startLine: 1,
                endLine: 1,
                oldText: "a",
                newText: "a",
              },
              ctx,
            ),
          ).rejects.toThrow("No changes to apply")
        },
      })
    })
  })

  describe("CRLF handling", () => {
    test("normalizes CRLF in comparison and preserves in output", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { filepath, tool } = await setup(tmp, "a\r\nb\r\nc\r\n")

          await tool.execute(
            {
              filePath: filepath,
              startLine: 2,
              endLine: 2,
              oldText: "b",
              newText: "B",
            },
            ctx,
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("a\r\nB\r\nc\r\n")
        },
      })
    })
  })
})
