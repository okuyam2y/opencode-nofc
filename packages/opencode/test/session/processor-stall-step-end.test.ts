import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { SessionProcessor } from "../../src/session/processor"
import { ProviderError } from "../../src/provider/error"
import { MessageV2 } from "../../src/session/message-v2"

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

  test("converts post-tool explicit connection drops into a graceful step end", () => {
    // Escalated StreamRetryableError without HTTP status (connection drop).
    const escalated = new MessageV2.StreamRetryableError(
      undefined,
      "recvAddress(..) failed with error(-104): Connection reset by peer",
    )
    expect(should(escalated, true, 0)).toBe(true)
    expect(should(escalated, false, 0)).toBe(false)
    expect(should(escalated, true, MAX)).toBe(false)

    // Directly-thrown SystemError shape (observed 2026-06-10: code=ECONNRESET).
    const sysErr = Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" })
    expect(should(sysErr, true, 0)).toBe(true)

    // Bare-string connection drop thrown past the escalation middleware.
    expect(should("recvAddress(..) failed with error(-104): Connection reset by peer", true, 0)).toBe(true)
  })

  test("post-tool 5xx escalations keep failing loud (statusCode present)", () => {
    const fiveHundred = new MessageV2.StreamRetryableError(503, "service unavailable")
    expect(should(fiveHundred, true, 0)).toBe(false)
  })

  test("status-bearing errors fail loud even when the message text matches the connection regex", () => {
    // StreamRetryableError with a status must short-circuit to false — it must
    // NOT fall through to the message-based check below it.
    const statusWithDropText = new MessageV2.StreamRetryableError(503, "The socket connection was closed unexpectedly")
    expect(should(statusWithDropText, true, 0)).toBe(false)

    // Raw error shape carrying an HTTP status + connection-reset message text:
    // the status means the server answered — a verdict, not a transport drop.
    const rawWithStatus = Object.assign(new Error("Connection reset by peer"), { statusCode: 502 })
    expect(should(rawWithStatus, true, 0)).toBe(false)

    // Explicit connection code stays trusted even alongside a status
    // (pre-existing semantics: code=ECONNRESET is transient).
    const codeWithStatus = Object.assign(new Error("stream closed"), { code: "ECONNRESET", status: 503 })
    expect(should(codeWithStatus, true, 0)).toBe(true)
  })
})
