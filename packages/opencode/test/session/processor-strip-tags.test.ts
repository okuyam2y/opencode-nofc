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

  // Full-width-bracket degraded variants \u2014 emitted by models under CJK /
  // non-ASCII pressure. Recognized by neither the parser nor the legacy strip
  // rules, so without normalization the raw markup persists and few-shot-poisons
  // subsequent turns (anthropics/claude-code#62123 failure class).
  describe("full-width-bracket degraded tags", () => {
    test("removes complete full-width tag pair", () => {
      expect(strip('before \uff1ctool_call\uff1e{"name":"bash"}\uff1c\uff0ftool_call\uff1e after')).toBe("before  after")
    })

    test("removes full-width pair with ASCII slash in close tag", () => {
      expect(strip('a\uff1ctool_call\uff1e{"name":"bash"}\uff1c/tool_call\uff1eb')).toBe("ab")
    })

    test("removes unclosed full-width open tag at end of string", () => {
      expect(strip('text\n\uff1ctool_call\uff1e\n{"name":"bash","arguments":{}}')).toBe("text")
    })

    test("removes orphaned full-width close tag", () => {
      expect(strip("text\uff1c\uff0ftool_response\uff1emore")).toBe("textmore")
    })

    test("handles mixed full-width and ASCII brackets", () => {
      // \uff1c ASCII> open, ASCII< \uff1e close \u2014 both degraded shapes normalize.
      expect(strip('a\uff1ctool_call>x</tool_call\uff1eb')).toBe("ab")
    })

    // Regression (Codex review): ASCII brackets + full-width slash in the CLOSE
    // tag. Without \uff0f in the fast-path guard this slipped through and the
    // unclosed-open rule deleted the trailing "b" too.
    test("removes pair whose close tag has ASCII brackets + full-width slash", () => {
      expect(strip('a<tool_call>x<\uff0ftool_call>b')).toBe("ab")
    })

    test("removes orphaned close tag with ASCII brackets + full-width slash", () => {
      expect(strip("a<\uff0ftool_response>b")).toBe("ab")
    })

    test("removes full-width multi_tool_use.parallel pair", () => {
      expect(strip("a\uff1cmulti_tool_use.parallel\uff1ex\uff1c\uff0fmulti_tool_use.parallel\uff1eb")).toBe("ab")
    })

    test("removes full-width pair with ZWS after the slash", () => {
      expect(strip('a\uff1ctool_call\uff1ex\uff1c\uff0f\u200btool_call\uff1eb')).toBe("ab")
    })

    test("removes full-width tool_response pair", () => {
      expect(strip('text\uff1ctool_response\uff1e{"result":"ok"}\uff1c\uff0ftool_response\uff1emore')).toBe("textmore")
    })

    // False-positive guard: full-width brackets NOT wrapping a known tag name
    // must survive untouched (e.g. Japanese prose using full-width parens).
    test("preserves ordinary full-width brackets without a tag name", () => {
      expect(strip("\u65e5\u672c\u8a9e\u306e\uff1c\u6ce8\u91c8\uff1e\u30c6\u30ad\u30b9\u30c8")).toBe("\u65e5\u672c\u8a9e\u306e\uff1c\u6ce8\u91c8\uff1e\u30c6\u30ad\u30b9\u30c8")
      expect(strip("\u6bd4\u8f03 \uff1c \u3068 \uff1e \u306e\u8a18\u53f7")).toBe("\u6bd4\u8f03 \uff1c \u3068 \uff1e \u306e\u8a18\u53f7")
    })

    test("preserves full-width brackets around a non-tool word", () => {
      expect(strip("\uff1ctool\uff1e and \uff1ccall\uff1e separately")).toBe("\uff1ctool\uff1e and \uff1ccall\uff1e separately")
    })
  })
})
