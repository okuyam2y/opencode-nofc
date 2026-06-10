import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { SessionProcessor } from "../../src/session/processor"
import { ProviderError } from "../../src/provider/error"

const should = SessionProcessor.shouldEndStepAfterStall
const MAX = SessionProcessor.MAX_CONSECUTIVE_STALL_STEP_ENDS

const stall = () => new ProviderError.ResponseStreamError("SSE read timed out")

describe("shouldEndStepAfterStall", () => {
  test("converts a post-tool SSE stall into a graceful step end", () => {
    expect(should(stall(), true, 0)).toBe(true)
    expect(should(stall(), true, MAX - 1)).toBe(true)
  })

  test("does not fire before any tool executed (auto-retry handles that case)", () => {
    expect(should(stall(), false, 0)).toBe(false)
  })

  test("fails loud once the consecutive cap is reached", () => {
    expect(should(stall(), true, MAX)).toBe(false)
    expect(should(stall(), true, MAX + 5)).toBe(false)
  })

  test("ignores non-stall errors — they must keep surfacing", () => {
    expect(should(new Error("boom"), true, 0)).toBe(false)
    expect(should(new ProviderError.HeaderTimeoutError(10_000), true, 0)).toBe(false)
    expect(
      should(
        new APICallError({
          message: "Bad Request",
          url: "https://example.com",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        }),
        true,
        0,
      ),
    ).toBe(false)
    expect(should(undefined, true, 0)).toBe(false)
    expect(should("SSE read timed out", true, 0)).toBe(false)
  })

  test("matches by error name so bundling cannot break instanceof", () => {
    const foreign = new Error("SSE read timed out")
    foreign.name = "ProviderResponseStreamError"
    expect(should(foreign, true, 0)).toBe(true)
  })
})
