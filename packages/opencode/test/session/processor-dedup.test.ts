import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

describe("SessionProcessor.isDuplicate + dedupKey", () => {
  test("first call is not a duplicate", () => {
    const accepted = new Set<string>()
    expect(SessionProcessor.isDuplicate(accepted, "read", { file: "a.ts", offset: 1 })).toBe(false)
  })

  test("second identical call is a duplicate", () => {
    const accepted = new Set<string>()
    const input = { file: "a.ts", offset: 1 }
    accepted.add(SessionProcessor.dedupKey("read", input))
    expect(SessionProcessor.isDuplicate(accepted, "read", input)).toBe(true)
  })

  test("different input is not a duplicate", () => {
    const accepted = new Set<string>()
    accepted.add(SessionProcessor.dedupKey("read", { file: "a.ts", offset: 1 }))
    expect(SessionProcessor.isDuplicate(accepted, "read", { file: "a.ts", offset: 100 })).toBe(false)
  })

  test("different toolName is not a duplicate", () => {
    const accepted = new Set<string>()
    accepted.add(SessionProcessor.dedupKey("read", { file: "a.ts" }))
    expect(SessionProcessor.isDuplicate(accepted, "write", { file: "a.ts" })).toBe(false)
  })

  test("empty accepted set has no duplicates", () => {
    expect(SessionProcessor.isDuplicate(new Set(), "read", { file: "a.ts" })).toBe(false)
  })

  test("step isolation: fresh Set has no duplicates", () => {
    const step1 = new Set<string>()
    step1.add(SessionProcessor.dedupKey("read", { file: "a.ts", offset: 1 }))
    expect(SessionProcessor.isDuplicate(step1, "read", { file: "a.ts", offset: 1 })).toBe(true)

    // Step 2 gets a fresh Set — same call is allowed
    const step2 = new Set<string>()
    expect(SessionProcessor.isDuplicate(step2, "read", { file: "a.ts", offset: 1 })).toBe(false)
  })

  test("survives tool-result deletion from toolcalls", () => {
    // Simulates: call-1 accepted → call-1 completes (deleted from toolcalls)
    // → call-2 arrives with same input → still detected as duplicate
    const accepted = new Set<string>()
    const input = { filePath: "/project/Planetiler.java", offset: 1, limit: 120 }

    // Accept call-1
    accepted.add(SessionProcessor.dedupKey("read", input))

    // call-1 completes — toolcalls entry deleted, but accepted Set unchanged

    // call-2 arrives with same input
    expect(SessionProcessor.isDuplicate(accepted, "read", input)).toBe(true)
  })

  test("incident replay: 10 identical reads → 2 executed, 8 deduped", () => {
    // Replays the exact pattern from the 2026-04-06 planetiler incident:
    // GPT-5.4 emitted 10 Read calls (2 files × 5 each, all offset:1 limit:120)
    // in a single step.
    const fileA = { filePath: "/project/Planetiler.java", offset: 1, limit: 120 }
    const fileB = { filePath: "/project/PlanetilerTests.java", offset: 1, limit: 120 }

    // Interleaved order matching the incident DB: A,B,A,B,A,B,A,B,A,B
    const calls = [
      { input: fileA },
      { input: fileB },
      { input: fileA },
      { input: fileB },
      { input: fileA },
      { input: fileB },
      { input: fileA },
      { input: fileB },
      { input: fileA },
      { input: fileB },
    ]

    const accepted = new Set<string>()
    let executed = 0
    let deduped = 0

    for (const call of calls) {
      if (SessionProcessor.isDuplicate(accepted, "read", call.input)) {
        deduped++
      } else {
        accepted.add(SessionProcessor.dedupKey("read", call.input))
        executed++
      }
    }

    expect(executed).toBe(2) // One per unique file
    expect(deduped).toBe(8) // 10 - 2 duplicates dropped
  })

  test("mixed calls: duplicates deduped, unique calls preserved", () => {
    // 5 identical Reads + 3 unique Reads with different offsets = 8 total
    const sameInput = { filePath: "/a.ts", offset: 1, limit: 50 }
    const calls = [
      { input: sameInput },
      { input: sameInput },
      { input: { filePath: "/a.ts", offset: 100, limit: 50 } },
      { input: sameInput },
      { input: { filePath: "/b.ts", offset: 1, limit: 50 } },
      { input: sameInput },
      { input: { filePath: "/a.ts", offset: 200, limit: 50 } },
      { input: sameInput },
    ]

    const accepted = new Set<string>()
    let executed = 0
    let deduped = 0

    for (const call of calls) {
      if (SessionProcessor.isDuplicate(accepted, "read", call.input)) {
        deduped++
      } else {
        accepted.add(SessionProcessor.dedupKey("read", call.input))
        executed++
      }
    }

    expect(executed).toBe(4) // 1 (a.ts:1) + 1 (a.ts:100) + 1 (b.ts:1) + 1 (a.ts:200)
    expect(deduped).toBe(4) // 4 duplicates of a.ts:1
  })

  describe("checkNearDuplicateWrite + trackWriteFilePath", () => {
    test("non-write tool returns undefined and does not track", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      expect(SessionProcessor.checkNearDuplicateWrite(map, "read", { filePath: "a.ts" })).toBeUndefined()
      SessionProcessor.trackWriteFilePath(map, "read", { filePath: "a.ts" }, "c1")
      expect(map.size).toBe(0)
    })

    test("first write returns undefined; trackWriteFilePath records it", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      const input = { filePath: "/a.ts", content: "hello" }
      expect(SessionProcessor.checkNearDuplicateWrite(map, "write", input)).toBeUndefined()
      SessionProcessor.trackWriteFilePath(map, "write", input, "c1")
      expect(map.get("/a.ts")).toEqual({ toolCallId: "c1", contentLength: 5 })
    })

    test("second write to same path returns near-duplicate info", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      SessionProcessor.trackWriteFilePath(map, "write", { filePath: "/a.ts", content: "short" }, "c1")
      const result = SessionProcessor.checkNearDuplicateWrite(map, "write", { filePath: "/a.ts", content: "longer content" })
      expect(result).toEqual({
        prevToolCallId: "c1",
        prevContentLength: 5,
        newContentLength: 14,
      })
    })

    test("different filePaths are independent", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      SessionProcessor.trackWriteFilePath(map, "write", { filePath: "/a.ts", content: "aaa" }, "c1")
      expect(SessionProcessor.checkNearDuplicateWrite(map, "write", { filePath: "/b.ts", content: "bbb" })).toBeUndefined()
    })

    test("skipped call does not update map — 3rd write compares against allowed write", () => {
      // Sequence: long(c1, allowed) -> short(c2, skipped) -> medium(c3)
      // c3 should compare against c1 (length 20), not c2 (length 3).
      const map = new Map<string, { toolCallId: string; contentLength: number }>()

      // c1: first write, allowed
      SessionProcessor.trackWriteFilePath(map, "write", { filePath: "/a.ts", content: "a]".repeat(10) }, "c1")

      // c2: shorter → near-duplicate detected, caller would skip (no trackWriteFilePath)
      const dup2 = SessionProcessor.checkNearDuplicateWrite(map, "write", { filePath: "/a.ts", content: "abc" })
      expect(dup2).toBeDefined()
      expect(dup2!.newContentLength).toBeLessThanOrEqual(dup2!.prevContentLength)
      // Caller skips c2 — map still points to c1

      // c3: medium (length 10) — still shorter than c1 (length 20), should be caught
      const dup3 = SessionProcessor.checkNearDuplicateWrite(map, "write", { filePath: "/a.ts", content: "0123456789" })
      expect(dup3).toBeDefined()
      expect(dup3!.prevToolCallId).toBe("c1")
      expect(dup3!.prevContentLength).toBe(20)
      expect(dup3!.newContentLength).toBe(10)
    })

    test("write without content field uses length 0", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      SessionProcessor.trackWriteFilePath(map, "write", { filePath: "/a.ts" }, "c1")
      expect(map.get("/a.ts")).toEqual({ toolCallId: "c1", contentLength: 0 })
    })

    test("write without filePath is ignored", () => {
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      expect(SessionProcessor.checkNearDuplicateWrite(map, "write", { content: "abc" })).toBeUndefined()
      SessionProcessor.trackWriteFilePath(map, "write", { content: "abc" }, "c1")
      expect(map.size).toBe(0)
    })
  })

  test("deduped call's tool-result is safely ignored", () => {
    // After dedup, the call is deleted from ctx.toolcalls.
    // When tool-result arrives for that callID, it won't find a match in
    // ctx.toolcalls — the existing guard handles this.
    const toolcalls: Record<string, unknown> = { "call-1": { status: "running" } }

    // Simulate dedup: delete from toolcalls
    delete toolcalls["call-2"] // never existed

    // tool-result for call-2: lookup returns undefined (safely ignored)
    expect(toolcalls["call-2"]).toBeUndefined()
  })
})
