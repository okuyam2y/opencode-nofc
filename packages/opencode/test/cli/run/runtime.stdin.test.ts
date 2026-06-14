import { describe, expect, test } from "bun:test"
import { Readable } from "node:stream"
import { INTERACTIVE_INPUT_ERROR, readPipedStdin, resolveInteractiveStdin } from "@/cli/cmd/run/runtime.stdin"

function stream(isTTY: boolean) {
  return Object.assign(new Readable({ read() {} }), { isTTY }) as NodeJS.ReadStream
}

describe("run interactive stdin", () => {
  test("reuses stdin when it is already a tty", () => {
    const stdin = stream(true)
    const seen: string[] = []
    const result = resolveInteractiveStdin(
      stdin,
      (path) => {
        seen.push(path)
        return stream(true)
      },
      "linux",
    )

    expect(result.stdin).toBe(stdin)
    expect(result.cleanup).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("opens the controlling terminal when stdin is piped", () => {
    const tty = stream(true)
    const seen: string[] = []
    const result = resolveInteractiveStdin(
      stream(false),
      (path) => {
        seen.push(path)
        return tty
      },
      "linux",
    )

    expect(result.stdin).toBe(tty)
    expect(seen).toEqual(["/dev/tty"])

    result.cleanup?.()
    expect(tty.destroyed).toBe(true)
  })

  test("uses CONIN$ on windows", () => {
    const seen: string[] = []
    resolveInteractiveStdin(
      stream(false),
      (path) => {
        seen.push(path)
        return stream(true)
      },
      "win32",
    )

    expect(seen).toEqual(["CONIN$"])
  })

  test("throws a clear error when no controlling terminal is available", () => {
    expect(() =>
      resolveInteractiveStdin(
        stream(false),
        () => {
          throw new Error("open failed")
        },
        "linux",
      ),
    ).toThrow(INTERACTIVE_INPUT_ERROR)
  })
})

describe("readPipedStdin", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test("returns undefined for a tty (interactive, nothing piped)", async () => {
    expect(await readPipedStdin(stream(true))).toBeUndefined()
  })

  test("reads piped input fully to EOF", async () => {
    const stdin = stream(false)
    const result = readPipedStdin(stdin, { graceMs: 1000, hasFallback: true })
    stdin.push("hello ")
    stdin.push("world")
    stdin.push(null)
    expect(await result).toBe("hello world")
  })

  test("returns empty string when stdin EOFs with no data (`< /dev/null`)", async () => {
    const stdin = stream(false)
    const result = readPipedStdin(stdin, { graceMs: 1000, hasFallback: true })
    stdin.push(null)
    expect(await result).toBe("")
  })

  test("returns undefined instead of hanging when no byte or EOF arrives (with fallback)", async () => {
    // Inherited pipe/socket held open with no data and no EOF — the silent-hang
    // case. With a fallback message the first-signal timer fires → no piped input.
    const start = Date.now()
    expect(await readPipedStdin(stream(false), { graceMs: 30, hasFallback: true })).toBeUndefined()
    expect(Date.now() - start).toBeLessThan(1000)
  })

  test("reads a slow producer to EOF without truncating once the first byte arrives", async () => {
    // round-1 reviewer's High: the time bound is only for the FIRST signal. A
    // mid-stream gap longer than grace must NOT cut the stream — after the first
    // byte we read to EOF like any Unix filter.
    const stdin = stream(false)
    const result = readPipedStdin(stdin, { graceMs: 40, hasFallback: true })
    stdin.push("a")
    await delay(80) // gap >> grace
    stdin.push("bc")
    stdin.push(null)
    expect(await result).toBe("abc")
  })

  test("without a fallback, stdin is the sole input and is read to EOF even if the first byte is slow", async () => {
    // No message arg → stdin is the only input source, so there is no
    // first-signal bound at all (Codex round flagged silent truncation of a
    // slow sole-input producer).
    const stdin = stream(false)
    const result = readPipedStdin(stdin, { graceMs: 20 }) // hasFallback defaults to false
    await delay(60) // far past grace, with no data yet
    stdin.push("late prompt")
    stdin.push(null)
    expect(await result).toBe("late prompt")
  })

  test("a fallback + grace-late first byte is dropped, but the drop is SURFACED not silent", async () => {
    // A never-closing inherited pipe and a slow producer are indistinguishable
    // by time; with a fallback we must bound the wait or the common
    // `opencode run "msg"`-from-a-harness case hangs forever. So a supplementary
    // pipe whose first byte arrives after the grace is treated as no input —
    // but onTimeout MUST fire so the caller can warn (round-4 reviewer: silent
    // data loss is the real defect, not the bounded wait).
    const stdin = stream(false)
    let timedOut = false
    const result = readPipedStdin(stdin, { graceMs: 30, hasFallback: true, onTimeout: () => (timedOut = true) })
    await delay(70) // first byte arrives only AFTER the grace
    stdin.push("late supplementary context")
    stdin.push(null)
    expect(await result).toBeUndefined()
    expect(timedOut).toBe(true)
  })

  test("onTimeout does NOT fire when stdin delivers within grace or EOFs", async () => {
    const fast = stream(false)
    let firedFast = false
    const r1 = readPipedStdin(fast, { graceMs: 50, hasFallback: true, onTimeout: () => (firedFast = true) })
    fast.push("x")
    fast.push(null)
    expect(await r1).toBe("x")
    expect(firedFast).toBe(false)

    const empty = stream(false)
    let firedEmpty = false
    const r2 = readPipedStdin(empty, { graceMs: 50, hasFallback: true, onTimeout: () => (firedEmpty = true) })
    empty.push(null) // immediate EOF, no data
    expect(await r2).toBe("")
    expect(firedEmpty).toBe(false)
  })

  test("with a fallback it does not hang on an inherited silent pipe (interactive case)", async () => {
    // run.ts passes hasFallback=true for --interactive (its real input is the
    // controlling terminal). `sleep 120 | opencode run --interactive` must not
    // block on the inherited pipe — the first-signal timer fires.
    const start = Date.now()
    expect(await readPipedStdin(stream(false), { graceMs: 30, hasFallback: true })).toBeUndefined()
    expect(Date.now() - start).toBeLessThan(1000)
  })

  test("rejects on a stream error instead of returning truncated input", async () => {
    const stdin = stream(false)
    const result = readPipedStdin(stdin, { graceMs: 1000, hasFallback: true })
    stdin.push("prefix")
    stdin.destroy(new Error("EIO"))
    await expect(result).rejects.toThrow("EIO")
  })
})
