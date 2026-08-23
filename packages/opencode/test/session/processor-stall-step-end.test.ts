import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { SessionProcessor } from "../../src/session/processor"
import { ProviderError } from "../../src/provider/error"
import { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"

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

  test("post-tool network_error ends the step gracefully instead of retrying", () => {
    // llm.ts fails the stream with exactly this error when a provider ends a step
    // with finish_reason "network_error".  Before a tool runs it retries; after one
    // has, forceNonRetryable vetoes the retry and this predicate is what keeps the
    // turn going instead of surfacing an error.  The coupling is by error name, so
    // renaming ResponseStreamError must break here rather than silently change the
    // post-tool behaviour.
    const networkError = () => new ProviderError.ResponseStreamError("Provider finish_reason: network_error")
    expect(should(networkError(), true, 0)).toBe(true)
    expect(should(networkError(), false, 0)).toBe(false)
    expect(should(networkError(), true, MAX)).toBe(false)
  })

  test("the usage-carrying subclass still takes the graceful-end branch", () => {
    // llm.ts throws LLM.FinishReasonError (a ResponseStreamError subclass) so the
    // committed post-tool step can still be billed. If subclassing ever stopped
    // inheriting `name`, post-tool network_error would surface as an error instead
    // of continuing the turn — catch that here rather than in production.
    const carrying = new LLM.FinishReasonError("Provider finish_reason: network_error", undefined, undefined)
    expect(carrying.name).toBe("ProviderResponseStreamError")
    expect(carrying).toBeInstanceOf(ProviderError.ResponseStreamError)
    expect(should(carrying, true, 0)).toBe(true)
    expect(should(carrying, false, 0)).toBe(false)
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

const settle = SessionProcessor.settlementForStall

describe("settlementForStall", () => {
  test("a committed step is billed whether or not the loop continues", () => {
    expect(settle({ hasUsage: true, hasExecutedTool: true, endsGracefully: true }).bill).toBe(true)
    // At the consecutive-stall cap the loop fails instead of continuing, but the tools
    // still ran and the tokens were still spent.
    expect(settle({ hasUsage: true, hasExecutedTool: true, endsGracefully: false }).bill).toBe(true)
  })

  test("nothing is billed before a tool ran — that attempt is rolled back and retried", () => {
    expect(settle({ hasUsage: true, hasExecutedTool: false, endsGracefully: true }).bill).toBe(false)
    expect(settle({ hasUsage: true, hasExecutedTool: false, endsGracefully: false }).bill).toBe(false)
  })

  test("nothing is billed when the error carries no usage", () => {
    expect(settle({ hasUsage: false, hasExecutedTool: true, endsGracefully: true }).bill).toBe(false)
  })

  test("the v2 step ends only when the loop continues", () => {
    // Ending it at the cap would split one provider step into a finished one plus the
    // empty failed one the failure path is about to report.
    expect(settle({ hasUsage: true, hasExecutedTool: true, endsGracefully: false }).settleV2).toBe(false)
    expect(settle({ hasUsage: true, hasExecutedTool: true, endsGracefully: true }).settleV2).toBe(true)
  })

  test("the v2 step ends for stalls that carry no usage too", () => {
    // A post-tool chunk timeout or connection drop commits the step just the same;
    // leaving it unsettled merges two provider steps into one that never ends.
    expect(settle({ hasUsage: false, hasExecutedTool: true, endsGracefully: true }).settleV2).toBe(true)
  })

  test("a step-finish part is written only when there is usage to record", () => {
    expect(settle({ hasUsage: true, hasExecutedTool: true, endsGracefully: true }).writeStepFinish).toBe(true)
    expect(settle({ hasUsage: false, hasExecutedTool: true, endsGracefully: true }).writeStepFinish).toBe(false)
    expect(settle({ hasUsage: true, hasExecutedTool: true, endsGracefully: false }).writeStepFinish).toBe(false)
  })

  test("a pre-tool stall settles nothing at all", () => {
    expect(settle({ hasUsage: true, hasExecutedTool: false, endsGracefully: true })).toEqual({
      bill: false,
      settleV2: false,
      writeStepFinish: false,
    })
  })
})
