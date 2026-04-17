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

  // ZWS-escaped variants — appears when the model echoes user input that was
  // escaped by the hermes escape middleware (see llm.ts escapeHermesTagsInMessage).
  describe("ZWS-escaped tags", () => {
    test("removes complete ZWS tag pair (tool_call)", () => {
      expect(strip('before <\u200btool_call>{"name":"bash"}</\u200btool_call> after')).toBe("before  after")
    })

    test("removes complete ZWS tag pair (tool_response)", () => {
      expect(strip('text<\u200btool_response>{"result":"ok"}</\u200btool_response>more')).toBe("textmore")
    })

    test("removes unclosed ZWS open tag at end of string", () => {
      expect(strip('text\n<\u200btool_call>\n{"name":"bash"}')).toBe("text")
    })

    test("removes orphaned ZWS close tags", () => {
      expect(strip("text</\u200btool_response>more")).toBe("textmore")
      expect(strip("text</\u200btool_call>more")).toBe("textmore")
    })

    test("removes ZWS open tag and content through end of string (matches literal behavior)", () => {
      // Orphaned open tag (no close) strips from the tag to end, same as the
      // literal <tool_call> case — see "removes unclosed tool_call at end of
      // string (regression)" above.
      expect(strip("text<\u200btool_call>more")).toBe("text")
    })

    test("mixed literal and ZWS forms in same text", () => {
      expect(strip("a<tool_call>x</\u200btool_call>b<\u200btool_call>y</tool_call>c")).toBe("abc")
    })

    test("preserves normal text containing isolated ZWS", () => {
      // ZWS not attached to any tag marker should survive
      expect(strip("text\u200bwith zws")).toBe("text\u200bwith zws")
    })
  })
})
