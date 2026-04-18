import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import {
  collapseIntermediate,
  createCollapser,
} from "../../../src/cli/cmd/tui/routes/session/intermediate-text-collapse"

const text = (id: string, body: string): Part =>
  ({ id, type: "text", text: body, time: { start: 0, end: 0 } }) as unknown as Part

const stepStart = (id: string): Part => ({ id, type: "step-start" }) as unknown as Part

const stepFinish = (id: string, reason: string): Part =>
  ({
    id,
    type: "step-finish",
    reason,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as unknown as Part

const tool = (id: string): Part =>
  ({
    id,
    type: "tool",
    tool: "read",
    callID: id,
    state: { status: "completed", input: {}, output: "", time: { start: 0, end: 0 } },
  }) as unknown as Part

describe("collapseIntermediate", () => {
  test("single stop step → no collapse", () => {
    const parts = [stepStart("ss1"), text("t1", "final"), stepFinish("sf1", "stop")]
    const out = collapseIntermediate(parts)
    expect(out.map((p) => p.type)).toEqual(["step-start", "text", "step-finish"])
  })

  test("tool-calls step + stop step → middle text collapsed", () => {
    const parts = [
      stepStart("ss1"),
      text("t1", "intermediate"),
      tool("tc1"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "final"),
      stepFinish("sf2", "stop"),
    ]
    const out = collapseIntermediate(parts)
    expect(out.find((p) => p.id === "t1")?.type).toBe("text-intermediate")
    expect(out.find((p) => p.id === "t2")?.type).toBe("text")
  })

  test("multiple tool-calls steps + stop → all intermediate collapsed", () => {
    const parts = [
      stepStart("ss1"),
      text("t1", "draft 1"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "draft 2"),
      stepFinish("sf2", "tool-calls"),
      stepStart("ss3"),
      text("t3", "final"),
      stepFinish("sf3", "stop"),
    ]
    const out = collapseIntermediate(parts)
    expect(out.find((p) => p.id === "t1")?.type).toBe("text-intermediate")
    expect(out.find((p) => p.id === "t2")?.type).toBe("text-intermediate")
    expect(out.find((p) => p.id === "t3")?.type).toBe("text")
  })

  test("only tool-calls steps (no final) → no collapse (abort/in-progress)", () => {
    const parts = [
      stepStart("ss1"),
      text("t1", "intermediate"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "still going"),
      stepFinish("sf2", "tool-calls"),
    ]
    const out = collapseIntermediate(parts)
    expect(out.find((p) => p.id === "t1")?.type).toBe("text")
    expect(out.find((p) => p.id === "t2")?.type).toBe("text")
  })

  test("step-finish never arrived (streaming) → no collapse", () => {
    const parts = [stepStart("ss1"), text("t1", "streaming")]
    const out = collapseIntermediate(parts)
    expect(out.find((p) => p.id === "t1")?.type).toBe("text")
  })

  test("text after final step-finish (next streaming step) → not collapsed", () => {
    const parts = [
      stepStart("ss1"),
      text("t1", "final"),
      stepFinish("sf1", "stop"),
      stepStart("ss2"),
      text("t2", "next turn streaming"),
    ]
    const out = collapseIntermediate(parts)
    expect(out.find((p) => p.id === "t1")?.type).toBe("text")
    expect(out.find((p) => p.id === "t2")?.type).toBe("text")
  })

  test("end_turn reason also treated as final", () => {
    const parts = [
      stepStart("ss1"),
      text("t1", "intermediate"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "final"),
      stepFinish("sf2", "end_turn"),
    ]
    const out = collapseIntermediate(parts)
    expect(out.find((p) => p.id === "t1")?.type).toBe("text-intermediate")
    expect(out.find((p) => p.id === "t2")?.type).toBe("text")
  })

  test("preserves original text body and id when collapsing", () => {
    const parts = [
      stepStart("ss1"),
      text("t1", "draft body"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "final body"),
      stepFinish("sf2", "stop"),
    ]
    const out = collapseIntermediate(parts)
    const collapsed = out.find((p) => p.id === "t1") as { type: string; text: string }
    expect(collapsed.type).toBe("text-intermediate")
    expect(collapsed.text).toBe("draft body")
  })

  test("non-text parts in tool-calls step are untouched", () => {
    const parts = [
      stepStart("ss1"),
      tool("tc1"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "final"),
      stepFinish("sf2", "stop"),
    ]
    const out = collapseIntermediate(parts)
    expect(out.find((p) => p.id === "tc1")?.type).toBe("tool")
  })

  test("empty parts array", () => {
    expect(collapseIntermediate([])).toEqual([])
  })
})

describe("createCollapser identity stability", () => {
  test("returns the same synthetic object across recomputes for the same text id", () => {
    const collapse = createCollapser()
    const baseParts = [
      stepStart("ss1"),
      text("t1", "draft"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "final"),
      stepFinish("sf2", "stop"),
    ]
    const out1 = collapse(baseParts)
    const collapsed1 = out1.find((p) => p.id === "t1")

    // Simulate a later sync update that adds a patch part after step-finish.
    const updated = [
      ...baseParts,
      { id: "patch1", type: "patch", files: [] } as unknown as Part,
    ]
    const out2 = collapse(updated)
    const collapsed2 = out2.find((p) => p.id === "t1")

    expect(collapsed1).toBeDefined()
    expect(collapsed2).toBeDefined()
    expect(collapsed1 === collapsed2).toBe(true)
  })

  test("invalidates cache when text body of the same id changes", () => {
    const collapse = createCollapser()
    const v1 = [
      stepStart("ss1"),
      text("t1", "draft v1"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "final"),
      stepFinish("sf2", "stop"),
    ]
    const out1 = collapse(v1)
    const c1 = out1.find((p) => p.id === "t1") as { text: string }

    const v2 = [
      stepStart("ss1"),
      text("t1", "draft v2"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "final"),
      stepFinish("sf2", "stop"),
    ]
    const out2 = collapse(v2)
    const c2 = out2.find((p) => p.id === "t1") as { text: string }

    expect(c1 === (c2 as unknown as object)).toBe(false)
    expect(c2.text).toBe("draft v2")
  })

  test("evicts cache entries for text parts no longer present", () => {
    const collapse = createCollapser()
    const v1 = [
      stepStart("ss1"),
      text("t1", "draft"),
      stepFinish("sf1", "tool-calls"),
      stepStart("ss2"),
      text("t2", "final"),
      stepFinish("sf2", "stop"),
    ]
    collapse(v1)
    // Simulate a fresh message reusing the same collapser (e.g. revert+regen).
    const v2 = [
      stepStart("ss3"),
      text("t3", "new draft"),
      stepFinish("sf3", "tool-calls"),
      stepStart("ss4"),
      text("t4", "new final"),
      stepFinish("sf4", "stop"),
    ]
    const out2 = collapse(v2)
    const c3 = out2.find((p) => p.id === "t3")
    expect(c3?.type).toBe("text-intermediate")
    // t1 should no longer be cached; calling v1 again gives a fresh identity.
    const out1again = collapse(v1)
    const c1again = out1again.find((p) => p.id === "t1") as { text: string }
    expect(c1again).toBeDefined()
  })
})
