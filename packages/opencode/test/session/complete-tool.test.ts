import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"

function makeMsg(
  role: "user" | "assistant",
  parts: MessageV2.Part[],
  opts?: { error?: unknown },
): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID: "s1" as SessionID,
      role,
      time: { created: Date.now() },
      ...(opts?.error ? { error: opts.error } : {}),
    } as any,
    parts,
  }
}

function textPart(text: string): MessageV2.Part {
  return {
    id: PartID.ascending(),
    sessionID: "s1" as SessionID,
    messageID: "m1" as MessageID,
    type: "text",
    text,
  } as any
}

function toolPart(tool: string, state: any): MessageV2.Part {
  return {
    id: PartID.ascending(),
    sessionID: "s1" as SessionID,
    messageID: "m1" as MessageID,
    type: "tool",
    tool,
    callID: "c1",
    state,
  } as any
}

describe("validateComplete", () => {
  test("passes when no failures", () => {
    const msgs = [
      makeMsg("user", [textPart("do something")]),
      makeMsg("assistant", [
        textPart("done"),
        toolPart("bash", {
          status: "completed",
          input: { command: "echo ok" },
          output: "ok",
          title: "echo",
          metadata: { exit: 0 },
          time: { start: 0, end: 1 },
        }),
      ]),
    ]
    expect(SessionPrompt.validateComplete(msgs)).toBeUndefined()
  })

  test("rejects when last assistant has error", () => {
    const msgs = [
      makeMsg("user", [textPart("do something")]),
      makeMsg("assistant", [textPart("oops")], { error: "content filter" }),
    ]
    const result = SessionPrompt.validateComplete(msgs)
    expect(result).toContain("Cannot complete")
    expect(result).toContain("content filter")
  })

  test("rejects when tool has error state", () => {
    const msgs = [
      makeMsg("user", [textPart("do something")]),
      makeMsg("assistant", [
        toolPart("write", {
          status: "error",
          input: {},
          error: "Duplicate tool call deduplicated",
          time: { start: 0, end: 1 },
        }),
      ]),
    ]
    const result = SessionPrompt.validateComplete(msgs)
    expect(result).toContain("Cannot complete")
    expect(result).toContain("Duplicate tool call")
  })

  test("rejects when bash exits non-zero", () => {
    const msgs = [
      makeMsg("user", [textPart("run tests")]),
      makeMsg("assistant", [
        toolPart("bash", {
          status: "completed",
          input: { command: "npx playwright test" },
          output: "error: unknown command 'test'",
          title: "run tests",
          metadata: { exit: 1 },
          time: { start: 0, end: 1 },
        }),
      ]),
    ]
    const result = SessionPrompt.validateComplete(msgs)
    expect(result).toContain("Cannot complete")
    expect(result).toContain("exit")
    expect(result).toContain("1")
  })

  test("passes when bash exits zero", () => {
    const msgs = [
      makeMsg("user", [textPart("run tests")]),
      makeMsg("assistant", [
        toolPart("bash", {
          status: "completed",
          input: { command: "npm test" },
          output: "6 passed",
          title: "run tests",
          metadata: { exit: 0 },
          time: { start: 0, end: 1 },
        }),
      ]),
    ]
    expect(SessionPrompt.validateComplete(msgs)).toBeUndefined()
  })

  test("only checks last assistant message", () => {
    const msgs = [
      makeMsg("user", [textPart("first attempt")]),
      makeMsg("assistant", [
        toolPart("bash", {
          status: "completed",
          input: { command: "false" },
          output: "",
          title: "fail",
          metadata: { exit: 1 },
          time: { start: 0, end: 1 },
        }),
      ]),
      makeMsg("user", [textPart("try again")]),
      makeMsg("assistant", [
        toolPart("bash", {
          status: "completed",
          input: { command: "true" },
          output: "",
          title: "success",
          metadata: { exit: 0 },
          time: { start: 0, end: 1 },
        }),
      ]),
    ]
    // Old failure in first assistant should NOT block
    expect(SessionPrompt.validateComplete(msgs)).toBeUndefined()
  })

  test("passes with empty messages", () => {
    expect(SessionPrompt.validateComplete([])).toBeUndefined()
  })

  test("passes when only user messages", () => {
    const msgs = [makeMsg("user", [textPart("hello")])]
    expect(SessionPrompt.validateComplete(msgs)).toBeUndefined()
  })
})

describe("validateCompleteFromParts (post-step check)", () => {
  test("catches bash non-zero exit in current step parts", () => {
    // Simulates: model batches bash(exit=1) + complete in one step.
    // execute-time check sees pre-step msgs (no failure).
    // post-step check sees current step's parts (has failure).
    const parts: MessageV2.Part[] = [
      toolPart("bash", {
        status: "completed",
        input: { command: "npx playwright test" },
        output: "error: unknown command",
        title: "run tests",
        metadata: { exit: 1 },
        time: { start: 0, end: 1 },
      }),
      toolPart("complete", {
        status: "completed",
        input: { summary: "all tests pass" },
        output: "all tests pass",
        title: "Complete",
        metadata: {},
        time: { start: 0, end: 1 },
      }),
    ]
    const result = SessionPrompt.validateCompleteFromParts(parts)
    expect(result).toContain("Cannot complete")
    expect(result).toContain("exit")
  })

  test("passes when all tools succeeded", () => {
    const parts: MessageV2.Part[] = [
      toolPart("bash", {
        status: "completed",
        input: { command: "npm test" },
        output: "6 passed",
        title: "run tests",
        metadata: { exit: 0 },
        time: { start: 0, end: 1 },
      }),
    ]
    expect(SessionPrompt.validateCompleteFromParts(parts)).toBeUndefined()
  })

  test("catches tool error state in current step", () => {
    const parts: MessageV2.Part[] = [
      toolPart("write", {
        status: "error",
        input: {},
        error: "Near-duplicate write to same filePath skipped",
        time: { start: 0, end: 1 },
      }),
    ]
    const result = SessionPrompt.validateCompleteFromParts(parts)
    expect(result).toContain("Cannot complete")
    expect(result).toContain("write")
  })

  test("ignores non-tool parts", () => {
    const parts: MessageV2.Part[] = [textPart("some text")]
    expect(SessionPrompt.validateCompleteFromParts(parts)).toBeUndefined()
  })
})
