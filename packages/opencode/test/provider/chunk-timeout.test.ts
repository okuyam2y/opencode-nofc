import { describe, expect, test } from "bun:test"
import { resolveChunkTimeout } from "../../src/provider/provider"

describe("resolveChunkTimeout", () => {
  test("defaults to 5 minutes when unset", () => {
    expect(resolveChunkTimeout(undefined)).toBe(300_000)
    expect(resolveChunkTimeout(null)).toBe(300_000)
  })

  test("honors an explicit positive override", () => {
    expect(resolveChunkTimeout(120_000)).toBe(120_000)
    expect(resolveChunkTimeout(1)).toBe(1)
  })

  test("false / 0 / negative disable the timeout", () => {
    expect(resolveChunkTimeout(false)).toBeUndefined()
    expect(resolveChunkTimeout(0)).toBeUndefined()
    expect(resolveChunkTimeout(-1)).toBeUndefined()
  })

  test("unexpected types disable rather than guess", () => {
    expect(resolveChunkTimeout("300000")).toBeUndefined()
    expect(resolveChunkTimeout(true)).toBeUndefined()
  })
})
