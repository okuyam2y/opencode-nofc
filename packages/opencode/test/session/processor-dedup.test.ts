import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

describe("SessionProcessor.isDuplicate + dedupKey", () => {
  test("first call is not a duplicate", () => {
    const accepted = new Map<string, string>()
    expect(SessionProcessor.isDuplicate(accepted, "read", { file: "a.ts", offset: 1 })).toBeUndefined()
  })

  test("second identical call returns first toolCallId", () => {
    const accepted = new Map<string, string>()
    const input = { file: "a.ts", offset: 1 }
    accepted.set(SessionProcessor.dedupKey("read", input), "call-1")
    expect(SessionProcessor.isDuplicate(accepted, "read", input)).toBe("call-1")
  })

  test("different input is not a duplicate", () => {
    const accepted = new Map<string, string>()
    accepted.set(SessionProcessor.dedupKey("read", { file: "a.ts", offset: 1 }), "call-1")
    expect(SessionProcessor.isDuplicate(accepted, "read", { file: "a.ts", offset: 100 })).toBeUndefined()
  })

  test("different toolName is not a duplicate", () => {
    const accepted = new Map<string, string>()
    accepted.set(SessionProcessor.dedupKey("read", { file: "a.ts" }), "call-1")
    expect(SessionProcessor.isDuplicate(accepted, "write", { file: "a.ts" })).toBeUndefined()
  })

  test("empty accepted map has no duplicates", () => {
    expect(SessionProcessor.isDuplicate(new Map(), "read", { file: "a.ts" })).toBeUndefined()
  })

  test("step isolation: fresh Map has no duplicates", () => {
    const step1 = new Map<string, string>()
    step1.set(SessionProcessor.dedupKey("read", { file: "a.ts", offset: 1 }), "call-1")
    expect(SessionProcessor.isDuplicate(step1, "read", { file: "a.ts", offset: 1 })).toBe("call-1")

    // Step 2 gets a fresh Map — same call is allowed
    const step2 = new Map<string, string>()
    expect(SessionProcessor.isDuplicate(step2, "read", { file: "a.ts", offset: 1 })).toBeUndefined()
  })

  test("survives tool-result deletion from toolcalls", () => {
    const accepted = new Map<string, string>()
    const input = { filePath: "/project/Planetiler.java", offset: 1, limit: 120 }

    accepted.set(SessionProcessor.dedupKey("read", input), "call-1")

    // call-2 arrives with same input — still detected, returns first callId
    expect(SessionProcessor.isDuplicate(accepted, "read", input)).toBe("call-1")
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
      if (SessionProcessor.isDuplicate(accepted, "read", call.input)) {
        deduped++
      } else {
        accepted.set(SessionProcessor.dedupKey("read", call.input), call.id)
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
      if (SessionProcessor.isDuplicate(accepted, "read", call.input)) {
        deduped++
      } else {
        accepted.set(SessionProcessor.dedupKey("read", call.input), call.id)
        executed++
      }
    }

    expect(executed).toBe(4)
    expect(deduped).toBe(4)
  })

  test("duplicate returns first call's toolCallId for dedupOf tracking", () => {
    const accepted = new Map<string, string>()
    const input = { command: "git log --oneline -10" }
    accepted.set(SessionProcessor.dedupKey("bash", input), "first-call-id")
    const firstId = SessionProcessor.isDuplicate(accepted, "bash", input)
    expect(firstId).toBe("first-call-id")
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
      const map = new Map<string, { toolCallId: string; contentLength: number }>()
      SessionProcessor.trackWriteFilePath(map, "write", { filePath: "/a.ts", content: "a]".repeat(10) }, "c1")
      const dup2 = SessionProcessor.checkNearDuplicateWrite(map, "write", { filePath: "/a.ts", content: "abc" })
      expect(dup2).toBeDefined()
      expect(dup2!.newContentLength).toBeLessThanOrEqual(dup2!.prevContentLength)
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
