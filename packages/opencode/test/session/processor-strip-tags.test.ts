import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

const strip = SessionProcessor._stripToolTags

describe("stripToolTags", () => {
  test("removes complete tag pair", () => {
    expect(strip('before <tool_call>{"name":"bash"}</tool_call> after')).toBe("before  after")
  })

  test("removes multiple complete pairs", () => {
    expect(strip("a<tool_call>x</tool_call>b<tool_call>y</tool_call>c")).toBe("abc")
  })

  test("removes complete tool_response pair", () => {
    expect(strip('text<tool_response>{"result":"ok"}</tool_response>more')).toBe("textmore")
  })

  test("removes complete commentary pair", () => {
    expect(strip("text<commentary>thinking...</commentary>more")).toBe("textmore")
  })

  // The bug that was fixed: unclosed <tool_call> at end of stream
  // Previously, standalone tag removal stripped <tool_call> but left the JSON body.
  test("removes unclosed tool_call at end of string (regression)", () => {
    expect(strip('text\n<tool_call>\n{"name":"bash","arguments":{}}')).toBe("text")
  })

  test("removes unclosed tool_call with preceding close tag", () => {
    expect(strip('good text\n</tool_response>\n<tool_call>\n{"name":"bash"}')).toBe("good text")
  })

  test("removes orphaned close tags", () => {
    expect(strip("text</tool_response>more")).toBe("textmore")
    expect(strip("text</tool_result>more")).toBe("textmore")
    expect(strip("text</tool_call>more")).toBe("textmore")
  })

  test("preserves normal text with angle brackets", () => {
    expect(strip("use a < b and c > d comparison")).toBe("use a < b and c > d comparison")
  })

  test("preserves text without any tags", () => {
    expect(strip("perfectly normal text here")).toBe("perfectly normal text here")
  })

  test("handles empty string", () => {
    expect(strip("")).toBe("")
  })

  test("removes multi_tool_use.parallel pair", () => {
    expect(strip("a<multi_tool_use.parallel>content</multi_tool_use.parallel>b")).toBe("ab")
  })

  test("removes unclosed tool_response at end", () => {
    expect(strip('text\n<tool_response>{"partial":"data')).toBe("text")
  })

  test("strips trailing partial tag prefix", () => {
    // Stream cut off mid-tag like "<tool_cal"
    const result = strip("some text<tool_cal")
    expect(result).toBe("some text")
  })
})
