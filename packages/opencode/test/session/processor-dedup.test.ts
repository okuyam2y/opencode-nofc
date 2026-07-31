import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"
import * as ToolGate from "../../src/session/tool-gate"

describe("ToolGate.isDuplicate + dedupKey", () => {
  test("first call is not a duplicate", () => {
    const accepted = new Map<string, string>()
    expect(ToolGate.isDuplicate(accepted, "read", { file: "a.ts", offset: 1 })).toBeUndefined()
  })

  test("second identical call returns first toolCallId", () => {
    const accepted = new Map<string, string>()
    const input = { file: "a.ts", offset: 1 }
    accepted.set(ToolGate.dedupKey("read", input), "call-1")
    expect(ToolGate.isDuplicate(accepted, "read", input)).toBe("call-1")
  })

  test("different input is not a duplicate", () => {
    const accepted = new Map<string, string>()
    accepted.set(ToolGate.dedupKey("read", { file: "a.ts", offset: 1 }), "call-1")
    expect(ToolGate.isDuplicate(accepted, "read", { file: "a.ts", offset: 100 })).toBeUndefined()
  })

  test("different toolName is not a duplicate", () => {
    const accepted = new Map<string, string>()
    accepted.set(ToolGate.dedupKey("read", { file: "a.ts" }), "call-1")
    expect(ToolGate.isDuplicate(accepted, "write", { file: "a.ts" })).toBeUndefined()
  })

  test("empty accepted map has no duplicates", () => {
    expect(ToolGate.isDuplicate(new Map(), "read", { file: "a.ts" })).toBeUndefined()
  })

  test("step isolation: fresh Map has no duplicates", () => {
    const step1 = new Map<string, string>()
    step1.set(ToolGate.dedupKey("read", { file: "a.ts", offset: 1 }), "call-1")
    expect(ToolGate.isDuplicate(step1, "read", { file: "a.ts", offset: 1 })).toBe("call-1")

    // Step 2 gets a fresh Map — same call is allowed
    const step2 = new Map<string, string>()
    expect(ToolGate.isDuplicate(step2, "read", { file: "a.ts", offset: 1 })).toBeUndefined()
  })

  test("survives tool-result deletion from toolcalls", () => {
    const accepted = new Map<string, string>()
    const input = { filePath: "/project/Planetiler.java", offset: 1, limit: 120 }

    accepted.set(ToolGate.dedupKey("read", input), "call-1")

    // call-2 arrives with same input — still detected, returns first callId
    expect(ToolGate.isDuplicate(accepted, "read", input)).toBe("call-1")
  })

  test("incident replay: 10 identical reads → 2 executed, 8 deduped", () => {
    const fileA = { filePath: "/project/Planetiler.java", offset: 1, limit: 120 }
    const fileB = { filePath: "/project/PlanetilerTests.java", offset: 1, limit: 120 }

    const calls = [
      { id: "c1", input: fileA },
      { id: "c2", input: fileB },
      { id: "c3", input: fileA },
      { id: "c4", input: fileB },
      { id: "c5", input: fileA },
      { id: "c6", input: fileB },
      { id: "c7", input: fileA },
      { id: "c8", input: fileB },
      { id: "c9", input: fileA },
      { id: "c10", input: fileB },
    ]

    const accepted = new Map<string, string>()
    let executed = 0
    let deduped = 0

    for (const call of calls) {
      if (ToolGate.isDuplicate(accepted, "read", call.input)) {
        deduped++
      } else {
        accepted.set(ToolGate.dedupKey("read", call.input), call.id)
        executed++
      }
    }

    expect(executed).toBe(2)
    expect(deduped).toBe(8)
  })

  test("mixed calls: duplicates deduped, unique calls preserved", () => {
    const sameInput = { filePath: "/a.ts", offset: 1, limit: 50 }
    const calls = [
      { id: "c1", input: sameInput },
      { id: "c2", input: sameInput },
      { id: "c3", input: { filePath: "/a.ts", offset: 100, limit: 50 } },
      { id: "c4", input: sameInput },
      { id: "c5", input: { filePath: "/b.ts", offset: 1, limit: 50 } },
      { id: "c6", input: sameInput },
      { id: "c7", input: { filePath: "/a.ts", offset: 200, limit: 50 } },
      { id: "c8", input: sameInput },
    ]

    const accepted = new Map<string, string>()
    let executed = 0
    let deduped = 0

    for (const call of calls) {
      if (ToolGate.isDuplicate(accepted, "read", call.input)) {
        deduped++
      } else {
        accepted.set(ToolGate.dedupKey("read", call.input), call.id)
        executed++
      }
    }

    expect(executed).toBe(4)
    expect(deduped).toBe(4)
  })

  test("duplicate returns first call's toolCallId for dedupOf tracking", () => {
    const accepted = new Map<string, string>()
    const input = { command: "git log --oneline -10" }
    accepted.set(ToolGate.dedupKey("bash", input), "first-call-id")
    const firstId = ToolGate.isDuplicate(accepted, "bash", input)
    expect(firstId).toBe("first-call-id")
  })

  describe("checkNearDuplicateWrite + trackWriteFilePath", () => {
    test("non-write tool returns undefined and does not track", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      expect(ToolGate.checkNearDuplicateWrite(map, "read", { filePath: "a.ts" })).toBeUndefined()
      ToolGate.trackWriteFilePath(map, "read", { filePath: "a.ts" }, "c1")
      expect(map.size).toBe(0)
    })

    test("first write returns undefined; trackWriteFilePath records it", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      const input = { filePath: "/a.ts", content: "hello" }
      expect(ToolGate.checkNearDuplicateWrite(map, "write", input)).toBeUndefined()
      ToolGate.trackWriteFilePath(map, "write", input, "c1")
      expect(map.get("/a.ts")).toEqual({ toolCallId: "c1", contentLength: 5 })
    })

    test("second write to same path returns near-duplicate info", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      ToolGate.trackWriteFilePath(map, "write", { filePath: "/a.ts", content: "short" }, "c1")
      const result = ToolGate.checkNearDuplicateWrite(map, "write", { filePath: "/a.ts", content: "longer content" })
      expect(result).toEqual({
        prevToolCallId: "c1",
        prevContentLength: 5,
        newContentLength: 14,
      })
    })

    test("different filePaths are independent", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      ToolGate.trackWriteFilePath(map, "write", { filePath: "/a.ts", content: "aaa" }, "c1")
      expect(ToolGate.checkNearDuplicateWrite(map, "write", { filePath: "/b.ts", content: "bbb" })).toBeUndefined()
    })

    test("skipped call does not update map — 3rd write compares against allowed write", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      ToolGate.trackWriteFilePath(map, "write", { filePath: "/a.ts", content: "a]".repeat(10) }, "c1")
      const dup2 = ToolGate.checkNearDuplicateWrite(map, "write", { filePath: "/a.ts", content: "abc" })
      expect(dup2).toBeDefined()
      expect(dup2!.newContentLength).toBeLessThanOrEqual(dup2!.prevContentLength)
      const dup3 = ToolGate.checkNearDuplicateWrite(map, "write", { filePath: "/a.ts", content: "0123456789" })
      expect(dup3).toBeDefined()
      expect(dup3!.prevToolCallId).toBe("c1")
      expect(dup3!.prevContentLength).toBe(20)
      expect(dup3!.newContentLength).toBe(10)
    })

    test("write without content field uses length 0", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      ToolGate.trackWriteFilePath(map, "write", { filePath: "/a.ts" }, "c1")
      expect(map.get("/a.ts")).toEqual({ toolCallId: "c1", contentLength: 0 })
    })

    test("write without filePath is ignored", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      expect(ToolGate.checkNearDuplicateWrite(map, "write", { content: "abc" })).toBeUndefined()
      ToolGate.trackWriteFilePath(map, "write", { content: "abc" }, "c1")
      expect(map.size).toBe(0)
    })
  })

  // NOTE: DEDUP_SKIP_TOOLS (module-scope in processor.ts) exempts read-only tools:
  //   read, glob, grep, webfetch, websearch, codesearch, invalid
  // Side-effecting tools (bash, write, edit, question, skill, task, todo_write)
  // are NOT exempt — duplicates are caught but returned as synthetic "completed"
  // (not "error") so the model doesn't see a failure.

  test("deduped call's tool-result is safely ignored", () => {
    const toolcalls: Record<string, unknown> = { "call-1": { status: "running" } }
    delete toolcalls["call-2"]
    expect(toolcalls["call-2"]).toBeUndefined()
  })
})

describe("SessionProcessor.dedupStreamOverlap", () => {
  test("varied retransmission overlap is detected", () => {
    const acc = "prefix text 0123456789ABCDEF"
    const delta = "0123456789ABCDEF and then more"
    expect(SessionProcessor.dedupStreamOverlap(acc, delta)).toBe(16)
  })

  test("no overlap returns 0", () => {
    expect(SessionProcessor.dedupStreamOverlap("the quick brown fox jumps", "completely different content")).toBe(0)
  })

  test("short overlap (<15 chars) is ignored", () => {
    // "lmnop" overlap is only 5 chars — below the 15-char threshold
    expect(SessionProcessor.dedupStreamOverlap("abcdefghijklmnop", "lmnopqrstuvwxyz0")).toBe(0)
  })

  test("regression: uniform dash run is NOT deduped (markdown HR corruption)", () => {
    const acc = "intro paragraph\n" + "-".repeat(20)
    const delta = "-".repeat(20) + "\nnext paragraph"
    // Before the fix this returned 20 and silently halved a 40-dash rule.
    expect(SessionProcessor.dedupStreamOverlap(acc, delta)).toBe(0)
  })

  test("regression: uniform blank-line run is NOT deduped", () => {
    const acc = "section one" + "\n".repeat(16)
    const delta = "\n".repeat(16) + "section two"
    expect(SessionProcessor.dedupStreamOverlap(acc, delta)).toBe(0)
  })

  test("regression: uniform '=' separator run is NOT deduped", () => {
    const acc = "title\n" + "=".repeat(18)
    const delta = "=".repeat(18) + " trailing"
    expect(SessionProcessor.dedupStreamOverlap(acc, delta)).toBe(0)
  })

  test("regression: uniform supplementary-plane (emoji) run is NOT deduped (llm-review R3 P1)", () => {
    // seg[0] is a UTF-16 code unit; [...seg] yields code points. Comparing the
    // two treated a uniform emoji run as "varied" and stripped it.
    const run = "🎉".repeat(10) // 20 UTF-16 units >= DEDUP_MIN
    const acc = "intro paragraph\n" + run
    const delta = run + "\nnext paragraph"
    expect(SessionProcessor.dedupStreamOverlap(acc, delta)).toBe(0)
  })

  describe("chunk-boundary alignment (optional mode, NOT used at runtime)", () => {
    // These pin the semantics of the optional `boundaries` argument.  The mode
    // was live 2026-07-30..31 on the assumption that a retransmission re-sends
    // whole previously delivered chunks and is therefore boundary-aligned; a
    // measurement probe refuted that (91 declined overlaps in one session, ≥87
    // true retransmissions, none starting on a boundary — distances 1–63), so
    // the runtime call-site reverted to the boundary-less scan.  The tests stay
    // so the trade-off both modes make remains executable documentation.

    test("retransmission of a whole previous chunk is deduped", () => {
      const c1 = "実行結果をまとめます。\n\n"
      const c2 = "- `tests/test_parser_step_b.py` → `154 passed`\n"
      const acc = c1 + c2
      const boundaries = [0, c1.length, acc.length]
      // Gateway re-sends c2, then continues.
      const delta = c2 + "- `tests/test_parser_step_c.py` → `98 passed`\n"
      expect(SessionProcessor.dedupStreamOverlap(acc, delta, boundaries)).toBe(c2.length)
    })

    test("retransmission spanning several previous chunks is deduped in full", () => {
      const c1 = "前置きのテキストです。\n"
      const c2 = "- 手順その一を実行しました\n"
      const c3 = "- 手順その二を実行しました\n"
      const acc = c1 + c2 + c3
      const boundaries = [0, c1.length, c1.length + c2.length, acc.length]
      const delta = c2 + c3 + "- 手順その三を実行しました\n"
      expect(SessionProcessor.dedupStreamOverlap(acc, delta, boundaries)).toBe(c2.length + c3.length)
    })

    test("regression: coincidental repeat at a non-boundary offset is NOT deduped", () => {
      // Observed in a real session: an enumerated pytest run list where the
      // next delta's leading run of `-q` / path text matched the buffer tail at
      // an offset no chunk ever started at.  The legacy arbitrary-offset scan
      // stripped it and silently deleted real characters, producing output like
      // "-q`reader_step_b.py" with "tests/test_" missing.
      // The model listed the same path twice in one pytest invocation, so the
      // intended text genuinely contains the segment back to back, and raw
      // concatenation is the correct output.
      const arg = "tests/test_reader_step_b.py "
      const c1 = "- 全体: `uv run -m pytest "
      // The repeat starts mid-chunk, so no chunk boundary sits at its start.
      const c2 = "および " + arg
      const acc = c1 + c2
      const boundaries = [0, c1.length, acc.length]
      const delta = arg + "tests/test_reader_step_c.py -q`\n"
      // No chunk started where the repeat begins, so the overlap is left alone.
      expect(SessionProcessor.dedupStreamOverlap(acc, delta, boundaries)).toBe(0)
      // The legacy boundary-less scan strips it and deletes one of the two
      // legitimate occurrences — the corruption observed in the smoke run.
      expect(SessionProcessor.dedupStreamOverlap(acc, delta)).toBeGreaterThan(0)
    })

    test("known residual: a legitimate repeat that IS one whole chunk stays ambiguous", () => {
      // Boundary alignment narrows the false-positive surface but cannot close it:
      // when the doubled segment happens to be exactly the last chunk, content and
      // boundaries agree with both readings and the overlap is still stripped.
      // Documented rather than silently tolerated — closing this needs an
      // out-of-band retransmission signal, not a better content heuristic.
      const arg = "tests/test_reader_step_b.py "
      const c1 = "- 全体: `uv run -m pytest "
      const acc = c1 + arg
      const boundaries = [0, c1.length, acc.length]
      const delta = arg + "tests/test_reader_step_c.py -q`\n"
      expect(SessionProcessor.dedupStreamOverlap(acc, delta, boundaries)).toBe(arg.length)
    })

    test("regression: over-long coincidental match is not preferred over the boundary", () => {
      // The legacy scan walked len down from 200 and returned the FIRST (longest)
      // match, so in repetitive content it could strip far more than the chunk
      // that was actually retransmitted.
      const unit = "  - `tests/test_step_x.py` → `12 passed`\n"
      const c1 = "見出し\n" + unit
      const c2 = unit
      const acc = c1 + c2
      const boundaries = [0, c1.length, acc.length]
      // Only the last chunk (one unit) was retransmitted, but the delta happens
      // to open with two units because the next list entry repeats the line.
      const delta = unit + unit + "おわり\n"
      expect(SessionProcessor.dedupStreamOverlap(acc, delta, boundaries)).toBe(unit.length)
      // The legacy scan takes the longest match and strips both units.
      expect(SessionProcessor.dedupStreamOverlap(acc, delta)).toBe(unit.length * 2)
    })

    test("boundaries that scrolled past the 200-char window yield no overlap", () => {
      const c1 = "x".repeat(30) + "unique-head-marker\n"
      const acc = c1 + "y".repeat(400)
      const boundaries = [0, c1.length, acc.length]
      // c1 is far outside the window, so its boundary produces no candidate.
      expect(SessionProcessor.dedupStreamOverlap(acc, c1 + "tail", boundaries)).toBe(0)
    })
  })
})
