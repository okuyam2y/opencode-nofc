import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"

const neverReceivedInput = SessionProcessor.toolCallNeverReceivedInput

describe("toolCallNeverReceivedInput", () => {
  test("pending with empty input and empty raw is a parser orphan", () => {
    // Shape produced by the tool-input-start handler before any argument
    // delta arrives.  Observed in production when the parser opened an
    // envelope for a tool name mis-extracted from prose (e.g. " files").
    expect(neverReceivedInput({ status: "pending", input: {}, raw: "" })).toBe(true)
  })

  test("pending with streamed raw arguments is not an orphan", () => {
    // Arguments started arriving, so the call did reach the model's intent —
    // it was cut off, which is a genuine interruption.
    expect(neverReceivedInput({ status: "pending", input: {}, raw: '{"cmd":"pw' })).toBe(false)
  })

  test("pending with parsed input is not an orphan", () => {
    expect(neverReceivedInput({ status: "pending", input: { cmd: "pwd" }, raw: "" })).toBe(false)
  })

  test("running tool is not an orphan", () => {
    const state: MessageV2.ToolState = { status: "running", input: { cmd: "pwd" }, time: { start: 1 } }
    expect(neverReceivedInput(state)).toBe(false)
  })

  test("running tool with empty input is not an orphan", () => {
    // Execution began, so cleanup must still report it as interrupted even
    // though the input record happens to be empty.
    const state: MessageV2.ToolState = { status: "running", input: {}, time: { start: 1 } }
    expect(neverReceivedInput(state)).toBe(false)
  })

  test("completed tool is not an orphan", () => {
    const state: MessageV2.ToolState = {
      status: "completed",
      input: {},
      output: "",
      title: "",
      metadata: {},
      time: { start: 1, end: 2 },
    }
    expect(neverReceivedInput(state)).toBe(false)
  })

  test("already errored tool is not an orphan", () => {
    const state: MessageV2.ToolState = {
      status: "error",
      input: {},
      error: "boom",
      time: { start: 1, end: 2 },
    }
    expect(neverReceivedInput(state)).toBe(false)
  })
})
