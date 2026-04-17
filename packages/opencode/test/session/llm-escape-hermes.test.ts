import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"

const escapeText = LLM._escapeHermesTagsInText
const escapeMessage = LLM._escapeHermesTagsInMessage

describe("escapeHermesTagsInText", () => {
  test("escapes open tool_call tag", () => {
    expect(escapeText("a<tool_call>b")).toBe("a<\u200btool_call>b")
  })

  test("escapes close tool_call tag", () => {
    expect(escapeText("a</tool_call>b")).toBe("a</\u200btool_call>b")
  })

  test("escapes open tool_response tag", () => {
    expect(escapeText("a<tool_response>b")).toBe("a<\u200btool_response>b")
  })

  test("escapes close tool_response tag", () => {
    expect(escapeText("a</tool_response>b")).toBe("a</\u200btool_response>b")
  })

  test("escapes multiple tags in one text", () => {
    expect(escapeText('<tool_call>{"name":"bash"}</tool_call>')).toBe(
      '<\u200btool_call>{"name":"bash"}</\u200btool_call>',
    )
  })

  test("leaves plain text untouched", () => {
    expect(escapeText("no tags here")).toBe("no tags here")
  })

  test("does not touch unrelated tags", () => {
    expect(escapeText("<tool_calls>x</tool_calls>")).toBe("<tool_calls>x</tool_calls>")
    expect(escapeText("<commentary>x</commentary>")).toBe("<commentary>x</commentary>")
  })

  test("preserves existing ZWS-escaped tags (idempotent)", () => {
    // Already escaped — should not re-escape since the regex does not match <\u200btool_call>.
    const already = "a<\u200btool_call>b</\u200btool_call>c"
    expect(escapeText(already)).toBe(already)
  })

  test("code block content is escaped too (intentional)", () => {
    // We do not parse markdown — all user-input text is treated uniformly.
    expect(escapeText("```\n<tool_call>x</tool_call>\n```")).toBe(
      "```\n<\u200btool_call>x</\u200btool_call>\n```",
    )
  })
})

describe("escapeHermesTagsInMessage", () => {
  test("escapes string content for user role", () => {
    const m: { role: string; content: any } = { role: "user", content: "hello <tool_call>" }
    expect(escapeMessage(m)).toEqual({ role: "user", content: "hello <\u200btool_call>" })
  })

  test("escapes string content for system role", () => {
    const m: { role: string; content: any } = { role: "system", content: "<tool_response>{}</tool_response>" }
    expect(escapeMessage(m)).toEqual({
      role: "system",
      content: "<\u200btool_response>{}</\u200btool_response>",
    })
  })

  test("skips assistant role (tool calls are genuine there)", () => {
    const m: { role: string; content: any } = { role: "assistant", content: "<tool_call>real</tool_call>" }
    expect(escapeMessage(m)).toEqual(m)
  })

  test("skips tool role (middleware handles it)", () => {
    const m: { role: string; content: any } = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "x", toolName: "bash", output: "ok" }],
    }
    expect(escapeMessage(m)).toEqual(m)
  })

  test("escapes array content text parts for user", () => {
    const m: { role: string; content: any } = {
      role: "user",
      content: [
        { type: "text", text: "review <tool_call>" },
        { type: "image", image: "base64data" },
      ],
    }
    const result = escapeMessage(m)
    expect(result.content).toEqual([
      { type: "text", text: "review <\u200btool_call>" },
      { type: "image", image: "base64data" },
    ])
  })

  test("preserves non-text parts unchanged in array content", () => {
    const m: { role: string; content: any } = {
      role: "user",
      content: [
        { type: "text", text: "<tool_call>" },
        { type: "tool-call", toolCallId: "x", toolName: "bash", input: "{}" },
      ],
    }
    const result = escapeMessage(m)
    expect((result.content as any[])[1]).toEqual({ type: "tool-call", toolCallId: "x", toolName: "bash", input: "{}" })
  })

  test("handles array with no text parts", () => {
    const m: { role: string; content: any } = {
      role: "user",
      content: [{ type: "image", image: "x" }],
    }
    const result = escapeMessage(m)
    expect(result.content).toEqual([{ type: "image", image: "x" }])
  })

  test("no-op for unsupported content shape", () => {
    const m: { role: string; content: any } = { role: "user", content: null }
    expect(escapeMessage(m)).toEqual(m)
  })
})
