import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

const createFilter = SessionProcessor._createStreamingTagFilter

describe("createStreamingTagFilter — ZWS partial handling", () => {
  test("passes through literal partial (regression — existing behavior)", () => {
    const f = createFilter()
    expect(f.push("hello <")).toBe("hello ")
    expect(f.push("tool_cal")).toBe("")
    expect(f.push("l>body</tool_call> after")).toBe(" after")
    expect(f.flush()).toBe("")
  })

  test("handles ZWS-escaped open tag split across chunks", () => {
    const f = createFilter()
    expect(f.push("hello <")).toBe("hello ")
    // Next chunk starts with ZWS (splitting the ZWS-escaped <\u200btool_call>)
    expect(f.push("\u200btool_call>body</\u200btool_call> after")).toBe(" after")
    expect(f.flush()).toBe("")
  })

  test("handles ZWS split at the ZWS character itself", () => {
    const f = createFilter()
    expect(f.push("hello <\u200b")).toBe("hello ")
    expect(f.push("tool_call>body</\u200btool_call>!")).toBe("!")
    expect(f.flush()).toBe("")
  })

  test("handles ZWS close tag split across chunks", () => {
    const f = createFilter()
    expect(f.push("inside <\u200btool_call>x")).toBe("inside ")
    expect(f.push("</")).toBe("")
    expect(f.push("\u200btool_call>after")).toBe("after")
  })

  test("abandons partial when ZWS tag diverges (not a real tag)", () => {
    const f = createFilter()
    expect(f.push("<\u200bto")).toBe("")
    // Now diverge — "<\u200btomato" is not a tag
    const out = f.push("mato>")
    // The "<\u200bto" was a valid partial prefix of "<\u200btool_call>"/etc.
    // After divergence we should flush the longest-valid prefix and continue.
    // Behavior matches the literal case: characters that were "held" but
    // turned out not to be a tag are released.
    expect(out).toContain("mato>")
  })

  test("flush() preserves normal text without tags", () => {
    const f = createFilter()
    expect(f.push("just some text")).toBe("just some text")
    expect(f.flush()).toBe("")
  })

  test("flush() strips trailing partial ZWS open tag", () => {
    const f = createFilter()
    // Stream cut off mid-tag like "<\u200btool_respons"
    expect(f.push("tail <\u200btool_respons")).toBe("tail ")
    expect(f.flush()).toBe("")
  })

  test("flush() discards buffered content inside unclosed ZWS tag", () => {
    const f = createFilter()
    expect(f.push("outside <\u200btool_call>{\"partial\":")).toBe("outside ")
    // Stream cut off inside the tag — buffered content is discarded
    expect(f.flush()).toBe("")
  })

  test("ZWS variants match both slash positions", () => {
    const f1 = createFilter()
    expect(f1.push("a<\u200btool_response>x</\u200btool_response>b")).toBe("ab")
    const f2 = createFilter()
    expect(f2.push("a<tool_response>x</\u200btool_response>b")).toBe("ab")
    const f3 = createFilter()
    expect(f3.push("a<\u200btool_response>x</tool_response>b")).toBe("ab")
  })
})
