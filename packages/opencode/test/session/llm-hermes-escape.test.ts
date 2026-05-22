import { describe, test, expect } from "bun:test"
import { _escapeHermesCloseTagsInJson } from "../../src/session/llm"

describe("escapeHermesCloseTagsInJson", () => {
  test("leaves clean JSON unchanged", () => {
    const json = JSON.stringify({ name: "bash", content: "echo hi" })
    expect(_escapeHermesCloseTagsInJson(json)).toBe(json)
  })

  test("escapes literal </tool_response> inside JSON-encoded content", () => {
    const original = "leak: </tool_response>"
    const json = JSON.stringify({ name: "read", content: original })
    expect(json).toContain("</tool_response>")
    const escaped = _escapeHermesCloseTagsInJson(json)
    expect(escaped).not.toContain("</tool_response>")
    expect(escaped).toContain("<\\/tool_response>")
    expect(JSON.parse(escaped).content).toBe(original)
  })

  test("escapes literal </tool_call> inside JSON-encoded content", () => {
    const original = "see </tool_call> below"
    const json = JSON.stringify({ name: "read", content: original })
    const escaped = _escapeHermesCloseTagsInJson(json)
    expect(escaped).not.toContain("</tool_call>")
    expect(escaped).toContain("<\\/tool_call>")
    expect(JSON.parse(escaped).content).toBe(original)
  })

  test("escapes every occurrence and preserves JSON-parse semantics", () => {
    const original = "</tool_response> and </tool_call>"
    const json = JSON.stringify({ name: "bash", content: original })
    const escaped = _escapeHermesCloseTagsInJson(json)
    const escapedMatches = escaped.match(/<\\\//g) ?? []
    expect(escapedMatches.length).toBe(2)
    expect(escaped).not.toMatch(/<\/(tool_response|tool_call)>/)
    expect(JSON.parse(escaped).content).toBe(original)
  })

  test("does not touch unrelated close tags like </span>", () => {
    const json = JSON.stringify({ content: "</span> and </div>" })
    expect(_escapeHermesCloseTagsInJson(json)).toBe(json)
  })
})
