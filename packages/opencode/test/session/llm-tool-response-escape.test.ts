import { describe, test, expect } from "bun:test"
import { hermesToolMiddleware } from "@ai-sdk-tool/parser"
import { LLM } from "../../src/session/llm"

const escape = LLM._escapeHermesTagsInJson

// A tool result whose content contains a literal hermes OPEN tag (e.g. read/grep
// over this repo's own hermes docs) must not inject that tag into the prompt —
// the close-tag-only escape left the open-tag path open and could hang the
// pipeline the same way user text does (C-010).
describe("session.llm._escapeHermesTagsInJson (C-010)", () => {
  test("escapes a literal <tool_call> open tag in tool output, JSON-transparently", () => {
    const original = "the format is <tool_call>{...}"
    const json = JSON.stringify({ name: "read", content: original })
    expect(json).toContain("<tool_call>")
    const escaped = escape(json)
    expect(escaped).not.toContain("<tool_call>")
    expect(escaped).toContain("\\u003ctool_call>")
    expect(JSON.parse(escaped).content).toBe(original)
  })

  test("escapes <tool_response> open tag too", () => {
    const json = JSON.stringify({ content: "echoed <tool_response> here" })
    const escaped = escape(json)
    expect(escaped).not.toMatch(/<tool_response>/)
    expect(JSON.parse(escaped).content).toBe("echoed <tool_response> here")
  })

  test("still escapes close tags (open + close in one payload)", () => {
    const original = "<tool_call>x</tool_call>"
    const json = JSON.stringify({ content: original })
    const escaped = escape(json)
    expect(escaped).not.toMatch(/<\/?(tool_call|tool_response)>/)
    expect(JSON.parse(escaped).content).toBe(original)
  })

  test("leaves clean JSON and unrelated tags untouched", () => {
    const json = JSON.stringify({ name: "bash", content: "<div> echo hi </span>" })
    expect(escape(json)).toBe(json)
  })
})

// The non-strict "hermes" mode uses the library's default response template,
// which the fork's bun patch on @ai-sdk-tool/parser teaches to escape the same
// way (the C-010 fix in llm.ts only covers the strict middleware). This drives
// the real middleware so the patch's presence — not a fork re-implementation —
// is what's under test.
describe("hermesToolMiddleware (non-strict) escapes tool outputs via fork patch", () => {
  test("tool output containing literal hermes tags is escaped in the converted prompt", async () => {
    const params: any = {
      prompt: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "read",
              output: { type: "text", value: "usage: <tool_call>{...}</tool_call> done" },
            },
          ],
        },
      ],
    }
    const result: any = await (hermesToolMiddleware as any).transformParams({ type: "stream", params })
    const texts: string[] = []
    for (const msg of result.prompt ?? []) {
      if (typeof msg.content === "string") texts.push(msg.content)
      else if (Array.isArray(msg.content)) for (const p of msg.content) if (p?.type === "text") texts.push(p.text)
    }
    // Only the converted tool-response message — the appended hermes system
    // prompt legitimately contains <tool_call> usage instructions.
    const response = texts.find((t) => t.includes("<tool_response>"))
    expect(response).toBeDefined()
    expect(response!).toContain("\\u003ctool_call>") // payload open tag escaped
    expect(response!).toContain("<\\/tool_call>") // payload close tag escaped
    expect(response!).not.toContain("<tool_call>") // no raw protocol tag from payload
  })
})
