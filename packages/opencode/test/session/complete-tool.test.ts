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

describe("createCompleteTool", () => {
  test("execute returns Complete and invokes onSuccess (no history check)", async () => {
    let captured: string | undefined
    const t = SessionPrompt.createCompleteTool({
      onSuccess: (s) => {
        captured = s
      },
    })
    const result = (await (t as any).execute({ summary: "all done" }, {} as any)) as {
      output: string
      title: string
      metadata: Record<string, unknown>
    }
    expect(result.title).toBe("Complete")
    expect(result.output).toBe("all done")
    expect(captured).toBe("all done")
  })
})
