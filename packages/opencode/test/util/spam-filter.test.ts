import { describe, expect, test } from "bun:test"
import { containsSpam, containsSpamKeyword, containsTraceMarker, containsSpamInValues, stripSpam } from "@/util/spam-filter"

describe("containsSpam (requires keyword + trace marker)", () => {
  test("detects spam keyword + trace marker together", () => {
    expect(containsSpam("\tRTLRanalysis to=all code  天天中彩票彩金")).toBe(true)
    expect(containsSpam("+#+#+#+#+#+ to=commentary code  重庆时时彩彩")).toBe(true)
    expect(containsSpam("】【：】【\"】【assistant to=edit commentating code  大发快三的arguments  天天中彩票软件")).toBe(true)
  })

  test("does NOT flag spam keyword alone (no trace marker)", () => {
    // This is the key false-positive fix: documentation mentioning spam keywords
    expect(containsSpam("大发快三")).toBe(false)
    expect(containsSpam("天天中彩票")).toBe(false)
    expect(containsSpam("重庆时时彩")).toBe(false)
    expect(containsSpam("引数に中国語のギャンブルスパム（大发快三/天天中彩票）が混入する")).toBe(false)
  })

  test("does NOT flag trace marker alone (no spam keyword)", () => {
    expect(containsSpam("RTLRanalysis to=all code")).toBe(false)
    expect(containsSpam("+#+#+#+#+#+ to=commentary code")).toBe(false)
  })

  test("does not flag legitimate CJK content", () => {
    expect(containsSpam("これは日本語のコメントです")).toBe(false)
    expect(containsSpam("// 設定ファイルを読み込む")).toBe(false)
    expect(containsSpam("中文注释")).toBe(false)
    expect(containsSpam("const 変数 = 42")).toBe(false)
  })

  test("does not flag normal English text", () => {
    expect(containsSpam("function foo() { return bar }")).toBe(false)
    expect(containsSpam("")).toBe(false)
  })
})

describe("containsSpamKeyword", () => {
  test("detects known keywords", () => {
    expect(containsSpamKeyword("大发快三")).toBe(true)
    expect(containsSpamKeyword("天天中彩票")).toBe(true)
    expect(containsSpamKeyword("重庆时时彩")).toBe(true)
    expect(containsSpamKeyword("some text 大发快三 more")).toBe(true)
  })

  test("does not flag normal text", () => {
    expect(containsSpamKeyword("normal text")).toBe(false)
    expect(containsSpamKeyword("日本語")).toBe(false)
  })
})

describe("containsTraceMarker", () => {
  test("detects known trace markers", () => {
    expect(containsTraceMarker("RTLRanalysis to=all code")).toBe(true)
    expect(containsTraceMarker("+#+#+#+#+#+ to=commentary")).toBe(true)
    expect(containsTraceMarker("】【：】【\"】【assistant to=edit")).toBe(true)
  })

  test("does not flag normal text", () => {
    expect(containsTraceMarker("normal text")).toBe(false)
  })
})

describe("containsSpamInValues", () => {
  test("detects spam when keyword and trace marker are in different fields", () => {
    // Trace marker in one field, spam keyword in another — should detect
    expect(containsSpamInValues({
      oldString: "RTLRanalysis to=all code",
      newString: "大发快三 injected",
    })).toBe(true)
  })

  test("detects spam when both are in same field", () => {
    expect(containsSpamInValues({
      text: "\tRTLRanalysis to=all code  天天中彩票彩金",
    })).toBe(true)
  })

  test("passes when only keyword present (no trace marker)", () => {
    expect(containsSpamInValues({
      oldString: "docs about 大发快三 incident",
      newString: "updated docs about 天天中彩票",
    })).toBe(false)
  })

  test("passes clean objects", () => {
    expect(containsSpamInValues({ oldString: "const x = 1", newString: "const x = 2" })).toBe(false)
    expect(containsSpamInValues({ content: "日本語コメント付きコード" })).toBe(false)
  })

  test("handles non-object types", () => {
    expect(containsSpamInValues(null)).toBe(false)
    expect(containsSpamInValues(42)).toBe(false)
    expect(containsSpamInValues(undefined)).toBe(false)
    expect(containsSpamInValues(true)).toBe(false)
  })
})

describe("stripSpam", () => {
  test("removes lines containing both spam keyword and trace marker", () => {
    const input = "normal line\n\tRTLRanalysis to=all code  天天中彩票彩金\nanother normal line"
    expect(stripSpam(input)).toBe("normal line\nanother normal line")
  })

  test("preserves lines with spam keyword only (no trace marker)", () => {
    const input = "docs about 大发快三 incident\nnormal line"
    expect(stripSpam(input)).toBe(input)
  })

  test("preserves clean text unchanged", () => {
    const input = "line 1\nline 2\nline 3"
    expect(stripSpam(input)).toBe(input)
  })

  test("preserves leading/trailing whitespace and blank lines", () => {
    const input = "\n  line 1\n\n  line 2\n"
    expect(stripSpam(input)).toBe(input)
  })

  test("preserves CJK content that is not spam", () => {
    const input = "// これは日本語のコメント\nconst x = 1\n// 中文注释"
    expect(stripSpam(input)).toBe(input)
  })
})
