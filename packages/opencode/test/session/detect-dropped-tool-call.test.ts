import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { LLM } from "../../src/session/llm"

const detect = LLM._detectDroppedToolCall

// The exact onError signal emitted by @ai-sdk-tool/parser@4.1.20 at stream
// finish when a tool call's JSON can't be parsed (verified against the patched
// dist: message + { toolCall } context, no `reason` field). Before C-002 the
// fork only matched reason:"unfinished" / "dropping malformed tool call", so
// none of these fired and hermes-drop-recovery was dead code.
describe("session.llm._detectDroppedToolCall (C-002)", () => {
  test("detects the parser 4.1.20 finish-time drop (message + context.toolCall)", () => {
    const raw = '{"name":"bash","arguments":{"command":"ls"}'
    expect(
      detect("Could not complete streaming JSON tool call at finish; emitting original text.", { toolCall: raw }),
    ).toEqual({ toolName: "bash", raw })
    expect(detect("Could not complete streaming JSON tool call at finish.", { toolCall: raw })).toEqual({
      toolName: "bash",
      raw,
    })
  })

  test("still detects the legacy signals (older/unpatched parsers)", () => {
    expect(detect("dropping malformed tool call", { toolCall: '{"name":"read"}' })).toMatchObject({ toolName: "read" })
    expect(detect("whatever", { reason: "unfinished", toolName: "edit", toolCall: "x" })).toMatchObject({
      toolName: "edit",
    })
  })

  // Dep-bump canary (docs/lessons: "dep-bump signal death"): the fixtures above
  // are local strings, so they keep passing even when a parser upgrade renames
  // its onError message and silently turns hermes-drop-recovery into dead code
  // — exactly how the 4.1.20 bump killed it the first time. Scan the installed
  // parser dist for the message we match so the next rename fails HERE and
  // points at _detectDroppedToolCall.
  test("canary: installed @ai-sdk-tool/parser still emits the matched drop signal", () => {
    const dist = path.dirname(fileURLToPath(import.meta.resolve("@ai-sdk-tool/parser")))
    const joined = readdirSync(dist)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(path.join(dist, f), "utf8"))
      .join("\n")
    expect(joined).toContain("Could not complete streaming JSON tool call at finish")
  })

  test("does not fire on unrelated parser errors that lack a dropped tool call", () => {
    // toolChoice validation errors carry no toolCall context.
    expect(detect("toolChoice JSON payload must be an object", { parsed: {} })).toBeUndefined()
    expect(detect("toolChoice arguments must be a JSON object", { toolName: "x", arguments: "y" })).toBeUndefined()
    // The finish message without a toolCall context must not fire either.
    expect(detect("Could not complete streaming JSON tool call at finish.", {})).toBeUndefined()
    expect(detect("some generic parse warning", { text: "...", error: "boom" })).toBeUndefined()
  })
})
