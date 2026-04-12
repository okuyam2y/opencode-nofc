import { describe, expect, test } from "bun:test"
import { StepTextBuffer } from "../../../src/cli/cmd/run"

describe("StepTextBuffer", () => {
  test("flushes text on non-tool-calls step-finish", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    buf.push("hello")
    buf.stepFinish("stop")

    expect(output).toEqual(["hello"])
  })

  test("discards text on tool-calls step-finish and counts skipped", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    buf.push("intermediate summary")
    buf.stepFinish("tool-calls")

    expect(output).toEqual([])
    expect(buf.skipped).toBe(1)
  })

  test("preserves multiple text parts in the same step", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    buf.push("part 1")
    buf.push("part 2")
    buf.stepFinish("stop")

    expect(output).toEqual(["part 1", "part 2"])
  })

  test("discards all text parts on tool-calls step", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    buf.push("part A")
    buf.push("part B")
    buf.stepFinish("tool-calls")

    expect(output).toEqual([])
  })

  test("handles multi-step sequence: discard intermediate, keep final", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    // Step 1: intermediate text + tool-calls → discard
    buf.push("Findings (draft)")
    buf.stepFinish("tool-calls")

    // Step 2: final text + stop → flush
    buf.push("Findings (final)")
    buf.stepFinish("stop")

    expect(output).toEqual(["Findings (final)"])
    expect(buf.skipped).toBe(1)
  })

  test("flush() outputs remaining buffered text", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    buf.push("orphan text")
    buf.flush()

    expect(output).toEqual(["orphan text"])
  })

  test("flush() is idempotent when buffer is empty", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    buf.flush()
    buf.flush()

    expect(output).toEqual([])
  })

  test("end_turn reason also flushes text", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    buf.push("response")
    buf.stepFinish("end_turn")

    expect(output).toEqual(["response"])
    expect(buf.skipped).toBe(0)
  })

  test("skipped accumulates across multiple tool-calls steps", () => {
    const output: string[] = []
    const buf = new StepTextBuffer((t) => output.push(t))

    buf.push("draft 1")
    buf.push("draft 1b")
    buf.stepFinish("tool-calls")

    buf.push("draft 2")
    buf.stepFinish("tool-calls")

    buf.push("final")
    buf.stepFinish("stop")

    expect(output).toEqual(["final"])
    expect(buf.skipped).toBe(3)
  })
})
