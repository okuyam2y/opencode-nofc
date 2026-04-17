import { describe, expect, test } from "bun:test"
import { applyMaxCompletionTokensTransform } from "../../src/provider/provider"

describe("applyMaxCompletionTokensTransform", () => {
  test("renames max_tokens to max_completion_tokens", () => {
    const input = JSON.stringify({ model: "gpt-5", max_tokens: 4096, messages: [] })
    const output = applyMaxCompletionTokensTransform(input)
    const parsed = JSON.parse(output)
    expect(parsed.max_completion_tokens).toBe(4096)
    expect(parsed.max_tokens).toBeUndefined()
    expect(parsed.model).toBe("gpt-5")
  })

  test("passes through bodies without max_tokens unchanged", () => {
    const input = JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] })
    expect(applyMaxCompletionTokensTransform(input)).toBe(input)
  })

  test("preserves existing max_completion_tokens when only it is set", () => {
    const input = JSON.stringify({ model: "gpt-5", max_completion_tokens: 2048 })
    const output = applyMaxCompletionTokensTransform(input)
    const parsed = JSON.parse(output)
    expect(parsed.max_completion_tokens).toBe(2048)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("overwrites existing max_completion_tokens with max_tokens value when both present", () => {
    // max_tokens wins — callers shouldn't send both, but if they do we normalize to the
    // legacy-named value since that's what the caller most likely intended.
    const input = JSON.stringify({ max_tokens: 4096, max_completion_tokens: 1024 })
    const output = applyMaxCompletionTokensTransform(input)
    const parsed = JSON.parse(output)
    expect(parsed.max_completion_tokens).toBe(4096)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("passes through non-JSON body unchanged (form-data, multipart, binary)", () => {
    const formLike = "name=value&max_tokens=4096"
    expect(applyMaxCompletionTokensTransform(formLike)).toBe(formLike)

    const binaryLike = "\x00\x01\x02binary payload"
    expect(applyMaxCompletionTokensTransform(binaryLike)).toBe(binaryLike)
  })

  test("passes through empty string unchanged", () => {
    expect(applyMaxCompletionTokensTransform("")).toBe("")
  })

  test("passes through JSON scalars unchanged", () => {
    expect(applyMaxCompletionTokensTransform("42")).toBe("42")
    expect(applyMaxCompletionTokensTransform("null")).toBe("null")
    expect(applyMaxCompletionTokensTransform('"hello"')).toBe('"hello"')
  })
})
